// PyRuntime: calls into harness.py inside a worker, with a time limit per call. A call that exceeds its limit kills
// the worker (the only way to stop a runaway generator in WebAssembly) and a fresh one starts on the next call.
// `spawn()` returns {post(msg), onMessage(cb), terminate()} - a browser Worker or a Node worker thread.

export class TimeoutError extends Error {}

export class PyRuntime {
  constructor(spawn) {
    this.spawn = spawn;
    this.worker = null;
    this.ready = null;
    this.seq = 0;
    this.pending = new Map();
  }

  _start() {
    if (this.worker) return this.ready;
    const w = this.spawn();
    this.worker = w;
    this.ready = new Promise((resolve, reject) => {
      w.onMessage((msg) => {
        if (msg.type === "ready") return resolve();
        if (msg.type === "fatal") return reject(new Error(msg.error));
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      });
    });
    return this.ready;
  }

  _kill(reason) {
    if (!this.worker) return;
    try { this.worker.terminate(); } catch { /* already gone */ }
    this.worker = null;
    this.ready = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
  }

  // fn: a harness.py function; args: JSON object; opts: {db, dbs, wantDb, code, timeoutMs}
  async call(fn, args, opts = {}) {
    await this._start();
    const id = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? 120000;
    const msg = { id, fn, args, db: opts.db, dbs: opts.dbs, wantDb: !!opts.wantDb, code: opts.code };
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._kill(new TimeoutError(`${fn} ran over ${Math.round(timeoutMs / 1000)} s`));
        reject(new TimeoutError(`${fn} ran over ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.post(msg);
    });
    if (!reply.ok) throw new Error(`harness ${fn} failed: ${reply.error}`);
    return { result: reply.result, db: reply.db };
  }

  close() { this._kill(new Error("runtime closed")); }
}
