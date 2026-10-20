// A PyRuntime backed by a Node worker thread.
import { Worker } from "node:worker_threads";
import { PyRuntime } from "../web/core/runtime.js";

export function nodeRuntime() {
  return new PyRuntime(() => {
    const w = new Worker(new URL("./py-worker.mjs", import.meta.url));
    return {
      post: (msg) => w.postMessage(msg),
      onMessage: (cb) => w.on("message", cb),
      terminate: () => w.terminate(),
    };
  });
}
