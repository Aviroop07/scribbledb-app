// The provider layer against a fake fetch: request shapes per provider, every fallback, and the errors that must not
// be retried or fallen back on.
import test from "node:test";
import assert from "node:assert/strict";
import { createLLM, isFatal, LLMError } from "../web/core/llm.js";
import { Pipeline, PipelineError } from "../web/core/pipeline.js";

// a fake fetch: `answer(url, body)` returns [status, json] or throws; every request is recorded
function fake(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers || {} });
    const [status, json] = await answer(url, body, calls.length);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), json: async () => json };
  };
  return { fetch, calls };
}
const chatOk = (text) => [200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }];
const respOk = (text) => [200, { output_text: text, usage: { input_tokens: 3, output_tokens: 2 } }];
const QUOTA = [429, { error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "insufficient_quota" } }];

test("OpenAI: Responses API shape, then Chat Completions when the Responses API is unavailable", async () => {
  const f = fake((url) => url.endsWith("/responses") ? [404, { error: { message: "not found" } }] : chatOk("hi"));
  const logs = [];
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "low", fetch: f.fetch, log: (e) => logs.push(e.what) });
  assert.equal((await llm.complete({ system: "S", messages: [{ role: "user", content: "u" }], maxTokens: 50 })).text, "hi");
  const [r, c] = f.calls;
  assert.deepEqual(r.body, { model: "m", input: [{ role: "user", content: "u" }], max_output_tokens: 50, instructions: "S", reasoning: { effort: "low" } });
  assert.equal(r.headers.authorization, "Bearer k");
  assert.deepEqual(c.body.messages, [{ role: "system", content: "S" }, { role: "user", content: "u" }]);
  assert.equal(c.body.reasoning_effort, "low");
  assert.equal(c.body.max_completion_tokens, 50);
  assert.match(logs.join(), /Chat Completions/);
  // the switch is remembered: the next call goes straight to chat
  await llm.complete({ messages: [{ role: "user", content: "u" }] });
  assert.ok(f.calls[2].url.endsWith("/chat/completions"));
  assert.equal(llm.usage.calls, 2);
});

test("a model that rejects the reasoning setting is retried without it, once, and the change sticks", async () => {
  const f = fake((url, body) => body.reasoning ? [400, { error: { message: "Unsupported parameter: 'reasoning.effort'" } }] : respOk("ok"));
  const logs = [];
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "high", fetch: f.fetch, log: (e) => logs.push(e.what) });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }] })).text, "ok");
  assert.equal(llm.effort, "none");
  await llm.complete({ messages: [{ role: "user", content: "u" }] });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].body.reasoning, undefined);
  assert.match(logs.join(), /rejected reasoning effort "high"/);
});

test("a compatible server that only knows max_tokens", async () => {
  const f = fake((url, body) => body.max_completion_tokens ? [400, { error: { message: "unknown field max_completion_tokens" } }] : chatOk("x"));
  const llm = createLLM({ provider: "compatible", model: "m", baseUrl: "http://h/v1/", effort: "none", fetch: f.fetch });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }], maxTokens: 7 })).text, "x");
  assert.equal(f.calls[0].url, "http://h/v1/chat/completions");
  assert.equal(f.calls[1].body.max_tokens, 7);
  assert.equal(f.calls[0].headers.authorization, undefined);
});

test("Anthropic and Gemini request shapes", async () => {
  const a = fake(() => [200, { content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "A" }], usage: { input_tokens: 1, output_tokens: 1 } }]);
  const la = createLLM({ provider: "anthropic", model: "c", apiKey: "k", effort: "low", fetch: a.fetch });
  assert.equal((await la.complete({ system: "S", messages: [{ role: "user", content: "u" }], maxTokens: 1000 })).text, "A");
  const ab = a.calls[0];
  assert.ok(ab.url.endsWith("/messages"));
  assert.equal(ab.body.system, "S");
  assert.deepEqual(ab.body.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.ok(ab.body.max_tokens > 2048);
  assert.equal(ab.headers["x-api-key"], "k");
  assert.equal(ab.headers["anthropic-dangerous-direct-browser-access"], "true");
  const g = fake(() => [200, { candidates: [{ content: { parts: [{ text: "t", thought: true }, { text: "G" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]);
  const lg = createLLM({ provider: "gemini", model: "gm", apiKey: "k", effort: "medium", fetch: g.fetch });
  assert.equal((await lg.complete({ system: "S", messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }, { role: "user", content: "v" }] })).text, "G");
  const gb = g.calls[0];
  assert.match(gb.url, /\/models\/gm:generateContent\?key=k$/);
  assert.deepEqual(gb.body.systemInstruction, { parts: [{ text: "S" }] });
  assert.deepEqual(gb.body.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(gb.body.generationConfig.thinkingConfig, { thinkingBudget: 8192 });
});

test("regression: an account without credits fails at once, is not retried and is not taken for a search failure", async () => {
  // live run 2026-10-20: a 429 insufficient_quota was retried 4 times (30 s) and then read as "web search failed"
  const f = fake(() => QUOTA);
  const logs = [];
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", fetch: f.fetch, log: (e) => logs.push(e.what) });
  await assert.rejects(llm.research("q", "S"), (e) => isFatal(e) && e.status === 429);
  assert.equal(f.calls.length, 1);
  assert.equal(logs.length, 0);
  for (const status of [401, 403]) assert.ok(isFatal(new LLMError("x", status, "")));
  assert.ok(!isFatal(new LLMError("x", 429, "Rate limit reached for requests")));
});

test("a failing native web search falls back to Wikipedia, then to model knowledge", async () => {
  let wiki = true;
  const f = fake((url, body) => {
    if (url.includes("wikipedia.org/w/api.php")) {
      if (!wiki) throw new Error("offline");
      return [200, { query: { search: [{ title: "Library" }] } }];
    }
    if (url.includes("wikipedia.org/api/rest_v1")) return [200, { extract: "A library is a collection." }];
    return body.tools ? [400, { error: { message: "web_search tool is not supported" } }] : respOk("answer");
  });
  const logs = [];
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: f.fetch, log: (e) => logs.push(e.what) });
  const r = await llm.research("What do library loans look like?", "S");
  assert.equal(r.source, "Wikipedia search");
  assert.match(f.calls.at(-1).body.input[0].content, /A library is a collection/);
  assert.match(logs.join(), /built-in web search failed/);
  wiki = false;
  const llm2 = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: f.fetch, log: (e) => logs.push(e.what) });
  assert.equal((await llm2.research("What do library loans look like?", "S")).source, "model knowledge (no search available)");
});

test("regression: a provider error no retry can fix ends the pipeline instead of using up its attempts", async () => {
  // root cause: the attempt loops caught every error from ask() as a bad answer (plan fell back to the default plan)
  const f = fake(() => [401, { error: { message: "Incorrect API key provided" } }]);
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "bad", effort: "none", fetch: f.fetch });
  const p = new Pipeline({ llm, runtime: null, emit: () => {}, runId: "r", settings: { research: true } });
  await assert.rejects(p.run("A description long enough to pass the length check."), (e) => e instanceof PipelineError && /refused/.test(e.message));
  assert.equal(f.calls.length, 1);
});
