// One interface over the providers a user may bring a key for. Everything goes straight from the user's browser (or
// the Node runner) to the provider; no server of ours sees the key.
//
//   const llm = createLLM({provider, model, apiKey, baseUrl, effort, log});
//   const {text, usage} = await llm.complete({system, messages, maxTokens});
//   const {text, source} = await llm.research(question, system);
//
// Fallbacks, each logged through `log` (never silent):
//   - a request rejected for its reasoning setting is retried without it (and stays without it);
//   - a request rejected for its output-token limit is retried with a lower one (8192, then 4096);
//   - OpenAI's Responses API falls back to Chat Completions;
//   - an answer cut off at the output limit is asked again once with twice the limit;
//   - research: the provider's own web search, else Wikipedia search (CORS-enabled), else model knowledge.
// Never retried or fallen back on: a bad key, no access, no credits (isFatal) - those end the run.

export const PROVIDERS = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", modelHint: "gpt-5-mini" },
  anthropic: { label: "Anthropic", base: "https://api.anthropic.com/v1", modelHint: "claude-sonnet-4-5" },
  gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta", modelHint: "gemini-2.5-flash" },
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", modelHint: "openai/gpt-5-mini" },
  compatible: { label: "OpenAI-compatible (custom URL)", base: "", modelHint: "deepseek-chat" },
};

export const EFFORTS = ["none", "low", "medium", "high"];
const THINKING_BUDGET = { low: 2048, medium: 8192, high: 16384 };
const MAX_TOKENS_CEILING = 64000;

export class LLMError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An error no retry or fallback can fix: a bad key (401), no access (403), or an account without credits (a 429 whose
// body says quota/credits/billing - OpenAI sends insufficient_quota as 429). Retrying it wastes the user's time and
// treating it as "search unavailable" hides it (live run 2026-10-20: 30 s of retries, then a silent search fallback).
const FATAL_429 = /insufficient_quota|quota|credit|billing|exceeded your current/i;
export const isFatal = (e) => e instanceof LLMError && (e.status === 401 || e.status === 403 ||
  (e.status === 429 && FATAL_429.test(e.body || "")));

const ATTEMPTS = 4;
// a request that gets no complete answer in this time is abandoned and retried: a stalled connection must not hang a
// run (the browser has a Stop button; the command-line runner has nothing else). Long reasoning calls took ~3 min.
export const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

async function post(url, headers, body, { fetchImpl, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const final = attempt === ATTEMPTS - 1;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const relay = () => ctl.abort();
    if (signal) signal.addEventListener("abort", relay, { once: true });
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body), signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      if (signal && signal.aborted) throw e;
      last = new LLMError(ctl.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `network error: ${e.message}`, 0, "");
      if (!final) await sleep(1500 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", relay);
    }
    if (res.ok) {
      try { return JSON.parse(text); } catch { throw new LLMError(`the provider answered with non-JSON: ${text.slice(0, 300)}`, res.status, text); }
    }
    last = new LLMError(`HTTP ${res.status}: ${text.slice(0, 600)}`, res.status, text);
    if (isFatal(last)) throw last;
    if (res.status === 429 || res.status >= 500) { if (!final) await sleep(2000 * 2 ** attempt); continue; }
    throw last;
  }
  throw last;
}

// a 400 that names the reasoning/thinking setting (not any "unsupported": a rejected search tool says that too)
const rejectsReasoning = (e) => e instanceof LLMError && e.status === 400 &&
  /reasoning|thinking|effort|budget_tokens|thinking_?budget/i.test(e.body || "");
// a 400 about the output-token limit being too large for the model
const rejectsTokenLimit = (e) => e instanceof LLMError && e.status === 400 &&
  /max_tokens|max_output_tokens|max_completion_tokens|maxOutputTokens|output tokens/i.test(e.body || "") &&
  /too large|exceed|maximum|at most|less than|or fewer|range|limit|>/i.test(e.body || "");
const rejectsTools = (e) => e instanceof LLMError && (e.status === 400 || e.status === 404) && /tool|search|plugin|grounding/i.test(e.body || "");

function chatMessages(system, messages) {
  return [...(system ? [{ role: "system", content: system }] : []), ...messages];
}

