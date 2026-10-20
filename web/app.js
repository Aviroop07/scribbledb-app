// The page: settings, the run, the live timeline, the result tabs and the downloads.
import { createLLM, PROVIDERS } from "./core/llm.js";
import { Pipeline, PipelineError, assembleVerifiers } from "./core/pipeline.js";
import { PyRuntime } from "./core/runtime.js";
import { packageZip } from "./core/package.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };

const EXAMPLES = {
  "Public library": "A small public library over one year: about 2,000 books in several genres with authors and publication years, 300-500 members who joined over the past decade, and 5,000-9,000 loans. Loans last 7-28 days, a few are returned late, popular genres and new books are borrowed more, members borrow at very different rates, and borrowing dips in summer.",
  "Bike sharing": "A city bike-sharing service over one month: 40-60 stations with capacities of 10-40 docks, 400-600 bikes, and 15,000-30,000 trips. Trips are mostly 5-30 minutes, peak on weekday mornings and evenings, start and end at different stations mostly, and a few stations are much busier than others.",
  "Online shop": "A small online shop over six months: 150-300 products in categories with prices, 1,000-2,000 customers, 3,000-6,000 orders with one to five order lines each. Most customers order once or twice, a few order often; cheap products sell more units; orders peak in the last weeks.",
};

// -- settings ---------------------------------------------------------------------------------------------------

for (const [id, p] of Object.entries(PROVIDERS)) $("provider").append(new Option(p.label, id));
function syncProvider() {
  const p = $("provider").value;
  $("baseUrlRow").hidden = p !== "compatible";
  $("model").placeholder = `e.g. ${PROVIDERS[p].modelHint}`;
}
$("provider").value = store.get("sdb.provider") || "openai";
$("model").value = store.get("sdb.model") || "";
$("baseUrl").value = store.get("sdb.baseUrl") || "";
$("effort").value = store.get("sdb.effort") || "medium";
const savedKey = store.get("sdb.key");
if (savedKey) { $("apiKey").value = savedKey; $("remember").checked = true; }
$("provider").addEventListener("change", syncProvider);
syncProvider();
for (const [name, text] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => { $("description").value = text; };
  $("examples").append(b);
}
$("description").value = store.get("sdb.description") || "";

// -- the runtime ------------------------------------------------------------------------------------------------

// hashSeed: the worker's PYTHONHASHSEED; the second runtime (another seed) rebuilds each stage to prove it reproducible
function browserRuntime(hashSeed) {
  return new PyRuntime(() => {
    const w = new Worker(new URL(`./worker.js?hashseed=${hashSeed}`, import.meta.url), { type: "module" });
    return {
      post: (msg) => w.postMessage(msg),
      onMessage: (cb) => { w.onmessage = (e) => cb(e.data); w.onerror = (e) => cb({ type: "fatal", error: e.message || "the worker failed to start" }); },
      terminate: () => w.terminate(),
    };
  });
}

// -- the timeline -----------------------------------------------------------------------------------------------

const STATUS = { running: "running", done: "done", failed: "failed", info: "note" };
const items = new Map();
function onStep(e) {
  let li = items.get(e.id);
  if (!li) {
    li = document.createElement("li");
    items.set(e.id, li);
    $("timeline").append(li);
  }
  li.className = e.status;
  const secs = e.end ? ` · ${((e.end - e.at) / 1000).toFixed(1)} s` : "";
  li.innerHTML = `<span class="phase">${esc(e.phase)}</span> ${esc(e.title)} <span class="status">${STATUS[e.status] || e.status}${secs}</span>` +
    (e.detail ? `<details${e.status === "failed" ? " open" : ""}><summary class="muted">details</summary><pre>${esc(e.detail)}</pre></details>` : "");
  li.scrollIntoView({ block: "nearest" });
}

// -- results ----------------------------------------------------------------------------------------------------

