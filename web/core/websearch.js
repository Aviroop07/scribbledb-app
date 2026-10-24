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

  // A page is read over plain HTTP. Articles of two main open archives are read through their public text instead:
  // PubMed Central and PubMed through Europe PMC's API (their pages answer plain requests with a browser check), arXiv
  // through its HTML rendering (its PDFs are not text).
  async function read(url, focus = []) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, text: "not a web address" };
    const article = articleSource(url);
    if (article) return readArticle(article, focus);
    const page = await fetchText(url, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,text/plain" });
    if (!page.ok) return page;
    const full = pageText(page.text);
    if (full.length < CHALLENGE_MAX_CHARS && CHALLENGE.test(full)) return { ok: false, text: "the site answered with a bot check instead of the page" };
    const text = excerpt(full, focus);
    return text ? { ok: true, text } : { ok: false, text: "the page has no readable text (it may need a browser to render)" };
  }

  async function fetchText(url, headers) {
    let res;
    try {
      res = await get(url, READ_TIMEOUT_MS, headers);
    } catch (e) {
      // undici reports "fetch failed" and keeps the reason (a refused connection, a broken certificate chain) in cause
      return { ok: false, text: e.name === "TimeoutError" ? "the page did not answer in time" : `the page could not be fetched (${e.cause?.code || e.cause?.message || e.message})` };
    }
    if (!res.ok) return { ok: false, text: `the page answered HTTP ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (/pdf|octet-stream|image|zip/i.test(type)) return { ok: false, text: `the page is not text (${type.split(";")[0]})` };
    return { ok: true, text: (await res.text()).slice(0, MAX_PAGE_BYTES) };
  }

  // PMC: the full text when the article is open access, else its abstract. arXiv: the HTML paper, else the abstract page.
  async function readArticle({ pmcid, pmid, arxiv }, focus) {
    if (arxiv) {
      for (const url of [`https://arxiv.org/html/${arxiv}`, `https://arxiv.org/abs/${arxiv}`]) {
        const page = await fetchText(url, { "User-Agent": UA, Accept: "text/html" });
        const text = page.ok ? excerpt(pageText(page.text), focus) : "";
        if (text) return { ok: true, text };
      }
      return { ok: false, text: `arXiv ${arxiv} has no readable text on the queries` };
    }
    if (!pmcid) {
      const found = await fetchText(`${EUROPE_PMC}/search?query=EXT_ID:${pmid}%20AND%20SRC:MED&resultType=core&format=json`, { Accept: "application/json" });
      if (!found.ok) return found;
      let hit;
      try { hit = JSON.parse(found.text).resultList?.result?.[0]; } catch { hit = null; }
      if (!hit) return { ok: false, text: `Europe PMC has no record of PubMed ${pmid}` };
      if (hit.pmcid && hit.isOpenAccess === "Y") pmcid = hit.pmcid;
      else {
        const abs = pageText(String(hit.abstractText || ""));
        return abs ? { ok: true, text: `${hit.title || ""} (abstract only)
${excerpt(abs, focus) || abs.slice(0, EXCERPT_CHARS)}` }
          : { ok: false, text: `PubMed ${pmid} has no abstract` };
      }
    }
    const xml = await fetchText(`${EUROPE_PMC}/${pmcid}/fullTextXML`, { Accept: "application/xml" });
    if (!xml.ok) return { ok: false, text: `Europe PMC has no full text of ${pmcid} (${xml.text})` };
    // the abstract and the body; the front matter (affiliations, dates, licences) and the references carry numbers too
    const parts = [xml.text.match(/<abstract\b[\s\S]*?<\/abstract>/i)?.[0], xml.text.match(/<body\b[\s\S]*<\/body>/i)?.[0]].filter(Boolean);
    const text = excerpt(pageText(parts.join("\n") || xml.text), focus);
    return text ? { ok: true, text } : { ok: false, text: `the full text of ${pmcid} has no passage on the queries` };
  }

  return { available, search, papers, read };
}

const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
// a challenge page is short; a long page that mentions a captcha in passing is still read
const CHALLENGE_MAX_CHARS = 3000;
const CHALLENGE = /captcha|checking your browser|verify (?:that )?you are (?:a )?human|are you a robot|just a moment|enable javascript and cookies|unusual traffic|access denied/i;

// {pmcid} for a PubMed Central article address, {pmid} for a PubMed one, {arxiv} for an arXiv paper (abstract, PDF
// or HTML address, any version), else null
export function articleSource(url) {
  const pmc = url.match(/^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)/i);
  if (pmc) return { pmcid: pmc[1].toUpperCase() };
  const pm = url.match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  if (pm) return { pmid: pm[1] };
  const ax = url.match(/^https?:\/\/(?:www\.|export\.)?(?:arxiv\.org|ar5iv\.labs\.arxiv\.org)\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i);
  return ax ? { arxiv: ax[1] } : null;
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
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/blockquote|\/title|\/sec|\/caption)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : " "; }
      return ENTITIES[e.toLowerCase()] ?? " ";
    })
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

// a quantity, not any digit: a share, a measured value with its unit, a decimal or a thousands-grouped count. Citation
// markers, years and dates alone do not make a passage carry a figure.
const QUANTITY = /\d\s?(?:%|percent\b|per\s?cent\b)|\d\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|kg|km|kwh|mb|gb)\b|\d\.\d|\d{1,3}(?:,\d{3})+|\bper\s(?:day|week|month|year|patient|customer|visit)\b|\b\d+\s?(?:out of|in)\s\d+\b|\b(?:mean|median|average|sd|iqr)\b[^.]{0,40}\d/i;

// The passages worth the model's attention, in page order, within a character budget: a passage scores by the focus
// terms it contains, plus one when it states a quantity (research is after rates, sizes and shares).
export function excerpt(text, focus = [], budget = EXCERPT_CHARS) {
  const terms = [...new Set(focus.flatMap((f) => String(f).toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 4))];
  const blocks = text.split("\n").filter((b) => b.length >= 40);
  const scored = blocks.map((b, i) => {
    const low = b.toLowerCase();
    return { i, b, score: terms.filter((t) => low.includes(t)).length + (QUANTITY.test(b) ? 1 : 0) };
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
