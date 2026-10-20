// A PyRuntime backed by a Node worker thread. hashSeed: the worker's PYTHONHASHSEED (see web/worker.js).
import { Worker } from "node:worker_threads";
import { PyRuntime } from "../web/core/runtime.js";

export function nodeRuntime({ hashSeed = 0 } = {}) {
  return new PyRuntime(() => {
    const w = new Worker(new URL("./py-worker.mjs", import.meta.url), { workerData: { hashSeed } });
    return {
      post: (msg) => w.postMessage(msg),
      onMessage: (cb) => { w.on("message", cb); w.on("error", (e) => cb({ type: "fatal", error: String(e && e.message ? e.message : e) })); },
      terminate: () => w.terminate(),
    };
  });
}