let current = null;
const TABS = {
  Specification: (s) => `<h3>Schema</h3><pre>${esc(s.schema)}</pre><h3>Triggers</h3><pre>${esc(s.triggers || "(none)")}</pre>` +
    `<h3>Rules</h3><table><tr><th>id</th><th>statement</th><th>origin</th></tr>${s.rules.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.statement)}</td><td>${esc(r.origin)}</td></tr>`).join("")}</table>` +
    `<details><summary>verifiers.py</summary><pre>${esc(assembleVerifiers(s.rules))}</pre></details>`,
  Plan: (s) => `<ol>${s.stages.map((st) => `<li><b>${esc(st.tables.join(", "))}</b><br><span class="muted">${esc(st.notes)}</span></li>`).join("")}</ol>`,
  Generator: (s) => s.stages.map((st, i) => `<details${i === 0 ? " open" : ""}><summary>Stage ${i + 1}: ${esc(st.tables.join(", "))}</summary><pre>${esc(s.codes[i] || "(not generated)")}</pre></details>`).join(""),
  Audit: (s) => s.rounds.length ? s.rounds.map((r) => `<h3>Round ${r.round}</h3>` + (r.flaws.length ?
    `<table><tr><th>flaw</th><th>severity</th><th>evidence</th><th>outcome</th></tr>${r.flaws.map((f) =>
      `<tr><td>${esc(f.title || f.id)}</td><td>${esc(f.severity)}</td><td>${esc(f.evidence)}</td><td>${esc(f.outcome)}</td></tr>`).join("")}</table>` :
      r.incomplete ? "<p>The auditor gave no report; the audit stopped (the data was not certified clean).</p>" : "<p>No flaw found.</p>")).join("") : "<p>No audit round ran.</p>",
  Verification: (s) => {
    const seeds = Object.keys(s.verification);
    if (!seeds.length) return "<p>Not verified yet.</p>";
    const ids = Object.keys(s.verification[seeds[0]]);
    return `<table><tr><th>rule</th>${seeds.map((x) => `<th>database ${esc(x)}</th>`).join("")}</tr>${ids.map((id) => `<tr><td>${esc(id === "__integrity__" ? "integrity" : id)}</td>${seeds.map((x) => {
      const v = s.verification[x][id];
      return `<td class="${v.passed ? "ok" : "bad"}">${v.passed ? "pass" : "FAIL"} <span class="muted">${esc(v.detail)}</span></td>`;
    }).join("")}</tr>`).join("")}</table>`;
  },
  Research: (s) => `<p class="muted">${esc(s.research?.source || "")}</p><pre>${esc(s.research?.text || "(none)")}</pre>`,
};
let activeTab = "Specification";
function renderResult() {
  if (!current) return;
  $("resultCard").hidden = false;
  $("tabs").innerHTML = "";
  for (const name of Object.keys(TABS)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.className = name === activeTab ? "active" : "";
    b.onclick = () => { activeTab = name; renderResult(); };
    $("tabs").append(b);
  }
  $("tabBody").innerHTML = TABS[activeTab](current);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// -- the run ----------------------------------------------------------------------------------------------------

let controller = null;
let runtime = null;
let checkRuntime = null;
$("run").onclick = async () => {
  $("error").hidden = true;
  const provider = $("provider").value;
  const settings = { provider, model: $("model").value.trim(), apiKey: $("apiKey").value.trim(), baseUrl: $("baseUrl").value.trim(), effort: $("effort").value };
  const description = $("description").value.trim();
  store.set("sdb.provider", provider); store.set("sdb.model", settings.model); store.set("sdb.baseUrl", settings.baseUrl);
  store.set("sdb.effort", settings.effort); store.set("sdb.description", description);
  store.set("sdb.key", $("remember").checked ? settings.apiKey : null);
  let llm;
  try {
    llm = createLLM({ ...settings, log: (e) => onStep({ id: `f${Date.now()}${Math.random()}`, phase: "fallback", title: e.what, status: "info" }) });
  } catch (e) {
    $("error").textContent = e.message; $("error").hidden = false; return;
  }
  if (description.length < 20) { $("error").textContent = "Describe the database in a few sentences first."; $("error").hidden = false; return; }
  controller = new AbortController();
  runtime = runtime || browserRuntime(0);
  checkRuntime = checkRuntime || browserRuntime(1);
  items.clear(); $("timeline").innerHTML = ""; $("timelineCard").hidden = false;
  current = null; $("resultCard").hidden = true; $("dlZip").disabled = true; $("dlDb").disabled = true;
  $("run").disabled = true; $("stop").hidden = false;
  const pipe = new Pipeline({
    llm, runtime, checkRuntime, signal: controller.signal, runId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    settings: { auditRounds: Number($("rounds").value), maxCalls: Number($("maxCalls").value) },
    emit: (e) => {
      if (e.type === "step") onStep(e);
      if (e.type === "usage") $("usage").textContent = `${e.usage.calls} model calls · ${e.usage.input.toLocaleString()} in / ${e.usage.output.toLocaleString()} out tokens`;
      if (["spec", "plan", "code", "audit"].includes(e.type)) { current = pipe.state; renderResult(); }
    },
  });
  const boot = { id: "boot", phase: "setup", title: "Starting the in-browser Python runtime (first time: ~10 MB download)", status: "running", at: Date.now() };
  onStep(boot);
  try {
    const warm = { schema: "CREATE TABLE t (x INTEGER);", triggers: "", verifiers: "def verify_t(db):\n    return {'passed': True, 'detail': ''}\n" };
    await Promise.all([runtime.call("check_spec", warm, { timeoutMs: 180000 }), checkRuntime.call("check_spec", warm, { timeoutMs: 180000 })]);
    onStep({ ...boot, status: "done", end: Date.now() });
    const state = await pipe.run(description);
    current = state;
    renderResult();
    $("dlZip").disabled = false; $("dlDb").disabled = false;
  } catch (e) {
    if (boot.status === "running" && !items.get("boot").className.includes("done")) onStep({ ...boot, status: "failed", detail: String(e.message), end: Date.now() });
    $("error").textContent = e instanceof PipelineError ? `Stopped: ${e.message}` : `Error: ${e.message}`;
    $("error").hidden = false;
    if (pipe.state.schema) { current = pipe.state; renderResult(); $("dlZip").disabled = false; }
  } finally {
    $("run").disabled = false; $("stop").hidden = true;
  }
};
$("stop").onclick = () => {
  if (controller) controller.abort();
  for (const rt of [runtime, checkRuntime]) if (rt) rt.close();
  runtime = null; checkRuntime = null;
};
$("dlZip").onclick = async () => {
  const zip = await packageZip(window.JSZip, current, { provider: $("provider").value, model: $("model").value });
  download(await zip.generateAsync({ type: "blob" }), "scribbledb-package.zip");
};
$("dlDb").onclick = () => {
  const seeds = Object.keys(current.databases);
  if (seeds.length) download(new Blob([current.databases[seeds[0]]], { type: "application/vnd.sqlite3" }), "database.sqlite");
};

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
