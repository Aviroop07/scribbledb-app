// Local mode: the same web app, with the model settings and the key on this machine instead of in the page.
//   node node/local.mjs [port]        (default 8770; listens on 127.0.0.1 only - it holds a key)
// Settings come from the environment:
//   SCRIBBLE_PROVIDER  openai | anthropic | gemini | openrouter | compatible   (default openai)
//   SCRIBBLE_MODEL     the model name                                          (default gpt-6-luna)
//   SCRIBBLE_EFFORT    none | low | medium | high                              (default medium)
//   SCRIBBLE_ROUNDS    audit rounds (default 3);  SCRIBBLE_MAX_CALLS  model-call budget (default 150)
//   SCRIBBLE_BASE_URL  the provider's base URL (required for compatible)
//   the key: SCRIBBLE_API_KEY, else the provider's usual variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...)
// The page reads /local-config.json (provider, model, effort, rounds, budget - never the key), hides its Model card, and
// sends every model call to /proxy/..., which forwards it to the provider with the key added here. Everything else -
// the pipeline, the Python runtime, the timeline, the results - is the published app, unchanged.
// Every proxied call is logged to the console and to out/local/calls.jsonl (requests and responses, no key).
import { createServer } from "node:http";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const LOG_DIR = fileURLToPath(new URL("../out/local/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".py": "text/plain", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".png": "image/png" };
const UPSTREAM = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta", openrouter: "https://openrouter.ai/api/v1" };
const KEY_VARS = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY", compatible: "COMPATIBLE_API_KEY" };

const env = process.env;
const config = {
  provider: env.SCRIBBLE_PROVIDER || "openai",
  model: env.SCRIBBLE_MODEL || "gpt-6-luna",
  effort: env.SCRIBBLE_EFFORT || "medium",
  auditRounds: Number(env.SCRIBBLE_ROUNDS || 3),
  maxCalls: Number(env.SCRIBBLE_MAX_CALLS || 150),
};
const upstream = (env.SCRIBBLE_BASE_URL || UPSTREAM[config.provider] || "").replace(/\/$/, "");
const key = env.SCRIBBLE_API_KEY || env[KEY_VARS[config.provider]] || "";
if (!KEY_VARS[config.provider]) throw new Error(`unknown SCRIBBLE_PROVIDER ${config.provider}`);
if (!upstream) throw new Error("SCRIBBLE_BASE_URL is required for the compatible provider");
if (!key && config.provider !== "compatible") throw new Error(`no API key: set SCRIBBLE_API_KEY or ${KEY_VARS[config.provider]}`);

// the provider's own auth header, added here; whatever auth the page sent (a placeholder) is dropped
function authHeaders() {
  if (!key) return {};
  if (config.provider === "anthropic") return { "x-api-key": key };
  if (config.provider === "gemini") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}
const PASS_HEADERS = ["content-type", "anthropic-version", "anthropic-beta", "http-referer", "x-title"];

const stamp = () => new Date().toISOString().slice(11, 19);
let seq = 0;

async function proxy(req, res, path) {
  const id = ++seq;
  let body = "";
  for await (const chunk of req) body += chunk;
  const headers = { ...authHeaders() };
  for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  const url = `${upstream}/${path}`;
  const t0 = Date.now();
  console.log(`${stamp()} call ${id} -> ${config.provider} /${path.split("?")[0]} (${body.length} bytes)`);
  let status = 502;
  let text = "";
  try {
    const r = await fetch(url, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
    status = r.status;
    text = await r.text();
  } catch (e) {
    text = JSON.stringify({ error: { message: `local proxy could not reach ${config.provider}: ${e.message}` } });
  }
  const seconds = (Date.now() - t0) / 1000;
  console.log(`${stamp()} call ${id} <- HTTP ${status} in ${seconds.toFixed(1)} s (${text.length} bytes)`);
  await appendFile(join(LOG_DIR, "calls.jsonl"), JSON.stringify({ id, at: new Date().toISOString(), path: path.split("?")[0], status, seconds,
    request: safeJson(body), response: safeJson(text) }) + "\n").catch(() => {});
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function serveFile(req, res) {
  const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  const file = join(ROOT, rel || "index.html");
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file.endsWith("\\") || file.endsWith("/") ? join(file, "index.html") : file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}

await mkdir(LOG_DIR, { recursive: true });
const port = Number(process.argv[2] || 8770);
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/local-config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(config));
  } else if (path.startsWith("/proxy/")) {
    await proxy(req, res, req.url.slice("/proxy/".length));
  } else {
    await serveFile(req, res);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`local ScribbleDB on http://127.0.0.1:${port}  (${config.provider} / ${config.model}, effort ${config.effort}, ` +
    `${config.auditRounds} audit rounds, budget ${config.maxCalls} calls; key held here, not in the page)`);
});
