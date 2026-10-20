// Node worker thread for PyRuntime (tests and the headless runner).
import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import { createHandler } from "../web/core/py-handler.js";

const harness = await readFile(fileURLToPath(new URL("../web/py/harness.py", import.meta.url)), "utf8");
let handle;
try {
  handle = await createHandler(loadPyodide, harness);
  parentPort.postMessage({ type: "ready" });
} catch (e) {
  parentPort.postMessage({ type: "fatal", error: String(e) });
}
parentPort.on("message", async (msg) => {
  const reply = await handle(msg);
  parentPort.postMessage({ id: msg.id, ...reply });
});
