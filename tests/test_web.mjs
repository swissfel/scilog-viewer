// The browser-only viewer (tools/build_web.py) against tools/fake_scilog.py, in Chromium:
// the token is entered and checked with "SciLog", the logbook is read and drawn with its
// images (through the service worker), a plot opens, and the writes go to "SciLog".
// Run by tests/test_web.py, which starts both servers: node test_web.mjs <site> <api log>.
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const [site, log] = process.argv.slice(2);
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
  const html = `<p>from the browser</p><figure class="image"><img src="${up.url}"></figure><p><a href="${plotFile.url}">scan_4217.html</a></p>`;
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
  const sandbox = await mine.locator(".plot iframe").getAttribute("sandbox");
  check(sandbox === "allow-scripts", "the plot's frame is sandboxed");

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
  check(problems.length === 0, `no errors in the page${problems.length ? `: ${problems.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
