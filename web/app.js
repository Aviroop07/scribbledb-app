// The page: settings, the run, the live timeline, the result tabs and the downloads.
import { createLLM, PROVIDERS } from "./core/llm.js";
import { Pipeline, PipelineError, assembleVerifiers } from "./core/pipeline.js";
import { PyRuntime } from "./core/runtime.js";
import { packageZip } from "./core/package.js";
import { erDiagram } from "./core/er.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };

const EXAMPLES = {
  "Public library": "A small public library over one year: about 2,000 books in several genres with authors and publication years, 300-500 members who joined over the past decade, and 5,000-9,000 loans. Loans last 7-28 days, a few are returned late, popular genres and new books are borrowed more, members borrow at very different rates, and borrowing dips in summer.",
  "Bike sharing": "A city bike-sharing service over one month: 40-60 stations with capacities of 10-40 docks, 400-600 bikes, and 15,000-30,000 trips. Trips are mostly 5-30 minutes, peak on weekday mornings and evenings, start and end at different stations mostly, and a few stations are much busier than others.",
  "Online shop": "A small online shop over six months: 150-300 products in categories with prices, 1,000-2,000 customers, 3,000-6,000 orders with one to five order lines each. Most customers order once or twice, a few order often; cheap products sell more units; orders peak in the last weeks.",
};

// -- local mode -------------------------------------------------------------------------------------------------
// Served by node/local.mjs, the page finds /local-config.json: the provider, model and limits are set on the machine,
// the key stays there (calls go through its /proxy/), and the Model card is hidden. On the published site the file
// does not exist and the page is the normal one.
let local = null;
try {
  const r = await fetch(new URL("local-config.json", location.href), { cache: "no-store" });
  if (r.ok) local = await r.json();
} catch { /* not local */ }
if (local) {
  $("settings").hidden = true;
  $("tagline").textContent = $("tagline").textContent.replace("with your own model key", "with the model set up on this machine");
  $("localNote").hidden = false;
  $("localNote").textContent = `Local mode: ${local.provider} / ${local.model}, reasoning ${local.effort}, ${local.auditRounds} audit rounds, ` +
    `up to ${local.maxCalls} model calls. The key is held by the local server.`;
}

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

