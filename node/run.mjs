// Headless runner: the same pipeline as the web app, from the command line.
//   node node/run.mjs --provider openai --model <name> [--effort medium] [--rounds 3] [--max-calls 150]
//        (--description "..." | --description-file f.txt) [--out out/]
// The API key comes from the environment: SCRIBBLE_API_KEY, else the provider's usual variable (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY). It is never printed.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLLM } from "../web/core/llm.js";
import { Pipeline, PipelineError } from "../web/core/pipeline.js";
import { packageFiles } from "../web/core/package.js";
import { nodeRuntime } from "./runtime-node.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const provider = opt("provider", "openai");
const ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY", compatible: "COMPATIBLE_API_KEY" };
const apiKey = process.env.SCRIBBLE_API_KEY || process.env[ENV[provider]] || "";
const description = opt("description") || readFileSync(opt("description-file"), "utf8");
const out = opt("out", "out");
mkdirSync(out, { recursive: true }); // usage.json is written even when the run stops before any package file

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s`;
const llm = createLLM({ provider, model: opt("model"), apiKey, baseUrl: opt("base-url", ""), effort: opt("effort", "medium"),
  log: (e) => console.log(`${stamp()} [fallback] ${e.what}`) });
// every model call, request and response, one JSON line each (out/calls.jsonl), for reading a run call by call
const callLog = join(out, "calls.jsonl");
writeFileSync(callLog, "");
for (const name of ["complete", "research"]) {
  const inner = llm[name].bind(llm);
  llm[name] = async (...a) => {
    const at = Date.now();
    try {
      const r = await inner(...a);
      appendFileSync(callLog, JSON.stringify({ name, seconds: (Date.now() - at) / 1000, request: name === "research" ? { question: a[0], system: a[1] } : a[0], response: r }) + "\n");
      return r;
    } catch (e) {
      appendFileSync(callLog, JSON.stringify({ name, seconds: (Date.now() - at) / 1000, request: a[0], error: String(e.message) }) + "\n");
      throw e;
    }
  };
}
const runtime = nodeRuntime({ hashSeed: 0 });
const checkRuntime = nodeRuntime({ hashSeed: 1 }); // rebuilds each stage under another string-hash seed
const pipe = new Pipeline({ llm, runtime, checkRuntime, runId: opt("run-id", `cli-${Date.now()}`),
  settings: { auditRounds: Number(opt("rounds", 3)), maxCalls: Number(opt("max-calls", 150)) },
  emit: (e) => {
    if (e.type === "step" && e.status !== "running") console.log(`${stamp()} [${e.phase}] ${e.status.toUpperCase()} ${e.title}${e.detail ? ` -- ${String(e.detail).split("\n")[0].slice(0, 220)}` : ""}`);
    else if (e.type === "step") console.log(`${stamp()} [${e.phase}] ... ${e.title}`);
  } });

function write(state) {
  for (const [name, content] of Object.entries(packageFiles(state, { provider, model: opt("model") }))) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), content);
  }
}

let code = 0;
try {
  const state = await pipe.run(description);
  write(state);
  console.log(`${stamp()} DONE: package in ${out}`);
} catch (e) {
  code = 1;
  console.log(`${stamp()} STOPPED: ${e.message}`);
  if (e instanceof PipelineError && pipe.state.schema) { write(pipe.state); console.log(`partial package in ${out}`); }
} finally {
  const u = llm.usage;
  console.log(`usage: ${u.calls} calls, ${u.input} input tokens, ${u.output} output tokens`);
  writeFileSync(join(out, "usage.json"), JSON.stringify(u));
  runtime.close();
  checkRuntime.close();
}
process.exit(code);
