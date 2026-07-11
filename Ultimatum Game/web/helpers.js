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
