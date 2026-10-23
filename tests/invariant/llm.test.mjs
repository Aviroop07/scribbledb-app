// The provider layer against a fake fetch: request shapes per provider, every fallback, and the errors that must not
// be retried or fallen back on.
import test from "node:test";
import assert from "node:assert/strict";
import { createLLM, isFatal, LLMError } from "../../web/core/llm.js";
import { Pipeline, PipelineError } from "../../web/core/pipeline.js";

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
  assert.match(gb.url, /\/models\/gm:generateContent$/);
  assert.equal(gb.headers["x-goog-api-key"], "k"); // the key in a header, not in the URL
  assert.ok(gb.body.generationConfig.maxOutputTokens >= 8192 + 4000); // thinking fits inside the output limit
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

test("regression: a rejected search tool does not switch reasoning off for the rest of the run", async () => {
  // root cause: the reasoning fallback matched any 400 saying "not supported"
  const f = fake((url, body) => body.tools ? [400, { error: { message: "Hosted tool 'web_search' is not supported with this model." } }] : respOk("ok"));
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "medium", fetch: f.fetch });
  await llm.research("What do library loans look like?", "S");
  assert.equal(llm.effort, "medium");
  assert.deepEqual(f.calls.at(-1).body.reasoning, { effort: "medium" });
});

test("regression: after the Chat Completions fallback, research does not claim a web search that never ran", async () => {
  const f = fake((url) => {
    if (url.endsWith("/responses")) return [404, { error: { message: "not found" } }];
    if (url.includes("wikipedia.org/w/api.php")) return [200, { query: { search: [] } }];
    return chatOk("answer");
  });
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: f.fetch });
  const r = await llm.research("What do library loans look like?", "S");
  assert.notEqual(r.source, "OpenAI web search");
  assert.equal(r.source, "model knowledge (no search available)");
});

test("regression: an answer cut off at the output limit is asked again with a higher limit, then fails loudly", async () => {
  let n = 0;
  const f = fake((url, body) => (++n === 1 ? [200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }] : respOk(`ok ${body.max_output_tokens}`)));
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: f.fetch });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }], maxTokens: 1000 })).text, "ok 2000");
  const g = fake(() => [200, { choices: [{ message: { content: "partial" }, finish_reason: "length" }] }]);
  const l2 = createLLM({ provider: "compatible", model: "m", baseUrl: "http://h/v1", effort: "none", fetch: g.fetch });
  await assert.rejects(l2.complete({ messages: [{ role: "user", content: "u" }], maxTokens: 1000 }), /cut off/);
  assert.equal(g.calls.length, 2);
  const empty = fake(() => respOk(""));
  const l3 = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: empty.fetch });
  await assert.rejects(l3.complete({ messages: [{ role: "user", content: "u" }] }), /empty answer/);
});

test("regression: a model with a smaller output cap gets a lower limit instead of failing the run", async () => {
  const f = fake((url, body) => body.max_tokens > 8192 ? [400, { error: { message: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens" } }] : [200, { content: [{ type: "text", text: "A" }], stop_reason: "end_turn" }]);
  const llm = createLLM({ provider: "anthropic", model: "c", apiKey: "k", effort: "none", fetch: f.fetch });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }], maxTokens: 32000 })).text, "A");
  assert.equal(llm.tokenCap, 8192);
  await llm.complete({ messages: [{ role: "user", content: "u" }], maxTokens: 32000 });
  assert.equal(f.calls.length, 3);
});

test("Anthropic: a paused server-tool turn is continued and its text joined", async () => {
  let n = 0;
  const f = fake((url, body) => (++n === 1 ? [200, { content: [{ type: "text", text: "part one. " }, { type: "server_tool_use", id: "s", name: "web_search", input: {} }], stop_reason: "pause_turn" }] :
    [200, { content: [{ type: "text", text: `part two (${body.messages.length} msgs)` }], stop_reason: "end_turn" }]));
  const llm = createLLM({ provider: "anthropic", model: "c", apiKey: "k", effort: "none", fetch: f.fetch });
  const r = await llm.research("What do library loans look like?", "S");
  assert.equal(r.text, "part one. part two (2 msgs)");
  assert.equal(f.calls[1].body.messages[1].role, "assistant");
});

test("regression: a request that never answers is abandoned at its time limit and retried", async () => {
  // root cause: fetch had no time limit, so a stalled connection hung the command-line runner forever
  let n = 0;
  const fetch = (url, init) => {
    if (++n === 1) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: "late but fine" }) });
  };
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch, requestTimeoutMs: 50 });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }] })).text, "late but fine");
  assert.equal(n, 2);
  // the user's Stop still ends it at once
  const stop = new AbortController();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const l2 = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "none", fetch: hang });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(l2.complete({ messages: [{ role: "user", content: "u" }] }, stop.signal), /aborted/);
});

test("Responses: reasoning items are not taken for the answer", async () => {
  const f = fake(() => [200, { status: "completed", output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "THINKING" }] },
    { type: "message", content: [{ type: "output_text", text: "ANSWER" }] }] }]);
  const llm = createLLM({ provider: "openai", model: "m", apiKey: "k", effort: "low", fetch: f.fetch });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }] })).text, "ANSWER");
});
