/* Market Ultimatum — helpers.js
 * Tiny DOM / utility helpers.
 */

// Sprites are split across sub-folders by kind: Characters (customers),
// Machines, Ressources (resources + their tiers) and UI (coins, worker…).
// Pass the folder so we fetch from the right place; "" keeps the sprites/ root.
export const sprite = (id, folder = "") => (id ? `sprites/${folder ? folder + "/" : ""}${id}.png` : "");
export const $ = (s) => document.querySelector(s);
export const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Show an overlay and bring it to the front. Overlays share a z-index in CSS,
// so stacking order is otherwise decided by DOM order — this bumps the just-
// opened one above the others, so a widget opened from inside another panel
// (resource from codex, building from a recipe graph…) always lands on top and,
// once closed, reveals the panel underneath.
let _overlayZ = 1500;
export const openOverlay = (id) => { const o = document.getElementById(id); if (!o) return; o.style.zIndex = ++_overlayZ; o.classList.remove("hidden"); };

// Forward a nested scroller's over-scroll to the page. On touch (iOS especially)
// a swipe is locked to the inner scroller it started in: once it hits the inner
// top/bottom it just rubber-bands instead of scrolling the page — so a big flick
// that lands on the inventory feels "stuck". While the inner list is pinned at a
// boundary and the finger keeps pushing past it, we scroll the nearest scrollable
// ancestor ourselves (and swallow the default) so the gesture keeps going.
const _scrollableAncestor = (node) => {
  for (let n = node; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  }
  return document.scrollingElement || document.documentElement;
};
// iOS quirk: once a gesture starts scrolling a list natively, preventDefault is
// ignored for the rest of that gesture — so a single flick that exhausts a short
// list just rubber-bands and never reaches the page. We decide once per gesture:
// tall lists keep native scroll (with inertia); short lists, or gestures that
// start already pinned at a boundary, are driven manually so the finger's motion
// is split between the inner list and the page in the SAME gesture.
const _MANUAL_MAX = 48;   // lists whose scroll range is <= ~1 row: never worth native inertia
export const chainOverscroll = (elm) => {
  let lastY = 0, manual = null;   // per-gesture: null (undecided) | true | false
  const range = () => elm.scrollHeight - elm.clientHeight;
  elm.addEventListener("touchstart", (e) => { lastY = e.touches[0].clientY; manual = null; }, { passive: true });
  elm.addEventListener("touchmove", (e) => {
    const y = e.touches[0].clientY;
    const dy = y - lastY;                 // >0: finger down -> reveal content above
    const m = range();
    if (manual === null) {                // decide on the first move (iOS can only be stopped here)
      const atTop = elm.scrollTop <= 0, atBottom = elm.scrollTop >= m - 1;
      const canScroll = (dy < 0 && !atBottom) || (dy > 0 && !atTop);
      manual = m <= _MANUAL_MAX || !canScroll;
    }
    if (!manual) { lastY = y; return; }   // tall list, room to move: let iOS scroll it natively
    e.preventDefault();                   // take over the whole gesture
    const oldT = elm.scrollTop;
    elm.scrollTop = Math.max(0, Math.min(m, oldT - dy));   // inner consumes what it can
    const outer = _scrollableAncestor(elm.parentElement);
    const remaining = dy - (oldT - elm.scrollTop);          // the rest scrolls the page
    if (outer && remaining) outer.scrollTop -= remaining;
    lastY = y;
  }, { passive: false });
};
