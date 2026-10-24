// Web tools for the research step when the host offers a local search service: the model searches, reads pages and
// looks up papers itself, through calls that leave this machine as ordinary requests (no provider-side search tool,
// no search API key).
//
//   const web = createWebTools({ searchUrl: "http://127.0.0.1:7072" });
//   await web.available();                      // the service answers its health check
//   await web.search("...")                     // {engine, hits: [{title, url, snippet}], errors}
//   await web.papers("...")                     // [{title, year, cited, url, abstract}]
//   await web.read(url, focusTerms)             // {ok, text} - the page passages that carry numbers or focus terms
//
// The search service is openserp (github.com/karust/openserp, settings in node/openserp.yaml): it drives the installed
// browser, which is what keeps a search engine answering. Plain HTTP requests to search engines are refused quietly
// after a few queries (DuckDuckGo answers 202, Bing serves an empty result page); ScribbleDB's
// experiments/websearch/FINDINGS.md has the measurements. Bing goes first (40/40 there, 3 searches at a time), Google
// second (30/30). openserp's region/language parameters are left out: they made Bing return unrelated or no results.
// Papers come from OpenAlex, a public scholarly index that needs no key.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ENGINES = ["bing", "google"];
const SEARCH_TIMEOUT_MS = 90000; // a browser search under load took up to ~20 s; one engine may also retry inside
const READ_TIMEOUT_MS = 20000;
const MAX_PAGE_BYTES = 3_000_000;
export const EXCERPT_CHARS = 3500;

export function createWebTools({ searchUrl, fetchImpl = globalThis.fetch.bind(globalThis), engines = ENGINES, log = () => {} }) {
  const base = String(searchUrl || "").replace(/\/$/, "");
  const get = (url, timeoutMs, headers = {}) => fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

  async function available() {
    try { return (await get(`${base}/health`, 5000)).ok; } catch { return false; }
  }

  // the first engine that returns results; an engine that errors or comes back empty passes to the next (logged)
  async function search(query, limit = 8) {
    const errors = [];
    for (const engine of engines) {
      try {
        const res = await get(`${base}/${engine}/search?text=${encodeURIComponent(query)}&limit=${limit}`, SEARCH_TIMEOUT_MS);
        const body = await res.text();
        if (!res.ok) { errors.push(`${engine}: HTTP ${res.status} ${body.slice(0, 120)}`); continue; }
        const hits = parseResults(body).slice(0, limit);
        if (hits.length) return { engine, hits, errors };
        errors.push(`${engine}: no results`);
      } catch (e) {
        errors.push(`${engine}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
      }
    }
    log({ kind: "search", what: `no engine answered "${query}" (${errors.join("; ")})` });
    return { engine: "", hits: [], errors };
  }

  async function papers(query, limit = 5) {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}` +
      "&select=display_name,publication_year,cited_by_count,abstract_inverted_index,doi,id";
    const res = await get(url, READ_TIMEOUT_MS, { Accept: "application/json" });
    if (!res.ok) throw new Error(`OpenAlex answered HTTP ${res.status}`);
    const data = await res.json();
    return (data.results || []).map((w) => ({ title: w.display_name || "", year: w.publication_year, cited: w.cited_by_count,
      url: w.doi || w.id || "", abstract: abstractText(w.abstract_inverted_index) }));
  }

  async function read(url, focus = []) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, text: "not a web address" };
    let res;
    try {
      res = await get(url, READ_TIMEOUT_MS, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,text/plain" });
    } catch (e) {
      // undici reports "fetch failed" and keeps the reason (a refused connection, a broken certificate chain) in cause
      return { ok: false, text: e.name === "TimeoutError" ? "the page did not answer in time" : `the page could not be fetched (${e.cause?.code || e.cause?.message || e.message})` };
    }
    if (!res.ok) return { ok: false, text: `the page answered HTTP ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (/pdf|octet-stream|image|zip/i.test(type)) return { ok: false, text: `the page is not text (${type.split(";")[0]})` };
    const body = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const text = excerpt(pageText(body), focus);
    return text ? { ok: true, text } : { ok: false, text: "the page has no readable text (it may need a browser to render)" };
  }

  return { available, search, papers, read };
}

// openserp answers {results: [...]} (or a bare list); each result has title, url and description
export function parseResults(body) {
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  return list.filter((r) => r && typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({ title: String(r.title || "").trim(), url: r.url, snippet: String(r.description || r.snippet || "").trim() }));
}

// OpenAlex ships abstracts as {word: [positions]}
export function abstractText(inverted) {
  if (!inverted || typeof inverted !== "object") return "";
  const words = [];
  for (const [w, positions] of Object.entries(inverted)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", percnt: "%" };

// the visible text of an HTML page, one block element per line
export function pageText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : " "; }
      return ENTITIES[e.toLowerCase()] ?? " ";
    })
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

// The passages worth the model's attention, in page order, within a character budget: a passage scores by the focus
// terms it contains, plus one when it carries a number (research is after rates, sizes and shares).
export function excerpt(text, focus = [], budget = EXCERPT_CHARS) {
  const terms = [...new Set(focus.flatMap((f) => String(f).toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 4))];
  const blocks = text.split("\n").filter((b) => b.length >= 40);
  const scored = blocks.map((b, i) => {
    const low = b.toLowerCase();
    return { i, b, score: terms.filter((t) => low.includes(t)).length + (/\d/.test(b) ? 1 : 0) };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = [];
  let used = 0;
  for (const x of scored) {
    const piece = x.b.length > 800 ? `${x.b.slice(0, 800)}...` : x.b;
    if (used + piece.length > budget) continue;
    chosen.push({ ...x, b: piece });
    used += piece.length + 1;
  }
  return chosen.sort((a, b) => a.i - b.i).map((x) => x.b).join("\n");
}
