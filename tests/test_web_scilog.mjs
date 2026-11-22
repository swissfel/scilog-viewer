// When SciLog does not let the viewer's site call it (no CORS, as at PSI): the web site says so precisely,
// offers the bookmark, and the viewer started from it inside SciLog's own page reads and writes SciLog
// there, with SciLog's login. Run by tests/test_web_scilog.py: node test_web_scilog.mjs <site> <scilog> <log> <post id> <api pid>
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const [site, scilog, log, postId, apiPid] = process.argv.slice(2);
const token = fs.readFileSync(log, "utf8").match(/token: (\S+)/)[1];
const fail = (msg) => { console.error(msg); process.exit(1); };
const check = (ok, msg) => { if (!ok) fail(`FAILED: ${msg}`); console.log(`ok: ${msg}`); };

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("dialog", (d) => d.accept());

  // the web site: refused, and told so
  await page.goto(site);
  await page.waitForSelector("dialog[open] textarea");
  await page.fill("dialog[open] textarea", token);
  await page.click('dialog[open] button:has-text("Use this token")');
  const note = await page.locator("dialog[open] .tk-note", { hasText: "Not accepted" }).textContent({ timeout: 20000 });
  check(/does not let this web site/.test(note) && /CORS/.test(note), "a SciLog that refuses the site is told apart from no network");
  const card = page.locator("dialog[open] details", { hasText: "inside SciLog's own page" });
  check(await card.count() === 1, "the token window offers the viewer inside SciLog's own page");
  const bookmark = await card.locator("a.tk-bookmarklet").getAttribute("href");
  check(bookmark.startsWith("javascript:") && bookmark.includes(`${new URL(site).origin}/inject.js`), "with a bookmark that loads it from this site");

  // SciLog's own page, logged in; the bookmark clicked there
  const sl = await context.newPage();
  sl.on("pageerror", (e) => problems.push(e.message));
  sl.on("dialog", (d) => d.accept());
  await sl.goto(scilog);
  await sl.evaluate((code) => { (0, eval)(decodeURIComponent(code.slice("javascript:".length))); }, bookmark);
  await sl.waitForSelector("#picker-list li", { timeout: 20000 });
  await sl.click("#picker-list li");
  await sl.waitForSelector(`#p-${postId}`, { timeout: 20000 });
  const status = await sl.evaluate(() => fetch("/api/token").then((r) => r.json()));
  check(status.ok && /SciLog's own login/.test(status.identity), "inside SciLog's page the viewer reads with SciLog's own login, no token entered");
  check(await sl.locator("#offline-button").count() === 0, "without the offline panel (it needs the site's own worker)");
  const post = sl.locator(`#p-${postId}`);
  await post.scrollIntoViewIfNeeded();
  const img = await post.evaluate(async (p) => {
    const i = p.querySelector("img");
    await new Promise((r) => (i.complete ? r() : (i.addEventListener("load", r, { once: true }), i.addEventListener("error", r, { once: true }))));
    return [i.getAttribute("src"), i.naturalWidth];
  });
  check(img[1] > 0 && img[0].startsWith(`${new URL(scilog).origin}/api/v1/images/`), "its images come straight from SciLog, with SciLog's login cookie");
  const attachment = post.locator("a.attachment");
  check((await attachment.getAttribute("download")) !== null && /\/filesnippet\/[0-9a-f]{24}\/files$/.test(await attachment.getAttribute("href")),
    "attachments are saved from SciLog, never opened in SciLog's origin");
  await post.locator(".plot button").click();
  const summary = await sl.frameLocator(`#p-${postId} .plot iframe`).locator("summary").textContent({ timeout: 10000 });
  const frame = sl.frames().find((f) => f !== sl.mainFrame());
  const inside = await frame.evaluate(() => {
    let storage, parentPage;
    try { storage = localStorage.getItem("id_token"); } catch (e) { storage = "blocked"; }
    try { parentPage = parent.document.title; } catch (e) { parentPage = "blocked"; }
    return { origin: self.origin, storage, parentPage };
  });
  check(summary === "scan_4217" && inside.origin === "null" && inside.storage === "blocked" && inside.parentPage === "blocked",
    "its plot opens sandboxed: SciLog's login cannot be reached from it");

  await sl.click('#composer button:has-text("Allow writing here")');
  const lb = await sl.evaluate(() => state.logbook.id);
  const saved = await sl.evaluate(async ([lb]) => {
    const png = await (await fetch(document.querySelector("#flow img").src)).blob();
    const form = new FormData();
    form.append("file", new File([png], "again.png", { type: "image/png" }));
    const up = await (await fetch(`/api/upload?logbook=${lb}`, { method: "POST", body: form })).json();
    const r = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logbook: lb, tags: [], html: `<p>written inside SciLog's page</p><figure class="image"><img src="${up.url}"></figure>` }) });
    return [r.status, await r.json()];
  }, [lb]);
  check(saved[0] === 200 && saved[1].html.includes("/api/v1/images/") && saved[1].text.startsWith("written inside"),
    "and writes there: a post with an uploaded image is saved");
  const raw = await sl.evaluate(async (id) => (await fetch(`/api/v1/basesnippets/${id}`)).json(), saved[1].id);
  check(/<img[^>]+src=""[^>]+title="/.test(raw.textcontent) || /<img[^>]+title="[^"]+"[^>]+src=""/.test(raw.textcontent),
    "stored as SciLog stores an image (named by its hash, not by an address)");
  check(problems.length === 0, `no errors in the pages${problems.length ? `: ${problems.join(" | ")}` : ""}`);

  // no SciLog at all: said as such
  process.kill(Number(apiPid));
  await new Promise((r) => setTimeout(r, 500));
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(site);
  await fresh.waitForSelector("dialog[open] textarea");
  await fresh.fill("dialog[open] textarea", token);
  await fresh.click('dialog[open] button:has-text("Use this token")');
  const gone = await fresh.locator("dialog[open] .tk-note", { hasText: "Not accepted" }).textContent({ timeout: 20000 });
  check(/cannot be reached/.test(gone) && !/CORS/.test(gone), "a SciLog that is not there at all is said to be unreachable");
} finally {
  await browser.close();
}
