// The browser's Python runtime: Pyodide (CPython compiled to WebAssembly) with SQLite, running harness.py.
// ?hashseed=N sets PYTHONHASHSEED: the pipeline builds each stage again in a second worker with another hash seed to
// catch programs whose rows depend on set/dict iteration order of strings (Pyodide randomizes string hashing per
// start, and a native 64-bit CPython orders such sets differently whatever the seed - experiments/hashseed.mjs).
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs";
import { createHandler } from "./core/py-handler.js";

let handle = null;
const queue = [];
const hashSeed = new URL(self.location.href).searchParams.get("hashseed") || "0";

async function start() {
  try {
    const harness = await (await fetch(new URL("./py/harness.py", import.meta.url))).text();
    handle = await createHandler(loadPyodide, harness, { indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
      env: { PYTHONHASHSEED: hashSeed } });
    self.postMessage({ type: "ready" });
    for (const m of queue.splice(0)) answer(m);
  } catch (e) {
    self.postMessage({ type: "fatal", error: String(e && e.message ? e.message : e) });
  }
}

async function answer(msg) {
  const reply = await handle(msg);
  self.postMessage({ id: msg.id, ...reply }, reply.db ? [reply.db.buffer] : []);
}

self.onmessage = (ev) => (handle ? answer(ev.data) : queue.push(ev.data));
start();
