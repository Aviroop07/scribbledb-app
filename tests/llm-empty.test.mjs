// An empty answer is asked again once before it counts as a failure (live, OpenRouter 2026-10-25: one empty reply on
// an audit turn ended the whole run).
import test from "node:test";
import assert from "node:assert/strict";
import { createLLM } from "../web/core/llm.js";

const chat = (text) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } }) });

test("regression: one empty answer is asked again and the second answer is used", async () => {
  const answers = ["", "the answer"];
  const logs = [];
  const llm = createLLM({ provider: "openrouter", model: "m", apiKey: "k", effort: "none", fetch: async () => chat(answers.shift()),
    log: (e) => logs.push(e.what) });
  assert.equal((await llm.complete({ messages: [{ role: "user", content: "u" }] })).text, "the answer");
  assert.equal(llm.usage.calls, 2); // both requests are counted
  assert.match(logs.join(), /empty answer; asking again/);
});

test("two empty answers in a row are a failure", async () => {
  let n = 0;
  const llm = createLLM({ provider: "openrouter", model: "m", apiKey: "k", effort: "none", fetch: async () => { n++; return chat("  "); } });
  await assert.rejects(llm.complete({ messages: [{ role: "user", content: "u" }] }), /empty answer/);
  assert.equal(n, 2);
});
