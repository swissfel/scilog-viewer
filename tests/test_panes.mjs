// The whole page in a DOM (jsdom): a long logbook read from its end in pieces, what the three
// panes do while it comes, and the way back to the top. Run by tests/test_panes.py, which
// skips it where node or jsdom are missing.
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const DIR = fileURLToPath(new URL("../scilog_viewer/static", import.meta.url));
const html = fs.readFileSync(`${DIR}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");

// -- a made-up logbook ---------------------------------------------------------------------
const POSTS = [];
{
  let t = Date.UTC(2026, 6, 1, 8, 0, 0) / 1000;      // 1 July 2026
  for (let i = 0; i < 600; i++) {
    t += 3600 * (2 + (i % 7));                        // a few posts a day, over some months
    const heads = i % 3 === 0 ? `<h2>Heading ${i}</h2>` : i % 11 === 0 ? `<h1>Chapter ${i}</h1><h3>Detail ${i}</h3>` : "";
    POSTS.push({
      id: `p${i}`, t, author: i % 2 ? "ann@psi.ch" : "bo@psi.ch", tags: i % 5 === 0 ? ["setup"] : [],
      html: `${heads}<p>Post number ${i}</p>`, text: `Post number ${i}`, title: `Post number ${i}`,
      comments: [], quote: null, edited: false, shared: false, inserted: false, can_edit: false,
      can_delete: false, groups: [], created: new Date(t * 1000).toISOString(),
      updated: new Date(t * 1000).toISOString(), editor: "", written: t, order: null, expires: 0,
    });
  }
}
const iso = (p) => new Date(p.t * 1000).toISOString();
let hold = null;                                      // holds the next piece back
const holdPieces = () => { let go; hold = { wait: new Promise((r) => (go = r)), release: () => { go(); hold = null; } }; };

let pieceCount = 0;
async function fakeFetch(url) {
  const u = new URL(url, "http://local/");
  const q = u.searchParams;
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.pathname === "/api/token") return json({ ok: true, who: "ann@psi.ch", until: "2030-01-01" });
  if (u.pathname === "/api/me") return json({ identity: "Ann <ann@psi.ch>", email: "ann@psi.ch", can_write: false });
  if (u.pathname === "/api/logbooks") return json({ logbooks: [{ id: "L1", name: "One" }, { id: "L2", name: "Two" }] });
  if (u.pathname === "/api/tasks") return json({ tasks: [] });
  if (u.pathname === "/api/views") return json({ views: [] });
  if (u.pathname === "/api/posts") {
    if (q.get("since")) return json({ posts: [], removed: [], since: "now" });
    const n = parseInt(q.get("newest") || "0", 10);
    const before = q.get("before");
    if (!n) return json({ posts: POSTS, removed: [], since: "now", from: iso(POSTS[0]), whole: true });
    if (before) { pieceCount++; if (hold) await hold.wait; }
    const upto = before ? POSTS.filter((p) => iso(p) <= before) : POSTS;
    const piece = upto.slice(Math.max(0, upto.length - n));
    return json({ posts: piece, removed: [], since: "now", from: piece.length ? iso(piece[0]) : null,
                  whole: piece.length < n || piece[0].id === POSTS[0].id });
  }
  throw new Error(`no stub for ${u.pathname}`);
}

// -- the page ------------------------------------------------------------------------------
const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only", url: "http://local/" });
const w = dom.window;
class Watcher { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} }
w.IntersectionObserver = Watcher;
w.ResizeObserver = Watcher;
w.fetch = fakeFetch;
w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.scrollIntoView = function () {};
w.Element.prototype.setPointerCapture = function () {};
w.Element.prototype.releasePointerCapture = function () {};
w.Element.prototype.scrollTo = function (o) { if (o && typeof o === "object") this.scrollTop = o.top ?? this.scrollTop; };
w.HTMLElement.prototype.focus = function () {};
// the scripts of the page, in the order index.html loads them, as one script (they share
// one scope in the browser too); main() is called by hand, below
const files = ["app.js", "editor.js", "map.js", "views.js", "pin.js", "headings.js", "postmenu.js", "tasks.js", "rail.js"];
const src = files.map((n) => fs.readFileSync(`${DIR}/${n}`, "utf8").replace(/\nmain\(\);\s*$/, "\n")).join("\n")
  + "\nObject.assign(window, { main, state, setPane, openLogbook, flowScrolled, hideToTop,"
  + " markDayPart, dayPart, dayTitle, updateRail, drawRailTicks, railState, editorConfig });\n";
try { w.eval(src); } catch (e) { console.log(`FAIL loading the page: ${e.message}\n${e.stack}`); process.exit(1); }
const flow = w.document.getElementById("flow");
let height = 0;
Object.defineProperty(flow, "clientHeight", { get: () => 800, configurable: true });
Object.defineProperty(flow, "scrollHeight", { get: () => height, configurable: true });
Object.defineProperty(flow, "scrollTop", { get() { return this._top || 0; }, set(v) { this._top = v; }, configurable: true });

// jsdom draws nothing, so the flow is given a layout of its own: every day header 32 high,
// every post 160, and getBoundingClientRect answers out of it (the rail reads places that way).
const tops = new Map();
const DAY_H = 32, POST_H = 160, OTHER_H = 20;
function layOut() {
  let y = 0;
  tops.clear();
  for (const node of flow.children) {
    tops.set(node, y);
    y += node.classList.contains("day") ? DAY_H : node.classList.contains("post") ? POST_H : OTHER_H;
  }
  height = y;
}
const rect = (top, h, width = 900) => ({ top, bottom: top + h, height: h, left: 0, right: width, width, x: 0, y: top });
w.Element.prototype.getBoundingClientRect = function () {
  if (this === flow) return rect(0, 800);
  if (this.id === "rail-handle") {
    const moved = /translateY\(([-\d.]+)px\)/.exec(this.style.transform || "");
    return rect(moved ? parseFloat(moved[1]) : 0, parseFloat(this.style.height) || 0, 12);
  }
  let node = this;
  while (node && node.parentElement !== flow) node = node.parentElement;
  if (!node || !tops.has(node)) return rect(0, 0);
  const own = node === this;
  return rect(tops.get(node) - flow.scrollTop + (own ? 0 : 24), own ? POST_H : OTHER_H);
};
const rail = w.document.getElementById("rail");
Object.defineProperty(rail, "clientHeight", { get: () => 800, configurable: true });
// what the flow would show at this scroll position, worked out from that layout alone
function whatIsAt(scrollTop) {
  let found = null;
  for (const node of flow.children) {
    if (tops.get(node) <= scrollTop + 8 && node.classList.contains("post")) found = node;
  }
  return found && w.state.byId.get(found.dataset.id);
}
const point = (type, clientY) => rail.dispatchEvent(new w.MouseEvent(type, { clientY, bubbles: true }));

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  -- " + extra}`); if (!cond) fails++; };
const all = (sel) => [...w.document.querySelectorAll(sel)];
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
};

