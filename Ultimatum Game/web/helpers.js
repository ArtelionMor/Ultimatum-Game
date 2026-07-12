/* Market Ultimatum — helpers.js
 * Tiny DOM / utility helpers.
 */

export const sprite = (id) => (id ? `sprites/${id}.png` : "");
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
export const chainOverscroll = (elm) => {
  let lastY = 0;
  elm.addEventListener("touchstart", (e) => { lastY = e.touches[0].clientY; }, { passive: true });
  elm.addEventListener("touchmove", (e) => {
    const y = e.touches[0].clientY;
    const dy = y - lastY;                 // >0: finger down -> reveal content above
    lastY = y;
    const atTop = elm.scrollTop <= 0;
    const atBottom = Math.ceil(elm.scrollTop + elm.clientHeight) >= elm.scrollHeight;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) {
      const outer = _scrollableAncestor(elm.parentElement);
      if (outer) { outer.scrollTop -= dy; e.preventDefault(); }  // take over: scroll the page, not the (pinned) list
    }
  }, { passive: false });
};
