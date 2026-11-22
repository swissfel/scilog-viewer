// SciLog viewer in the browser: what the local server (scilog_viewer/server.py) does,
// done in the page itself, so that the viewer runs from a plain web site with nothing
// installed.
//
// The page (app.js and the rest of static/) is the same as with the server. It asks for
// /api/... as always; this file answers those requests here, talking to SciLog's REST API
// directly with the user's token (SciLog's API allows calls from any origin). Images and
// attachments (img/<id>, file/<id>) are answered by the service worker beside the page
// (sw.js), which this file gives the token to.
//
// What the server has and this has not: the beamline account (its password cannot be
// handed to a web page), eco's plugin, and the files on disk (token, config, cache): the
// token and the logbooks written to are kept in this browser's storage instead.
"use strict";

(() => {
  // Two ways of running: from its own web site (the default: files through the service worker, a token
  // entered in the page) or inside SciLog's own page, started from a bookmark (inject.js: files straight
  // from SciLog's API with SciLog's login cookie, SciLog's own login, no service worker -- and no CORS).
  const CONFIG = Object.assign({ api: "https://scilog.psi.ch/api/v1", web: "https://scilog.psi.ch",
    files: "worker", tokenFrom: "viewer", worker: true }, window.SCILOG_BROWSER_CONFIG || {});
  const IN_SCILOG = CONFIG.files === "api";
  // SciLog's API is called with the browser's own fetch, never with the page's /api/... (below)
  const nativeFetch = window.fetch.bind(window);
  const API = CONFIG.api.replace(/\/+$/, "");
  const PAGE = 500;
  const MAX_UPLOAD = 50 * 1024 * 1024;
  const TEMPORARY_HOURS = 8;
  const EVERYONE_LOGGED_IN = "any-authenticated-user";
  const ID = /^[0-9a-f]{24}$/;
  const ISO = /^\d{4}-\d{2}-\d{2}[T ][\d:.]{5,15}(Z|[+-]\d{2}:?\d{2})?$/;
  const KEY_TOKEN = "scilog-viewer-token";            // localStorage: a kept token
  const KEY_TEMP = "scilog-viewer-token-temporary";   // sessionStorage: {token, until}
  const KEY_WRITE = "scilog-viewer-write-logbooks";   // localStorage: [logbook ids]

  // -- errors, as the server's handlers turn them into HTTP statuses ----------------------------

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => new HttpError(400, msg);
  const forbidden = (msg) => new HttpError(403, msg);
  const notFound = (msg) => new HttpError(404, msg);
  const conflict = (msg) => new HttpError(409, msg);
  class TokenError extends HttpError { constructor(msg) { super(401, msg); } }

  const store = (kind) => { try { return window[kind]; } catch (e) { return null; } };
  const get = (kind, key) => { try { return store(kind)?.getItem(key) ?? null; } catch (e) { return null; } };
  const put = (kind, key, value) => { try { store(kind)?.setItem(key, value); } catch (e) { /* private or full */ } };
  const drop = (kind, key) => { try { store(kind)?.removeItem(key); } catch (e) { /* private */ } };

  // -- the token ------------------------------------------------------------------------------

  function cleanToken(value) {
    value = String(value || "").trim().replace(/^["']|["']$/g, "");
    return value.startsWith("Bearer ") ? value.slice(7).trim() : value;
  }

  function claims(value) {
    try {
      const part = cleanToken(value).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(part + "=".repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return {}; }
  }

  function who(value) {
    const c = claims(value);
    return (c.name || "?") + (c.email ? ` <${c.email}>` : "");
  }

  const hhmm = (epoch) => new Date(epoch * 1000).toTimeString().slice(0, 5);

  /** {token, access: "scilog"|"stored"|"temporary", until} or null. */
  function currentToken() {
    if (CONFIG.tokenFrom === "scilog") {  // inside SciLog's page: its own login
      const own = get("localStorage", "id_token");
      if (own) return { token: cleanToken(own), access: "scilog", until: null };
    }
    try {
      const temp = JSON.parse(get("sessionStorage", KEY_TEMP) || "null");
      if (temp && temp.token) {
        if (temp.until < Date.now() / 1000) {
          drop("sessionStorage", KEY_TEMP);
          throw new TokenError(`the temporary token was used for ${TEMPORARY_HOURS} hours and is forgotten now`);
        }
        return { token: temp.token, access: "temporary", until: temp.until };
      }
    } catch (e) { if (e instanceof TokenError) throw e; }
    const kept = get("localStorage", KEY_TOKEN);
    return kept ? { token: kept, access: "stored", until: null } : null;
  }

  // -- SciLog's REST API (client.py's Reader) ------------------------------------------------------

  const POST_FIELDS = { id: true, createdAt: true, createdBy: true, tags: true, textcontent: true, files: true, deleted: true, parentId: true };
  const CHILD_FIELDS = { id: true, parentId: true, linkType: true, createdAt: true, createdBy: true, updatedAt: true, updatedBy: true,
    textcontent: true, files: true, tags: true, deleted: true, expiresAt: true, readACL: true, updateACL: true, deleteACL: true };
  const CHILD_WHERE = { snippetType: "paragraph", linkType: { inq: ["comment", "quote"] } };
  const TASK_FIELDS = { id: true, parentId: true, content: true, isDone: true, defaultOrder: true, createdAt: true, createdBy: true,
    updatedAt: true, updatedBy: true, deleted: true, updateACL: true, deleteACL: true };

  const UNREACHABLE = "SciLog cannot be reached from this browser: no network, or it is blocked on the way.";
  const refused = () => `SciLog answers, but does not let this web site (${location.origin}) read it: its server sends `
    + "no CORS permission for it. The SciLog operators can allow it. Meanwhile: the viewer inside SciLog's own page "
    + "(the 🔖 bookmark in the token window), or the installed viewer.";

  /** A request to SciLog failed in the browser itself: tell "refused (CORS)" from "not reached". A request
   *  that does not ask to read the answer (no-cors) needs no permission: if that one gets through, SciLog
   *  is there and only the permission is missing. */
  async function whyUnreachable() {
    try {
      await nativeFetch(API + "/", { mode: "no-cors", credentials: "omit", cache: "no-store" });
      return refused();
    } catch (e) { return UNREACHABLE; }
  }

  class Reader {
    constructor(token) { this.token = token; this._locations = null; }

    async _fetch(method, path, { query, json, form } = {}) {
      const url = new URL(API + path);
      if (query) url.searchParams.set("filter", JSON.stringify(query));
      const headers = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
      let body;
      if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
      if (form) body = form;
      let r;
      try { r = await nativeFetch(url, { method, headers, body, mode: "cors", credentials: IN_SCILOG ? "same-origin" : "omit" }); }
      catch (e) { throw new HttpError(502, await whyUnreachable()); }
      if (r.status === 401) throw new TokenError(`SciLog refused the token (${who(this.token)}): log in to SciLog again and enter the new one`);
      if (r.status >= 400) {
        let detail = r.statusText;
        try { const d = await r.json(); detail = d?.error?.message || JSON.stringify(d); } catch (e) { /* not json */ }
        throw new HttpError(r.status === 403 ? 403 : 400, `SciLog: ${r.status} ${String(detail).slice(0, 300)}`);
      }
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    }

    get(path, query) { return this._fetch("GET", path, { query }); }
    send(method, path, json) { return this._fetch(method, path, { json }); }

    async locations() {
      if (!this._locations) {
        const rows = await this.get("/locations", { fields: { id: true, name: true } });
        this._locations = Object.fromEntries(rows.map((r) => [r.id, r.name || ""]));
      }
      return this._locations;
    }

    async logbooks() {
      const rows = await this.get("/logbooks", { fields: { id: true, name: true, ownerGroup: true, location: true,
        isPrivate: true, touchedAt: true, updatedAt: true, deleted: true } });
      const locs = rows.length ? await this.locations() : {};
      return rows.filter((r) => !r.deleted).map((r) => ({
        id: r.id, name: r.name || "",
        pgroup: r.ownerGroup || ((r.name || "").match(/p\d{5}/) || [""])[0],
        location: r.location ? locs[r.location] || "" : "",
        private: !!r.isPrivate, touched: r.touchedAt || r.updatedAt || "",
      })).sort((a, b) => (a.touched < b.touched ? 1 : a.touched > b.touched ? -1 : 0));
    }

    logbook(id) { return this.get(`/logbooks/${encodeURIComponent(id)}`); }
    post(id) { return this.get(`/basesnippets/${encodeURIComponent(id)}`); }

    _postQuery(children) {
      const fields = Object.assign({}, POST_FIELDS, { updatedAt: true, updatedBy: true, updateACL: true, ownerGroup: true,
        accessGroups: true, isPrivate: true, defaultOrder: true, expiresAt: true, readACL: true, deleteACL: true });
      const extra = children ? { include: [{ relation: "subsnippets", scope: { where: CHILD_WHERE, fields: CHILD_FIELDS } }] } : {};
      return [fields, extra];
    }

    async newestPosts(logbookId, n, before = null, children = false) {
      const where = { snippetType: "paragraph", parentId: logbookId };
      if (before) where.createdAt = { lte: before };
      const [fields, extra] = this._postQuery(children);
      const rows = await this.get("/basesnippets", { where, order: ["createdAt DESC"], limit: n, fields, ...extra });
      return rows.reverse();
    }

    async posts(logbookId, updatedAfter = null, children = false) {
      const where = { snippetType: "paragraph", parentId: logbookId };
      if (updatedAfter) where.updatedAt = { gt: updatedAfter };
      const [fields, extra] = this._postQuery(children);
      let out = [];
      for (let skip = 0; ; skip += PAGE) {
        const rows = await this.get("/basesnippets", { where, order: ["createdAt ASC"], limit: PAGE, skip, fields, ...extra });
        out = out.concat(rows);
        if (rows.length < PAGE) break;
      }
      return out;
    }

    childrenSince(updatedAfter, limit = 2000) {
      return this.get("/basesnippets", { where: { ...CHILD_WHERE, updatedAt: { gt: updatedAfter } },
        order: ["updatedAt ASC"], limit, fields: CHILD_FIELDS });
    }

    uploadFile(blob, filename, fields) {
      // "fields" a plain form field: sent as a part with a content type, SciLog ignores it
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("fields", JSON.stringify(fields));
      return this._fetch("POST", "/filesnippet/files", { form });
    }

    createPost(payload) { return this.send("POST", "/basesnippets", payload); }
    updatePost(id, payload) { return this.send("PATCH", `/basesnippets/${encodeURIComponent(id)}`, payload); }
    deletePost(id) { return this.send("DELETE", `/basesnippets/${encodeURIComponent(id)}`); }
    fileSnippet(id) { return this.get(`/filesnippet/${encodeURIComponent(id)}`); }
    setReadAcl(kind, id, acl) {
      if (!["basesnippets", "filesnippet"].includes(kind)) throw bad(kind);
      return this.send("PATCH", `/${kind}/${encodeURIComponent(id)}`, { readACL: [...acl] });
    }
    async tasks(logbookId) {
      const rows = await this.get("/tasks", { where: { parentId: logbookId }, fields: TASK_FIELDS, limit: 5000 });
      return rows.filter((r) => !r.deleted);
    }
    createTask(payload) { return this.send("POST", "/tasks", payload); }
    updateTask(id, payload) { return this.send("PATCH", `/tasks/${encodeURIComponent(id)}`, payload); }
    deleteTask(id) { return this.send("DELETE", `/tasks/${encodeURIComponent(id)}`); }
    views(parents) { return this.get("/views", { where: { parentId: { inq: [...parents] } }, limit: 1000 }); }
    view(id) { return this.get(`/views/${encodeURIComponent(id)}`); }
    updateView(id, payload) { return this.send("PATCH", `/views/${encodeURIComponent(id)}`, payload); }
    deleteView(id) { return this.send("DELETE", `/views/${encodeURIComponent(id)}`); }
  }

  // -- a post's HTML (content.py), with the browser's own inert parser ---------------------------

  const TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span", "div", "hr", "mark",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "a", "img", "figure", "figcaption"]);
  const ATTRIBUTES = { "*": ["class", "style"], a: ["href", "title", "target"], img: ["title", "alt", "width", "height", "src"],
    td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], col: ["span"], ol: ["start"] };
  const URL_ATTRS = new Set(["href", "src"]);
  const SCHEMES = new Set(["http", "https", "mailto", "file"]);
  // dropped together with what is in them: not text to show
  const HIDDEN = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "svg", "math",
    "frame", "frameset", "applet", "textarea", "select", "title"]);
  const STYLE_PROPERTIES = new Set(["width", "height", "max-width", "aspect-ratio", "text-align", "float", "color",
    "background-color", "margin-left", "margin-right", "font-weight", "font-style", "text-decoration", "vertical-align"]);
  const STYLE_VALUE = /^[#%(),./\w\s-]{1,80}$/;
  const LOCAL = /^(?:\.\/|\/)?(img|file)\/([0-9a-f]{24})(?:\?.*)?$/;
  const WIDTH = /(?:^|;)\s*width:\s*([\d.]+(?:px|%))/;

  /** A parsed fragment in a document that runs nothing and loads nothing. */
  function fragment(html) {
    const doc = document.implementation.createHTMLDocument("");
    const box = doc.createElement("div");
    box.innerHTML = html || "";
    return box;
  }

  function cleanStyle(value) {
    const keep = [];
    for (const decl of String(value).split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase(), val = decl.slice(i + 1).trim();
      if (STYLE_PROPERTIES.has(prop) && STYLE_VALUE.test(val) && !/url/i.test(val)) keep.push(`${prop}:${val}`);
    }
    return keep.join(";");
  }

  function allowedUrl(value) {
    const v = String(value).replace(/[\u0000- \u007f-\u009f]/g, "");
    const scheme = v.match(/^([a-z][a-z0-9+.-]*):/i);
    return !scheme || SCHEMES.has(scheme[1].toLowerCase());
  }

  function cleanTree(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }  // a comment
      if (child.nodeType !== 1) continue;
      const tag = child.localName;
      if (HIDDEN.has(tag)) { child.remove(); continue; }
      cleanTree(child);
      if (!TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      const allowed = new Set([...ATTRIBUTES["*"], ...(ATTRIBUTES[tag] || [])]);
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name) || (URL_ATTRS.has(name) && !allowedUrl(attr.value))) child.removeAttribute(attr.name);
      }
      if (child.hasAttribute("style")) {
        const s = cleanStyle(child.getAttribute("style"));
        if (s) child.setAttribute("style", s); else child.removeAttribute("style");
      }
    }
  }

  /** Untrusted HTML reduced to formatting (content.sanitize), as a fragment. */
  function sanitizeTree(html) {
    const box = fragment(html);
    cleanTree(box);
    return box;
  }

  function htmlToText(html) {
    const PARAGRAPH = new Set(["p", "div", "h1", "h2", "h3", "h4", "pre", "table"]), LINE = new Set(["br", "li", "tr"]);
    const parts = [];
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) parts.push(child.data);
        else if (child.nodeType === 1) {
          const tag = child.localName;
          if (tag === "script" || tag === "style") continue;
          if (PARAGRAPH.has(tag)) parts.push("\n\n"); else if (LINE.has(tag)) parts.push("\n");
          walk(child);
        }
      }
    })(fragment(html));
    return parts.join("").replace(/\n[ \t]*\n\s*/g, "\n\n").trim();
  }

  function fileWidth(f) {
    const width = String(f?.style?.width || "").trim();
    return /^\d+(\.\d+)?(px|%)$/.test(width) ? width : "";
  }

  const byHash = (files) => Object.fromEntries((files || []).filter((f) => f.fileHash && f.fileId).map((f) => [f.fileHash, f]));

  /** Where the page gets a file: beside it (the service worker) or, inside SciLog's page, SciLog's API itself. */
  function fileUrl(kind, id) {
    if (!IN_SCILOG) return `${kind}/${id}`;
    return kind === "img" ? `${API}/images/${id}` : `${API}/filesnippet/${id}/files`;
  }
  const isFileUrl = (src) => src.startsWith("img/") || (IN_SCILOG && src.startsWith(`${API}/images/`));

  function makeImg(doc, attrs, f, forEditor) {
    const img = doc.createElement("img");
    img.setAttribute("src", fileUrl("img", f.fileId));
    for (const k of ["width", "height", "style", "alt"]) if (attrs.has(k)) img.setAttribute(k, attrs.get(k));
    if (!forEditor) img.setAttribute("loading", "lazy");
    return img;
  }

  const attrMap = (el) => new Map([...el.attributes].map((a) => [a.name, a.value]));

  /** img title=<hash> -> src img/<fileId>; a figure without a width gets the one SciLog keeps in the file's style. */
  function showImages(box, hashes, forEditor) {
    const doc = box.ownerDocument;
    for (const fig of box.querySelectorAll("figure")) {
      const imgs = fig.querySelectorAll("img");
      if (imgs.length !== 1) continue;
      const attrs = attrMap(imgs[0]);
      const f = hashes[attrs.get("title") || ""];
      if (!f) continue;
      const width = fileWidth(f);
      if (width && !WIDTH.test(fig.getAttribute("style") || "")) {
        const style = fig.getAttribute("style");
        fig.setAttribute("style", `width:${width}` + (style ? `;${style}` : ""));
        fig.setAttribute("class", [...new Set(`${fig.getAttribute("class") || "image"} image_resized`.split(/\s+/).filter(Boolean))].join(" "));
      }
      imgs[0].replaceWith(makeImg(doc, attrs, f, forEditor));
    }
    for (const img of box.querySelectorAll("img")) {
      const attrs = attrMap(img), src = attrs.get("src") || "";
      if (isFileUrl(src)) continue;
      const f = hashes[attrs.get("title") || ""];
      if (f) img.replaceWith(makeImg(doc, attrs, f, forEditor));
      else if (!src.startsWith("http")) {
        const span = doc.createElement("span");
        span.className = "missing";
        span.textContent = "[image not found]";
        img.replaceWith(span);
      }
    }
  }

  function cleanPost(text, files) {
    const hashes = byHash(files);
    const box = sanitizeTree(text);
    showImages(box, hashes, false);
    const doc = box.ownerDocument;
    for (const a of box.querySelectorAll("a")) {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("file:")) continue;
      const f = hashes[href.slice(5)];
      if (!f) {
        const span = doc.createElement("span");
        span.className = "missing";
        span.append(...a.childNodes, " (attachment not found)");
        a.replaceWith(span);
        continue;
      }
      const plain = a.textContent;
      const link = doc.createElement("a");
      link.append(...a.childNodes);
      const isPlot = (f.fileExtension || "").includes("html") || /\.html?$/i.test(plain);
      if (!isPlot) link.className = "attachment";
      // the file's name goes along: SciLog does not let another site read it from its answer
      link.setAttribute("href", isPlot ? fileUrl("file", f.fileId)
        : IN_SCILOG ? fileUrl("file", f.fileId) : `file/${f.fileId}?download=1&name=${encodeURIComponent(plain.trim())}`);
      // inside SciLog's page an attachment comes from SciLog's own origin: saved, never opened there
      if (IN_SCILOG && !isPlot) link.setAttribute("download", plain.trim());
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener");
      if (isPlot) {
        const span = doc.createElement("span");
        span.className = "plot";
        span.dataset.file = f.fileId;
        span.dataset.name = plain;
        span.append(link);
        a.replaceWith(span);
      } else a.replaceWith(link);
    }
    return box.innerHTML;
  }

  function editorHtml(text, files) {
    const hashes = byHash(files);
    const box = sanitizeTree(text);
    showImages(box, hashes, true);
    for (const a of box.querySelectorAll("a")) {
      const href = a.getAttribute("href") || "";
      const f = href.startsWith("file:") ? hashes[href.slice(5)] : null;
      if (!f) continue;
      const link = box.ownerDocument.createElement("a");
      link.setAttribute("href", fileUrl("file", f.fileId));
      link.append(...a.childNodes);
      a.replaceWith(link);
    }
    return box.innerHTML;
  }

  /** "img/<id>" or "file/<id>" also when the editor made it an address of this page. */
  function localMatch(value) {
    let v = String(value || "");
    if (IN_SCILOG) {  // SciLog's own addresses of a file, as fileUrl() makes them
      const m = v.match(/\/images\/([0-9a-f]{24})(?:\?.*)?$/) || v.match(/\/filesnippet\/([0-9a-f]{24})\/files(?:\?.*)?$/);
      if (m && v.startsWith(API)) return [v, v.includes("/images/") ? "img" : "file", m[1]];
    }
    const base = new URL(".", location.href).href;
    if (v.startsWith(base)) v = v.slice(base.length);
    return v.match(LOCAL);
  }

  /** (textcontent, files) as SciLog stores them, from the editor's HTML (content.to_scilog). */
  function toScilog(text, known) {
    const files = [], problems = [];
    if (/<img\b[^>]*\bsrc="(?:data|blob):/i.test(text || "")) problems.push("an image is still being uploaded");
    const box = sanitizeTree(text);
    const doc = box.ownerDocument;
    const container = (fileId) => {
      const f = known[fileId];
      return f ? Object.assign({ fileHash: crypto.randomUUID() }, f) : null;
    };
    const image = (img, widthFrom) => {
      const src = img.getAttribute("src") || "";
      if (/^(data|blob):/.test(src)) { problems.push("an image is still being uploaded"); return false; }
      const local = localMatch(src);
      if (!local) return false;
      const f = container(local[2]);
      if (!f) { problems.push(`an image (${src}) is not a file of this post`); return false; }
      const width = (widthFrom || "").match(WIDTH);
      f.style = { width: width ? width[1] : "", height: "" };
      files.push(f);
      img.setAttribute("src", "");
      img.setAttribute("title", f.fileHash);
      return true;
    };
    for (const fig of box.querySelectorAll("figure")) {
      const imgs = fig.querySelectorAll("img");
      if (imgs.length === 1) image(imgs[0], fig.getAttribute("style") || "");
    }
    for (const img of box.querySelectorAll("img")) {
      if (img.getAttribute("src") === "" && img.getAttribute("title")) continue;  // done above
      image(img, img.getAttribute("style") || "");
    }
    for (const a of box.querySelectorAll("a")) {
      const local = localMatch(a.getAttribute("href"));
      if (!local) continue;
      const f = container(local[2]);
      if (!f) { problems.push(`the attachment '${a.textContent}' is not a file of this post`); continue; }
      files.push(f);
      const link = doc.createElement("a");
      link.className = "fileLink";
      link.setAttribute("target", "_blank");
      link.setAttribute("href", `file:${f.fileHash}`);
      link.append(...a.childNodes);
      a.replaceWith(link);
    }
    if (problems.length) throw bad(`not saved: ${[...new Set(problems)].join("; ")}`);
    return [box.innerHTML, files];
  }

  function setHeading(text, index, level) {
    if (!["h1", "h2", "h3", "h4", "h5", "h6", "p"].includes(level)) throw bad(`not a heading level: ${level}`);
    let seen = -1;
    const out = text.replace(/<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi, (m, tag, attrs, inner) => {
      seen += 1;
      return seen === index ? `<${level}${attrs}>${inner}</${level}>` : m;
    });
    if (seen < index) throw bad(`the post has no heading number ${index + 1}`);
    return out;
  }

  // -- views (server.py's view_summary / apply_view_changes) ----------------------------------------

  async function viewVersion(raw) {
    const keep = {};
    for (const k of ["configuration", "description", "location", "name", "parentId"]) keep[k] = raw[k] ?? null;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(stableJson(keep)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  // JSON with sorted keys, as Python's json.dumps(sort_keys=True) (its spacing too)
  function stableJson(v) {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(", ")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${stableJson(v[k])}`).join(", ")}}`;
    return JSON.stringify(v ?? null);
  }

  async function viewSummary(raw, logbookId, names) {
    const panels = ((raw.configuration || {}).widgetConfig || []).map((w, i) => {
      const cfg = w.config || {}, general = cfg.general || {}, filt = cfg.filter || {};
      const others = [];
      for (const lid of filt.additionalLogbooks || []) {
        if (!others.some((o) => o.id === lid)) others.push({ id: lid, name: names[lid] || "", readable: lid in names });
      }
      return { index: i, type: general.type || "", title: general.title || "", target: filt.targetId || "",
        target_name: names[filt.targetId] || "", tags: [...(filt.tags || [])], excludeTags: [...(filt.excludeTags || [])],
        snippetType: [...(filt.snippetType || [])], logbooks: others,
        duplicates: (filt.additionalLogbooks || []).length - others.length, size: [w.cols, w.rows], at: [w.x, w.y] };
    });
    const name = raw.name || "";
    return { id: raw.id, name, description: raw.description || "", owner: raw.ownerGroup || "",
      created: ID.test(raw.id || "") ? parseInt(raw.id.slice(0, 8), 16) : 0,
      on: raw.parentId === logbookId ? "logbook" : "location", personal: name.endsWith("_personal"),
      template: !!(raw.configuration || {}).isTemplate, panels, version: await viewVersion(raw) };
  }

  function tagList(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) throw bad("tags must be a list of words");
    return value.map((t) => t.trim()).filter(Boolean);
  }

  function applyViewChanges(raw, changes) {
    const config = JSON.parse(JSON.stringify(raw.configuration || {}));
    const widgets = config.widgetConfig || [];
    const payload = {};
    if ("name" in changes) {
      const name = String(changes.name).trim();
      if (!name) throw bad("a view needs a name");
      payload.name = name.slice(0, 120);
    }
    if ("description" in changes) payload.description = String(changes.description).slice(0, 500);
    for (const ch of changes.panels || []) {
      const i = ch.index;
      if (!Number.isInteger(i) || i < 0 || i >= widgets.length) throw bad("no such panel");
      const cfg = widgets[i].config = widgets[i].config || {};
      if ("title" in ch) (cfg.general = cfg.general || {}).title = String(ch.title).slice(0, 120);
      const filt = cfg.filter = cfg.filter || {};
      for (const key of ["tags", "excludeTags"]) if (key in ch) filt[key] = tagList(ch[key]);
      if ("logbooks" in ch) {
        const ids = ch.logbooks;
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && ID.test(x))) throw bad("logbooks must be logbook ids");
        filt.additionalLogbooks = [...new Set(ids)];
      }
    }
    if ((changes.panels || []).length) payload.configuration = config;
    if (!Object.keys(payload).length) throw bad("nothing to change");
    return payload;
  }

  // -- offline copies --------------------------------------------------------------------------
  //
  // Logbooks kept in this browser to be read later without a network and without a token:
  // their posts (as SciLog has them, comments included), tasks, and -- if asked for -- their
  // images and attachments. IndexedDB "scilog-viewer-offline": "books" (one record per
  // logbook), "files" (id -> {type, name, size, blob} or, kept in a folder, without the blob),
  // "meta" (settings, the folder's handle). A folder (the File System Access API: Chrome and
  // Edge on a computer) holds the files where the browser's storage would be too small; the
  // service worker asks the page for those, since only the page may ask for the folder's
  // permission again after a restart.

  const OFFLINE_DB = "scilog-viewer-offline";
  //: a copy this large is only made after asking (bytes); so is one larger than half the free space
  const OFFLINE_LARGE = 500 * 2 ** 20;
  //: copies older than this are brought up to date when the viewer is online with a token (ms)
  const OFFLINE_STALE = 6 * 3600 * 1000;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(OFFLINE_DB, 2);  // 2: never the empty one an older worker might have left
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ["books", "files"]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  let idbPromise = null;
  const idb = () => (idbPromise = idbPromise || idbOpen().catch((e) => { idbPromise = null; throw e; }));
  async function idbDo(store, mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(tx.objectStore(store))).then((r) => { out = r; });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }
  const req2p = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const idbGet = (store, key) => idbDo(store, "readonly", (s) => req2p(s.get(key)));
  const idbAll = (store) => idbDo(store, "readonly", (s) => req2p(s.getAll()));
  const idbPut = (store, value, key) => idbDo(store, "readwrite", (s) => { key === undefined ? s.put(value) : s.put(value, key); });
  const idbDelete = (store, key) => idbDo(store, "readwrite", (s) => { s.delete(key); });

  const fileIdsOf = (raws) => {
    const ids = new Set();
    for (const r of raws) for (const x of [r, ...(r.subsnippets || [])]) for (const f of x.files || []) if (f.fileId) ids.add(f.fileId);
    return [...ids];
  };

  const Offline = {
    supported: typeof indexedDB !== "undefined" && !!CONFIG.worker,  // offline needs the site's own worker
    large: OFFLINE_LARGE,
    folderSupported: typeof window.showDirectoryPicker === "function",

    async books() { try { return await idbAll("books"); } catch (e) { return []; } },
    async count() { try { return await idbDo("books", "readonly", (st) => req2p(st.count())); } catch (e) { return 0; } },
    async book(id) { try { return await idbGet("books", id); } catch (e) { return null; } },

    async setting(key, fallback) { try { const v = await idbGet("meta", key); return v === undefined ? fallback : v; } catch (e) { return fallback; } },
    async set(key, value) { await idbPut("meta", value, key); },

    /** What is kept, for the panel: per logbook its name, when, how many posts and files, how large. */
    async summary() {
      return (await this.books()).map((b) => ({ id: b.id, name: b.logbook.name, pgroup: b.logbook.pgroup, location: b.logbook.location,
        saved: b.saved, posts: b.raw.length, files: b.fileIds.length, withFiles: b.withFiles, bytes: b.bytes, where: b.where }));
    },

    async storage() {
      const out = { usage: null, quota: null, persisted: null };
      try { Object.assign(out, await navigator.storage.estimate()); } catch (e) { /* not told */ }
      try { out.persisted = await navigator.storage.persisted(); } catch (e) { /* not told */ }
      return out;
    },

    // -- the folder

    async folder() { return this.folderSupported ? this.setting("folder", null) : null; },
    async folderState() {
      const handle = await this.folder();
      if (!handle) return { supported: this.folderSupported, name: null, permission: null };
      let permission = "prompt";
      try { permission = await handle.queryPermission({ mode: "readwrite" }); } catch (e) { /* gone */ }
      return { supported: true, name: handle.name, permission };
    },
    /** Choose the folder (in a click: the browser asks). */
    async chooseFolder() {
      const handle = await window.showDirectoryPicker({ id: "scilog-viewer-offline", mode: "readwrite" });
      await this.set("folder", handle);
      return this.folderState();
    },
    /** Allow the folder again after the browser was restarted (in a click). */
    async allowFolder() {
      const handle = await this.folder();
      if (!handle) throw bad("no folder chosen");
      return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    },
    async _filesDir(create = true) {
      const handle = await this.folder();
      if (!handle) throw bad("no folder chosen for the offline copies");
      if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") throw forbidden("the browser needs your permission for the offline copies' folder again");
      return handle.getDirectoryHandle("scilog-viewer-files", { create });
    },

    /** A kept file: {type, name, blob} or null. */
    async file(id) {
      const rec = await idbGet("files", id).catch(() => null);
      if (!rec) return null;
      if (rec.blob) return rec;
      try {
        const dir = await this._filesDir(false);
        const blob = await (await dir.getFileHandle(id)).getFile();
        return { ...rec, blob };
      } catch (e) { return null; }
    },

    async _keepFile(id, blob, type, name, where) {
      if (where === "folder") {
        const dir = await this._filesDir();
        const writable = await (await dir.getFileHandle(id, { create: true })).createWritable();
        await writable.write(blob);
        await writable.close();
        await idbPut("files", { id, type, name, size: blob.size, where });
      } else await idbPut("files", { id, type, name, size: blob.size, where, blob });
    },

    async _dropFile(id) {
      const rec = await idbGet("files", id).catch(() => null);
      if (rec && rec.where === "folder") {
        try { await (await this._filesDir(false)).removeEntry(id); } catch (e) { /* gone already */ }
      }
      await idbDelete("files", id);
    },

    // -- making copies

    /** Read what the chosen logbooks hold (their posts now; their files' sizes estimated from a few),
     *  for the panel to say how large the copies would be before any is made. */
    async plan(reader, logbooks, withFiles, progress = () => {}) {
      const books = [];
      let sampled = 0, sampleBytes = 0;
      for (const [i, lb] of logbooks.entries()) {
        progress(`Reading ${lb.name} (${i + 1} of ${logbooks.length}) …`);
        const raw = await reader.posts(lb.id, null, true);
        let tasks = [];
        try { tasks = await reader.tasks(lb.id); } catch (e) { /* a copy without them */ }
        const ids = withFiles ? fileIdsOf(raw) : [];
        const kept = new Set((await idbAll("files").catch(() => [])).map((f) => f.id));
        const missing = ids.filter((id) => !kept.has(id));
        // a few of the files that would be fetched, fetched now (they are kept): their sizes stand for the rest
        for (const id of missing.slice(0, Math.max(0, 3 - Math.min(3, sampled)))) {
          const got = await this._fetchFile(reader, id, raw);
          if (got) { sampled++; sampleBytes += got.blob.size; this._prefetched.set(id, got); }
        }
        const jsonBytes = new Blob([JSON.stringify(raw)]).size;
        books.push({ logbook: lb, raw, tasks, fileIds: ids, missing, jsonBytes });
      }
      const missing = books.reduce((n, b) => n + b.missing.length, 0);
      const avg = sampled ? sampleBytes / sampled : 300 * 1024;
      const estimate = books.reduce((n, b) => n + b.jsonBytes, 0) + Math.round(avg * missing);
      return { books, withFiles, missing, estimate, storage: await this.storage() };
    },

    /** Whether a plan should be asked about first, and why. */
    tooLarge(plan, where) {
      const free = plan.storage.quota != null ? plan.storage.quota - (plan.storage.usage || 0) : null;
      if (plan.estimate > this.large) return `about ${mb(plan.estimate)}`;
      if (where !== "folder" && free != null && plan.estimate > free / 2) return `about ${mb(plan.estimate)}, more than half of the space this browser has left (${mb(free)})`;
      return "";
    },

    _prefetched: new Map(),

    async _fetchFile(reader, id, raws) {
      const meta = (() => {
        for (const r of raws) for (const x of [r, ...(r.subsnippets || [])]) for (const f of x.files || []) if (f.fileId === id) return f;
        return {};
      })();
      const isImage = String(meta.fileExtension || "").startsWith("image");
      const path = isImage ? `/images/${encodeURIComponent(id)}` : `/filesnippet/${encodeURIComponent(id)}/files`;
      try {
        const r = await nativeFetch(API + path, { headers: { Authorization: `Bearer ${reader.token}` }, mode: "cors", credentials: "omit" });
        if (!r.ok) return null;
        const name = (r.headers.get("content-disposition") || "").match(/filename="?([^";]+)/);
        return { blob: await r.blob(), type: r.headers.get("content-type") || "application/octet-stream", name: name ? name[1] : "" };
      } catch (e) { return null; }
    },

    /** Make (or bring up to date) the copies a plan describes. */
    async save(reader, plan, where, progress = () => {}) {
      try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* the browser decides */ }
      if (where === "folder") await this._filesDir();  // refused here, before anything is fetched, if it cannot be written
      const done = [];
      for (const [i, b] of plan.books.entries()) {
        const label = `${b.logbook.name} (${i + 1} of ${plan.books.length})`;
        let bytes = b.jsonBytes, n = 0;
        const queue = [...b.missing];
        const worker = async () => {
          while (queue.length) {
            const id = queue.shift();
            const got = this._prefetched.get(id) || (await this._fetchFile(reader, id, b.raw));
            this._prefetched.delete(id);
            if (got) { await this._keepFile(id, got.blob, got.type, got.name, where); bytes += got.blob.size; }
            n++;
            if (n % 5 === 0 || !queue.length) progress(`Keeping ${label}: files ${n} of ${b.missing.length} (${mb(bytes)})`);
          }
        };
        progress(`Keeping ${label} …`);
        await Promise.all([worker(), worker(), worker(), worker()]);
        const already = b.fileIds.filter((id) => !b.missing.includes(id));
        for (const id of already) bytes += (await idbGet("files", id).catch(() => null))?.size || 0;
        const since = b.raw.reduce((a, r) => maxIso(a, r.updatedAt, r.createdAt, ...(r.subsnippets || []).map((k) => k.updatedAt)), "");
        await idbPut("books", { id: b.logbook.id, logbook: b.logbook, raw: b.raw, tasks: b.tasks, fileIds: b.fileIds, withFiles: plan.withFiles,
          where, bytes, since, saved: new Date().toISOString() });
        done.push(b.logbook.id);
      }
      await this._collect();
      return done;
    },

    async remove(id) {
      await idbDelete("books", id);
      await this._collect();
    },

    /** Files no copy refers to any more go. */
    async _collect() {
      const used = new Set((await this.books()).flatMap((b) => b.fileIds));
      for (const f of await idbAll("files").catch(() => [])) if (!used.has(f.id)) await this._dropFile(f.id);
    },
  };

  const mb = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${Math.max(0.1, bytes / 2 ** 20).toFixed(1)} MB`);

  // -- the store (server.py's Store) ------------------------------------------------------------

  const epoch = (iso) => { const t = Date.parse(iso || ""); return Number.isNaN(t) ? 0 : t / 1000; };
  const maxIso = (...xs) => xs.reduce((a, b) => ((b || "") > a ? b : a), "");
  const firstLine = (text) => (text.split("\n").find((l) => l.trim()) || "").trim().slice(0, 120);
  const inOrder = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const TASK_STEP = 1000000;
  const MAX_EDIT_DAYS = 3650;

  class Store {
    constructor() {
      this.logbooks = {};   // id -> {posts: {id: record}, raw: {id: raw}, since, from, whole}
      this.tasksHeld = {};  // logbook id -> {task id: raw}
      this.uploads = {};    // fileId -> file container, uploaded while editing
      this.chains = {};     // logbook id -> the promise of the last posts() call
      this._reader = null;
      this._readerToken = null;
    }

    get reader() {
      const cur = currentToken();
      if (!cur) throw new TokenError("There is no SciLog token here yet");
      if (cur.token !== this._readerToken) { this.forget(); this._reader = new Reader(cur.token); this._readerToken = cur.token; }
      return this._reader;
    }

    forget() {
      this.logbooks = {};
      this.tasksHeld = {};
      this._reader = null;
      this._readerToken = null;
    }

    // -- the token

    options() {
      const kept = get("localStorage", KEY_TOKEN);
      const out = { shared: false, temporary_hours: TEMPORARY_HOURS, beamline: { available: false, who: "" }, stored: { available: !!kept } };
      if (kept) {
        const exp = claims(kept).exp;
        Object.assign(out.stored, { who: who(kept), expires: exp, available: !(exp && exp < Date.now() / 1000) });
      }
      return out;
    }

    /** Whether a token is there that has not run out (SciLog may still refuse it). */
    usable() {
      try {
        const cur = currentToken();
        const exp = cur && claims(cur.token).exp;
        return !!cur && !(exp && exp < Date.now() / 1000);
      } catch (e) { return false; }
    }

    /** No usable token, but offline copies: read those (and write nothing). */
    async refreshMode() {
      this.offlineMode = !this.usable() && (await Offline.count()) > 0;
      return this.offlineMode;
    }

    async tokenStatus() {
      const st = this.liveTokenStatus();
      if (st.ok || !(await this.refreshMode())) return st;
      return { ...st, ok: true, offline: true, access: "offline", personal: true, expires: null, token_why: st.why,
        identity: "the offline copies kept in this browser (no SciLog token)" };
    }

    liveTokenStatus() {
      const base = { can_set: true, options: this.options() };
      let cur;
      try { cur = currentToken(); } catch (e) { return { ...base, ok: false, why: e.message, must_choose: false }; }
      if (!cur) return { ...base, ok: false, why: "There is no SciLog token here yet", must_choose: false };
      let exp = claims(cur.token).exp;
      if (cur.access === "temporary") exp = Math.min(exp || cur.until, cur.until);
      if (exp && exp < Date.now() / 1000) {
        return { ...base, ok: false, expires: exp, why: cur.access === "scilog"
          ? "SciLog's login in this tab has expired: log in to SciLog again, then start the viewer from the bookmark"
          : "the SciLog token has expired" };
      }
      return { ...base, ok: true, identity: this.identity(cur), personal: true, access: cur.access, expires: exp || null };
    }

    identity(cur) {
      return `${who(cur.token)} (${cur.access === "scilog" ? "SciLog's own login" : cur.access === "temporary" ? `temporary, until ${hhmm(cur.until)}` : "kept in this browser"})`;
    }

    async setToken(value, keep = true) {
      value = cleanToken(value);
      if (value.split(".").length !== 3) throw bad("that is not a SciLog token (expected three dot-separated parts)");
      const exp = claims(value).exp;
      if (exp && exp < Date.now() / 1000) throw bad("this token has already expired: log in to SciLog again and copy the new one");
      await new Reader(value).get("/logbooks", { limit: 1, fields: { id: true } });  // refused: TokenError
      if (keep) {
        put("localStorage", KEY_TOKEN, value);
        drop("sessionStorage", KEY_TEMP);
      } else {
        const until = Math.min(exp || Infinity, Date.now() / 1000 + TEMPORARY_HOURS * 3600);
        put("sessionStorage", KEY_TEMP, JSON.stringify({ token: value, until }));
      }
      this.forget();
      await giveWorkerToken(true);
      return this.tokenStatus();
    }

    /** Remove every token from this browser (both kinds) and the files kept with it. */
    async forgetToken() {
      drop("localStorage", KEY_TOKEN);
      drop("sessionStorage", KEY_TEMP);
      this.forget();
      await giveWorkerToken(true);
      return this.tokenStatus();
    }

    /** Back from a token lent to this tab to the one kept in this browser. */
    async useKept() {
      if (!this.options().stored.available) throw bad("there is no valid token kept in this browser");
      drop("sessionStorage", KEY_TEMP);
      this.forget();
      await giveWorkerToken(true);
      return this.tokenStatus();
    }

    // -- who is reading, and may they write

    me() {
      if (this.offlineMode) {
        return { identity: "Offline copies", email: "", roles: new Set(), writes: false, access: "offline", as_beamline: false,
          why_not: "this is an offline copy: enter a SciLog token (🔑) to write", write_logbooks: [] };
      }
      const cur = currentToken();
      if (!cur) throw new TokenError("There is no SciLog token here yet");
      const c = claims(cur.token);
      let write = [];
      try { write = JSON.parse(get("localStorage", KEY_WRITE) || "[]"); } catch (e) { /* none */ }
      return { identity: this.identity(cur), email: c.email || "", roles: new Set(c.roles || []), writes: true, why_not: "",
        write_logbooks: Array.isArray(write) ? write : [], as_beamline: false, access: cur.access };
    }

    publicMe() { const { roles, ...rest } = this.me(); return rest; }

    mayWriteTo(logbookId) {
      const me = this.me();
      if (!me.writes) return [false, me.why_not];
      if (!me.write_logbooks.includes(logbookId)) return [false, "writing to this logbook is not switched on in this browser"];
      return [true, ""];
    }

    setWriteLogbook(logbookId, on = true) {
      if (typeof logbookId !== "string" || !ID.test(logbookId)) throw bad("not a logbook id");
      const list = this.me().write_logbooks.filter((x) => x !== logbookId).concat(on ? [logbookId] : []);
      put("localStorage", KEY_WRITE, JSON.stringify(list));
      return this.publicMe();
    }

    mayEdit(raw) {
      try {
        const me = this.me();
        return raw.createdBy === me.email || (raw.updateACL || []).some((g) => me.roles.has(g));
      } catch (e) { return false; }
    }

    mayDelete(raw) {
      try { const me = this.me(); return (raw.deleteACL || []).some((g) => me.roles.has(g)); } catch (e) { return false; }
    }

    checkWrite(logbookId, raw = null) {
      const [ok, why] = this.mayWriteTo(logbookId);
      if (!ok) throw forbidden(why);
      if (raw && !this.mayEdit(raw)) throw forbidden("SciLog lets you edit only your own posts (or those of a group you are in)");
    }

    async listLogbooks() {
      if (this.offlineMode) return this.offlineLogbooks();
      let rows;
      try { rows = await this.reader.logbooks(); } catch (e) {
        if (e.status === 502 && (await Offline.count())) { this.unreachable = true; return this.offlineLogbooks(); }
        throw e;
      }
      this.unreachable = false;
      for (const lb of rows) lb.url = `${CONFIG.web}/logbooks/${lb.id}/dashboard`;
      return rows;
    }

    /** The logbooks kept offline, as the list of logbooks. */
    async offlineLogbooks() {
      return (await Offline.books()).map((b) => ({ ...b.logbook, offline: true, url: `${CONFIG.web}/logbooks/${b.id}/dashboard` }))
        .sort((a, b) => (a.touched < b.touched ? 1 : a.touched > b.touched ? -1 : 0));
    }

    /** A logbook from its offline copy, as posts() returns it; null without a copy. */
    async postsOffline(logbookId, since) {
      const held = this.logbooks[logbookId];
      if (since != null && held) return { posts: [], removed: [], since: held.since, from: held.from, whole: true };
      const copy = await Offline.book(logbookId);
      if (!copy) return null;
      const book = this.logbooks[logbookId] = { posts: {}, raw: {}, since: copy.since, from: "", whole: true, offline: true };
      for (const r of copy.raw) if (!r.deleted) book.raw[r.id] = r;
      this.linkQuotes(book, Object.values(book.raw));
      for (const r of Object.values(book.raw)) book.posts[r.id] = this.record(r);
      book.from = Object.values(book.raw).map((r) => r.createdAt).filter(Boolean).reduce((a, b) => (b < a ? b : a), "9999");
      return { posts: Object.values(book.posts).sort(inOrder), removed: [], since: book.since, from: book.from, whole: true };
    }

    // -- posts

    record(raw) {
      const text = htmlToText(raw.textcontent || "");
      const created = raw.createdAt || "", updated = raw.updatedAt || "";
      const written = epoch(created);
      const order = raw.defaultOrder;
      const at = typeof order === "number" && order > 0 ? order / 1e6 : written;
      const kids = (raw.subsnippets || []).filter((k) => !k.deleted);
      const quote = kids.find((k) => k.linkType === "quote");
      return {
        id: raw.id, t: at, written, inserted: Math.abs(at - written) > 600,
        order: typeof order === "number" ? order : null, expires: epoch(raw.expiresAt),
        comments: kids.filter((k) => k.linkType === "comment").sort((a, b) => ((a.createdAt || "") < (b.createdAt || "") ? -1 : 1)).map((k) => this.childRecord(k)),
        quote: quote ? Object.assign(this.childRecord(quote), { of: raw._quote_of ?? null }) : null,
        shared: (raw.readACL || []).includes(EVERYONE_LOGGED_IN), groups: [...(raw.readACL || [])].sort(),
        can_delete: this.mayDelete(raw), created, updated,
        edited: !!(updated && created && epoch(updated) - epoch(created) > 60),
        author: raw.createdBy || "", editor: raw.updatedBy || "", tags: [...(raw.tags || [])],
        html: cleanPost(raw.textcontent || "", raw.files), text, title: firstLine(text), can_edit: this.mayEdit(raw),
      };
    }

    childRecord(raw) {
      const text = htmlToText(raw.textcontent || "");
      const created = raw.createdAt || "", updated = raw.updatedAt || "";
      return { id: raw.id, t: epoch(created), author: raw.createdBy || "", html: cleanPost(raw.textcontent || "", raw.files), text,
        created, updated, editor: raw.updatedBy || "", edited: !!(updated && created && epoch(updated) - epoch(created) > 60),
        expires: epoch(raw.expiresAt), tags: [...(raw.tags || [])],
        can_edit: raw.linkType === "comment" && this.mayEdit(raw), can_delete: raw.linkType === "comment" && this.mayDelete(raw) };
    }

    /** A reply's quote is a copy without a link to what it copies: find the original by its text, else by its expiry. */
    linkQuotes(book, raws) {
      let byText = null;
      for (const raw of raws) {
        const quote = (raw.subsnippets || []).find((k) => k.linkType === "quote" && !k.deleted);
        if (!quote) continue;
        if (!byText) {
          byText = new Map();
          for (const r of Object.values(book.raw)) { const k = (r.textcontent || "").trim(); if (!byText.has(k)) byText.set(k, r.id); }
        }
        let found = byText.get((quote.textcontent || "").trim());
        if (!found && quote.expiresAt) {
          const born = epoch(quote.expiresAt) - 3 * 86400;
          found = Object.values(book.raw).find((r) => Math.abs(epoch(r.createdAt) - born) < 2)?.id;
        }
        raw._quote_of = found && found !== raw.id ? found : null;
      }
    }

    /** Posts whose comments (or quote) changed since `since`: a comment does not touch its post's updatedAt. */
    async changedByChildren(book, since, already) {
      if (!since) return [];
      const out = new Map();
      for (const kid of await this.reader.childrenSince(since)) {
        const parent = book.raw[kid.parentId];
        if (!parent) continue;
        book.since = maxIso(book.since, kid.updatedAt, kid.createdAt);
        parent.subsnippets = (parent.subsnippets || []).filter((k) => k.id !== kid.id).concat([kid]);
        if (!already.has(parent.id)) out.set(parent.id, parent);
      }
      return [...out.values()];
    }

    posts(logbookId, since = null, newest = null, before = null) {
      // one at a time per logbook, as the server's lock
      const run = (this.chains[logbookId] || Promise.resolve()).catch(() => {}).then(async () => {
        if (this.offlineMode || this.unreachable) {
          const kept = await this.postsOffline(logbookId, since);
          if (kept) return kept;
        }
        try { return await this._posts(logbookId, since, newest, before); } catch (e) {
          if (e.status !== 502) throw e;
          const kept = await this.postsOffline(logbookId, since);  // no network: the offline copy, if there is one
          if (!kept) throw e;
          this.unreachable = true;
          return kept;
        }
      });
      this.chains[logbookId] = run;
      return run;
    }

    async _posts(logbookId, since, newest, before) {
      const reader = this.reader;
      let book = this.logbooks[logbookId];
      const piece = !!newest && !(book && book.whole);
      let changed;
      if (!book) {
        book = this.logbooks[logbookId] = { posts: {}, raw: {}, since: "", from: "", whole: !piece };
        changed = piece ? await reader.newestPosts(logbookId, newest, before || null, true) : await reader.posts(logbookId, null, true);
      } else if (piece) {
        const bound = before || book.from || null;
        let asked = newest;
        changed = await reader.newestPosts(logbookId, asked, bound, true);
        // nothing new in the piece: more posts carry the instant it ends on than fit in it
        while (bound && changed.length === asked && !changed.some((r) => !(r.id in book.raw))) {
          asked *= 4;
          changed = await reader.newestPosts(logbookId, asked, bound, true);
        }
        book.whole = changed.length < asked;
      } else {
        const oldSince = book.since;
        changed = oldSince ? await reader.posts(logbookId, oldSince, true) : [];
        changed = changed.concat(await this.changedByChildren(book, oldSince, new Set(changed.map((r) => r.id))));
      }
      const removed = [];
      for (const r of changed) {
        book.since = maxIso(book.since, r.updatedAt, r.createdAt);
        if (r.deleted) { delete book.posts[r.id]; delete book.raw[r.id]; removed.push(r.id); }
        else { book.raw[r.id] = r; book.posts[r.id] = this.record(r); }
      }
      this.linkQuotes(book, changed.filter((r) => !r.deleted));
      for (const r of changed) if (!r.deleted && r.id in book.posts) book.posts[r.id] = this.record(r);
      const made = changed.map((r) => r.createdAt).filter(Boolean);
      if (made.length) book.from = (book.from ? [...made, book.from] : made).reduce((a, b) => (b < a ? b : a));
      let posts;
      if (piece || since != null) {
        const ids = new Set(changed.filter((r) => !r.deleted).map((r) => r.id));
        posts = [...ids].filter((i) => i in book.posts).map((i) => book.posts[i]).sort(inOrder);
      } else posts = Object.values(book.posts).sort(inOrder);
      return { posts, removed, since: book.since, from: book.from, whole: book.whole };
    }

    async raw(logbookId, postId) {
      if (!(logbookId in this.logbooks)) await this.posts(logbookId);
      const raw = this.logbooks[logbookId].raw[postId];
      if (!raw) throw notFound(`no post ${postId} in this logbook`);
      return raw;
    }

    async rawOrComment(logbookId, snippetId) {
      try { return [await this.raw(logbookId, snippetId), null]; } catch (e) { if (e.status !== 404) throw e; }
      for (const post of Object.values(this.logbooks[logbookId].raw)) {
        for (const kid of post.subsnippets || []) {
          if (kid.id === snippetId && kid.linkType === "comment" && !kid.deleted) return [kid, post];
        }
      }
      throw notFound(`no post or comment ${snippetId} in this logbook`);
    }

    async remove(logbookId, postId) {
      const [raw, parent] = await this.rawOrComment(logbookId, postId);
      const [ok, why] = this.mayWriteTo(logbookId);
      if (!ok) throw forbidden(why);
      if (!this.mayDelete(raw)) throw forbidden("SciLog lets only the members of this post's delete groups delete it");
      await this.reader.deletePost(postId);
      const book = this.logbooks[logbookId];
      if (parent) {
        parent.subsnippets = (parent.subsnippets || []).filter((k) => k.id !== postId);
        book.posts[parent.id] = this.record(parent);
        return { removed: postId, post: book.posts[parent.id] };
      }
      delete book.raw[postId];
      delete book.posts[postId];
      return { removed: postId };
    }

    // -- tasks

    taskRecord(raw) {
      let order = raw.defaultOrder;
      if (typeof order !== "number") order = epoch(raw.createdAt) * 1e6;
      return { id: raw.id, text: raw.content || "", done: !!raw.isDone, order, author: raw.createdBy || "", created: raw.createdAt || "",
        editor: raw.updatedBy || "", updated: raw.updatedAt || "", can_edit: this.mayEdit(raw), can_delete: this.mayDelete(raw) };
    }

    async tasks(logbookId) {
      if (!ID.test(logbookId || "")) throw bad("not a logbook id");
      let raws;
      if (this.offlineMode || this.unreachable) raws = (await Offline.book(logbookId))?.tasks;
      if (!raws) {
        try { raws = await this.reader.tasks(logbookId); } catch (e) {
          raws = e.status === 502 ? (await Offline.book(logbookId))?.tasks : null;
          if (!raws) throw e;
        }
      }
      this.tasksHeld[logbookId] = Object.fromEntries(raws.map((r) => [r.id, r]));
      const records = raws.map((r) => this.taskRecord(r)).sort((a, b) => a.order - b.order || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
      return { tasks: records };
    }

    async task(logbookId, taskId, edit = true) {
      if (!ID.test(String(taskId))) throw bad("not a task id");
      const [ok, why] = this.mayWriteTo(logbookId);
      if (!ok) throw forbidden(why);
      if (!this.tasksHeld[logbookId]?.[taskId]) await this.tasks(logbookId);
      const raw = this.tasksHeld[logbookId][taskId];
      if (!raw) throw notFound(`no task ${taskId} in this logbook`);
      if (edit && !this.mayEdit(raw)) throw forbidden("SciLog lets you change only your own tasks (or those of a group you are in)");
      return raw;
    }

    async addTask(logbookId, text, first = false) {
      text = (text || "").trim();
      if (!text) throw bad("the task is empty");
      if (!ID.test(logbookId || "")) throw bad("not a logbook id");
      const [ok, why] = this.mayWriteTo(logbookId);
      if (!ok) throw forbidden(why);
      const book = await this.reader.logbook(logbookId);
      const payload = {};
      for (const k of ["ownerGroup", "accessGroups", "isPrivate"]) if (book[k] != null) payload[k] = book[k];
      Object.assign(payload, { parentId: logbookId, snippetType: "task", content: text, isDone: false });
      const current = (await this.tasks(logbookId)).tasks;
      if (first && current.length) payload.defaultOrder = Math.trunc(current[0].order - TASK_STEP);
      else if (current.length) payload.defaultOrder = Math.trunc(Math.max(current[current.length - 1].order + TASK_STEP, Date.now() * 1000));
      await this.reader.createTask(payload);
      return this.tasks(logbookId);
    }

    async updateTask(logbookId, taskId, text = null, done = null) {
      await this.task(logbookId, taskId);
      const payload = {};
      if (text != null) { if (!text.trim()) throw bad("the task is empty"); payload.content = text.trim(); }
      if (done != null) payload.isDone = !!done;
      if (Object.keys(payload).length) await this.reader.updateTask(taskId, payload);
      return this.tasks(logbookId);
    }

    async moveTask(logbookId, taskId, before = null, after = null) {
      await this.task(logbookId, taskId);
      const tasks = (await this.tasks(logbookId)).tasks.filter((t) => t.id !== taskId);
      const ids = tasks.map((t) => t.id);
      const anchor = before || after;
      if (!ids.includes(anchor)) throw notFound(`no task ${anchor} in this logbook`);
      const i = ids.indexOf(anchor) + (before ? 0 : 1);
      let lo = i > 0 ? tasks[i - 1].order : null, hi = i < tasks.length ? tasks[i].order : null;
      if (lo != null && hi != null && hi - lo < 2) {
        if (!tasks.every((t) => t.can_edit)) {
          throw forbidden("there is no room between these two tasks, and making room would change tasks SciLog does not let you change; move them the other way round");
        }
        const start = Math.trunc(tasks[0].order);
        for (let n = 0; n < tasks.length; n++) {
          const neu = start + n * TASK_STEP;
          if (tasks[n].order !== neu) { await this.reader.updateTask(tasks[n].id, { defaultOrder: neu }); tasks[n].order = neu; }
        }
        lo = i > 0 ? tasks[i - 1].order : null;
        hi = i < tasks.length ? tasks[i].order : null;
      }
      const order = lo == null ? hi - TASK_STEP : hi == null ? lo + TASK_STEP : lo + Math.floor((hi - lo) / 2);
      await this.reader.updateTask(taskId, { defaultOrder: Math.trunc(order) });
      return this.tasks(logbookId);
    }

    async deleteTask(logbookId, taskId) {
      const raw = await this.task(logbookId, taskId, false);
      if (!this.mayDelete(raw)) throw forbidden("SciLog lets only the members of this task's delete groups delete it");
      await this.reader.deleteTask(taskId);
      return this.tasks(logbookId);
    }

    // -- SciLog's views

    async names() { return Object.fromEntries((await this.listLogbooks()).map((r) => [r.id, r.name])); }

    async views(logbookId) {
      if (!ID.test(logbookId || "")) throw bad("not a logbook id");
      if (this.offlineMode || this.unreachable) return { views: [], logbooks: [], can_edit: false };
      const lb = await this.reader.logbook(logbookId);
      const parents = [logbookId].concat(ID.test(String(lb.location || "")) ? [lb.location] : []);
      const names = await this.names();
      const rows = (await this.reader.views(parents)).filter((r) => !r.deleted).sort((a, b) => (a.id < b.id ? -1 : 1));
      return { views: await Promise.all(rows.map((r) => viewSummary(r, logbookId, names))),
        logbooks: Object.entries(names).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
        can_edit: this.mayWriteTo(logbookId)[0] };
    }

    async viewForChange(logbookId, viewId, version) {
      this.checkWrite(logbookId);
      if (!ID.test(viewId || "")) throw bad("not a view id");
      const raw = await this.reader.view(viewId);
      if (![logbookId, (await this.reader.logbook(logbookId)).location].includes(raw.parentId)) throw forbidden("this view does not belong to this logbook");
      if (version && (await viewVersion(raw)) !== version) throw conflict("the view was changed meanwhile (in SciLog or by someone else): reload the list");
      put("localStorage", `scilog-viewer-view-backup:${raw.id}`, JSON.stringify({ at: new Date().toISOString(), view: raw }));
      return raw;
    }

    async changeView(logbookId, viewId, version, changes) {
      const raw = await this.viewForChange(logbookId, viewId, version);
      await this.reader.updateView(viewId, applyViewChanges(raw, changes || {}));
      return viewSummary(await this.reader.view(viewId), logbookId, await this.names());
    }

    async removeView(logbookId, viewId, version) {
      const raw = await this.viewForChange(logbookId, viewId, version);
      await this.reader.deleteView(viewId);
      return { deleted: viewId, name: raw.name };
    }

    // -- writing

    async forEditor(logbookId, postId) {
      const [raw] = await this.rawOrComment(logbookId, postId);
      this.checkWrite(logbookId, raw);
      return { html: editorHtml(raw.textcontent || "", raw.files), tags: [...(raw.tags || [])], updated: raw.updatedAt || "" };
    }

    async upload(logbookId, postId, file) {
      const raw = postId ? await this.raw(logbookId, postId) : null;
      this.checkWrite(logbookId, raw);
      const filename = file.name || "file";
      if (file.size > MAX_UPLOAD) throw bad(`${filename} is larger than ${MAX_UPLOAD / 2 ** 20} MB`);
      const contentType = file.type || "application/octet-stream";
      const acl = raw || (await this.reader.logbook(logbookId));
      const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : contentType.split("/").pop();
      const isImage = contentType.startsWith("image/");
      const fields = {};
      for (const k of ["ownerGroup", "accessGroups", "isPrivate"]) if (acl[k] != null) fields[k] = acl[k];
      fields.fileExtension = isImage ? contentType.split("/")[1] : ext;
      const snippet = await this.reader.uploadFile(file, filename, fields);
      this.uploads[snippet.id] = { fileHash: crypto.randomUUID(), fileId: snippet.id, accessHash: snippet.accessHash,
        fileExtension: isImage ? contentType : `file/${ext}` };
      return { fileId: snippet.id, url: fileUrl(isImage ? "img" : "file", snippet.id), name: filename, image: isImage };
    }

    knownFiles(raw) {
      const known = Object.fromEntries(((raw || {}).files || []).filter((f) => f.fileId).map((f) => [f.fileId, f]));
      return { ...this.uploads, ...known };
    }

    insertOrder(logbookId, afterId = null, beforeId = null) {
      const book = this.logbooks[logbookId] || { raw: {} };
      const orders = Object.values(book.raw).map((r) => r.defaultOrder).filter((o) => typeof o === "number").sort((a, b) => a - b);
      const anchor = book.raw[afterId || beforeId];
      if (!anchor || typeof anchor.defaultOrder !== "number") throw bad("the post to insert next to is not known");
      let a, b;
      if (beforeId) {
        b = anchor.defaultOrder;
        const earlier = orders.filter((o) => o < b);
        a = earlier.length ? earlier[earlier.length - 1] : b - 2000000;
      } else {
        a = anchor.defaultOrder;
        const later = orders.filter((o) => o > a);
        if (!later.length) return null;
        b = later[0];
      }
      if (b - a < 2) throw bad("there is no room between these two posts");
      return Math.trunc(a + Math.floor((b - a) / 2));
    }

    async save(logbookId, postId, html, tags, expectedUpdated = null, editDays = null, after = null, before = null, commentOn = null, replyTo = null) {
      const [raw, parent] = postId ? await this.rawOrComment(logbookId, postId) : [null, null];
      this.checkWrite(logbookId, raw);
      for (const target of [commentOn, replyTo]) if (target && !ID.test(String(target))) throw bad("not a post id");
      if (commentOn || replyTo) await this.raw(logbookId, commentOn || replyTo);
      const [textcontent, files] = toScilog(html, this.knownFiles(raw));
      if (!textcontent.trim()) throw bad("the post is empty");
      tags = (tags || []).filter((t) => t && t.trim()).map((t) => t.trim());
      if (!raw) {
        const payload = { snippetType: "paragraph", linkType: "paragraph", parentId: logbookId, textcontent, files, tags };
        if (commentOn) Object.assign(payload, { linkType: "comment", parentId: commentOn });
        if (editDays != null) {
          const days = Number(editDays);
          if (!(days > 0 && days <= MAX_EDIT_DAYS)) throw bad(`the edit period must be between 1 and ${MAX_EDIT_DAYS} days`);
          payload.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        }
        if ((after || before) && !commentOn) {
          if (!ID.test(String(after || before))) throw bad("not a post id");
          const order = this.insertOrder(logbookId, after, before);
          if (order != null) payload.defaultOrder = order;
        }
        const neu = await this.reader.createPost(payload);
        postId = neu.id;
        if (replyTo) {
          const quoted = await this.reader.post(replyTo);
          const copy = {};
          for (const k of ["textcontent", "files", "tags", "expiresAt", "isPrivate"]) if (k in quoted) copy[k] = quoted[k];
          await this.reader.createPost({ ...copy, snippetType: "paragraph", linkType: "quote", parentId: postId });
        }
      } else {
        const current = await this.reader.post(postId);
        if (expectedUpdated && current.updatedAt && current.updatedAt !== expectedUpdated) {
          throw conflict(`the post was changed meanwhile (by ${current.updatedBy} at ${current.updatedAt}); reload it before saving`);
        }
        await this.reader.updatePost(postId, { textcontent, files, tags });
      }
      for (const f of files) delete this.uploads[f.fileId];
      if (commentOn || parent) return this.reread(logbookId, commentOn || parent.id);
      return this.reread(logbookId, postId);
    }

    async reread(logbookId, postId) {
      const book = this.logbooks[logbookId];
      await this.posts(logbookId, book ? book.since : null);
      return this.logbooks[logbookId].posts[postId];
    }

    async share(logbookId, postId, on = true) {
      const raw = await this.raw(logbookId, postId);
      this.checkWrite(logbookId, raw);
      const current = await this.reader.post(postId);
      const flip = (acl) => {
        acl = [...(acl || [])];
        const neu = on ? [...new Set([...acl, EVERYONE_LOGGED_IN])].sort() : acl.filter((g) => g !== EVERYONE_LOGGED_IN);
        const same = neu.length === new Set(acl).size && neu.every((g) => acl.includes(g));
        return same ? null : neu;
      };
      for (const f of new Set((current.files || []).map((f) => f.fileId).filter(Boolean))) {
        const neu = flip((await this.reader.fileSnippet(f)).readACL);
        if (neu) await this.reader.setReadAcl("filesnippet", f, neu);
      }
      for (const kid of raw.subsnippets || []) {
        const neu = flip(kid.readACL);
        if (neu) { await this.reader.setReadAcl("basesnippets", kid.id, neu); kid.readACL = neu; }
      }
      const neu = flip(current.readACL);
      if (neu) { await this.reader.setReadAcl("basesnippets", postId, neu); raw.readACL = neu; }
      else if (current.readACL) raw.readACL = [...current.readACL];
      const record = this.record(raw);
      this.logbooks[logbookId].posts[postId] = record;
      return record;
    }

    async setHeadingLevel(logbookId, postId, index, level) {
      const raw = await this.raw(logbookId, postId);
      this.checkWrite(logbookId, raw);
      const current = await this.reader.post(postId);
      await this.reader.updatePost(postId, { textcontent: setHeading(current.textcontent || "", index, level) });
      return this.reread(logbookId, postId);
    }
  }

  // -- the routes the page asks for (server.py's handlers) -------------------------------------------

  const S = new Store();

  async function route(method, url, body) {
    const p = url.pathname.replace(/^.*?\/api\//, "");
    await S.refreshMode();
    const q = (k) => url.searchParams.get(k);
    const b = body || {};
    let m;
    if (method === "GET") {
      if (p === "token") return S.tokenStatus();
      if (p === "me") return S.publicMe();
      if (p === "logbooks") return { logbooks: await S.listLogbooks() };
      if (p === "posts") {
        const lb = q("logbook") || "";
        if (!ID.test(lb)) throw bad("not a logbook id");
        let newest = q("newest");
        if (newest != null) {
          newest = parseInt(newest, 10);
          if (Number.isNaN(newest)) throw bad("newest is a number of posts");
          newest = Math.min(Math.max(newest, 1), 5000);
        }
        const before = q("before");
        if (before && !ISO.test(before)) throw bad("before is a time as SciLog writes it");
        return S.posts(lb, q("since"), newest, before);
      }
      if ((m = p.match(/^edit\/([0-9a-f]{24})$/))) return S.forEditor(q("logbook"), m[1]);
      if (p === "tasks") return S.tasks(q("logbook"));
      if (p === "views") return S.views(q("logbook"));
    } else {
      if (p === "token/set") return S.setToken(String(b.token || ""), !!(b.keep ?? true));
      if (p === "token/forget") return S.forgetToken();
      if (S.offlineMode && p !== "token/set" && p !== "write-logbook") throw forbidden(S.me().why_not);
      if (p === "access") {
        if (b.kind !== "stored") throw bad("the beamline account is only in the installed viewer and in eco");
        return S.useKept();
      }
      if (p === "write-logbook") return S.setWriteLogbook(b.logbook, !!(b.on ?? true));
      if (p === "upload") {
        const file = body instanceof FormData ? body.get("file") : null;
        if (!file) throw bad("no file");
        return S.upload(q("logbook"), q("post"), file);
      }
      if (p === "save" && method === "POST") {
        return S.save(b.logbook, null, b.html || "", b.tags, null, b.edit_days, b.after, b.before, b.comment_on, b.reply_to);
      }
      if ((m = p.match(/^save\/([0-9a-f]{24})$/)) && method === "PATCH") return S.save(b.logbook, m[1], b.html || "", b.tags, b.updated);
      if ((m = p.match(/^heading\/([0-9a-f]{24})$/))) return S.setHeadingLevel(b.logbook, m[1], parseInt(b.index ?? -1, 10), b.level || "");
      if ((m = p.match(/^delete\/([0-9a-f]{24})$/))) return S.remove(b.logbook, m[1]);
      if ((m = p.match(/^share\/([0-9a-f]{24})$/))) return S.share(b.logbook, m[1], !!(b.on ?? true));
      if (p === "task") return S.addTask(b.logbook, b.text || "", !!b.first);
      if ((m = p.match(/^task\/([0-9a-f]{24})(?:\/(delete|move))?$/))) {
        if (m[2] === "delete") return S.deleteTask(b.logbook, m[1]);
        if (m[2] === "move") return S.moveTask(b.logbook, m[1], b.before, b.after);
        return S.updateTask(b.logbook, m[1], b.text ?? null, b.done ?? null);
      }
      if ((m = p.match(/^view\/([0-9a-f]{24})(?:\/(delete))?$/))) {
        return m[2] ? S.removeView(b.logbook, m[1], b.version) : S.changeView(b.logbook, m[1], b.version, b.changes);
      }
    }
    throw notFound(`no such request: ${method} /api/${p}`);
  }

  const json = (status, data) => new Response(JSON.stringify(data ?? null), { status, headers: { "Content-Type": "application/json" } });

  async function answer(method, url, init) {
    await workerReady;
    let body = init?.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return json(400, { error: "not JSON" }); } }
    try {
      return json(200, await route(method, url, body));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json(status, { error: status === 500 ? `${e.name}: ${e.message}` : e.message });
    }
  }

  // The page's own requests for /api/... are answered here; everything else goes out as usual.
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (url.origin === location.origin && /\/api\//.test(url.pathname) && !url.href.startsWith(API + "/")) {
        return answer(((init && init.method) || (input && input.method) || "GET").toUpperCase(), url, init);
      }
    } catch (e) { /* not ours */ }
    return realFetch(input, init);
  };

  // -- the service worker: images and attachments --------------------------------------------------

  function auth() {
    let cur = null;
    try { cur = currentToken(); } catch (e) { /* none */ }
    return { token: cur ? cur.token : null, api: API };
  }

  async function giveWorkerToken(forgetFiles = false) {
    const sw = navigator.serviceWorker?.controller;
    if (sw) sw.postMessage({ auth: auth(), forgetFiles });
  }

  // said once in the page, where it can be seen: without the worker there are no images
  function noWorker(why) {
    console.warn(why);
    const say = () => window.toast?.("Images, plots and attachments cannot be shown in this browser window (no service worker; a private window?).");
    if (document.readyState === "complete") setTimeout(say, 1500); else window.addEventListener("load", () => setTimeout(say, 1500));
  }

  const workerReady = (async () => {
    if (!CONFIG.worker) {
      // inside SciLog's page: images come with SciLog's login cookie, which its API reads as the token
      const cur = (() => { try { return currentToken(); } catch (e) { return null; } })();
      if (cur && !/(?:^|; )id_token=/.test(document.cookie)) document.cookie = `id_token=${cur.token}; path=/; secure; samesite=lax`;
      return;
    }
    if (!("serviceWorker" in navigator)) { noWorker("no service worker here: images and attachments will not show"); return; }
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.want === "auth" && e.ports[0]) e.ports[0].postMessage(auth());
      if (e.data && e.data.want === "file" && e.ports[0]) {
        Offline.file(e.data.id).then((f) => e.ports[0].postMessage(f ? { blob: f.blob, type: f.type, name: f.name } : null),
          () => e.ports[0].postMessage(null));
      }
    });
    try {
      await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }
      await giveWorkerToken();
      if (!navigator.serviceWorker.controller) noWorker("the service worker does not control this page (a hard reload?)");
    } catch (e) { noWorker(`the service worker did not start: ${e}`); }
  })();

  // what the offline panel (offline.js) uses
  const offlineApi = {
    supported: Offline.supported,
    folderSupported: Offline.folderSupported,
    /** From how many bytes on a copy is asked about first (changeable for a test). */
    get large() { return Offline.large; },
    set large(bytes) { Offline.large = bytes; },
    mb,
    async state() { await S.refreshMode(); return { offline: S.offlineMode, unreachable: !!S.unreachable, token: S.usable() }; },
    summary: () => Offline.summary(),
    storage: () => Offline.storage(),
    folderState: () => Offline.folderState(),
    chooseFolder: () => Offline.chooseFolder(),
    allowFolder: () => Offline.allowFolder(),
    setting: (k, d) => Offline.setting(k, d),
    set: (k, v) => Offline.set(k, v),
    async logbooks() { return S.offlineMode ? S.offlineLogbooks() : S.listLogbooks(); },
    async plan(logbooks, withFiles, progress) { return Offline.plan(S.reader, logbooks, withFiles, progress); },
    tooLarge: (plan, where) => Offline.tooLarge(plan, where),
    async save(plan, where, progress) { const done = await Offline.save(S.reader, plan, where, progress); return done; },
    async remove(id) { await Offline.remove(id); delete S.logbooks[id]; },
    /** Bring copies older than OFFLINE_STALE up to date, quietly (online with a token only). */
    async refreshDue(progress = () => {}) {
      if (S.offlineMode || !S.usable() || !(await Offline.setting("keepUpdated", true))) return [];
      const due = (await Offline.books()).filter((b) => Date.now() - Date.parse(b.saved) > OFFLINE_STALE);
      const done = [];
      for (const b of due) {
        if (b.where === "folder" && (await Offline.folderState()).permission !== "granted") continue;
        try {
          const plan = await Offline.plan(S.reader, [b.logbook], b.withFiles, progress);
          done.push(...(await Offline.save(S.reader, plan, b.where, progress)));
        } catch (e) { console.warn(`the offline copy of ${b.logbook.name} could not be brought up to date`, e); if (e.status === 502 || e.status === 401) break; }
      }
      return done;
    },
  };

  // the bar holds a 🔑 badge more than with the server: the status beside it, which says the same, goes
  // first when it is full, and no button breaks into two lines
  const barStyle = document.createElement("style");
  barStyle.textContent = "@media (max-width: 1450px) { #status { display: none; } } #tasks-button, #views-button, #new-post { white-space: nowrap; }";
  document.head.append(barStyle);

  window.ScilogBrowser = { config: CONFIG, inScilog: IN_SCILOG, fileUrl, store: S, offline: offlineApi, sanitize: (h) => sanitizeTree(h).innerHTML, cleanPost, editorHtml, toScilog, htmlToText };
})();