// -- 1: the first piece, with the outline pane (headings) showing -----------------------------
w.localStorage.setItem("eco-scilog-pane", "headings");
w.setPane("headings");
await w.main();                       // it offers the logbooks; this one is opened by hand
await w.openLogbook("L1");
ok("the newest piece is on the screen at once", all("#flow .post").length === 50, all("#flow .post").length);
ok("the outline pane has its lines", all("#headings .hd-item").length > 0, all("#headings .hd-item").length);
ok("the stream pane is not drawn while it is hidden", all("#outline-tree .o-post").length === 0);
ok("the map is not drawn while it is hidden", all("#map .m-post").length === 0);

ok("the rest is still coming", w.state.reading === true);
ok("the logbook read so far is in order",
   all("#flow .post").map((n) => n.dataset.id).join() === POSTS.slice(-50).map((p) => p.id).join());

// -- 2: the rest arrives ---------------------------------------------------------------------
ok("the whole logbook arrives", await until(() => w.state.whole && !w.state.reading));
ok("every post is in the flow, in order",
   all("#flow .post").map((n) => n.dataset.id).join() === POSTS.map((p) => p.id).join(),
   all("#flow .post").length);
ok("it came in a handful of pieces, not one per post", pieceCount <= 8, pieceCount);
const days = all("#flow .day").map((n) => n.dataset.day);
ok("every day has exactly one header", new Set(days).size === days.length, days.length);
ok("the outline pane holds the whole logbook",
   all("#headings .hd-item").length === POSTS.filter((p) => /<h[1-6]/.test(p.html)).reduce((n, p) => n + (p.html.match(/<h[1-6]/g) || []).length, 0),
   all("#headings .hd-item").length);
ok("the stream pane was left alone the whole time", all("#outline-tree .o-post").length === 0);

// -- 3: the stream pane, built when it is chosen ----------------------------------------------
w.setPane("outline");
ok("the stream pane is built when it is chosen", all("#outline-tree .o-post").length === POSTS.length,
   all("#outline-tree .o-post").length);
