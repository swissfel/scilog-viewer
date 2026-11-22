// SciLog viewer in the browser: images and attachments, and the viewer itself offline.
//
// A post's HTML points at img/<id> and file/<id> beside the page, as with the local
// server. SciLog serves them only with the token in a header, which an <img> or an
// <iframe> cannot send, so this worker fetches them with it and keeps them in the
// browser's cache. The token comes from the page (browser.js): sent when the page starts
// or the token changes, and asked for again when this worker was stopped in between.
//
// Offline copies (browser.js, "offline copies"): their files are served from IndexedDB
// before anything is fetched, so that they show without a network and without a token;
// files kept in a folder come from the page, which holds the folder's permission. The
// viewer's own files (SHELL, filled in by tools/build_web.py) are kept too: fetched afresh
// whenever there is a network, taken from the cache when there is none.
"use strict";

const SHELL = [];          // the site's files: written by tools/build_web.py
const VERSION = "dev";     // likewise: a new build makes a new shell cache
const SHELL_CACHE = `scilog-viewer-shell-${VERSION}`;
const CACHE = "scilog-viewer-files-v1";
const FILE = /\/(img|file)\/([0-9a-f]{24})$/;
//: files kept in the browser's cache; past this the oldest go (they are fetched again when needed)
const KEEP = 600;
let auth = null;  // {token, api}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((p) => new URL(p, self.registration.scope).href))).catch(() => {}));
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith("scilog-viewer-shell-") && name !== SHELL_CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener("message", (e) => {
  if (e.data && e.data.auth) auth = e.data.auth;
  if (e.data && e.data.forgetFiles) e.waitUntil(caches.delete(CACHE));
});

/** Ask a window of this site: for the token ({want: "auth"}) or a file kept in the folder ({want: "file", id}). */
async function askPage(message, ok = (got) => got && got.token) {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    const got = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      client.postMessage(message, [channel.port2]);
      setTimeout(() => resolve(null), 4000);
    });
    if (ok(got)) return got;
  }
  return null;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  const m = url.pathname.match(FILE);
  if (m) e.respondWith(serve(m[1], m[2], url.searchParams.has("download"), url.searchParams.get("name")));
  else if (e.request.mode === "navigate" || isShell(url)) e.respondWith(shell(e.request, url));
});

function isShell(url) {
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  return SHELL.includes(path);
}

/** The viewer's own files: from the network when there is one (and kept), else as kept. */
async function shell(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const r = await fetch(request);
    if (r.ok && r.type === "basic") cache.put(url.origin + url.pathname, r.clone());
    return r;
  } catch (err) {
    const here = url.origin + url.pathname;
    return (await cache.match(here)) || (await cache.match(here, { ignoreSearch: true }))
      || (request.mode === "navigate" ? await cache.match(new URL("index.html", self.registration.scope).href) : null)
      || text(503, "The SciLog viewer is offline and was not kept in this browser yet.");
  }
}

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function trim(cache) {
  const keys = await cache.keys();  // in the order they were put
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) await cache.delete(k);
}

// -- offline copies: IndexedDB "scilog-viewer-offline", as browser.js writes it

function kept(id) {
  return new Promise((resolve) => {
    const open = indexedDB.open("scilog-viewer-offline");
    open.onupgradeneeded = () => { open.transaction.abort(); resolve(null); };  // none made in this browser
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("files")) { db.close(); resolve(null); return; }
      const get = db.transaction("files").objectStore("files").get(id);
      get.onsuccess = () => { db.close(); resolve(get.result || null); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  });
}

async function offlineFile(id) {
  const rec = await kept(id);
  if (!rec) return null;
  if (rec.blob) return rec;
  const got = await askPage({ want: "file", id }, (g) => g && g.blob);  // kept in the folder: the page reads it
  return got ? { ...rec, ...got } : null;
}

async function serve(kind, id, download, asked) {
  const cache = await caches.open(CACHE);
  const key = new URL(`${kind}/${id}`, self.registration.scope).href;
  let r = await cache.match(key);
  if (!r) {
    const off = await offlineFile(id);
    if (off) r = new Response(off.blob, { headers: { "Content-Type": off.type || "application/octet-stream", "X-Name": off.name || "" } });
  }
  if (!r) {
    if (!auth || !auth.token) auth = await askPage({ want: "auth" });
    if (!auth || !auth.token) return text(401, "no SciLog token in this browser yet, and no offline copy of this file");
    const path = kind === "img" ? `/images/${id}` : `/filesnippet/${id}/files`;
    try {
      r = await fetch(auth.api + path, { headers: { Authorization: `Bearer ${auth.token}` }, mode: "cors", credentials: "omit" });
    } catch (err) {
      return text(502, "SciLog could not be reached (no network, or SciLog does not let this web site call it)");
    }
    if (!r.ok) return text(r.status, `SciLog: ${r.status} ${r.statusText}`);
    // SciLog names the file in Content-Disposition, readable here only if SciLog exposes it
    const name = (r.headers.get("content-disposition") || "").match(/filename="?([^";]+)/);
    const headers = { "Content-Type": r.headers.get("content-type") || "application/octet-stream", "X-Name": name ? name[1] : "" };
    r = new Response(await r.blob(), { headers });
    await cache.put(key, r.clone());
    trim(cache);  // not waited for
  }
  const type = r.headers.get("content-type") || "application/octet-stream";
  // every file in a sandbox of its own: an SVG or HTML opened by itself must not run in this site's origin,
  // where the token is kept (a plot gets scripts, below, but still no origin of its own)
  const headers = new Headers({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox" });
  if (kind === "img") {
    if (!type.startsWith("image/")) return text(415, "not an image");
  } else if (download || !type.includes("html")) {
    // the name SciLog gave (if it let this site read it), else the one the link carries, else the id
    const name = (r.headers.get("X-Name") || asked || id).replace(/[\u0000-\u001f"\\/]/g, "_").slice(0, 200);
    if (type.startsWith("text/html")) headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  } else {
    // an interactive plot: its scripts run, in an origin of their own (no token, no page)
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "sandbox allow-scripts");
  }
  return new Response(await r.blob(), { headers });
}