// A small, safe Markdown subset for model prose (research notes): the text is escaped first, then **bold**, `code`,
// [links](http...), "- " lists, "#" headings and paragraphs are rendered. Nothing from the model becomes raw HTML.
function md(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) { (list ||= []).push(`<li>${inline(item[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) out.push(`<h4>${inline(head[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

// The timeline. Each step's element is built once and then updated in place: rebuilding it on every progress update
// closed a "details" the user had opened. The page follows new steps only while the user is at the bottom of it.
const STATUS = { running: "running", done: "done", failed: "failed", info: "note" };
const items = new Map();
const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
function onStep(e) {
  const follow = atBottom();
  let it = items.get(e.id);
  if (!it) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="phase"></span><div class="body"><div class="head"><span class="title"></span> <span class="status"></span></div>` +
      `<details class="detail" hidden><summary>details</summary><div class="content"></div></details></div>`;
    $("timeline").append(li);
    it = { li, detail: null };
    items.set(e.id, it);
  }
  const { li } = it;
  li.className = e.status;
  li.querySelector(".phase").textContent = e.phase;
  li.querySelector(".title").textContent = e.title;
  const secs = e.end ? ` · ${((e.end - e.at) / 1000).toFixed(1)} s` : "";
  li.querySelector(".status").textContent = `${STATUS[e.status] || e.status}${secs}`;
  const details = li.querySelector("details");
  if (e.detail && e.detail !== it.detail) {
    const content = li.querySelector(".content");
    if (e.phase === "research") {
      // "<source>\n\n<notes>": the source as a line, the notes as formatted prose
      const [source, ...rest] = String(e.detail).split("\n\n");
      content.innerHTML = `<p class="muted">${esc(source)}</p><div class="md">${md(rest.join("\n\n"))}</div>`;
    } else {
      content.innerHTML = `<pre>${esc(e.detail)}</pre>`;
    }
    it.detail = e.detail;
    details.hidden = false;
    if (e.status === "failed") details.open = true;
  }
  if (follow) li.scrollIntoView({ block: "nearest" });
}

// -- results ----------------------------------------------------------------------------------------------------

let current = null;
const code = (text, key) => `<div class="codebox"><button class="copy" data-copy>Copy</button><pre data-key="${esc(key)}">${esc(text)}</pre></div>`;
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
const scroll = (html) => `<div class="scroll">${html}</div>`;
const lines = (s) => String(s || "").trim().split("\n").length;
let schemaView = "sql"; // the schema as SQL or as an ER diagram

const TABS = {
  Specification: (s) =>
    `<div class="sectionhead"><h3>Schema</h3><div class="seg" role="group" aria-label="Schema view">` +
    `<button data-schema="sql" class="${schemaView === "sql" ? "active" : ""}">SQL</button>` +
    `<button data-schema="er" class="${schemaView === "er" ? "active" : ""}">ER diagram</button></div></div>` +
    (schemaView === "sql" ? code(s.schema, "schema") :
      // the cached drawing goes in directly, so the re-render on every pipeline event does not flash the placeholder
      `<div class="er" id="erBox">${erCache.src && erCache.src === erDiagram(s.tables || []) ? erCache.svg : '<p class="muted">Drawing the diagram...</p>'}</div>` +
      '<div class="actions"><button id="erSvg" disabled>Download SVG</button></div>') +
    `<h3>Triggers</h3>${s.triggers ? code(s.triggers, "triggers") : '<p class="muted">None.</p>'}` +
    `<h3>Rules <span class="muted">(${s.rules.length})</span></h3>` +
    scroll(`<table class="rules"><tr><th>rule</th><th>statement</th><th>origin</th></tr>${s.rules.map((r) =>
      `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.statement)}<details class="detail" data-key="rule:${esc(r.id)}"><summary>check</summary><div class="content"><pre>${esc(r.code)}</pre></div></details></td>` +
      `<td class="muted">${esc(r.origin)}</td></tr>`).join("")}</table>`) +
    `<details class="detail" data-key="verifiers"><summary>verifiers.py (all rules as one file)</summary><div class="content">${code(assembleVerifiers(s.rules), "verifiers")}</div></details>`,
  Plan: (s) => s.stages.map((st, i) =>
    `<div class="stage"><div><span class="muted">Stage ${i + 1}</span> ${st.tables.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` +
    (st.notes ? `<p class="note">${esc(st.notes)}</p>` : "") + "</div>").join(""),
  Generator: (s) => s.stages.map((st, i) =>
    `<details class="detail stagecode" data-key="stage:${i}"${i === 0 ? " open" : ""}><summary>Stage ${i + 1}: ${st.tables.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}` +
    `<span class="muted">${s.codes[i] ? `${lines(s.codes[i])} lines` : "not generated"}</span></summary>` +
    `<div class="content">${s.codes[i] ? code(s.codes[i], `code:${i}`) : '<p class="muted">Not generated.</p>'}</div></details>`).join(""),
  Audit: (s) => s.rounds.length ? s.rounds.map((r) => {
    const head = `<h3>Round ${r.round} <span class="muted">${r.incomplete ? "incomplete" : `${r.flaws.length} finding${r.flaws.length === 1 ? "" : "s"}, ${r.accepted.length} rule${r.accepted.length === 1 ? "" : "s"} adopted`}</span></h3>`;
    if (r.incomplete) return head + '<p class="note">The auditor gave no report; the audit stopped (the data was not certified clean).</p>';
    if (!r.flaws.length) return head + '<p class="note">No flaw found.</p>';
    return head + scroll(`<table class="audit"><tr><th>finding</th><th>severity</th><th>evidence</th><th>outcome</th></tr>${r.flaws.map((f) =>
      `<tr><td>${esc(f.title || f.id)}</td><td>${pill(String(f.severity || "").toLowerCase(), f.severity || "?")}</td><td class="muted">${esc(f.evidence)}</td>` +
      `<td>${esc(f.outcome)}</td></tr>`).join("")}</table>`);
  }).join("") : '<p class="note">No audit round ran.</p>',
  Verification: (s) => {
    const seeds = Object.keys(s.verification);
    if (!seeds.length) return '<p class="note">Not verified yet.</p>';
    const ids = Object.keys(s.verification[seeds[0]]);
    const failed = ids.filter((id) => seeds.some((x) => !s.verification[x][id]?.passed)).length;
    return `<p class="note">${failed ? `${failed} of ${ids.length} checks fail` : `All ${ids.length} checks pass`} on ${seeds.length} database${seeds.length === 1 ? "" : "s"}.</p>` +
      scroll(`<table class="verify"><tr><th>rule</th>${seeds.map((x, i) => `<th>${i === 0 ? "database.sqlite" : `database_seed_${esc(x)}.sqlite`}</th>`).join("")}</tr>${ids.map((id) =>
        `<tr><td><code>${esc(id === "__integrity__" ? "integrity" : id)}</code></td>${seeds.map((x) => {
          const v = s.verification[x][id];
          return `<td>${pill(v.passed ? "ok" : "bad", v.passed ? "pass" : "fail")}<div class="muted">${esc(v.detail)}</div></td>`;
        }).join("")}</tr>`).join("")}</table>`);
  },
  Research: (s) => `<p class="muted">${esc(s.research?.source || "")}</p><div class="md">${md(s.research?.text || "(none)")}</div>`,
};
let activeTab = "Specification";
// Re-rendering (it happens on every pipeline event) keeps what the user opened and where they had scrolled code to.
function renderResult() {
  if (!current) return;
  $("resultCard").hidden = false;
  const body = $("tabBody");
  const open = new Set([...body.querySelectorAll("details[data-key]")].filter((d) => d.open).map((d) => d.dataset.key));
  const closed = new Set([...body.querySelectorAll("details[data-key]")].filter((d) => !d.open).map((d) => d.dataset.key));
  const scrolled = Object.fromEntries([...body.querySelectorAll("pre[data-key]")].map((p) => [p.dataset.key, p.scrollTop]));
  $("tabs").innerHTML = "";
  for (const name of Object.keys(TABS)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.className = name === activeTab ? "active" : "";
    b.onclick = () => { activeTab = name; $("tabBody").innerHTML = ""; renderResult(); };
    $("tabs").append(b);
  }
  body.innerHTML = TABS[activeTab](current);
  for (const d of body.querySelectorAll("details[data-key]")) {
    if (open.has(d.dataset.key)) d.open = true;
    else if (closed.has(d.dataset.key)) d.open = false;
  }
  for (const p of body.querySelectorAll("pre[data-key]")) if (scrolled[p.dataset.key]) p.scrollTop = scrolled[p.dataset.key];
  if (activeTab === "Specification" && schemaView === "er") drawEr();
}

// copy buttons and the schema view switch (delegated: the tab body is re-rendered)
$("tabBody").addEventListener("click", async (ev) => {
  const copy = ev.target.closest("[data-copy]");
  if (copy) {
    const text = copy.parentElement.querySelector("pre").textContent;
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
    setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    return;
  }
  const view = ev.target.closest("[data-schema]");
  if (view && view.dataset.schema !== schemaView) { schemaView = view.dataset.schema; renderResult(); }
});

// -- the ER diagram ---------------------------------------------------------------------------------------------
// Mermaid (a pinned version from the CDN) is loaded the first time the diagram is shown. The SVG of the current
// schema is kept, so re-renders do not redraw it and the zip can include it.
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
let mermaidReady = null;
let erCache = { src: "", svg: "" };
let erSeq = 0;
const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
async function erSvg(tables) {
  const src = erDiagram(tables);
  if (erCache.src === src) return erCache.svg;
  mermaidReady ||= import(MERMAID).then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "neutral", er: { useMaxWidth: true } });
    return m;
  });
  const m = await mermaidReady;
  const { svg } = await m.render(`er${++erSeq}`, src);
  erCache = { src, svg };
  return svg;
}
async function drawEr() {
  const box = $("erBox");
  if (!box || !current?.tables?.length) return;
  try {
    const svg = await erSvg(current.tables);
    if (!$("erBox")) return; // the view changed meanwhile
    $("erBox").innerHTML = svg;
    $("erSvg").disabled = false;
    $("erSvg").onclick = () => download(new Blob([svg], { type: "image/svg+xml" }), "er_diagram.svg");
  } catch (e) {
    if ($("erBox")) $("erBox").innerHTML = `<p class="error">The diagram could not be drawn (${esc(e.message)}). The SQL view has the full schema.</p>`;
  }
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
  const provider = local ? local.provider : $("provider").value;
  // local mode: the proxy adds the key (keyFromProxy), the page sends none. The base URL field belongs to the
  // OpenAI-compatible provider only: a value left in it must not redirect the other providers.
  const settings = local
    ? { provider, model: local.model, keyFromProxy: true, baseUrl: new URL("proxy", location.href).href, effort: local.effort }
    : { provider, model: $("model").value.trim(), apiKey: $("apiKey").value.trim(), baseUrl: provider === "compatible" ? $("baseUrl").value.trim() : "", effort: $("effort").value };
  const limits = local ? { auditRounds: local.auditRounds, maxCalls: local.maxCalls } : { auditRounds: Number($("rounds").value), maxCalls: Number($("maxCalls").value) };
  const description = $("description").value.trim();
  store.set("sdb.description", description);
  if (!local) {
    store.set("sdb.provider", provider); store.set("sdb.model", settings.model); store.set("sdb.baseUrl", $("baseUrl").value.trim());
    store.set("sdb.effort", settings.effort);
    store.set("sdb.key", $("remember").checked ? settings.apiKey : null);
  }
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
    settings: limits,
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
  const zip = await packageZip(window.JSZip, current, local ? { provider: local.provider, model: local.model } : { provider: $("provider").value, model: $("model").value });
  // the drawn diagram goes in too (er_diagram.mmd, its source, is always there); without the drawing library, skip it
  try { if (current.tables?.length) zip.file("er_diagram.svg", await erSvg(current.tables)); } catch { /* the .mmd is enough */ }
  download(await zip.generateAsync({ type: "blob" }), "scribbledb-package.zip");
};
$("dlDb").onclick = () => {
  const seeds = Object.keys(current.databases);
  if (seeds.length) download(new Blob([current.databases[seeds[0]]], { type: "application/vnd.sqlite3" }), "database.sqlite");
};

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
