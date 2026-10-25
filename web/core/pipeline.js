// The pipeline: plain-language description -> specification -> plan -> stage generators -> audited, revised,
// verified database package. Models propose; deterministic code (harness.py, the checks below) decides.
//
// Phases and their gates:
//   research   what real data of this kind looks like: the model searches through the host's web tools when the host
//              has them (a local search service), else through the provider's own web search when it has one
//   spec       schema, triggers, rules - must load in SQLite; every rule's verifier must run
//   plan       stages - every table once, foreign keys respected (else a deterministic plan, logged)
//   code       each stage: every rule of the stage passes on 3 shown seeds AND 2 hidden seeds (the coder is told a
//              hidden seed failed and which rule's check said what, never the seed itself), the stage uses its
//              seed (its tables' rows differ across the shown seeds unless declared FIXED), and its rows are
//              reproducible: rebuilt in a second runtime with another string-hash seed, they are the same (so the
//              package's generate.py rebuilds them in any CPython); a stage that cannot be made to pass gets its
//              rules repaired (loosened) and is tried again
//   audit      the auditor looks for unrealistic patterns on the hidden-seed databases and proposes rules; a rule
//              is accepted only if it runs and FAILS on at least one of those databases; accepted rules are
//              applied and the affected stages regenerated; stop when no high or medium flaw is found, or at the
//              round limit
//   package    the database, the generator, the verifiers, the DDL, the verification report, the lineage

import { AUDIT_SYSTEM, CODE_SYSTEM, EXPECT_SYSTEM, PLAN_SYSTEM, REPAIR_SYSTEM, RESEARCH_SYSTEM, RESEARCH_TOOLS_SYSTEM, SPEC_FIX, SPEC_SYSTEM } from "./prompts.js";
import { extractJson, extractPython, isFatal, LLMError } from "./llm.js";
import { applyAnswer } from "./edits.js";

export const DEFAULTS = {
  specAttempts: 4,
  planAttempts: 3,
  codeAttempts: 6,
  repairs: 2,
  auditRounds: 3,
  auditTurns: 10,
  maxCalls: 150,
  stageTimeoutMs: 120000,
  shownSeeds: [1, 2, 3],
  research: true,
  researchTurns: 6,
  // a domain expert's list of what real data of this kind shows, given to the coders and the auditor
  expectations: true,
};

export class PipelineError extends Error {
  constructor(message, partial) { super(message); this.partial = partial; }
}

const ID = /^[a-z][a-z0-9_]{1,50}$/;
// model JSON is untrusted in shape: a list field may come as a string, null or an object
const strList = (x) => (Array.isArray(x) ? x.filter((v) => v != null).map(String) : typeof x === "string" && x ? [x] : []);
const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const ruleCodes = (rules) => rules.map((r) => [r.id, r.code]);
const clip = (s, n = 4000) => { s = String(s ?? ""); return s.length <= n ? s : `${s.slice(0, n / 2)}\n...[${s.length - n} chars left out]...\n${s.slice(-n / 2)}`; };

