/* Market Ultimatum — game-customers.js
 * Customer spawning, shop choice and sales extracted from main.js.
 *  - pickNeed: pure (market def + resource order).
 *  - restackCustomers: pure DOM (no game state).
 *  - attractiveness / chooseShop / sellTo: module-local, take game.
 *  - spawnCustomer: exported orchestration (DOM + animation).
 */
"use strict";

import { $, el, sprite, randInt } from "./helpers.js";
import { FALL_TIME } from "./constants.js";
import { openCodexResource, openCodexCustomer } from "./codex.js";

function pickNeed(marketDef, order) {
  const w = marketDef.weights;
  const tot = order.reduce((s, r) => s + (w[r] || 0), 0);
  let r = Math.random() * tot; let res = order.find((x) => w[x] > 0) || order[0];
  for (const x of order) { if (!w[x]) continue; r -= w[x]; if (r <= 0) { res = x; break; } }
  const avg = marketDef.avg; const qty = Math.max(1, [avg - 1, avg, avg + 1][randInt(0, 2)]);
  return { resId: res, qty };
}

function attractiveness(game, c, resId) { return c.marketing + game.tierInfo(resId, game.bestTier(c, resId)).influence; }

function chooseShop(game, eligible, resId) {
  const min = game.cfg.g.minimalPercentage;
  const A = eligible.map((c) => attractiveness(game, c, resId));
  const sum = A.reduce((s, x) => s + x, 0);
  let p = A.map((x) => x / sum);
  // enforce floor then renormalize the non-floored proportionally
  const fixed = p.map((x) => x < min);
  const fixedSum = p.reduce((s, x, i) => s + (fixed[i] ? min : 0), 0);
  const freeSum = p.reduce((s, x, i) => s + (fixed[i] ? 0 : x), 0);
  p = p.map((x, i) => fixed[i] ? min : (freeSum > 0 ? x / freeSum * (1 - fixedSum) : (1 - fixedSum) / p.length));
  let r = Math.random(); for (let i = 0; i < eligible.length; i++) { r -= p[i]; if (r <= 0) return eligible[i]; }
  return eligible[eligible.length - 1];
}

function sellTo(game, c, resId, qty) {
  let gain = 0;
  const m = c.stock[resId];
  const tiers = Object.keys(m).map(Number).sort((a, b) => b - a); // highest tier first
  for (const t of tiers) { while (qty > 0 && m[t] > 0) { m[t]--; qty--; gain += game.tierInfo(resId, t).price; } }
  c.money += gain; c.salesThisRound += gain;
  if (c === game.player) game._invDirty = true;
  return gain;
}

export function spawnCustomer(game) {
  const need = pickNeed(game.market.def, game.cfg.resourceOrder);
  const m = game.market; m.active++;
  const lane = $("#customer-lane");
  const cust = el("div", "customer");
  cust.style.left = randInt(12, 88) + "%";
  const custSprite = game.cfg.customerSprites[need.resId] || "Customer"; // sprite chosen by demanded resource
  cust.innerHTML = `<div class="bubble"><span>${need.qty}×</span><img src="${game.tierSrc(need.resId, 1)}"></div><img class="cust-sprite" src="${sprite(custSprite)}">`;
  const fall = FALL_TIME / (game.cfg.g.customerSpeed || 1); // customerSpeed: higher = faster
  cust.style.setProperty("--fall", fall + "s");
  // tap the bubble to inspect the wanted resource, the sprite to inspect the client
  cust.querySelector(".bubble").onclick = (e) => { e.stopPropagation(); openCodexResource(need.resId); };
  cust.querySelector(".cust-sprite").onclick = (e) => { e.stopPropagation(); const cid = game.customerForResource(need.resId); if (cid) openCodexCustomer(cid); };
  lane.appendChild(cust);
  requestAnimationFrame(() => cust.classList.add("falling"));

  setTimeout(() => {
    const eligible = game.competitors.filter((c) => !c.eliminated && game.stockOf(c, need.resId) >= need.qty);
    if (eligible.length) {
      const winner = chooseShop(game, eligible, need.resId);
      const gain = sellTo(game, winner, need.resId, need.qty);
      if (winner._counter) {
        const cr = winner._counter.getBoundingClientRect(), lr = lane.getBoundingClientRect();
        cust.style.left = (cr.left - lr.left + cr.width / 2) + "px";
        cust.classList.add("toShop");
        game.flashStall(winner, gain);
      }
    } else {
      cust.classList.add("nobody"); // turns red
      const x = parseFloat(cust.style.left) || 50;
      cust.style.left = (x < 50 ? -25 : 125) + "%"; // slide off to the nearest edge
    }
    setTimeout(() => cust.remove(), 750);
    m.served++; m.active--;
    game.refreshSuppliers();
  }, fall * 1000);
}

// Depth-sort customers so the closest ones (lowest on screen) paint on top.
// Two z bands keep every bubble above every sprite; within each band, closer = higher.
export function restackCustomers() {
  const lane = $("#customer-lane");
  if (!lane) return;
  const custs = [...lane.querySelectorAll(".customer")];
  if (custs.length < 2) return;
  custs
    .map((c) => ({ c, y: c.getBoundingClientRect().top }))
    .sort((a, b) => a.y - b.y) // farthest (higher up) first, closest (lower) last
    .forEach(({ c }, i) => {
      const custSprite = c.querySelector(".cust-sprite");
      const bubble = c.querySelector(".bubble");
      if (custSprite) custSprite.style.zIndex = 1 + i;
      if (bubble) bubble.style.zIndex = 1000 + i;
    });
}