export function createLLM(cfg) {
  const { provider, model, apiKey } = cfg;
  const fetchImpl = cfg.fetch || globalThis.fetch.bind(globalThis);
  const log = cfg.log || (() => {});
  const timeoutMs = cfg.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  let effort = cfg.effort || "medium";
  let tokenCap = Infinity;
  const base = (cfg.baseUrl || PROVIDERS[provider]?.base || "").replace(/\/$/, "");
  const usage = { calls: 0, input: 0, output: 0 };
  let openaiChatOnly = false;
  let searchMode = "native"; // native -> wikipedia -> none, degraded on failures

  if (!PROVIDERS[provider]) throw new Error(`unknown provider ${provider}`);
  // keyFromProxy: calls go to a local proxy that adds the key itself (node/local.mjs); the page holds none
  if (!apiKey && provider !== "compatible" && !cfg.keyFromProxy) throw new Error("an API key is required");
  if (!model) throw new Error("a model name is required");
  if (!base) throw new Error("a base URL is required for an OpenAI-compatible provider");

  const add = (i, o) => { usage.calls++; usage.input += i || 0; usage.output += o || 0; };
  const thinkingFit = (max, eff) => {
    // a thinking budget must fit inside the output limit, with room for the answer
    if (eff === "none") return { max, budget: 0 };
    const total = Math.min(Math.max(max, THINKING_BUDGET[eff] + 8000), tokenCap);
    const budget = Math.min(THINKING_BUDGET[eff], total - 4000);
    return budget >= 1024 ? { max: total, budget } : { max: Math.min(max, tokenCap), budget: 0 };
  };

  // -- providers: each returns {text, truncated} --------------------------------------------------------------------

  async function openaiResponses(req, eff, signal, search) {
    const body = { model, input: req.messages.map((m) => ({ role: m.role, content: m.content })), max_output_tokens: req.maxTokens };
    if (req.system) body.instructions = req.system;
    if (eff !== "none") body.reasoning = { effort: eff };
    if (search) body.tools = [{ type: "web_search" }];
    const data = await post(`${base}/responses`, { authorization: `Bearer ${apiKey}` }, body, { fetchImpl, signal, timeoutMs });
    add(data.usage?.input_tokens, data.usage?.output_tokens);
    // the answer is the message items' output_text parts (reasoning and tool-call items are skipped)
    const text = (data.output || []).filter((o) => o.type === "message")
      .flatMap((o) => (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text || "")).join("") || data.output_text || "";
    return { text, truncated: data.status === "incomplete" ? (data.incomplete_details?.reason || "incomplete") : "" };
  }

  async function chatCompletions(req, eff, signal, extra = {}) {
    const body = { model, messages: chatMessages(req.system, req.messages), ...extra };
    if (provider === "openrouter") {
      if (eff !== "none") body.reasoning = { effort: eff };
    } else if (eff !== "none") {
      body.reasoning_effort = eff;
    }
    body.max_completion_tokens = req.maxTokens;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    if (provider === "openrouter") { headers["HTTP-Referer"] = "https://github.com/Aviroop07/scribbledb-app"; headers["X-Title"] = "ScribbleDB"; }
    let data;
    try {
      data = await post(`${base}/chat/completions`, headers, body, { fetchImpl, signal, timeoutMs });
    } catch (e) {
      // some compatible servers only know max_tokens
      if (e instanceof LLMError && e.status === 400 && /max_completion_tokens/i.test(e.body || "") && !rejectsTokenLimit(e)) {
        delete body.max_completion_tokens; body.max_tokens = req.maxTokens;
        data = await post(`${base}/chat/completions`, headers, body, { fetchImpl, signal, timeoutMs });
      } else throw e;
    }
    add(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    const choice = data.choices?.[0] || {};
    return { text: choice.message?.content || "", truncated: choice.finish_reason === "length" ? "length" : "" };
  }

  async function anthropic(req, eff, signal, search) {
    const fit = thinkingFit(req.maxTokens, eff);
    const body = { model, max_tokens: fit.max, messages: [...req.messages] };
    if (req.system) body.system = req.system;
    if (fit.budget) body.thinking = { type: "enabled", budget_tokens: fit.budget };
    if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
    const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    let text = "";
    // a long server-tool turn (web search) may pause: send the partial turn back and let the model continue
    for (let turn = 0; turn < 5; turn++) {
      const data = await post(`${base}/messages`, headers, body, { fetchImpl, signal, timeoutMs });
      add(data.usage?.input_tokens, data.usage?.output_tokens);
      text += (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (data.stop_reason !== "pause_turn") return { text, truncated: data.stop_reason === "max_tokens" ? "max_tokens" : "" };
      body.messages = [...body.messages, { role: "assistant", content: data.content }];
    }
    return { text, truncated: "pause_turn" };
  }

  async function gemini(req, eff, signal, search) {
    const fit = thinkingFit(req.maxTokens, eff); // thinking tokens count against maxOutputTokens
    const body = { contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: fit.max } };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (fit.budget) body.generationConfig.thinkingConfig = { thinkingBudget: fit.budget };
    if (search) body.tools = [{ google_search: {} }];
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    const data = await post(url, { "x-goog-api-key": apiKey }, body, { fetchImpl, signal, timeoutMs });
    add(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
    const cand = data.candidates?.[0] || {};
    const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    return { text, truncated: cand.finishReason === "MAX_TOKENS" ? "MAX_TOKENS" : "" };
  }

  async function dispatch(req, eff, signal, search) {
    if (provider === "openai") {
      if (!openaiChatOnly) {
        try { return await openaiResponses(req, eff, signal, search); } catch (e) {
          if (e instanceof LLMError && (e.status === 404 || (e.status === 400 && /responses|input/i.test(e.body || "") && !rejectsReasoning(e) && !rejectsTokenLimit(e) && !(search && rejectsTools(e))))) {
            log({ kind: "fallback", what: "the Responses API is unavailable for this model; using Chat Completions" });
            openaiChatOnly = true;
          } else throw e;
        }
      }
      // OpenAI's web search lives in the Responses API: without it there is no native search
      if (search) throw new LLMError("web search needs the Responses API", 0, "search unavailable");
      return chatCompletions(req, eff, signal);
    }
    if (provider === "anthropic") return anthropic(req, eff, signal, search);
    if (provider === "gemini") return gemini(req, eff, signal, search);
    if (provider === "openrouter") return chatCompletions(req, eff, signal, search ? { plugins: [{ id: "web" }] } : {});
    return chatCompletions(req, eff, signal);
  }

  // one request with the setting fallbacks (each applies once and sticks for the rest of the run)
  async function once(req, signal, search) {
    let maxTokens = Math.min(req.maxTokens || 16000, MAX_TOKENS_CEILING);
    let grown = false;
    for (let tries = 0; ; tries++) {
      try {
        const r = await dispatch({ ...req, maxTokens: Math.min(maxTokens, tokenCap) }, effort, signal, search);
        if (r.truncated) {
          const more = Math.min(maxTokens * 2, MAX_TOKENS_CEILING, tokenCap);
          if (!grown && more > Math.min(maxTokens, tokenCap)) {
            log({ kind: "fallback", what: `the answer was cut off at ${Math.min(maxTokens, tokenCap)} output tokens (${r.truncated}); asking again with ${more}` });
            maxTokens = more; grown = true;
            continue;
          }
          throw new LLMError(`the answer was cut off at the output limit (${r.truncated})`, 0, "truncated");
        }
        if (!r.text.trim()) throw new LLMError("the model returned an empty answer", 0, "empty");
        return r.text;
      } catch (e) {
        if (tries >= 4) throw e;
        if (rejectsTokenLimit(e) && Math.min(maxTokens, tokenCap) > 4096) {
          tokenCap = Math.min(maxTokens, tokenCap) > 8192 ? 8192 : 4096;
          log({ kind: "fallback", what: `${model} rejected the output-token limit; using ${tokenCap}` });
          continue;
        }
        if (effort !== "none" && rejectsReasoning(e)) {
          log({ kind: "fallback", what: `${model} rejected reasoning effort "${effort}"; continuing without it` });
          effort = "none";
          continue;
        }
        throw e;
      }
    }
  }

  async function complete(req, signal) {
    const text = await once(req, signal, false);
    return { text, usage: { ...usage } };
  }

  // research: a question answered with web search when the provider can search; else Wikipedia; else knowledge only
  async function research(question, system, signal) {
    if (searchMode === "native" && provider !== "compatible") {
      try {
        const text = await once({ system, messages: [{ role: "user", content: question }], maxTokens: 8000 }, signal, true);
        return { text, source: `${PROVIDERS[provider].label} web search` };
      } catch (e) {
        if ((signal && signal.aborted) || isFatal(e)) throw e;
        log({ kind: "fallback", what: `built-in web search failed (${String(e.message).slice(0, 160)}); using Wikipedia search` });
        searchMode = "wikipedia";
      }
    }
    let context = "";
    if (searchMode !== "none") {
      try {
        context = await wikipedia(question, fetchImpl);
      } catch (e) {
        log({ kind: "fallback", what: `Wikipedia search failed (${String(e.message).slice(0, 120)}); answering from model knowledge` });
        searchMode = "none";
      }
    }
    const prompt = context ? `${question}\n\nSearch results (Wikipedia):\n${context}` : question;
    const text = (await complete({ system, messages: [{ role: "user", content: prompt }], maxTokens: 8000 }, signal)).text;
    return { text, source: context ? "Wikipedia search" : "model knowledge (no search available)" };
  }

  return { complete, research, usage, get effort() { return effort; }, get tokenCap() { return tokenCap; } };
}

async function wikipedia(question, fetchImpl) {
  const terms = question.replace(/[^\w\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 8).join(" ");
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(terms)}&srlimit=4&format=json&origin=*`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const hits = data.query?.search || [];
  const parts = [];
  for (const h of hits.slice(0, 3)) {
    const r = await fetchImpl(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title)}`);
    if (r.ok) { const s = await r.json(); parts.push(`- ${h.title}: ${s.extract || ""}`); }
  }
  return parts.join("\n");
}

// The first JSON object in a model's answer (a ```json fence, or the outermost {...}).
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* next */ }
  }
  throw new Error("the answer contains no valid JSON object");
}

// The last ```python fence (or the whole text when it has no fence and defines generate).
export function extractPython(text) {
  const fences = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (fences.length) return fences[fences.length - 1];
  if (/def \w+\(/.test(text)) return text;
  throw new Error("the answer contains no Python code block");
}
