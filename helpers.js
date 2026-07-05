/* Market Ultimatum — helpers.js
 * Tiny DOM / utility helpers.
 */

import { SPRITES } from "./constants.js";

export const sprite = (id) => SPRITES[id] || (id ? `sprites/${id}.png` : "");
export const $ = (s) => document.querySelector(s);
export const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
