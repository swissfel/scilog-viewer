// The picture on its own (lightbox in app.js): pinch, drag, double tap, wheel and the ways out.
// A tiny fake DOM, just enough to run the real function and feed it pointer events: node tests/test_lightbox.mjs
import fs from "node:fs";
const src = fs.readFileSync(new URL("../scilog_viewer/static/app.js", import.meta.url), "utf8");
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`);
  let i = src.indexOf(") {", start) + 2, depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
};
const W = 400, H = 800;                       // a phone-sized box
const IMGW = 384, IMGH = 288;                 // the picture as it fits (96vw)

function node(tag) {
  const e = {
    tag, children: [], style: {}, listeners: {}, parent: null,
    className: "", attrs: {},
    classList: { set: new Set(),
      toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
      contains(c) { return this.set.has(c); } },
    addEventListener(t, f) { (e.listeners[t] ||= []).push(f); },
    append(...cs) { for (const c of cs) { e.children.push(c); if (c && typeof c === 'object') c.parent = e; } },
    remove() { e.removed = true; },
    setAttribute(k, v) { e.attrs[k] = v; },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    clientWidth: W, clientHeight: H,
    fire(type, ev) { for (const f of e.listeners[type] || []) f({ preventDefault() {}, ...ev }); },
  };
  if (tag === "img") { e.offsetWidth = IMGW; e.offsetHeight = IMGH; e.naturalWidth = 2000; }
  return e;
}
let body = node("body");
globalThis.document = { createElement: node, body };
globalThis.setTimeout = ((f, ms) => { pending.push({ f, ms }); return pending.length; });
globalThis.clearTimeout = ((id) => { if (id) pending[id - 1].cancelled = true; });
let pending = [];
const realTimeout = (f) => f();

eval(grab("el") + "\n" + grab("lightbox") + "\nglobalThis.el = el; globalThis.lightbox = lightbox;");

const open = () => { body = node("body"); document.body = body; pending = []; lightbox("x.png"); return body.children[0]; };
const img = (box) => box.children[0];
const T = (box) => {  // the transform, as numbers
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(box.children[0].style.transform || "translate(0px, 0px) scale(1)");
  return m ? { tx: +m[1], ty: +m[2], s: +m[3] } : { tx: 0, ty: 0, s: 1 };
};
const touch = (box, id, x, y, type, target) =>
  box.fire(type, { pointerId: id, clientX: x, clientY: y, pointerType: "touch", target: target || img(box) });

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name} ${cond ? "" : extra}`); if (!cond) fails++; };

// 1. a pinch zooms, around the fingers' middle
let box = open();
touch(box, 1, 100, 400, "pointerdown"); touch(box, 2, 300, 400, "pointerdown");
touch(box, 1, 50, 400, "pointermove");  touch(box, 2, 350, 400, "pointermove");
let t = T(box);
ok("pinch zooms", Math.abs(t.s - 1.5) < .01, JSON.stringify(t));
ok("pinch keeps the middle of the fingers (the box centre) put", Math.abs(t.tx) < .01, JSON.stringify(t));
ok("the box is marked zoomed", box.classList.contains("zoomed"));

// 2. the spot under the fingers stays under them (off-centre pinch)
box = open();
touch(box, 1, 120, 300, "pointerdown"); touch(box, 2, 180, 300, "pointerdown");
touch(box, 1, 90, 300, "pointermove");  touch(box, 2, 210, 300, "pointermove");
t = T(box);
// the spot (150,300) → from the centre (-50, -100); after scaling by 2 it must still be at x = -50
// (sideways there is room to move; up and down the doubled picture still fits, so it stays centred)
const after = { x: t.tx + 2 * -50, y: t.ty + 2 * -100 };
ok("the pinched spot stays under the fingers (sideways)", Math.abs(after.x + 50) < .5, JSON.stringify({ t, after }));
ok("while it still fits, it stays centred up and down", t.ty === 0, JSON.stringify(t));

// 3. zoomed in, one finger pans, and the picture cannot leave the screen
touch(box, 1, 90, 300, "pointerup"); touch(box, 2, 210, 300, "pointerup");
const before = T(box);
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 260, 400, "pointermove");
t = T(box);
ok("one finger pans", t.tx > before.tx && Math.abs(t.s - before.s) < .01, JSON.stringify({ before, t }));
touch(box, 1, 5000, 400, "pointermove");
t = T(box);
ok("the picture stops at its edge", Math.abs(t.tx - (IMGW * t.s - W) / 2) < .01, JSON.stringify(t));
touch(box, 1, 5000, 400, "pointerup");
ok("a pan does not close it", !box.removed);

// 4. a double tap zooms in to the picture's own size, and out again
box = open();
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 200, 400, "pointerup");
ok("one tap waits (it may be the first of two)", !box.removed && pending.length === 1);
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 200, 400, "pointerup");
t = T(box);
ok("a double tap zooms in", t.s > 2 && !box.removed, JSON.stringify(t));
ok("the waiting close was called off", pending[0].cancelled);
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 200, 400, "pointerup");
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 200, 400, "pointerup");
t = T(box);
ok("a double tap zooms back out", Math.abs(t.s - 1) < .01 && t.tx === 0 && t.ty === 0, JSON.stringify(t));

// 5. a single tap, unzoomed, closes it (after the double-tap wait)
box = open();
touch(box, 1, 200, 400, "pointerdown"); touch(box, 1, 200, 400, "pointerup");
ok("not closed yet", !box.removed);
pending.filter((p) => !p.cancelled).forEach((p) => p.f());
ok("a single tap closes it", box.removed);

// 6. a tap beside the picture closes it at once; so does a mouse click
box = open();
touch(box, 1, 5, 5, "pointerdown", box); touch(box, 1, 5, 5, "pointerup", box);
ok("a tap on the backdrop closes it at once", box.removed);
box = open();
box.fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 400, pointerType: "mouse", target: img(box) });
box.fire("pointerup", { pointerId: 1, clientX: 200, clientY: 400, pointerType: "mouse", target: img(box) });
ok("a mouse click closes it at once", box.removed);

// 7. the wheel zooms at the pointer, and never below the fitted size
box = open();
box.fire("wheel", { deltaY: -400, clientX: 200, clientY: 400 });
t = T(box);
ok("the wheel zooms in", t.s > 2.5, JSON.stringify(t));
box.fire("wheel", { deltaY: 4000, clientX: 200, clientY: 400 });
t = T(box);
ok("it never goes below the fitted size", Math.abs(t.s - 1) < .001 && t.tx === 0, JSON.stringify(t));

// 8. the × closes it
box = open();
box.children[1].listeners.click[0]({});
ok("the × closes it", box.removed);

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