const months = all("#outline-tree .o-month").map((n) => n.dataset.month);
ok("one node per month", new Set(months).size === months.length, months.join(" "));
const sdays = all("#outline-tree .o-day").map((n) => n.dataset.day);
ok("one node per day", new Set(sdays).size === sdays.length, `${sdays.length} / ${new Set(sdays).size}`);
ok("the stream is in order",
   all("#outline-tree .o-post").map((n) => n.dataset.post).join() === POSTS.map((p) => p.id).join());

// -- 4: another logbook, read in pieces while the stream pane is showing ----------------------
holdPieces();
await w.openLogbook("L2");
ok("the stream shows the newest piece at once", all("#outline-tree .o-post").length === 50,
   all("#outline-tree .o-post").length);
const before = all("#outline-tree .o-month").length;
const top = w.document.querySelector("#outline-tree .o-month");
top.classList.add("o-collapsed");                       // the reader folds the newest month
const folded = top.dataset.month;
hold.release();
ok("the older posts come in too", await until(() => w.state.whole && !w.state.reading));
ok("the stream grew with them", all("#outline-tree .o-post").length === POSTS.length,
   all("#outline-tree .o-post").length);
ok("the month the reader folded is still folded",
   w.document.querySelector(`#outline-tree .o-month[data-month="${folded}"]`)?.classList.contains("o-collapsed"));
const m2 = all("#outline-tree .o-month").map((n) => n.dataset.month);
ok("still one node per month after growing", new Set(m2).size === m2.length, m2.join(" "));
const d2 = all("#outline-tree .o-day").map((n) => n.dataset.day);
ok("still one node per day after growing", new Set(d2).size === d2.length, `${d2.length} / ${new Set(d2).size}`);
ok("in order after growing",
   all("#outline-tree .o-post").map((n) => n.dataset.post).join() === POSTS.map((p) => p.id).join());
ok("the month's count was corrected as it grew",
   [...all("#outline-tree .o-month")].every((n) => n.querySelector(".o-count").textContent.trim() === `(${n.querySelectorAll(".o-post").length})`),
   all("#outline-tree .o-month").map((n) => `${n.dataset.month}${n.querySelector(".o-count").textContent}:${n.querySelectorAll(".o-post").length}`).join(" "));
ok("more months than the one piece brought", all("#outline-tree .o-month").length > before);

// -- 5: the map, grown the same way ------------------------------------------------------------
w.setPane("map");
ok("the map holds the whole logbook", all("#map .m-post").length === POSTS.length, all("#map .m-post").length);
holdPieces();
await w.openLogbook("L1");
ok("the map shows the newest piece at once", all("#map .m-post").length === 50, all("#map .m-post").length);
hold.release();
ok("the map's logbook arrives", await until(() => w.state.whole && !w.state.reading));
ok("the map grew with it", all("#map .m-post").length === POSTS.length, all("#map .m-post").length);
const mdays = all("#map .m-day").map((n) => n.dataset.day);
ok("one map day header per day", new Set(mdays).size === mdays.length, `${mdays.length} / ${new Set(mdays).size}`);
ok("the map is in order", all("#map .m-post").map((n) => n.dataset.post).join() === POSTS.map((p) => p.id).join());

// -- 6: the way back to the top ----------------------------------------------------------------
const toTop = w.document.getElementById("to-top");
height = 60000;
flow.scrollTop = 30000;
w.flowScrolled();
ok("the button stays away while reading downwards", toTop.hidden);
flow.scrollTop = 29000; w.flowScrolled();
ok("one page up is not a flick", toTop.hidden);
flow.scrollTop = 27800; w.flowScrolled();
ok("a flick upwards offers the way to the top", !toTop.hidden);
toTop.onclick();
ok("the button takes the reader to the top", flow.scrollTop === 0);
w.flowScrolled();                      // the browser's own scroll event, after the jump
ok("and goes away once pressed", toTop.hidden);
flow.scrollTop = 20000; w.flowScrolled();
flow.scrollTop = 19500; w.flowScrolled();
ok("scrolling slowly leaves it away", toTop.hidden);
flow.scrollTop = 18000; w.flowScrolled();
ok("a flick brings it back", !toTop.hidden);
flow.scrollTop = 0; w.flowScrolled();
ok("at the top it goes away by itself", toTop.hidden);

w.hideToTop();

// -- 7: which part of the day is being read ------------------------------------------------------
const hourAt = (h) => new Date(2026, 0, 12, h, 30).getTime() / 1000;
const parts = [[0, "night"], [5, "night"], [6, "morning"], [10, "morning"], [11, "noon"], [13, "noon"],
               [14, "afternoon"], [17, "afternoon"], [18, "evening"], [21, "evening"], [22, "late"], [23, "late"]];
