// A PyRuntime backed by a Node worker thread. hashSeed: the worker's PYTHONHASHSEED (see web/worker.js).
//
// slots/slotDir (default: env SDB_CPU_SLOTS, SDB_CPU_SLOT_DIR): a machine-wide cap on runtime calls in flight across
// processes, for evaluations that run many pipelines at once (autotune). Stage time limits are wall-clock, so without
// it machine load turns into time-limit failures that a single user's browser would never see. A call's time limit
// starts once it holds a slot. A slot is a directory slotDir/slot-<i> holding its owner's pid; a slot whose owner is
// gone (a killed run) is reclaimed. No slots configured: no cap (tests, a single run).
//
// searchUrl (default: env SDB_SEARCH_URL): a local search service (openserp serve); the runtime then carries web tools
// (runtime.web, web/core/websearch.js) and the pipeline's research step searches through them. Unset: no web tools.
import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PyRuntime } from "../web/core/runtime.js";
import { createWebTools } from "../web/core/websearch.js";

const POLL_MS = 100;
const PID_GRACE_MS = 5000; // a slot just taken may not hold its pid file yet

export function nodeRuntime({ hashSeed = 0, slots = Number(process.env.SDB_CPU_SLOTS || 0), slotDir = process.env.SDB_CPU_SLOT_DIR || "",
  searchUrl = process.env.SDB_SEARCH_URL || "" } = {}) {
  const spawn = () => {
    const w = new Worker(new URL("./py-worker.mjs", import.meta.url), { workerData: { hashSeed } });
    return {
      post: (msg) => w.postMessage(msg),
      onMessage: (cb) => { w.on("message", cb); w.on("error", (e) => cb({ type: "fatal", error: String(e && e.message ? e.message : e) })); },
      terminate: () => w.terminate(),
    };
  };
  const rt = slots > 0 && slotDir ? new SlottedRuntime(spawn, slots, slotDir) : new PyRuntime(spawn);
  if (searchUrl) rt.web = createWebTools({ searchUrl });
  return rt;
}

class SlottedRuntime extends PyRuntime {
  constructor(spawn, slots, slotDir) {
    super(spawn);
    this.slots = slots;
    this.slotDir = slotDir;
    mkdirSync(slotDir, { recursive: true });
  }

  async call(fn, args, opts = {}) {
    if (this.closed) return super.call(fn, args, opts);
    const release = await acquireSlot(this.slotDir, this.slots);
    try {
      return await super.call(fn, args, opts);
    } finally {
      release();
    }
  }
}

// fsx: the file operations, replaceable in tests
export async function acquireSlot(dir, n, fsx = { mkdirSync, writeFileSync, rmSync }) {
  const release = (slot) => () => {
    // a release that Windows refuses for a moment must not fail the call that held the slot; the directory then
    // looks stale (its pid is this process, so it is reclaimed when this process is gone) or is removed on a retry
    for (let t = 0; t < 5; t++) {
      try { fsx.rmSync(slot, { recursive: true, force: true }); return; } catch { /* retry */ }
    }
  };
  for (;;) {
    for (let i = 0; i < n; i++) {
      const slot = join(dir, `slot-${i}`);
      try {
        fsx.mkdirSync(slot);
      } catch (e) {
        // EPERM/EACCES/EBUSY: on Windows a slot directory that another process is deleting cannot be created for a
        // moment (loop-2 runs 2026-10-24 ended as "unexpected error: EPERM ... mkdir slot-N"); treat it as occupied
        if (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY") continue;
        if (e.code !== "EEXIST") throw e;
        if (stale(slot)) rmSync(slot, { recursive: true, force: true });
        continue;
      }
      fsx.writeFileSync(join(slot, "pid"), String(process.pid));
      return release(slot);
    }
    await new Promise((r) => setTimeout(r, POLL_MS + Math.random() * POLL_MS));
  }
}

function stale(slot) {
  let pid;
  try {
    pid = Number(readFileSync(join(slot, "pid"), "utf8"));
  } catch {
    try { return Date.now() - statSync(slot).mtimeMs > PID_GRACE_MS; } catch { return false; }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}
