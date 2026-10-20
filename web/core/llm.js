// One interface over the providers a user may bring a key for. Everything goes straight from the user's browser (or
// the Node runner) to the provider; no server of ours sees the key.
//
//   const llm = createLLM({provider, model, apiKey, baseUrl, effort, log});
//   const {text, usage} = await llm.complete({system, messages, maxTokens, search});
//
// Fallbacks, each logged through `log` (never silent): a request rejected for its reasoning setting is retried
// without it; OpenAI's Responses API falls back to Chat Completions; a provider whose built-in web search fails
// falls back to Wikipedia search (CORS-enabled) and then to no search.

export const PROVIDERS = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", modelHint: "gpt-5-mini" },
  anthropic: { label: "Anthropic", base: "https://api.anthropic.com/v1", modelHint: "claude-sonnet-4-5" },
  gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta", modelHint: "gemini-2.5-flash" },
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", modelHint: "openai/gpt-5-mini" },
  compatible: { label: "OpenAI-compatible (custom URL)", base: "", modelHint: "deepseek-chat" },
};

export const EFFORTS = ["none", "low", "medium", "high"];
const THINKING_BUDGET = { low: 2048, medium: 8192, high: 16384 };

export class LLMError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, headers, body, { fetchImpl, signal }) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      last = new LLMError(`network error: ${e.message}`, 0, "");
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      try { return JSON.parse(text); } catch { throw new LLMError(`the provider answered with non-JSON: ${text.slice(0, 300)}`, res.status, text); }
    }
    last = new LLMError(`HTTP ${res.status}: ${text.slice(0, 600)}`, res.status, text);
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    throw last;
  }
  throw last;
}

// a 400 that names the reasoning/thinking setting: retry without it
const rejectsReasoning = (e) => e instanceof LLMError && e.status === 400 &&
  /reasoning|thinking|effort|budget|not supported|unsupported|unknown (parameter|field)|unrecognized/i.test(e.body || "");
const rejectsTools = (e) => e instanceof LLMError && (e.status === 400 || e.status === 404) && /tool|search|plugin|grounding/i.test(e.body || "");

function chatMessages(system, messages) {
  return [...(system ? [{ role: "system", content: system }] : []), ...messages];
}

export function createLLM(cfg) {
  const { provider, model, apiKey } = cfg;
  const fetchImpl = cfg.fetch || globalThis.fetch.bind(globalThis);
  const log = cfg.log || (() => {});
  let effort = cfg.effort || "medium";
  const base = (cfg.baseUrl || PROVIDERS[provider]?.base || "").replace(/\/$/, "");
  const usage = { calls: 0, input: 0, output: 0 };
  let openaiChatOnly = false;
  let searchMode = "native"; // native -> wikipedia -> none, degraded on failures

  if (!PROVIDERS[provider]) throw new Error(`unknown provider ${provider}`);
  if (!apiKey && provider !== "compatible") throw new Error("an API key is required");
  if (!model) throw new Error("a model name is required");
  if (!base) throw new Error("a base URL is required for an OpenAI-compatible provider");

  const add = (i, o) => { usage.calls++; usage.input += i || 0; usage.output += o || 0; };

  async function withReasoningFallback(fn) {
    try {
      return await fn(effort);
    } catch (e) {
      if (effort !== "none" && rejectsReasoning(e)) {
        log({ kind: "fallback", what: `${model} rejected reasoning effort "${effort}"; continuing without it` });
        effort = "none";
        return await fn(effort);
      }
      throw e;
    }
  }

  // -- providers ------------------------------------------------------------------------------------------------

  async function openaiResponses(req, eff, signal, search) {
    const body = { model, input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: req.maxTokens || 16000 };
    if (req.system) body.instructions = req.system;
    if (eff !== "none") body.reasoning = { effort: eff };
    if (search) body.tools = [{ type: "web_search" }];
    const data = await post(`${base}/responses`, { authorization: `Bearer ${apiKey}` }, body, { fetchImpl, signal });
    const text = data.output_text ?? (data.output || []).flatMap((o) => (o.content || []).map((c) => c.text || "")).join("");
    add(data.usage?.input_tokens, data.usage?.output_tokens);
    return text;
  }

  async function chatCompletions(req, eff, signal, extra = {}) {
    const body = { model, messages: chatMessages(req.system, req.messages), ...extra };
    if (provider === "openrouter") {
      if (eff !== "none") body.reasoning = { effort: eff };
    } else if (eff !== "none") {
      body.reasoning_effort = eff;
    }
    body.max_completion_tokens = req.maxTokens || 16000;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    if (provider === "openrouter") { headers["HTTP-Referer"] = "https://github.com/Aviroop07/scribbledb"; headers["X-Title"] = "ScribbleDB"; }
    let data;
    try {
      data = await post(`${base}/chat/completions`, headers, body, { fetchImpl, signal });
    } catch (e) {
      // some compatible servers only know max_tokens
      if (e instanceof LLMError && e.status === 400 && /max_completion_tokens/i.test(e.body || "")) {
        delete body.max_completion_tokens; body.max_tokens = req.maxTokens || 16000;
        data = await post(`${base}/chat/completions`, headers, body, { fetchImpl, signal });
      } else throw e;
    }
    add(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    return data.choices?.[0]?.message?.content || "";
  }

  async function anthropic(req, eff, signal, search) {
    const max = req.maxTokens || 16000;
    const body = { model, max_tokens: max, messages: req.messages };
    if (req.system) body.system = req.system;
    if (eff !== "none") {
      const budget = THINKING_BUDGET[eff];
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = Math.max(max, budget + 8000);
    }
    if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
    const data = await post(`${base}/messages`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true" }, body, { fetchImpl, signal });
    add(data.usage?.input_tokens, data.usage?.output_tokens);
    return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  }

  async function gemini(req, eff, signal, search) {
    const body = { contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: req.maxTokens || 16000 } };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (eff !== "none") body.generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET[eff] };
    if (search) body.tools = [{ google_search: {} }];
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const data = await post(url, {}, body, { fetchImpl, signal });
    add(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
    return (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  }

  async function once(req, signal, search) {
    return withReasoningFallback(async (eff) => {
      if (provider === "openai") {
        if (!openaiChatOnly) {
          try { return await openaiResponses(req, eff, signal, search); } catch (e) {
            if (e instanceof LLMError && (e.status === 404 || (e.status === 400 && /responses|input/i.test(e.body || "") && !rejectsReasoning(e) && !(search && rejectsTools(e))))) {
              log({ kind: "fallback", what: "the Responses API is unavailable for this model; using Chat Completions" });
              openaiChatOnly = true;
            } else throw e;
          }
        }
        return chatCompletions(req, eff, signal);
      }
      if (provider === "anthropic") return anthropic(req, eff, signal, search);
      if (provider === "gemini") return gemini(req, eff, signal, search);
      if (provider === "openrouter") return chatCompletions(req, eff, signal, search ? { plugins: [{ id: "web" }] } : {});
      return chatCompletions(req, eff, signal);
    });
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
        if (signal && signal.aborted) throw e;
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

  return { complete, research, usage, get effort() { return effort; } };
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
    try { return JSON.parse(c); } catch { /* next */ }
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
