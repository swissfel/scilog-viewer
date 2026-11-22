// SciLog viewer in the browser: images and attachments.
//
// A post's HTML points at img/<id> and file/<id> beside the page, as with the local
// server. SciLog serves them only with the token in a header, which an <img> or an
// <iframe> cannot send, so this worker fetches them with it and keeps them in the
// browser's cache. The token comes from the page (browser.js): sent when the page starts
// or the token changes, and asked for again when this worker was stopped in between.
"use strict";

const CACHE = "scilog-viewer-files-v1";
const FILE = /\/(img|file)\/([0-9a-f]{24})$/;
let auth = null;  // {token, api}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  if (e.data && e.data.auth) auth = e.data.auth;
  if (e.data && e.data.forgetFiles) e.waitUntil(caches.delete(CACHE));
});

async function askPage() {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    const got = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      client.postMessage({ want: "auth" }, [channel.port2]);
      setTimeout(() => resolve(null), 2000);
    });
    if (got && got.token) return got;
  }
  return null;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const m = url.origin === location.origin && e.request.method === "GET" ? url.pathname.match(FILE) : null;
  if (m) e.respondWith(serve(m[1], m[2], url.searchParams.has("download")));
});

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function serve(kind, id, download) {
  const cache = await caches.open(CACHE);
  const key = new URL(`${kind}/${id}`, self.registration.scope).href;
  let r = await cache.match(key);
  if (!r) {
    if (!auth || !auth.token) auth = await askPage();
    if (!auth || !auth.token) return text(401, "no SciLog token in this browser yet");
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
  }
  const type = r.headers.get("content-type") || "application/octet-stream";
  const headers = new Headers({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (kind === "img") {
    if (!type.startsWith("image/")) return text(415, "not an image");
  } else if (download || !type.includes("html")) {
    const name = (r.headers.get("X-Name") || id).replace(/"/g, "");
    if (type.startsWith("text/html")) headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${name}"`);
  } else {
    // an interactive plot: its scripts run, in an origin of their own (no token, no page)
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "sandbox allow-scripts");
  }
  return new Response(await r.blob(), { headers });
}