export function hiddenSeeds(runId) {
  let h = 2166136261;
  for (const ch of String(runId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const first = 100000 + (h % 800000);
  return [first, first + 1];
}

export function assembleVerifiers(rules) {
  const head = '"""Verification rules - each verify_<id>(db) returns {"passed": bool, "detail": str}.\n' +
    'db.query(sql, params) returns a list of row tuples."""\n';
  return head + rules.map((r) => `\n\n# ${r.id}: ${r.statement.replace(/\n/g, " ")}\n${r.code.trim()}\n`).join("");
}

// -- the plan: validation and the deterministic fallback ----------------------------------------------------------

export function validatePlan(stages, tables) {
  const problems = [];
  const names = new Set(tables.map((t) => t.name));
  const seen = new Map();
  stages.forEach((s, i) => (s.tables || []).forEach((t) => {
    if (!names.has(t)) problems.push(`stage ${i + 1} names an unknown table ${t}`);
    else if (seen.has(t)) problems.push(`table ${t} is in two stages`);
    else seen.set(t, i);
  }));
  for (const t of names) if (!seen.has(t)) problems.push(`table ${t} is in no stage`);
  for (const t of tables) {
    for (const ref of t.references) {
      if (seen.has(t.name) && seen.has(ref) && seen.get(ref) > seen.get(t.name)) {
        problems.push(`table ${t.name} (stage ${seen.get(t.name) + 1}) references ${ref}, written later (stage ${seen.get(ref) + 1})`);
      }
    }
  }
  if (stages.some((s) => !(s.tables || []).length)) problems.push("a stage has no table");
  return problems;
}

export function defaultPlan(tables) {
  // topological order of the foreign-key graph; tables in a reference cycle share a stage
  const refs = new Map(tables.map((t) => [t.name, new Set(t.references)]));
  const done = new Set();
  const stages = [];
  while (done.size < tables.length) {
    const ready = tables.map((t) => t.name).filter((n) => !done.has(n) && [...refs.get(n)].every((r) => done.has(r) || !refs.has(r)));
    const group = ready.length ? ready.slice(0, 1) : tables.map((t) => t.name).filter((n) => !done.has(n));
    group.forEach((n) => done.add(n));
    stages.push({ tables: group, notes: "" });
  }
  return stages;
}

export function ruleStage(rule, stages) {
  let at = -1;
  for (const t of rule.tables) {
    const i = stages.findIndex((s) => s.tables.includes(t));
    if (i < 0) return -1;
    at = Math.max(at, i);
  }
  return at;
}

// The earliest stage whose rows a rule reads. A rule is checked at ruleStage (its last table), but the rows of its
// earlier tables are fixed by then: a rule over two stages' tables (names of both, prices of both) can only be met
// if the earlier stage knows it (autotune loop 2: such rules, mostly added by the audit, ended runs with "this stage
// cannot repair the earlier table").
export function firstRuleStage(rule, stages) {
  let at = Infinity;
  for (const t of rule.tables) {
    const i = stages.findIndex((s) => s.tables.includes(t));
    if (i >= 0) at = Math.min(at, i);
  }
  return at === Infinity ? -1 : at;
}

// -- the pipeline -------------------------------------------------------------------------------------------------

export class Pipeline {
  // checkRuntime: a second runtime started with another PYTHONHASHSEED, for the reproducibility check (omitted: no check)
  // web: the host's web tools (web/core/websearch.js); the Node runtime carries them when a local search service is set
  constructor({ llm, runtime, checkRuntime, emit, settings = {}, signal, runId, web }) {
    this.llm = llm;
    this.rt = runtime;
    this.web = web || runtime?.web || null;
    this.rt2 = checkRuntime || null;
    this.emit = emit || (() => {});
    this.s = { ...DEFAULTS, ...settings };
    this.signal = signal;
    this.runId = runId || `${Date.now()}`;
    this.hidden = hiddenSeeds(this.runId);
    this.stepSeq = 0;
    this.state = { description: "", research: null, expectations: [], schema: "", triggers: "", rules: [], tables: [], stages: [],
      codes: [], fixed: [], rounds: [], rejected: [], verification: {}, databases: {}, lineage: [] };
  }

  // a timeline entry the UI shows; returns handles to update it
  step(phase, title, detail = "") {
    const id = ++this.stepSeq;
    const entry = { id, phase, title, status: "running", detail, at: Date.now() };
    this.state.lineage.push(entry);
    this.emit({ type: "step", ...entry });
    const set = (status) => (d) => { entry.status = status; if (d !== undefined) entry.detail = d; entry.end = Date.now(); this.emit({ type: "step", ...entry }); };
    return { done: set("done"), fail: set("failed"), info: set("info"), update: (d) => { entry.detail = d; this.emit({ type: "step", ...entry }); } };
  }

  checkBudget() {
    if (this.signal && this.signal.aborted) throw new PipelineError("stopped by the user", this.state);
    if (this.llm.usage.calls >= this.s.maxCalls) throw new PipelineError(`the model-call budget (${this.s.maxCalls}) is used up`, this.state);
  }

  // A provider error that no retry fixes (bad key, no credits, a rejected request or an unknown model) ends the run
  // with the partial state; the attempt loops below would otherwise read it as a bad answer and spend every attempt on
  // it (and the plan step would quietly fall back to the default plan). Errors that may pass (429 rate limit, 5xx,
  // network) were already retried by the provider layer and stay ordinary attempt failures.
  providerError(e) {
    if (e instanceof PipelineError) return e;
    if (this.signal && this.signal.aborted) return new PipelineError("stopped by the user", this.state);
    if (isFatal(e) || (e instanceof LLMError && (e.status === 400 || e.status === 404)))
      return new PipelineError(`the model provider refused the request: ${e.message}`, this.state);
    return e;
  }

  async ask(system, user, maxTokens = 16000, history = []) {
    this.checkBudget();
    const messages = [...history, { role: "user", content: user }];
    let text;
    try {
      ({ text } = await this.llm.complete({ system, messages, maxTokens }, this.signal));
    } catch (e) {
      throw this.providerError(e);
    }
    this.emit({ type: "usage", usage: { ...this.llm.usage } });
    return text;
  }

  // every failure leaves as a PipelineError carrying the partial state (the caller packages what was made)
  async run(description) {
    try {
      return await this.runPhases(description);
    } catch (e) {
      const pe = this.providerError(e);
      throw pe instanceof PipelineError ? pe : new PipelineError(`unexpected error: ${e && e.message ? e.message : e}`, this.state);
    }
  }

  async runPhases(description) {
    this.state.description = description.trim();
    if (this.state.description.length < 20) throw new PipelineError("the description is too short", this.state);
    this.emit({ type: "start", runId: this.runId, hiddenSeeds: this.hidden.length });
    if (this.s.research) await this.research();
    await this.specify();
    if (this.s.expectations) await this.expect();
    await this.planStages();
    await this.codeFrom(0);
    for (let round = 1; round <= this.s.auditRounds; round++) {
      const more = await this.audit(round);
      if (!more) break;
    }
    await this.finalVerification();
    this.emit({ type: "finished", state: this.state });
    return this.state;
  }

  // -- research ---------------------------------------------------------------------------------------------------

  async research() {
    if (this.web) {
      if (await this.web.available()) return this.researchWithTools();
      this.step("research", "The local search service does not answer").info("research uses the provider's own web search instead");
    }
    const st = this.step("research", "Researching what real data like this looks like");
    try {
      this.checkBudget();
      const r = await this.llm.research(`Database description:\n${this.state.description}\n\nWhat does real data of this kind look like?`,
        RESEARCH_SYSTEM, this.signal);
      this.state.research = r;
      st.done(`${r.source}\n\n${r.text}`);
    } catch (err) {
      const e = this.providerError(err);
      if (e instanceof PipelineError) throw e;
      this.state.research = { text: "", source: "none" };
      st.info(`research skipped: ${e.message}`);
    }
  }

  // The model drives the host's web tools turn by turn (the auditor's protocol: one JSON action per turn) and ends with
  // its notes. Every tool call is recorded in research.trail. A tool that fails answers the model with the failure, so
  // the model can try another query or page; a run of turns without notes leaves research empty, as a failed search does.
  async researchWithTools() {
    const st = this.step("research", "Researching what real data like this looks like (local web search)");
    const turns = this.s.researchTurns;
    const system = RESEARCH_TOOLS_SYSTEM(turns);
    const trail = [];
    const queries = [];
    const history = [];
    let user = `Database description:\n${this.state.description}\n\nWhat does real data of this kind look like?`;
    let notes = "";
    let stopped = "";
    try {
      for (let turn = 1; turn <= turns + 1 && !notes; turn++) {
        const last = turn > turns;
        const prompt = last ? `${user}\n\nNo more tool calls. Answer with {"action": "notes", "text": "..."} now.` : user;
        const answer = await this.ask(system, prompt, 8000, history);
        history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
        let act;
        try { act = extractJson(answer); } catch (e) {
          // the last turn can only be the notes: written as plain text, they are the notes (live: they were lost)
          if (last) { notes = answer.trim(); continue; }
          user = `That was not a JSON action (${e.message}). Answer with one JSON object.`;
          continue;
        }
        if (act.action === "notes") { notes = String(act.text || "").trim(); if (!notes) user = "The notes are empty. Give them in \"text\"."; continue; }
        if (last) continue; // a tool call on the last turn is not run
        if (act.action === "search") {
          const qs = strList(act.queries ?? act.query).slice(0, 3);
          if (!qs.length) { user = 'A search needs "queries".'; continue; }
          queries.push(...qs);
          const found = await Promise.all(qs.map((q) => this.web.search(q)));
          user = found.map((f, i) => {
            trail.push({ turn, tool: "search", query: qs[i], engine: f.engine, results: f.hits.length });
            const lines = f.hits.map((h, k) => `${k + 1}. ${h.title}\n   ${h.url}\n   ${clip(h.snippet, 400)}`);
            return `Results for "${qs[i]}":\n${lines.join("\n") || `(none: ${f.errors.join("; ") || "no results"})`}`;
          }).join("\n\n");
          st.update(`turn ${turn}: search ${qs.map((q) => `"${q}"`).join(", ")}`);
        } else if (act.action === "papers") {
          const q = String(act.query || "").trim();
          if (!q) { user = 'A paper search needs "query".'; continue; }
          queries.push(q);
          let works = [];
          let error = "";
          try { works = await this.web.papers(q); } catch (e) { error = e.message; }
          trail.push({ turn, tool: "papers", query: q, results: works.length, ...(error ? { error } : {}) });
          user = `Works for "${q}":\n` + (works.map((w, k) => `${k + 1}. ${w.title} (${w.year ?? "?"}, cited ${w.cited ?? "?"})\n   ${w.url}\n   ${clip(w.abstract, 700) || "(no abstract)"}`).join("\n")
            || `(none${error ? `: ${error}` : ""})`);
          st.update(`turn ${turn}: papers "${q}"`);
        } else if (act.action === "read") {
          const urls = strList(act.urls ?? act.url).slice(0, 3);
          if (!urls.length) { user = 'A read needs "urls".'; continue; }
          const pages = await Promise.all(urls.map((u) => this.web.read(u, [...queries])));
          user = pages.map((p, i) => {
            trail.push({ turn, tool: "read", url: urls[i], ok: p.ok, chars: p.text.length });
            return `Page ${urls[i]}:\n${p.ok ? p.text : `(not read: ${p.text})`}`;
          }).join("\n\n");
          st.update(`turn ${turn}: read ${urls.length} page(s)`);
        } else {
          user = 'Unknown action. Use "search", "papers", "read" or "notes".';
        }
      }
    } catch (err) {
      const e = this.providerError(err);
      if (e instanceof PipelineError) throw e;
      stopped = e.message;
      notes = "";
    }
    const searched = trail.filter((t) => t.tool !== "read").length;
    const read = trail.filter((t) => t.tool === "read" && t.ok).length;
    const source = `local web search (${searched} searches, ${read} pages read)`;
    this.state.research = { text: notes, source, trail };
    if (notes) st.done(`${source}\n\n${notes}`);
    else st.info(`research gave no notes (${stopped ? `stopped: ${stopped}` : `${turns + 1} turns used`}); the specification is written without them`);
  }

  // -- specification ----------------------------------------------------------------------------------------------

  async specify() {
    const st = this.step("spec", "Writing the schema, constraints and verification rules");
    const notes = this.state.research?.text ? `\n\nResearch notes:\n${this.state.research.text}` : "";
    const history = [];
    let user = `Database description:\n${this.state.description}${notes}`;
    let providerFailure = "";
    for (let attempt = 1; attempt <= this.s.specAttempts; attempt++) {
      st.update(`attempt ${attempt}`);
      let answer;
      try {
        answer = await this.ask(SPEC_SYSTEM, user, 32000, history);
      } catch (e) {
        // a transient provider failure (already retried) costs this attempt; the same request goes again
        if (e instanceof PipelineError) throw e;
        st.update(`attempt ${attempt}: the provider failed (${e.message})`);
        providerFailure = e.message;
        continue;
      }
      providerFailure = "";
      history.push({ role: "user", content: user }, { role: "assistant", content: answer });
      let spec;
      try { spec = extractJson(answer); } catch (e) { user = SPEC_FIX([e.message]); continue; }
      const problems = await this.checkSpecObject(spec);
      if (!problems.length) {
        st.done(`${this.state.tables.length} tables, ${this.state.rules.length} rules (attempt ${attempt})`);
        this.emit({ type: "spec", schema: this.state.schema, triggers: this.state.triggers, rules: this.state.rules });
        return;
      }
      st.update(`attempt ${attempt}: ${problems.length} problems - ${problems.slice(0, 3).join("; ")}`);
      user = SPEC_FIX(problems.slice(0, 20));
    }
    // when the last attempt failed at the provider, that is the cause to report, not the specification
    const why = providerFailure ? `the model provider kept failing (${providerFailure})` : "the specification could not be made valid";
    st.fail(why);
    throw new PipelineError(why, this.state);
  }

  async checkSpecObject(spec) {
    const problems = [];
    const schema = String(spec.schema_sql || "");
    const triggers = String(spec.triggers_sql || "");
    const rules = Array.isArray(spec.rules) ? spec.rules : [];
    if (!schema.trim()) problems.push("schema_sql is empty");
    if (!rules.length) problems.push("rules is empty");
    const ids = new Set();
    const clean = [];
    for (const r of rules) {
      if (!isObj(r)) { problems.push(`every rule must be an object with id, statement, tables and code (got ${JSON.stringify(r)})`); continue; }
      const id = String(r.id || "");
      if (!ID.test(id)) { problems.push(`rule id ${JSON.stringify(id)} must be snake_case`); continue; }
      if (ids.has(id)) { problems.push(`rule id ${id} is used twice`); continue; }
      ids.add(id);
      if (!String(r.code || "").includes(`def verify_${id}(`)) problems.push(`rule ${id}: its code must define verify_${id}(db)`);
      clean.push({ id, statement: String(r.statement || id), tables: strList(r.tables), code: String(r.code || ""), origin: "specification" });
    }
    if (problems.length) return problems;
    const res = (await this.rt.call("check_spec", { schema, triggers, verifiers: assembleVerifiers(clean), rule_codes: ruleCodes(clean) })).result;
    problems.push(...res.problems);
    const tableNames = new Set(res.tables.map((t) => t.name));
    for (const r of clean) {
      const unknown = r.tables.filter((t) => !tableNames.has(t));
      if (!r.tables.length) problems.push(`rule ${r.id}: "tables" must list the tables it reads`);
      if (unknown.length) problems.push(`rule ${r.id}: unknown tables ${unknown.join(", ")} (tables: ${[...tableNames].join(", ")})`);
    }
    if (!problems.length) {
      Object.assign(this.state, { schema, triggers, rules: clean, tables: res.tables });
    }
    return problems;
  }

  // -- plan -------------------------------------------------------------------------------------------------------

  // What real data of this kind shows that a generator easily misses (process structure, dependencies, rhythms,
  // shapes): one call after the specification. The list guides the stage coders (each sees the properties of its
  // tables) and the auditor (it checks them first); it adds no rule and gates nothing (live analysis 2026-10-25: the
  // judge's residual flaws were mostly about how the real process works, and audit rules did not reduce them).
  async expect() {
    const st = this.step("spec", "Listing what real data of this kind shows");
    const known = new Map(this.state.tables.map((t) => [t.name.toLowerCase(), t.name]));
    const user = `Description:\n${this.state.description}\n\nResearch notes:\n${this.state.research?.text || "(none)"}\n\nSchema:\n${this.state.schema}\n\n` +
      `Rules that already exist:\n${this.state.rules.map((r) => `- ${r.id} [${r.tables.join(", ")}]: ${r.statement}`).join("\n")}`;
    try {
      const answer = extractJson(await this.ask(EXPECT_SYSTEM, user, 8000));
      const list = (Array.isArray(answer.expectations) ? answer.expectations : []).filter(isObj).map((e) => ({
        tables: strList(e.tables).map((t) => known.get(t.toLowerCase())).filter(Boolean),
        property: String(e.property || "").trim().slice(0, 600),
      })).filter((e) => e.tables.length && e.property).slice(0, 12);
      this.state.expectations = list;
      if (list.length) st.done(`${list.length} properties:\n${list.map((e) => `- [${e.tables.join(", ")}] ${e.property}`).join("\n")}`);
      else st.info("no usable properties; generation goes on without them");
    } catch (e) {
      if (e instanceof PipelineError) throw e;
      this.state.expectations = [];
      st.info(`no usable properties (${e.message}); generation goes on without them`);
    }
  }

  // the properties concerning any of these tables, as prompt lines
  expectationsFor(tables) {
    const own = new Set(tables);
    return (this.state.expectations || []).filter((e) => e.tables.some((t) => own.has(t))).map((e) => `- [${e.tables.join(", ")}] ${e.property}`);
  }

  async planStages() {
    const st = this.step("plan", "Planning the generation stages");
    const tables = this.state.tables;
    const user = `Tables (with the tables each references):\n${tables.map((t) => `- ${t.name}: columns ${t.columns.map((c) => c.name).join(", ")}; references ${t.references.join(", ") || "none"}`).join("\n")}\n\n` +
      `Rules:\n${this.state.rules.map((r) => `- ${r.id} [${r.tables.join(", ")}]: ${r.statement}`).join("\n")}\n\nSchema:\n${this.state.schema}\n\nTriggers:\n${this.state.triggers || "(none)"}`;
    const history = [];
    let prompt = user;
    for (let attempt = 1; attempt <= this.s.planAttempts; attempt++) {
      let answer;
      try {
        answer = await this.ask(PLAN_SYSTEM, prompt, 16000, history);
      } catch (e) {
        if (e instanceof PipelineError) throw e;
        continue; // a transient provider failure: the same prompt goes again (it may be the one with the schema)
      }
      history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
      let plan;
      try { plan = extractJson(answer); } catch (e) {
        prompt = `That answer was not usable (${e.message}). Answer with the JSON object only.`;
        continue;
      }
      const stages = (Array.isArray(plan.stages) ? plan.stages : []).filter(isObj).map((s) => ({ tables: strList(s.tables), notes: String(s.notes || "") }));
      if (!stages.length) { prompt = 'The answer has no "stages" list of {"tables": [...], "notes": "..."} objects. Answer with the corrected JSON object.'; continue; }
      const problems = validatePlan(stages, tables);
      if (!problems.length) return this.setPlan(stages, st, `planned by the model (attempt ${attempt})`);
      prompt = `The plan has problems:\n- ${problems.join("\n- ")}\nAnswer with the corrected JSON object.`;
    }
    this.setPlan(defaultPlan(tables), st, "the model's plans were invalid; using the foreign-key order (one table per stage)");
  }

  setPlan(stages, st, how) {
    this.state.stages = stages.map((s, i) => ({ index: i, tables: s.tables, notes: s.notes }));
    this.state.codes = stages.map(() => "");
    this.state.fixed = stages.map(() => ({}));
    st.done(`${how}: ${this.state.stages.map((s) => s.tables.join("+")).join(" -> ")}`);
    this.emit({ type: "plan", stages: this.state.stages });
  }

  rulesOf(k) {
    return this.state.rules.filter((r) => ruleStage(r, this.state.stages) === k);
  }

  // rules checked at a later stage that also read stage k's tables: stage k's rows must make them satisfiable
  laterRulesOf(k) {
    const own = new Set(this.state.stages[k].tables);
    return this.state.rules.filter((r) => ruleStage(r, this.state.stages) > k && r.tables.some((t) => own.has(t)));
  }

  // -- code -------------------------------------------------------------------------------------------------------

  // revise: {stage index: reason} - stages that must rework their program for a rule they feed but do not check
  async codeFrom(first, revise = {}) {
    for (let k = first; k < this.state.stages.length; k++) await this.codeStage(k, revise[k] || "");
  }

  stagesFor(k, code) {
    return this.state.stages.slice(0, k + 1).map((s, i) => ({ index: i, tables: s.tables, code: i === k ? code : this.state.codes[i] }));
  }

  // the source of every stage a build of stage k runs: the worker loads the packages they import (a fresh worker,
  // after a time-limit kill, has none loaded)
  allCode(k, code) {
    return this.stagesFor(k, code).map((s) => s.code).join("\n");
  }

  // one candidate program for stage k on some seeds: {ok, feedback, results}
  async evaluate(k, code, seeds, hidden) {
    const stage = this.state.stages[k];
    const rules = this.rulesOf(k);
    const verifiers = assembleVerifiers(rules);
    const fails = [];
    const digests = {};
    let fixed = {};
    let seconds = 0;
    for (const [n, seed] of seeds.entries()) {
      const name = hidden ? `unseen seed #${n + 1}` : `seed ${seed}`;
      let built;
      try {
        built = await this.rt.call("build", { schema: this.state.schema, triggers: this.state.triggers, stages: this.stagesFor(k, code), seed },
          { wantDb: true, code: this.allCode(k, code), timeoutMs: this.s.stageTimeoutMs });
      } catch (e) {
        return { ok: false, feedback: `On ${name}: the program did not finish (${e.message}). Make it faster: no long rejection loops, no per-row queries in loops.` };
      }
      const rec = built.result.stages[k];
      if (!built.result.ok) {
        const bad = built.result.stages.find((s) => !s.ok);
        if (bad && bad.index < k) return { ok: false, earlier: true, feedback: `an earlier stage failed on ${name}: ${bad.error}` };
        // raised: the program stopped itself - often on purpose, with its own diagnosis of a rule it cannot meet
        return { ok: false, raised: true, feedback: `On ${name} the program raised:\n${rec?.error || "unknown error"}${rec?.output ? `\nIt printed:\n${rec.output}` : ""}` };
      }
      seconds = Math.max(seconds, rec.seconds);
      fixed = rec.fixed || {};
      for (const [t, d] of Object.entries(rec.table_digests || {})) (digests[t] ||= []).push(d);
      if (rules.length) {
        const v = (await this.rt.call("verify", { verifiers, rule_ids: rules.map((r) => r.id) }, { db: built.db })).result;
        for (const r of rules) {
          const res = v[r.id];
          if (!res || !res.passed) fails.push({ seed: name, rule: r.id, detail: res ? res.detail : "did not run" });
        }
      }
    }
    const unused = hidden ? [] : Object.entries(digests).filter(([t, ds]) => ds.length > 1 && new Set(ds).size === 1 && !(t in fixed)).map(([t]) => t);
    const first = Object.fromEntries(Object.entries(digests).map(([t, ds]) => [t, ds[0]]));
    if (!fails.length && !unused.length) return { ok: true, seconds, fixed, first };
    const lines = fails.map((f) => `- ${f.seed}: rule ${f.rule} fails: ${f.detail}`);
    if (unused.length) lines.push(`- the seed does not change table(s) ${unused.join(", ")}: every shown seed gave the same rows - draw them from rng (or, only if the rules fully fix the content, declare FIXED)`);
    return { ok: false, fails, unused, feedback: lines.slice(0, 30).join("\n") };
  }

  // The stage rebuilt on the first shown seed in the second runtime (another string-hash seed): the same rows, or
  // the program depends on something besides rng - set/dict order of strings (which also differs between this
  // WebAssembly Python and a native one), the clock, os/uuid randomness, numpy's default_rng() without a seed, SQL
  // random(). Such a program could not be rebuilt by the package's generate.py.
  async reproducible(k, code, firstDigests) {
    if (!this.rt2) return { ok: true };
    const seed = this.s.shownSeeds[0];
    let built;
    try {
      built = await this.rt2.call("build", { schema: this.state.schema, triggers: this.state.triggers, stages: this.stagesFor(k, code), seed },
        { code: this.allCode(k, code), timeoutMs: this.s.stageTimeoutMs });
    } catch (e) {
      return { ok: false, feedback: `Rebuilt on seed ${seed}, the program did not finish (${e.message}).` };
    }
    const rec = built.result.stages[k];
    if (!built.result.ok || !rec) {
      return { ok: false, feedback: `Rebuilt on seed ${seed} in a fresh Python, the program failed:\n${(built.result.stages.find((s) => !s.ok) || {}).error || "unknown error"}` };
    }
    const differ = Object.keys(firstDigests || {}).filter((t) => rec.table_digests[t] !== firstDigests[t]);
    if (!differ.length) return { ok: true };
    return { ok: false, feedback: `Built twice from seed ${seed}, the program gave different rows in ${differ.join(", ")}: its output depends on something ` +
      "besides rng - the iteration order of a set (or of a dict built from one) of strings, the clock, os/uuid randomness, numpy's default_rng() " +
      "without a seed, or SQL random(). Sort sets before iterating them and draw every random choice from rng." };
  }

  codePrompt(k, previous, feedback) {
    const s = this.state.stages[k];
    const rules = this.rulesOf(k);
    const later = this.laterRulesOf(k);
    const earlier = this.state.stages.slice(0, k).flatMap((x) => x.tables);
    return `Database description:\n${this.state.description}\n\nSchema (SQLite):\n${this.state.schema}\n\nTriggers:\n${this.state.triggers || "(none)"}\n\n` +
      `This is stage ${k + 1} of ${this.state.stages.length}. It writes: ${s.tables.join(", ")}. Already written by earlier stages (readable): ${earlier.join(", ") || "nothing"}.\n` +
      `Plan notes for this stage:\n${s.notes || "(none)"}\n\n` +
      (this.expectationsFor(s.tables).length ? `What real data of this kind shows, where this stage's tables are concerned (no check enforces these; make the rows show them while every rule holds):\n${this.expectationsFor(s.tables).join("\n")}\n\n` : "") +
      `Rules this stage must make hold on every seed (each with its exact check):\n${rules.map((r) => `### ${r.id}: ${r.statement}\n${r.code}`).join("\n\n") || "(no rule beyond the schema)"}\n\n` +
      (later.length ? `Rules checked at a later stage that also read this stage's tables. The later stage cannot change these rows, so this stage's rows must make each rule satisfiable (each with its exact check):\n${later.map((r) => `### ${r.id} [${r.tables.join(", ")}]: ${r.statement}\n${r.code}`).join("\n\n")}\n\n` : "") +
      (previous ? `Your previous program:\n\`\`\`python\n${previous}\n\`\`\`\n\nWhat went wrong:\n${feedback}\n\nFix the cause in the algorithm (do not special-case a seed). ` +
        "Answer with edits to the previous program, one block per change:\n<<<<<<< SEARCH\nexact lines of the previous program\n=======\ntheir replacement\n>>>>>>> REPLACE\n" +
        "Each SEARCH text must appear exactly once in the previous program. If the algorithm must change throughout, give the complete program in one ```python block instead." :
        "Write the program.");
  }

  async codeStage(k, revise = "") {
    const s = this.state.stages[k];
    const st = this.step("code", `Stage ${k + 1}: generator for ${s.tables.join(", ")}`);
    let repairsLeft = this.s.repairs;
    // a stage regenerated after a revision starts from its current program: kept as it is when it still passes -
    // unless a new rule checked later reads its tables (its own checks cannot see that rule, so passing them proves
    // nothing about it): then the coder reworks the program with that rule as the reason
    let previous = this.state.codes[k] || "";
    // problems: what the last evaluated program did wrong; note: what happened since (an answer that could not be used,
    // revised rules). The coder sees the newest note once, then the problems - the notes never pile up (live: answers
    // without a program stacked "Previous problems:" six deep)
    let problems = "";
    let note = "";
    const feedbackNow = () => (note && problems ? `${note}\n\nThe previous program's problems:\n${problems}` : note || problems);
    if (previous && revise) {
      problems = revise;
    } else if (previous) {
      const ev = await this.evaluate(k, previous, this.s.shownSeeds, false);
      const hid = ev.ok ? await this.evaluate(k, previous, this.hidden, true) : null;
      if (ev.ok && hid.ok) { st.done("the existing program still passes every rule"); return; }
      problems = ev.ok ? hid.feedback : ev.feedback;
    }
    for (;;) {
      let lastFails = [];
      let lastRaised = false;
      for (let attempt = 1; attempt <= this.s.codeAttempts; attempt++) {
        const feedback = feedbackNow();
        st.update(`attempt ${attempt}${feedback ? `\nlast problems:\n${clip(feedback, 900)}` : ""}`);
        let code;
        try {
          const answer = await this.ask(CODE_SYSTEM, this.codePrompt(k, previous, feedback), 32000);
          // a retry may answer with edits to the previous program; an edit that does not apply is fed back, and the
          // previous program stays the base for the next attempt
          const applied = previous ? applyAnswer(previous, answer) : { code: extractPython(answer) };
          if (applied.error) {
            note = /no Python code block/.test(applied.error)
              // an answer that only argues the rules cannot be met: the argument reaches the rule review only through a
              // program that raises it, so ask for one
              ? "Your answer held neither a program nor edits. Answer with a program. If you are sure a rule cannot be met, the program may raise an exception that states why: the rules are then reviewed."
              : `Your edits did not apply: ${applied.error}.`;
            continue;
          }
          code = applied.code;
        } catch (e) {
          if (e instanceof PipelineError) throw e;
          note = `${e.message}`;
          continue;
        }
        const ev = await this.evaluate(k, code, this.s.shownSeeds, false);
        if (ev.earlier) throw new PipelineError(`stage ${k + 1}: ${ev.feedback}`, this.state);
        let result = ev;
        if (ev.ok) {
          const hid = await this.evaluate(k, code, this.hidden, true);
          result = hid.ok ? ev : { ...hid, feedback: `It passed the shown seeds but not the unseen ones:\n${hid.feedback}` };
        }
        if (result.ok) {
          const rep = await this.reproducible(k, code, ev.first);
          if (!rep.ok) result = rep;
        }
        if (result.ok) {
          this.state.codes[k] = code;
          this.state.fixed[k] = result.fixed || {};
          const fixedNote = Object.keys(result.fixed || {}).length ? `; declared fixed: ${Object.keys(result.fixed).join(", ")}` : "";
          st.done(`passes every rule on ${this.s.shownSeeds.length} shown and ${this.hidden.length} unseen seeds (attempt ${attempt}, ${result.seconds}s${fixedNote})`);
          this.emit({ type: "code", stage: k, code });
          return;
        }
        previous = code;
        problems = result.feedback;
        note = "";
        lastFails = result.fails || [];
        lastRaised = Boolean(result.raised);
      }
      // a program that raised gets the repair step too: its message is often a correct diagnosis of a rule that is
      // infeasible or whose check measures the wrong thing (baseline 2026-10-22: 4 of 5 failed runs ended this way
      // without repair ever running)
      if (repairsLeft-- <= 0 || (!lastFails.length && !lastRaised)) {
        st.fail(`no program passed after ${this.s.codeAttempts} attempts:\n${clip(feedbackNow(), 1500)}`);
        throw new PipelineError(`stage ${k + 1} (${s.tables.join(", ")}) could not be generated: ${clip(feedbackNow(), 600)}`, this.state);
      }
      await this.repair(k, lastFails.length ? lastFails : this.namedRules(k, problems), problems);
      note = "The rules were revised after your attempts.";
    }
  }

  // the stage's rules a raised message names (as {rule} records for repair); every rule of the stage when it names none
  namedRules(k, feedback) {
    const rules = this.rulesOf(k);
    const named = rules.filter((r) => new RegExp(`\\b${r.id}\\b`).test(feedback));
    return (named.length ? named : rules).map((r) => ({ rule: r.id }));
  }

  async repair(k, fails, feedback) {
    const st = this.step("repair", `Stage ${k + 1}: reviewing rules the generator could not meet`);
    const ids = [...new Set(fails.map((f) => f.rule))];
    const rules = this.state.rules.filter((r) => ids.includes(r.id));
    // the triggers too: a generator's diagnosis often names one (live: without them repair twice kept a rule a trigger
    // made impossible, "no such trigger is shown")
    const user = `Description:\n${this.state.description}\n\nSchema:\n${this.state.schema}\n\nTriggers:\n${this.state.triggers || "(none)"}\n\n` +
      `Failing rules (with checks):\n${rules.map((r) => `### ${r.id}: ${r.statement}\n${r.code}`).join("\n\n")}\n\n` +
      `All rules of this stage:\n${this.rulesOf(k).map((r) => `- ${r.id}: ${r.statement}`).join("\n")}\n\nThe generator's last failures:\n${clip(feedback, 3000)}`;
    let answer;
    try { answer = extractJson(await this.ask(REPAIR_SYSTEM, user, 16000)); } catch (e) {
      if (e instanceof PipelineError) throw e;
      st.info(`no usable repair (${e.message}); retrying the stage as it is`);
      return;
    }
    const edits = (Array.isArray(answer.rules) ? answer.rules : []).filter((r) => isObj(r) && r.op === "edit" && ids.includes(r.id) && String(r.code || "").includes(`def verify_${r.id}(`));
    if (!edits.length) { st.info(`rules kept as they are: ${answer.reason || ""}`); return; }
    const tablesOf = (e, r) => (strList(e.tables).length ? strList(e.tables) : r.tables);
    const next = this.state.rules.map((r) => {
      const e = edits.find((x) => x.id === r.id);
      return e ? { ...r, statement: String(e.statement || r.statement), tables: tablesOf(e, r), code: String(e.code), origin: `${r.origin}; loosened at stage ${k + 1}` } : r;
    });
    const res = (await this.rt.call("check_spec", { schema: this.state.schema, triggers: this.state.triggers, verifiers: assembleVerifiers(next), rule_codes: ruleCodes(next) })).result;
    const badTables = next.filter((r) => edits.some((e) => e.id === r.id) && ruleStage(r, this.state.stages) < 0);
    if (!res.ok || badTables.length) { st.info(`the repair was invalid (${[...res.problems, ...badTables.map((b) => `${b.id}: unknown tables`)].slice(0, 3).join("; ")}); rules kept`); return; }
    this.state.rules = next;
    st.done(`revised ${edits.map((e) => e.id).join(", ")}: ${answer.reason || ""}`);
    this.emit({ type: "spec", schema: this.state.schema, triggers: this.state.triggers, rules: this.state.rules });
  }

  // -- the hidden-seed databases ----------------------------------------------------------------------------------

  async buildHidden() {
    const out = {};
    for (const seed of this.hidden) {
      const stages = this.state.stages.map((s, i) => ({ index: i, tables: s.tables, code: this.state.codes[i] }));
      const built = await this.rt.call("build", { schema: this.state.schema, triggers: this.state.triggers, stages, seed },
        { wantDb: true, code: this.state.codes.join("\n"), timeoutMs: this.s.stageTimeoutMs * stages.length });
      if (!built.result.ok) throw new PipelineError(`the final build failed on an unseen seed: ${JSON.stringify(built.result.stages.find((s) => !s.ok))}`, this.state);
      out[seed] = built.db;
    }
    return out;
  }

  // -- audit ------------------------------------------------------------------------------------------------------

  async audit(round) {
    const st = this.step("audit", `Audit round ${round}: looking for what gives the data away as generated`);
    const dbs = await this.buildHidden();
    const pairs = Object.entries(dbs).map(([s, d]) => [Number(s), d]);
    const profiles = {};
    for (const [seed, db] of pairs) profiles[seed] = (await this.rt.call("profile", {}, { db })).result;
    const same = (await this.rt.call("same_across", { profiles })).result;
    const seedNames = pairs.map(([s]) => s);
    const fixedDecl = this.state.fixed.flatMap((f) => Object.entries(f).map(([t, why]) => `${t}: ${why}`));
    let user = `Description:\n${this.state.description}\n\nResearch notes:\n${this.state.research?.text || "(none)"}\n\nSchema:\n${this.state.schema}\n\n` +
      `Triggers:\n${this.state.triggers || "(none)"}\n\nRules the data already satisfies:\n${this.state.rules.map((r) => `- ${r.id} [${r.tables.join(", ")}]: ${r.statement}`).join("\n")}\n\n` +
      (this.state.expectations?.length ? `What a domain expert expects of real data of this kind (check these first):\n${this.state.expectations.map((e) => `- [${e.tables.join(", ")}] ${e.property}`).join("\n")}\n\n` : "") +
      `Tables the generator declared fixed: ${fixedDecl.join("; ") || "none"}\n\nThe two databases are seeds ${seedNames.join(" and ")}. Profiles:\n` +
      clip(JSON.stringify(profiles), 14000) + `\n\nStatistics identical on both databases: ${same.join("; ") || "none"}`;
    const history = [];
    let flaws = null;
    for (let turn = 1; turn <= this.s.auditTurns + 1 && !flaws; turn++) {
      const last = turn > this.s.auditTurns;
      const prompt = last ? `${user}\n\nNo more tool calls: report now.` : user;
      const answer = await this.ask(AUDIT_SYSTEM, prompt, 16000, history);
      history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
      let act;
      try { act = extractJson(answer); } catch (e) { user = `That was not a JSON action (${e.message}). Answer with one JSON object.`; continue; }
      if (act.action === "report") { flaws = (Array.isArray(act.flaws) ? act.flaws : []).filter(isObj); break; }
      if (act.action === "query") {
        const seed = seedNames.includes(Number(act.seed)) ? Number(act.seed) : seedNames[0];
        const q = (await this.rt.call("query", { sql: String(act.sql || "") }, { db: dbs[seed] })).result;
        user = `Result (seed ${seed}):\n${clip(JSON.stringify(q), 4000)}`;
        st.update(`turn ${turn}: query on seed ${seed}`);
      } else if (act.action === "analyze") {
        let a;
        try { a = (await this.rt.call("analyze", { code: String(act.code || "") }, { dbs: pairs, timeoutMs: 60000 })).result; } catch (e) { a = { ok: false, error: e.message }; }
        user = `Result:\n${clip(JSON.stringify(a), 4000)}`;
        st.update(`turn ${turn}: analysis`);
      } else {
        user = 'Unknown action. Use "query", "analyze" or "report".';
      }
    }
    if (!flaws) {
      // the auditor used every turn without a report: that is not a clean round, and nothing was found to apply
      this.state.rounds.push({ round, flaws: [], accepted: [], rejected: [], incomplete: true });
      st.info(`the auditor gave no report in ${this.s.auditTurns + 1} turns; the audit stops here (the data was not certified clean)`);
      return false;
    }
    const serious = (f) => f.severity === "high" || f.severity === "medium";
    const checked = [];
    const verdictOf = async (f, note = "") => {
      const v = await this.checkFinding(f, dbs);
      return v.ok ? { ...f, rule: v.rule, reason: v.reason + note, ok: true } : { ...f, reason: v.reason + note, ok: false };
    };
    for (const f of flaws) checked.push(await verdictOf(f));
    // a serious finding whose rule was rejected gets one correction: the reasons go back to the auditor, which sends
    // a fixed rule or drops the finding (live run 2026-10-20: a real flaw was lost to a rule that raised on an empty
    // database, and the audit then stopped as if no serious flaw were left)
    const fixable = checked.filter((f) => !f.ok && f.rule && serious(f));
    if (fixable.length) {
      const prompt = `Some findings were rejected by the checks:\n${fixable.map((f) => `- ${f.id}: ${f.reason}`).join("\n")}\n\n` +
        "For each: if the flaw is real, send it again with a corrected rule (it must run on an empty database without raising, " +
        "define only its own verify_<id> plus helpers with rule-specific names, and FAIL on the current data); if the check " +
        'showed that the data does not have the flaw, leave it out. Answer with {"action": "report", "flaws": [...]} holding only the corrected findings.';
      let again = [];
      try {
        const answer = await this.ask(AUDIT_SYSTEM, prompt, 16000, history);
        history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
        const act = extractJson(answer);
        again = (Array.isArray(act.flaws) ? act.flaws : []).filter(isObj);
      } catch (e) {
        if (e instanceof PipelineError) throw e;
      }
      for (const g of again) {
        const i = checked.findIndex((f) => !f.ok && f.id === g.id);
        if (i >= 0) checked[i] = await verdictOf({ ...g, severity: checked[i].severity }, ` (after a correction; first: ${checked[i].reason})`);
      }
    }
    const accepted = checked.filter((f) => f.ok);
    const rejected = checked.filter((f) => !f.ok);
    const withRule = accepted.filter((f) => f.rule);
    const adopt = withRule.some(serious) ? withRule : [];
    // what happened to each finding, as the Audit tab and report.json show it
    const outcome = (f) => {
      if (!f.ok) return `rejected: ${f.reason}`;
      if (!f.rule) return "recorded (no rule proposed)";
      return adopt.includes(f) ? `rule ${f.rule.id} ${f.rule.op === "edit" ? "edited" : "added"}` : "rule not adopted (low severity only; no regeneration this round)";
    };
    const findings = checked.map((f) => ({ ...f, outcome: outcome(f) }));
    this.state.rounds.push({ round, flaws: findings, accepted: adopt.map((f) => f.id), rejected: rejected.map((f) => ({ id: f.id, reason: f.reason })) });
    this.state.rejected.push(...rejected.map((f) => ({ round, id: f.id, reason: f.reason })));
    const summary = `${flaws.length} flaws (${flaws.filter(serious).length} high/medium); ${adopt.length} rules adopted, ${rejected.length} findings rejected`;
    this.emit({ type: "audit", round, flaws: findings, accepted, rejected });
    if (!adopt.length) {
      st.done(`${summary} - ${flaws.some(serious) ? "no serious flaw could be turned into a valid rule" : "no serious flaw found"}: done`);
      return false;
    }
    // apply the adopted rules (low ones too: the stages are regenerated anyway); regenerate from the earliest stage
    // one of them touches. The last round's rules are applied as well, so the shipped data meets every rule.
    const rules = [...this.state.rules];
    for (const f of adopt) {
      const { op, ...rule } = f.rule;
      const r = { ...rule, origin: `audit round ${round} (${f.severity}: ${f.title || f.id}${op === "edit" ? ", edited" : ""})` };
      const i = rules.findIndex((x) => x.id === r.id);
      if (i >= 0) rules[i] = r; else rules.push(r);
    }
    this.state.rules = rules;
    // regenerate from the earliest stage an adopted rule reads, not the stage that checks it; every earlier stage it
    // reads reworks its program for it (see firstRuleStage)
    const revise = {};
    for (const f of adopt) {
      const at = ruleStage(f.rule, this.state.stages);
      for (const t of f.rule.tables) {
        const i = this.state.stages.findIndex((x) => x.tables.includes(t));
        if (i >= 0 && i < at) (revise[i] ||= []).push(f.rule);
      }
    }
    const first = Math.min(...adopt.map((f) => firstRuleStage(f.rule, this.state.stages)));
    const reasons = Object.fromEntries(Object.entries(revise).map(([i, rs]) => [i,
      `A new rule checked at a later stage reads this stage's tables, and the later stage cannot change these rows. Rework the program so its rows make it satisfiable:\n${rs.map((r) => `- ${r.id} [${r.tables.join(", ")}]: ${r.statement}`).join("\n")}`]));
    st.done(`${summary}; regenerating from stage ${first + 1}`);
    this.emit({ type: "spec", schema: this.state.schema, triggers: this.state.triggers, rules: this.state.rules });
    await this.codeFrom(first, reasons);
    return round < this.s.auditRounds;
  }

  // a finding's proposed rule must be well formed, must not clash with the other rules, and must FAIL on at least one
  // database: a rule the data already meets does not describe a flaw of it. Returns the cleaned rule.
  async checkFinding(f, dbs) {
    if (!isObj(f) || !ID.test(String(f.id || ""))) return { ok: false, reason: "malformed finding" };
    if (!f.rule) return { ok: true, rule: null, reason: "no rule proposed (recorded only)" };
    const r = f.rule;
    if (!isObj(r)) return { ok: false, reason: "the rule must be an object with op, id, statement, tables and code" };
    const id = String(r.id || "");
    if (!ID.test(id) || !String(r.code || "").includes(`def verify_${id}(`)) return { ok: false, reason: `the rule must define verify_${id}(db)` };
    const tables = strList(r.tables);
    if (!tables.length || ruleStage({ tables }, this.state.stages) < 0) return { ok: false, reason: `unknown or missing tables ${tables.join(", ")}` };
    const op = r.op === "edit" ? "edit" : "add";
    if (op === "edit" && !this.state.rules.some((x) => x.id === id)) return { ok: false, reason: `edit of a rule that does not exist (${id})` };
    if (op === "add" && this.state.rules.some((x) => x.id === id)) return { ok: false, reason: `a rule ${id} exists already (use edit)` };
    const rule = { op, id, statement: String(r.statement || id), tables, code: String(r.code) };
    const all = [...this.state.rules.filter((x) => x.id !== id), rule];
    const spec = (await this.rt.call("check_spec", { schema: this.state.schema, triggers: this.state.triggers, verifiers: assembleVerifiers([rule]), rule_codes: ruleCodes(all) })).result;
    if (!spec.ok) return { ok: false, reason: spec.problems.slice(0, 2).join("; ") };
    let fails = 0;
    for (const db of Object.values(dbs)) {
      const v = (await this.rt.call("verify", { verifiers: assembleVerifiers([rule]), rule_ids: [id] }, { db })).result;
      if (!v[id]?.passed) fails++;
    }
    if (!fails) return { ok: false, reason: "the rule passes on both databases: it does not describe a flaw of this data" };
    return { ok: true, rule, reason: `fails on ${fails} of ${Object.keys(dbs).length} databases` };
  }

  // -- final verification -----------------------------------------------------------------------------------------

  async finalVerification() {
    const st = this.step("verify", "Building the final databases and verifying every rule");
    const dbs = await this.buildHidden();
    const verifiers = assembleVerifiers(this.state.rules);
    const report = {};
    for (const [seed, db] of Object.entries(dbs)) report[seed] = (await this.rt.call("verify", { verifiers }, { db })).result;
    const failing = Object.entries(report).flatMap(([seed, v]) => Object.entries(v).filter(([, x]) => !x.passed).map(([id]) => `${id} (seed ${seed})`));
    this.state.verification = report;
    this.state.databases = dbs;
    if (failing.length) {
      st.fail(`rules failing on the final databases: ${failing.join(", ")}`);
      throw new PipelineError(`the final databases break rules: ${failing.join(", ")}`, this.state);
    }
    const n = Object.keys(report[this.hidden[0]]).length - 1;
    st.done(`${n} rules and the integrity checks pass on both final databases`);
  }
}
