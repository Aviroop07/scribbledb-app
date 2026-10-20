// The Python side of a runtime worker, shared by the browser Web Worker (web/worker.js) and the Node worker thread
// (node/py-worker.mjs): load Pyodide + sqlite3 + harness.py once, then answer {id, fn, args, db, dbs} messages.
// Kept free of browser/Node globals: the caller passes `loadPyodide` and the harness source.

export async function createHandler(loadPyodide, harnessSource, pyodideOptions = {}) {
  const py = await loadPyodide(pyodideOptions);
  await py.loadPackage(["sqlite3"]);
  py.runPython(harnessSource);
  const call = py.globals.get("call");
  const lastDb = py.globals.get("last_db");
  return async function handle(msg) {
    const { fn, args, db, dbs, wantDb } = msg;
    try {
      // packages a program imports (numpy, ...): Pyodide fetches them from its CDN on first use
      if (msg.code) await py.loadPackagesFromImports(msg.code);
      const json = call(fn, JSON.stringify(args || {}), db || undefined, dbs || undefined);
      const result = JSON.parse(json);
      let out = undefined;
      if (wantDb) {
        const proxy = lastDb();
        out = proxy.toJs();
        proxy.destroy();
      }
      return { ok: true, result, db: out };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e).slice(-3000) };
    }
  };
}
