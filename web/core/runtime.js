// PyRuntime: calls into harness.py inside a worker, with a time limit per call. A call that exceeds its limit kills
// the worker (the only way to stop a runaway generator in WebAssembly) and a fresh one starts on the next call.
// `spawn()` returns {post(msg), onMessage(cb), terminate()} - a browser Worker or a Node worker thread.
//
// The time limit covers the worker's start too (the first start downloads the Python runtime: a stalled download
// must end the call, not hang it). A start that fails is forgotten, so the next call starts a fresh worker. After
// close() every call is refused: a pipeline still running after the user pressed Stop must not start a new worker.

export class TimeoutError extends Error {}

export class PyRuntime {
  constructor(spawn) {
    this.spawn = spawn;
    this.worker = null;
    this.ready = null;
    this.abortStart = null;
    this.closed = false;
    this.seq = 0;
    this.pending = new Map();
  }

  _start() {
    if (this.closed) return Promise.reject(new Error("runtime closed"));
    if (this.worker) return this.ready;
    const w = this.spawn();
    this.worker = w;
    this.ready = new Promise((resolve, reject) => {
      this.abortStart = reject;
      w.onMessage((msg) => {
        if (msg.type === "ready") { this.abortStart = null; resolve(); return; }
        if (msg.type === "fatal") { this._kill(new Error(`the Python runtime failed to start: ${msg.error}`)); return; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
      });
    });
    return this.ready;
  }

  _kill(reason) {
    if (!this.worker) return;
    try { this.worker.terminate(); } catch { /* already gone */ }
    this.worker = null;
    this.ready = null;
    if (this.abortStart) { const abort = this.abortStart; this.abortStart = null; abort(reason); }
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
  }

  // fn: a harness.py function; args: JSON object; opts: {db, dbs, wantDb, code, timeoutMs}
  async call(fn, args, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 120000;
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new TimeoutError(`${fn} ran over ${Math.round(timeoutMs / 1000)} s`);
        this._kill(e);
        reject(e);
      }, timeoutMs);
    });
    try {
      await Promise.race([this._start(), limit]);
      const id = ++this.seq;
      const msg = { id, fn, args, db: opts.db, dbs: opts.dbs, wantDb: !!opts.wantDb, code: opts.code };
      const reply = await Promise.race([new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.post(msg);
      }), limit]);
      if (!reply.ok) throw new Error(`harness ${fn} failed: ${reply.error}`);
      return { result: reply.result, db: reply.db };
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    this.closed = true;
    this._kill(new Error("runtime closed"));
  }
}
