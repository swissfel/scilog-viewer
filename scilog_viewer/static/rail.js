// SciLog viewer: the scroll rail down the right of the flow.
//
// A handle wide enough for a thumb, a mark on the track for every day (the first day of a
// month a little stronger), and -- while the handle is held, or the rail is pointed at --
// a sign saying where it would take you: the day, which part of that day (night, morning,
// noon, afternoon, evening, late) and the heading of first or second order above that
// place. The sign goes by itself a moment after letting go, so it is never in the way.
//
// Where things are is read from the flow once (railIndex) and kept until the flow changes,
// so dragging through a logbook of a few thousand posts costs nothing per step.
"use strict";

const railState = { index: null, height: 0, at: 0, dragging: false, grab: 0, hide: null, ticks: null };
//: the handle is never smaller than a fingertip, however long the logbook is
const RAIL_MIN = 44;

function railGeometry() {
  const flow = $("#flow"), rail = $("#rail");
  const track = rail.clientHeight;
  const range = Math.max(1, flow.scrollHeight - flow.clientHeight);
  const size = Math.max(RAIL_MIN, Math.round(track * flow.clientHeight / Math.max(1, flow.scrollHeight)));
  return { flow, rail, track, range, size, travel: Math.max(1, track - size) };
}

// the handle where the flow stands; hidden when there is nothing to scroll
function updateRail() {
  const rail = document.getElementById("rail");
  if (!rail) return;
  const flow = $("#flow");
  if (!state.logbook || flow.scrollHeight - flow.clientHeight < 60) { rail.hidden = true; return; }
  rail.hidden = false;
  const { track, range, size, travel } = railGeometry();
  const at = Math.round(travel * Math.min(1, Math.max(0, flow.scrollTop / range)));
  const handle = $("#rail-handle");
  handle.style.height = `${size}px`;
  handle.style.transform = `translateY(${at}px)`;
  handle.setAttribute("aria-valuenow", String(Math.round(100 * flow.scrollTop / range)));
  railState.at = at;
  if (railState.height !== flow.scrollHeight && !railState.dragging) {
    railState.height = flow.scrollHeight;     // posts drawn on the way changed the lengths
    railState.index = null;
    laterRailTicks();
  }
  if (track <= 0) rail.hidden = true;
}

// Where every post and every heading of first or second order sits in the flow, in scroll
// pixels. Read in one go (a page of a few thousand posts: a few milliseconds) and kept.
function railIndex() {
  if (railState.index) return railState.index;
  const flow = $("#flow");
  const base = flow.getBoundingClientRect().top - flow.scrollTop;
  const posts = [];
  for (const p of state.posts) {
    const node = document.getElementById(`p-${p.id}`);
    if (node) posts.push({ at: node.getBoundingClientRect().top - base, t: p.t, id: p.id });
  }
  const heads = [];
  for (const h of flow.querySelectorAll(".body h1, .body h2")) {
    const text = h.textContent.trim();
    if (text) heads.push({ at: h.getBoundingClientRect().top - base, text: text.slice(0, 70),
                           level: h.tagName === "H1" ? 1 : 2 });
  }
  railState.index = { posts, heads };
  return railState.index;
}

