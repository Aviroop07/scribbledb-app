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
    "https://e.example/": () => { throw new Error("ECONNRESET"); },
    "https://f.example/": () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) }); } };
  const web = createWebTools({ searchUrl: "http://x", fetchImpl: async (u) => pages[u]() });
  assert.deepEqual(await web.read("https://a.example/", ["length of stay"]), { ok: true, text: page.replace(/<\/?p>/g, "") });
  assert.deepEqual(await web.read("https://b.example/"), { ok: false, text: "the page answered HTTP 403" });
  assert.deepEqual(await web.read("https://c.example/"), { ok: false, text: "the page is not text (application/pdf)" });
  assert.equal((await web.read("https://d.example/")).ok, false);
  assert.match((await web.read("https://e.example/")).text, /could not be fetched \(ECONNRESET\)/);
  assert.match((await web.read("https://f.example/")).text, /could not be fetched \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
  assert.deepEqual(await web.read("file:///etc/passwd"), { ok: false, text: "not a web address" });
});

test("regression: a bot-check page is a failed read, not a short page (live: PMC answered plain requests with a reCAPTCHA check)", async () => {
  const check = "<title>Checking your browser - reCAPTCHA</title><p>Checking your browser before accessing the site.</p><p>Click here if you are not automatically redirected after 5 seconds.</p>";
  const long = `<p>${"Real content about appointment no-show rates that runs long. ".repeat(60)}</p><p>Our form uses a captcha to stop spam, and the no-show rate was 12% overall.</p>`;
  const pages = { "https://a.example/": () => html(check), "https://b.example/": () => html(long) };
  const web = createWebTools({ searchUrl: "http://x", fetchImpl: async (u) => pages[u]() });
  assert.deepEqual(await web.read("https://a.example/", ["no-show"]), { ok: false, text: "the site answered with a bot check instead of the page" });
  assert.equal((await web.read("https://b.example/", ["no-show"])).ok, true); // a long page that mentions a captcha is read
});

test("article addresses: PubMed Central and PubMed are recognised, other pages are not", async () => {
  const { articleSource } = await import("../web/core/websearch.js");
  assert.deepEqual(articleSource("https://pmc.ncbi.nlm.nih.gov/articles/PMC9680883/"), { pmcid: "PMC9680883" });
  assert.deepEqual(articleSource("https://www.ncbi.nlm.nih.gov/pmc/articles/pmc3645455/"), { pmcid: "PMC3645455" });
  assert.deepEqual(articleSource("https://pubmed.ncbi.nlm.nih.gov/33053198/"), { pmid: "33053198" });
  assert.equal(articleSource("https://example.org/pmc/articles/PMC1/"), null);
  assert.deepEqual(articleSource("https://arxiv.org/pdf/2402.19209v3"), { arxiv: "2402.19209" });
  assert.deepEqual(articleSource("https://ar5iv.labs.arxiv.org/html/1802.09398"), { arxiv: "1802.09398" });
  assert.deepEqual(articleSource("https://arxiv.org/abs/math/0601001"), { arxiv: "math/0601001" });
  assert.equal(articleSource("https://example.org/abs/2402.19209"), null);
});

test("arXiv papers are read from their HTML rendering, else the abstract page; never as PDF", async () => {
  const paper = "<p>Abandonment was 7.5% of offered calls across the call center data.</p>";
  const asked = [];
  const pages = { "https://arxiv.org/html/1111.22222": () => html(paper), "https://arxiv.org/html/3333.44444": () => html("", 404),
    "https://arxiv.org/abs/3333.44444": () => html("<p>Abstract: mean call center handling time was 4.2 minutes.</p>") };
  const web = createWebTools({ searchUrl: "http://x", fetchImpl: async (u) => { asked.push(u); return (pages[u] || (() => html("", 404)))(); } });
  assert.deepEqual(await web.read("https://arxiv.org/pdf/1111.22222", ["call center"]), { ok: true, text: "Abandonment was 7.5% of offered calls across the call center data." });
  assert.deepEqual(asked, ["https://arxiv.org/html/1111.22222"]);
  assert.match((await web.read("https://arxiv.org/abs/3333.44444v2", ["call center"])).text, /4\.2 minutes/);
  assert.deepEqual(await web.read("https://arxiv.org/abs/5555.66666", ["call center"]), { ok: false, text: "arXiv 5555.66666 has no readable text on the queries" });
});

