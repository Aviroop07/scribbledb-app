// Offline support for the installed app. The app's own files are fetched network-first (the cache answers only when
// offline): cache-first would serve an old app.js next to a new core/ module after an update, and the two halves of
// one load must come from the same version. The Python runtime and JSZip come from version-pinned CDN URLs, so they
// are cache-first. Model calls are never cached.
const CACHE = "scribbledb-v7-3";
const SHELL = ["./", "index.html", "style.css", "app.js", "worker.js", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "icon-512.png", "core/llm.js", "core/pipeline.js", "core/prompts.js", "core/runtime.js", "core/package.js",
  "core/py-handler.js", "py/harness.py"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const own = url.origin === self.location.origin;
  const pinned = url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/") || url.hostname === "cdnjs.cloudflare.com";
  if (e.request.method !== "GET" || !(own || pinned)) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    if (pinned) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true }); // worker.js?hashseed=N is worker.js
      if (hit) return hit;
      throw err;
    }
  }));
});