function railLast(list, at) {
  let lo = 0, hi = list.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= at) { found = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** What is at this place of the flow: the post there and the heading above it. */
function railLook(scrollTop) {
  const index = railIndex();
  const want = scrollTop + 8;                 // what the top of the screen would show
  return { post: railLast(index.posts, want) || index.posts[0] || null,
           head: railLast(index.heads, want) };
}

function showRailSign(y, scrollTop) {
  const bubble = $("#rail-bubble"), rail = $("#rail");
  const { post, head } = railLook(scrollTop);
  bubble.replaceChildren(
    el("div", { class: "rb-when", text: post ? dayTitle(post.t) : "" }),
    el("div", { class: "rb-part", text: post ? `${dayPart(post.t)} · ${clock(post.t)}` : "" }),
    head ? el("div", { class: `rb-head rb-h${head.level}`, text: head.text }) : null);
  bubble.style.top = `${Math.round(Math.min(rail.clientHeight - 30, Math.max(30, y)))}px`;
  bubble.hidden = false;
  clearTimeout(railState.hide);
}

function hideRailSign(after = 1200) {
  clearTimeout(railState.hide);
  railState.hide = setTimeout(() => { const b = document.getElementById("rail-bubble"); if (b) b.hidden = true; }, after);
}

// -- holding the handle ---------------------------------------------------------------------

function railGrab(e) {
  const handle = $("#rail-handle");
  $("#rail").setPointerCapture(e.pointerId);
  railState.dragging = true;
  document.body.classList.add("railing");
  const box = handle.getBoundingClientRect();
  // taken by the handle: keep the place in it; taken anywhere else: the handle comes along
  railState.grab = e.clientY >= box.top && e.clientY <= box.bottom ? e.clientY - box.top : box.height / 2;
  railMove(e);
}

function railMove(e) {
  const { flow, rail, range, size, travel } = railGeometry();
  const top = rail.getBoundingClientRect().top;
  const want = Math.min(travel, Math.max(0, e.clientY - top - railState.grab));
  flow.scrollTop = range * want / travel;
  updateRail();
  showRailSign(want + size / 2, flow.scrollTop);
}

// pointed at with a mouse, not held: say what is there without going anywhere
function railPeek(e) {
  const { flow, rail, range, size, travel } = railGeometry();
  const top = rail.getBoundingClientRect().top;
  const want = Math.min(travel, Math.max(0, e.clientY - top - size / 2));
  showRailSign(e.clientY - top, range * want / travel);
  hideRailSign(2000);
}

function railLetGo() {
  if (!railState.dragging) return;
  railState.dragging = false;
  document.body.classList.remove("railing");
  railState.height = 0;                       // read the places again now that it has settled
  updateRail();
  hideRailSign();
}

// -- the days along the track ------------------------------------------------------------------

function drawRailTicks() {
  const rail = document.getElementById("rail");
  if (!rail || rail.hidden) return;
  const { range, size, travel } = railGeometry();
  const frag = document.createDocumentFragment();
  let day = null, month = null;
  for (const p of railIndex().posts) {
    const k = dayKey(p.t);
    if (k === day) continue;
    day = k;
    const m = monthKey(p.t);
    const mark = el("div", { class: `rail-tick${m === month ? "" : " month"}` });
    month = m;
    // the same reckoning as the handle: its middle on a mark means that day at the top
    mark.style.top = `${Math.round(Math.min(travel, Math.max(0, travel * p.at / range)) + size / 2)}px`;
    frag.append(mark);
  }
  $("#rail-ticks").replaceChildren(frag);
}

function laterRailTicks() {
  clearTimeout(railState.ticks);
  railState.ticks = setTimeout(drawRailTicks, 250);
}

// -- set up ---------------------------------------------------------------------------------------

(function setUpRail() {
  const rail = $("#rail"), flow = $("#flow");
  rail.addEventListener("pointerdown", (e) => { e.preventDefault(); railGrab(e); });
  rail.addEventListener("pointermove", (e) => {
    if (railState.dragging) railMove(e);
    else if (e.pointerType !== "touch") railPeek(e);
  });
  rail.addEventListener("pointerup", railLetGo);
  rail.addEventListener("pointercancel", railLetGo);
  rail.addEventListener("pointerleave", () => { if (!railState.dragging) hideRailSign(200); });
  rail.addEventListener("dblclick", (e) => e.preventDefault());
  flow.addEventListener("scroll", updateRail, { passive: true });
  window.addEventListener("resize", () => { railState.index = null; updateRail(); laterRailTicks(); });
  // posts drawn, a piece of older ones put in above: the places have moved
  new MutationObserver(() => { railState.index = null; updateRail(); laterRailTicks(); }).observe(flow, { childList: true });
  updateRail();
})();