test("articles are read through Europe PMC: open full text (abstract and body only), else the abstract", async () => {
  const jats = "<article><front><aff>Dept 1, 2022, 12345</aff><abstract><p>The no-show rate was 9.5% of all dental visits.</p></abstract></front>" +
    "<body><sec><title>Results</title><p>Mondays had 23% of appointments and an average duration of 41 minutes.</p></sec></body>" +
    "<back><ref-list><ref>Smith 2019, 12(3):45-67 dental appointments</ref></ref-list></back></article>";
  const asked = [];
  const routes = [
    [/PMC111\/fullTextXML$/, () => html(jats, 200, "application/xml")],
    [/EXT_ID:222/, () => json({ resultList: { result: [{ title: "Closed paper", abstractText: "<h4>Results</h4>The rate of dental no-show was 7% per year." }] } })],
    [/EXT_ID:333/, () => json({ resultList: { result: [{ pmcid: "PMC111", isOpenAccess: "Y" }] } })],
    [/EXT_ID:444/, () => json({ resultList: { result: [] } })],
    [/PMC999\/fullTextXML$/, () => html("", 500)],
    [/PMCID%3APMC999/, () => json({ resultList: { result: [{ title: "Not open", abstractText: "Dental no-show rate was 11% over two years of visits." }] } })],
    [/PMC777\/fullTextXML$/, () => html("", 500)],
    [/PMCID%3APMC777/, () => json({ resultList: { result: [] } })],
  ];
  const fetchImpl = async (u) => { asked.push(u); return routes.find(([re]) => re.test(u))[1](); };
  const web = createWebTools({ searchUrl: "http://x", fetchImpl });
  const focus = ["dental no-show rate"];
  const full = await web.read("https://pmc.ncbi.nlm.nih.gov/articles/PMC111/", focus);
  assert.equal(full.ok, true);
  assert.equal(full.text, "The no-show rate was 9.5% of all dental visits.\nMondays had 23% of appointments and an average duration of 41 minutes.");
  assert.match(asked[0], /^https:\/\/www\.ebi\.ac\.uk\/europepmc\/webservices\/rest\/PMC111\/fullTextXML$/);
  assert.deepEqual(await web.read("https://pubmed.ncbi.nlm.nih.gov/222/", focus), { ok: true, text: "Closed paper (abstract only)\nThe rate of dental no-show was 7% per year." });
  assert.equal((await web.read("https://pubmed.ncbi.nlm.nih.gov/333/", focus)).text, full.text); // open access: the full text
  assert.deepEqual(await web.read("https://pubmed.ncbi.nlm.nih.gov/444/", focus), { ok: false, text: "Europe PMC has no record of PubMed 444" });
  // outside the open full-text set: the abstract, else the reason
  assert.deepEqual(await web.read("https://pmc.ncbi.nlm.nih.gov/articles/PMC999/", focus), { ok: true, text: "Not open (abstract only)\nDental no-show rate was 11% over two years of visits." });
  assert.deepEqual(await web.read("https://pmc.ncbi.nlm.nih.gov/articles/PMC777/", focus), { ok: false, text: "Europe PMC has no text of PMC777 (the page answered HTTP 500)" });
});

test("excerpt: a quantity earns the bonus; citation markers, years and dates do not", () => {
  const cited = "Studies on clinic attendance were reviewed in earlier work 17 and in surveys 18, 19 from 2021.";
  const figure = "Clinic attendance surveys report that about 1,250 people were seen, with a mean wait of 14 minutes overall.";
  const ex = excerpt([cited, figure].join("\n"), ["clinic attendance"], 120);
  assert.equal(ex, figure); // equal terms; the quantity decides within the budget
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
  assert.match(llm.seen[2].last, /No more tool calls\. Answer with \{"action": "notes", "text": "\.\.\."\} now\.$/);
  assert.equal(p.state.research.text, "- late notes");

  llm = researcher(always());
  p = pipelineWith(llm, fakeWeb(), { researchTurns: 2 });
  await p.research();
  assert.equal(llm.usage.calls, 3); // the last turn's tool call is not run
  assert.equal(p.state.research.trail.length, 2);
  assert.equal(p.state.research.text, "");
  assert.match(p.state.lineage.at(-1).detail, /research gave no notes \(3 turns used\)/);
});

test("regression: notes written as plain text on the last turn are the notes (live: they were lost)", async () => {
  const llm = researcher([{ action: "search", queries: ["q"] }, "- plain notes\n- with a figure 12%"]);
  const p = pipelineWith(llm, fakeWeb(), { researchTurns: 1 });
  await p.research();
  assert.equal(p.state.research.text, "- plain notes\n- with a figure 12%");
  assert.equal(p.state.lineage.at(-1).status, "done");
  // before the last turn a plain-text answer is still corrected
  const early = researcher(["- notes too soon", { action: "notes", text: "- notes" }]);
  const q = pipelineWith(early, fakeWeb());
  await q.research();
  assert.match(early.seen[1].last, /That was not a JSON action/);
  assert.equal(q.state.research.text, "- notes");
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
