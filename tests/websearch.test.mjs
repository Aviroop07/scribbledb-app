// The research step's local web tools (web/core/websearch.js) and the research loop that drives them
// (Pipeline.researchWithTools), offline: fetch and the model are scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { abstractText, createWebTools, excerpt, pageText, parseResults } from "../web/core/websearch.js";
import { Pipeline } from "../web/core/pipeline.js";
import { RESEARCH_SYSTEM } from "../web/core/prompts.js";

const json = (v, status = 200, type = "application/json") => new Response(JSON.stringify(v), { status, headers: { "content-type": type } });
const html = (body, status = 200, type = "text/html; charset=utf-8") => new Response(body, { status, headers: { "content-type": type } });
const hit = (n) => ({ title: `T${n}`, url: `https://site${n}.example/page`, description: `snippet ${n}` });

test("search results: openserp's object and list forms; malformed bodies and non-web links are dropped", () => {
  assert.deepEqual(parseResults(JSON.stringify({ results: [hit(1)] })), [{ title: "T1", url: "https://site1.example/page", snippet: "snippet 1" }]);
  assert.equal(parseResults(JSON.stringify([hit(1), hit(2)])).length, 2);
  assert.deepEqual(parseResults("not json"), []);
  assert.deepEqual(parseResults(JSON.stringify({ error: "blocked" })), []);
  assert.deepEqual(parseResults(JSON.stringify({ results: [{ title: "x", url: "javascript:alert(1)" }, null, { title: "y" }] })), []);
});

test("OpenAlex abstracts are rebuilt from the inverted index", () => {
  assert.equal(abstractText({ rates: [2], No: [0], show: [1] }), "No show rates");
  assert.equal(abstractText(null), "");
});

test("page text: scripts, styles and markup go; entities decode; block elements become lines", () => {
  const t = pageText("<head><title>x</title></head><script>var a=1</script><style>p{}</style><p>A &amp; B&nbsp;&#37;</p><div>C<br>D</div><!-- c -->");
  assert.equal(t, "A & B %\nC\nD");
  assert.equal(pageText("<table><tr><td>a</td><td>b</td></tr></table>"), "a | b |");
});

test("excerpt: passages with focus terms or numbers, in page order, within the budget", () => {
  const filler = "This sentence is long enough to count as a passage but says nothing relevant at all here.";
  const text = [filler, "The no-show rate for outpatient visits averages 18 percent in large clinics.", filler,
    "Clinics schedule appointments in slots and the outpatient share of visits grows every year.", "short 5"].join("\n");
  const ex = excerpt(text, ["outpatient no-show rate"]);
  assert.deepEqual(ex.split("\n"), ["The no-show rate for outpatient visits averages 18 percent in large clinics.",
    "Clinics schedule appointments in slots and the outpatient share of visits grows every year."]);
  assert.equal(excerpt(text, ["outpatient"], 90).split("\n").length, 1); // the budget keeps the best passage only
  assert.equal(excerpt(filler, ["unrelated"]), "");
});