ok("the day falls into night, morning, noon, afternoon, evening and late",
   parts.every(([h, name]) => w.dayPart(hourAt(h)) === name),
   parts.filter(([h, name]) => w.dayPart(hourAt(h)) !== name).map(([h]) => `${h}h -> ${w.dayPart(hourAt(h))}`).join(" "));

const dayOf = (p) => w.document.querySelector(`#flow .day[data-day="${new Date(p.t * 1000).getFullYear()}-${new Date(p.t * 1000).getMonth()}-${new Date(p.t * 1000).getDate()}"] .part`);
const one = w.state.posts[10], other = w.state.posts.find((p) => new Date(p.t * 1000).getDate() !== new Date(one.t * 1000).getDate());
w.markDayPart(one.id);
ok("the day header says which part of the day is being read", dayOf(one)?.textContent === w.dayPart(one.t),
   `${dayOf(one)?.textContent} / ${w.dayPart(one.t)}`);
w.markDayPart(other.id);
ok("only the day being read carries it", dayOf(one)?.textContent === "" && dayOf(other)?.textContent === w.dayPart(other.t),
   `${dayOf(one)?.textContent} | ${dayOf(other)?.textContent}`);

// -- 8: the scroll rail --------------------------------------------------------------------------
layOut();
w.railState.index = null;
w.updateRail();
const handle = w.document.getElementById("rail-handle"), bubble = w.document.getElementById("rail-bubble");
ok("the rail is there once there is something to scroll", !rail.hidden);
ok("its handle is at least a fingertip tall", parseFloat(handle.style.height) >= 44, handle.style.height);

point("pointerdown", 400);                       // taken in the middle of the track
ok("holding it says where it would take you", !bubble.hidden);
const mid = flow.scrollTop;
ok("the middle of the rail is the middle of the logbook", Math.abs(mid / (height - 800) - 0.5) < 0.12,
   (mid / (height - 800)).toFixed(3));
let there = whatIsAt(mid);
ok("the sign names the day it would take you to", bubble.querySelector(".rb-when")?.textContent === w.dayTitle(there.t),
   `${bubble.querySelector(".rb-when")?.textContent} / ${w.dayTitle(there.t)}`);
ok("and which part of that day", bubble.querySelector(".rb-part")?.textContent.startsWith(w.dayPart(there.t)),
   `${bubble.querySelector(".rb-part")?.textContent} / ${w.dayPart(there.t)}`);
ok("and the heading above that place", !!bubble.querySelector(".rb-head")?.textContent);

point("pointermove", 700);                       // dragged further down
ok("dragging it down goes further down the logbook", flow.scrollTop > mid, `${mid} -> ${flow.scrollTop}`);
there = whatIsAt(flow.scrollTop);
ok("the sign follows while it is dragged", bubble.querySelector(".rb-when")?.textContent === w.dayTitle(there.t));
point("pointerup", 700);
ok("the sign stays for a moment after letting go", !bubble.hidden);
ok("the handle followed the flow", Math.abs(parseFloat(handle.style.transform.match(/([-\d.]+)px/)[1])
   - (800 - parseFloat(handle.style.height)) * flow.scrollTop / (height - 800)) < 2);

w.drawRailTicks();
const ticks = all("#rail-ticks .rail-tick");
ok("a mark on the track for every day", ticks.length === all("#flow .day").length, `${ticks.length} / ${all("#flow .day").length}`);
ok("the first day of a month is marked more strongly", ticks[0].classList.contains("month"));
ok("the marks are in order and inside the track",
   ticks.every((t, i) => parseFloat(t.style.top) >= 0 && parseFloat(t.style.top) <= 800
                          && (i === 0 || parseFloat(t.style.top) >= parseFloat(ticks[i - 1].style.top))));

// -- 7: writing a heading the way SciLog does -------------------------------------------------
// CKEditor's Autoformat builds "# " out of the digit in the model name, so heading1 must be
// the first heading whatever tag it writes. Name them after their tags and one hash does
// nothing, which is a thing a writer notices and cannot fix.
const heads = w.editorConfig({}, null, "").heading.options.filter((o) => o.model !== "paragraph");
ok("one hash writes the first heading", heads[0].model === "heading1", heads[0].model);
ok("the headings are heading1, 2, 3 in order", heads.every((o, i) => o.model === `heading${i + 1}`),
   heads.map((o) => o.model).join(" "));
ok("and they are still h2, h3, h4 in the post", heads.every((o, i) => o.view === `h${i + 2}`),
   heads.map((o) => o.view).join(" "));
ok("every heading's menu class matches its model", heads.every((o) => o.class === `ck-heading_${o.model}`));

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
