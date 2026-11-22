// The browser-only viewer (tools/build_web.py) against tools/fake_scilog.py, in Chromium:
// the token is entered and checked with "SciLog", the logbook is read and drawn with its
// images (through the service worker), a plot opens, and the writes go to "SciLog".
// Run by tests/test_web.py, which starts both servers: node test_web.mjs <site> <api log>.
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const [site, log, casesPath] = process.argv.slice(2);
const token = fs.readFileSync(log, "utf8").match(/token: (\S+)/)[1];
const fail = (msg) => { console.error(msg); process.exit(1); };
const check = (ok, msg) => { if (!ok) fail(`FAILED: ${msg}`); console.log(`ok: ${msg}`); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("dialog", (d) => d.accept());

  await page.goto(site);
  await page.waitForSelector("dialog[open] textarea");
  // the browser's cleaning of a post is the server's (content.py), the hostile parts gone in both
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const compared = await page.evaluate((cases) => {
    const norm = (h) => { const d = document.implementation.createHTMLDocument(""); const x = d.createElement("div"); x.innerHTML = h; return x.innerHTML; };
    const named = (h) => h.replace(/&amp;name=[^"]*/g, "");  // the browser adds the file's name to a download link
    return cases.map((c) => {
      const js = ScilogBrowser.cleanPost(c.text, c.files);
      return { text: c.text, clean: named(norm(js)) === norm(c.clean), editor: norm(ScilogBrowser.editorHtml(c.text, c.files)) === norm(c.editor),
        unsafe: /\son\w+=|javascript:|<script|<iframe|<svg|<math|<style|<object|<embed|<form|<input|data:text/i.test(js), hostile: c.hostile, js };
    });
  }, cases);
  const differ = compared.filter((c) => !c.clean || !c.editor);
  check(differ.length === 0, `the page cleans ${cases.length} posts as the server does${differ.length ? `: ${JSON.stringify(differ.slice(0, 2))}` : ""}`);
  const leaks = compared.filter((c) => c.unsafe);
  check(leaks.length === 0, `nothing hostile survives the cleaning${leaks.length ? `: ${leaks.map((c) => c.js).join(" | ")}` : ""}`);

  await page.fill("dialog[open] textarea", "not.a-token");
  await page.click('dialog[open] button:has-text("Use this token")');
  await page.waitForFunction(() => /Not accepted/.test(document.querySelector("dialog[open]")?.textContent || ""));
  check(true, "a wrong token is refused");
  await page.fill("dialog[open] textarea", token);
  await page.click('dialog[open] button:has-text("Use this token")');
  await page.waitForEvent("load");
  await page.waitForSelector("#picker-list li");
  await page.click("#picker-list li");
  await page.waitForSelector("#flow .post");
  const posts = await page.locator("#flow .post").count();
  check(posts > 20, `the logbook is drawn (${posts} posts)`);

  await page.click('#composer button:has-text("Allow writing here")');
  const lb = await page.evaluate(() => state.logbook.id);
  const call = (path, method, body) => page.evaluate(async ([path, method, body]) => {
    const init = { method, headers: { "X-Eco-Scilog": "1" } };
    if (body && body.file) {  // a file upload: {file: [name, type, bytes]}
      const [name, type, bytes] = body.file;
      const form = new FormData();
      form.append("file", new File([new Uint8Array(bytes)], name, { type }));
      init.body = form;
    } else if (body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    const r = await fetch(path, init);
    return [r.status, await r.json()];
  }, [path, method, body]);
  const png = [...fs.readFileSync(new URL("../android/app/src/main/res/mipmap-hdpi/ic_launcher.png", import.meta.url))];
  const [st, up] = await call(`/api/upload?logbook=${lb}`, "POST", { file: ["icon.png", "image/png", png] });
  check(st === 200 && up.image && /^img\//.test(up.url), "an image is uploaded to SciLog");
  const tree = [...Buffer.from("<!doctype html><details open><summary>scan_4217</summary>x: 1</details>")];
  const [, plotFile] = await call(`/api/upload?logbook=${lb}`, "POST", { file: ["scan_4217.html", "text/html", tree] });
  const [, dataFile] = await call(`/api/upload?logbook=${lb}`, "POST", { file: ["run 17.json", "application/json", [...Buffer.from('{"a": 1}')]] });
  const html = `<p>from the browser</p><figure class="image"><img src="${up.url}"></figure><p><a href="${plotFile.url}">scan_4217.html</a> <a href="${dataFile.url}">run 17.json</a></p>`;
  const [st2, post] = await call("/api/save", "POST", { logbook: lb, html, tags: ["web"] });
  check(st2 === 200 && post.html.includes(up.url) && post.html.includes('class="plot"') && post.tags[0] === "web", "a new post is saved with its files");

  await page.reload();
  await page.waitForSelector(`#p-${post.id}`);
  const mine = page.locator(`#p-${post.id}`);
  await mine.scrollIntoViewIfNeeded();
  const shown = await mine.evaluate(async (p) => {
    const img = p.querySelector("img");
    await new Promise((r) => (img.complete ? r() : img.addEventListener("load", r, { once: true })));
    return img.naturalWidth;
  });
  check(shown > 0, "its image comes through the service worker");
  await mine.locator(".plot button").click();
  const summary = await page.frameLocator(`#p-${post.id} .plot iframe`).locator("summary").textContent({ timeout: 10000 });
  check(summary === "scan_4217", "its interactive plot opens in a frame of its own");
  const plotFrame = page.frames().find((f) => /\/file\/[0-9a-f]{24}$/.test(f.url()));
  const inside = await plotFrame.evaluate(() => {
    let storage, parentPage;
    try { storage = localStorage.getItem("scilog-viewer-token"); } catch (e) { storage = "blocked"; }
    try { parentPage = parent.document.title; } catch (e) { parentPage = "blocked"; }
    return { origin: self.origin, storage, parentPage };
  });
  check(inside.origin === "null" && inside.storage === "blocked" && inside.parentPage === "blocked",
    "the plot runs in an origin of its own: neither the token nor the page can be reached from it");

  const download = await page.evaluate(async (href) => {
    const r = await fetch(href);
    return [r.status, r.headers.get("content-disposition"), r.headers.get("content-security-policy"), await r.text()];
  }, await mine.locator("a.attachment").getAttribute("href"));
  check(download[0] === 200 && /filename\*=UTF-8''run%2017\.json/.test(download[1]) && download[3] === '{"a": 1}',
    "an attachment is downloaded under its own name");
  const image = await page.evaluate(async (src) => (await fetch(src)).headers.get("content-security-policy"), up.url);
  check(image === "sandbox" && download[2] === "sandbox", "images and downloads opened by themselves are sandboxed");
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  check(/script-src 'self' https:\/\/cdn\.jsdelivr\.net;/.test(policy) && /connect-src 'self' http:\/\/localhost:\d+ /.test(policy),
    "the page has its security policy (scripts from the site and the editor's CDN, connections to SciLog)");
  const blocked = await page.evaluate(async () => { try { await fetch("https://example.org/"); return "sent"; } catch (e) { return "blocked"; } });
  check(blocked === "blocked", "the page cannot send anything to another site");

  const [, ed] = await call(`/api/edit/${post.id}?logbook=${lb}`, "GET");
  const [st3, edited] = await call(`/api/save/${post.id}`, "PATCH", { logbook: lb, html: ed.html.replace("from the browser", "edited in the browser"), tags: [], updated: ed.updated });
  check(st3 === 200 && edited.text.startsWith("edited in the browser") && edited.html.includes(up.url), "the post is edited, its files kept");
  const [st4] = await call(`/api/save/${post.id}`, "PATCH", { logbook: lb, html: "<p>x</p>", tags: [], updated: "2000-01-01T00:00:00.000Z" });
  check(st4 === 409, "an edit over someone else's is refused");
  const [st5, commented] = await call("/api/save", "POST", { logbook: lb, html: "<p>a comment</p>", tags: [], comment_on: post.id });
  check(st5 === 200 && commented.comments.length === 1, "a comment is saved under the post");
  const [st6, tasks] = await call("/api/task", "POST", { logbook: lb, text: "a task from the browser" });
  check(st6 === 200 && tasks.tasks.some((t) => t.text === "a task from the browser"), "a task is added");
  const [st7, gone] = await call(`/api/delete/${post.id}`, "POST", { logbook: lb });
  check(st7 === 200 && gone.removed === post.id, "the post is deleted");
  const cspErrors = problems.filter((p) => /Content Security Policy/.test(p) && !/example\.org/.test(p));
  check(cspErrors.length === 0, `nothing of the viewer's own is refused by the policy${cspErrors.length ? `: ${cspErrors.join(" | ")}` : ""}`);
  problems.splice(0, problems.length, ...problems.filter((p) => !/example\.org|Failed to fetch/.test(p)));

  const [st8, after] = await call("/api/token/forget", "POST", {});
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => /token/.test(k)));
  check(st8 === 200 && !after.ok && left.length === 0, "the token can be forgotten in this browser");
  check(problems.length === 0, `no errors in the page${problems.length ? `: ${problems.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