test("search: Bing first; an empty, failing or timed-out engine passes to Google; all failing gives no hits, logged", async () => {
  const calls = [];
  const logs = [];
  const script = { bing: () => json({ results: [] }), google: () => json({ results: [hit(1), hit(2)] }) };
  const fetchImpl = async (url) => { calls.push(url); const e = url.match(/7070\/(\w+)\//)[1]; return script[e](); };
  const web = createWebTools({ searchUrl: "http://127.0.0.1:7070/", fetchImpl, log: (e) => logs.push(e) });
  let r = await web.search("a b");
  assert.equal(r.engine, "google");
  assert.equal(r.hits.length, 2);
  assert.match(calls[0], /^http:\/\/127\.0\.0\.1:7070\/bing\/search\?text=a%20b&limit=8$/);
  assert.deepEqual(r.errors, ["bing: no results"]);

  script.bing = () => json({ message: "captcha" }, 503);
  script.google = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  r = await web.search("q");
  assert.deepEqual(r.hits, []);
  assert.equal(r.errors[0].startsWith("bing: HTTP 503"), true);
  assert.equal(r.errors[1], "google: timed out");
  assert.equal(logs.length, 1);
  assert.match(logs[0].what, /no engine answered "q"/);
});

test("available: the service's health check, false when it does not answer", async () => {
  assert.equal(await createWebTools({ searchUrl: "http://x", fetchImpl: async () => json({ status: "healthy" }) }).available(), true);
  assert.equal(await createWebTools({ searchUrl: "http://x", fetchImpl: async () => { throw new Error("refused"); } }).available(), false);
});

test("read: an HTML page gives its relevant passages; errors, non-text pages and empty pages say why", async () => {
  const page = "<p>The average length of stay is 4.5 days for inpatients in general hospitals worldwide.</p>";
  const pages = { "https://a.example/": () => html(page), "https://b.example/": () => html("x", 403),
    "https://c.example/": () => html("%PDF", 200, "application/pdf"), "https://d.example/": () => html("<script>render()</script>"),
    "https://e.example/": () => { throw new Error("ECONNRESET"); } };
  const web = createWebTools({ searchUrl: "http://x", fetchImpl: async (u) => pages[u]() });
  assert.deepEqual(await web.read("https://a.example/", ["length of stay"]), { ok: true, text: page.replace(/<\/?p>/g, "") });
  assert.deepEqual(await web.read("https://b.example/"), { ok: false, text: "the page answered HTTP 403" });
  assert.deepEqual(await web.read("https://c.example/"), { ok: false, text: "the page is not text (application/pdf)" });
  assert.equal((await web.read("https://d.example/")).ok, false);
  assert.match((await web.read("https://e.example/")).text, /could not be fetched \(ECONNRESET\)/);
  assert.deepEqual(await web.read("file:///etc/passwd"), { ok: false, text: "not a web address" });
});

test("papers: OpenAlex works with title, year, citations, link and abstract", async () => {
  let asked = "";
  const web = createWebTools({ searchUrl: "http://x", fetchImpl: async (u) => { asked = u; return json({ results: [
    { display_name: "W", publication_year: 2020, cited_by_count: 7, doi: "https://doi.org/1", abstract_inverted_index: { b: [1], a: [0] } }] }); } });
  assert.deepEqual(await web.papers("x y"), [{ title: "W", year: 2020, cited: 7, url: "https://doi.org/1", abstract: "a b" }]);
  assert.match(asked, /^https:\/\/api\.openalex\.org\/works\?search=x%20y&per-page=5&select=/);
  const down = createWebTools({ searchUrl: "http://x", fetchImpl: async () => json({}, 429) });
  await assert.rejects(down.papers("q"), /HTTP 429/);
});

// -- the research loop -------------------------------------------------------------------------------------------

// a model that answers the research turns from a list; it records every prompt it saw
function researcher(answers) {
  const seen = [];
  return {
    seen,
    usage: { calls: 0, input: 0, output: 0 },
    nativeResearch: 0,
    async research() { this.nativeResearch++; return { text: "- native notes", source: "provider web search" }; },
    async complete({ system, messages }) {
      this.usage.calls++;
      seen.push({ system, last: messages[messages.length - 1].content, history: messages.length });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return { text: typeof a === "string" ? a : JSON.stringify(a) };
    },
  };
}

function fakeWeb({ up = true } = {}) {
  const log = [];
  return {
    log,
    async available() { return up; },
    async search(q) { log.push(["search", q]); return q === "nothing" ? { engine: "", hits: [], errors: ["bing: no results", "google: no results"] }
      : { engine: "bing", hits: [{ title: `About ${q}`, url: `https://x.example/${q.length}`, snippet: "rate 12%" }], errors: [] }; },
    async papers(q) { log.push(["papers", q]); return [{ title: "Paper", year: 2019, cited: 3, url: "https://doi.org/p", abstract: "mean 4.2" }]; },
    async read(u, focus) { log.push(["read", u, focus]); return u.includes("bad") ? { ok: false, text: "the page answered HTTP 403" } : { ok: true, text: "the share is 31%" }; },
  };
}

const pipelineWith = (llm, web, settings = {}) => {
  const p = new Pipeline({ llm, runtime: null, web, settings });
  p.state.description = "A clinic with patients and appointments.";
  return p;
};

test("research loop: search, read, papers, then notes; every tool call is in the trail and tool output reaches the model", async () => {
  const llm = researcher([
    { action: "search", queries: ["clinic no-show rate", "nothing", "x", "dropped fourth"] },
    { action: "read", urls: ["https://x.example/19", "https://bad.example/"] },
    { action: "papers", query: "appointment no-show" },
    { action: "notes", text: "- no-show 12% (x.example)" },
  ]);
  const web = fakeWeb();
  const p = pipelineWith(llm, web);
  await p.research();
  const r = p.state.research;
  assert.equal(r.text, "- no-show 12% (x.example)");
  assert.equal(r.source, "local web search (4 searches, 1 pages read)");
  assert.deepEqual(r.trail.map((t) => t.tool), ["search", "search", "search", "read", "read", "papers"]);
  assert.equal(r.trail[1].results, 0);
  assert.equal(llm.nativeResearch, 0);
  // at most 3 queries per search; the focus terms for reading are the queries so far
  assert.deepEqual(web.log.filter((l) => l[0] === "search").map((l) => l[1]), ["clinic no-show rate", "nothing", "x"]);
  assert.deepEqual(web.log.find((l) => l[0] === "read")[2], ["clinic no-show rate", "nothing", "x"]);
  // the model sees the results, the failures and the system prompt with the research instructions and the budget
  assert.match(llm.seen[1].last, /Results for "clinic no-show rate":\n1\. About clinic no-show rate\n {3}https:\/\/x\.example\/19\n {3}rate 12%/);
  assert.match(llm.seen[1].last, /Results for "nothing":\n\(none: bing: no results; google: no results\)/);
  assert.match(llm.seen[2].last, /Page https:\/\/bad\.example\/:\n\(not read: the page answered HTTP 403\)/);
  assert.match(llm.seen[3].last, /Works for "appointment no-show":\n1\. Paper \(2019, cited 3\)/);
  assert.ok(llm.seen[0].system.startsWith(RESEARCH_SYSTEM));
  assert.match(llm.seen[0].system, /Use at most 6 tool calls\.$/);
  assert.equal(llm.seen[3].history, 7); // the conversation is carried turn to turn
  assert.equal(p.state.lineage.at(-1).status, "done");
});

test("research loop: a malformed or unknown action is answered with a correction and costs a turn", async () => {
  const llm = researcher(["I will search now.", { action: "browse" }, { action: "search" }, { action: "notes", text: "" },
    { action: "notes", text: "- done" }]);
  const p = pipelineWith(llm, fakeWeb());
  await p.research();
  assert.equal(p.state.research.text, "- done");
  assert.match(llm.seen[1].last, /That was not a JSON action/);
  assert.match(llm.seen[2].last, /Unknown action/);
  assert.match(llm.seen[3].last, /A search needs "queries"/);
  assert.match(llm.seen[4].last, /The notes are empty/);
});

test("research loop: the tool budget ends with a demand for notes; no notes leaves research empty and says so", async () => {
  const always = () => Array.from({ length: 10 }, () => ({ action: "search", queries: ["q"] }));
  let llm = researcher([...always().slice(0, 2), { action: "notes", text: "- late notes" }]);
  let p = pipelineWith(llm, fakeWeb(), { researchTurns: 2 });
  await p.research();
  assert.equal(llm.usage.calls, 3);
  assert.match(llm.seen[2].last, /No more tool calls: give your notes now\.$/);
  assert.equal(p.state.research.text, "- late notes");

  llm = researcher(always());
  p = pipelineWith(llm, fakeWeb(), { researchTurns: 2 });
  await p.research();
  assert.equal(llm.usage.calls, 3); // the last turn's tool call is not run
  assert.equal(p.state.research.trail.length, 2);
  assert.equal(p.state.research.text, "");
  assert.match(p.state.lineage.at(-1).detail, /research gave no notes \(3 turns used\)/);
});

test("research: with the search service down the provider's own search runs, and the switch is in the timeline", async () => {
  const llm = researcher([]);
  const p = pipelineWith(llm, fakeWeb({ up: false }));
  await p.research();
  assert.equal(llm.nativeResearch, 1);
  assert.equal(p.state.research.text, "- native notes");
  assert.match(p.state.lineage[0].title, /local search service does not answer/);
});

test("research loop: a transient provider failure ends research without notes; a fatal one ends the run", async () => {
  const { LLMError } = await import("../web/core/llm.js");
  let p = pipelineWith(researcher([{ action: "search", queries: ["q"] }, new LLMError("network error: reset", 0, "")]), fakeWeb());
  await p.research();
  assert.equal(p.state.research.text, "");
  assert.match(p.state.lineage.at(-1).detail, /stopped: network error: reset/);

  p = pipelineWith(researcher([new LLMError("HTTP 429: insufficient_quota", 429, "insufficient_quota")]), fakeWeb());
  await assert.rejects(p.research(), /refused the request/);
});
