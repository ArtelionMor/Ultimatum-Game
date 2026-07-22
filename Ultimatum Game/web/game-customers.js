/* Market Ultimatum — game-customers.js
 * Customer spawning, shop choice and sales extracted from main.js.
 *  - pickNeed: pure (market def + resource order).
 *  - restackCustomers: pure DOM (no game state).
 *  - attractiveness / chooseShop / reserveSale / settleSale: module-local, take game.
 *  - spawnCustomer: exported orchestration (DOM + animation).
 */
"use strict";

import { $, el, sprite, randInt } from "./helpers.js";
import { FALL_TIME } from "./constants.js";
import { openCodexCustomer } from "./codex.js";
import { openResource } from "./resource.js";

function pickNeed(marketDef, order) {
  const w = marketDef.weights;
  const tot = order.reduce((s, r) => s + (w[r] || 0), 0);
  let r = Math.random() * tot; let res = order.find((x) => w[x] > 0) || order[0];
  for (const x of order) { if (!w[x]) continue; r -= w[x]; if (r <= 0) { res = x; break; } }
  // La quantité RESPECTE la valeur configurée : « moyenne 1 » = chaque client
  // demande 1. Le tirage ±1 historique ne revient que si le round l'a demandé
  // (case « ±1 aléatoire » du bloc dans l'outil → colonne qty_spread).
  const avg = marketDef.avg;
  const qty = marketDef.spread ? Math.max(1, [avg - 1, avg, avg + 1][randInt(0, 2)]) : Math.max(1, avg);
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

// Le client choisit son shop À L'APPARITION et RÉSERVE tout de suite le stock
// (décrémenté ici) — ainsi un paquet de clients ne survend pas le même comptoir et
// chacun tombe devant le comptoir qu'il va vraiment visiter. L'argent, lui, n'est
// crédité qu'à l'ARRIVÉE (settleSale), pour garder le ressenti « payé à la vente ».
function reserveSale(game, c, resId, qty) {
  let gain = 0; const asked = qty;
  const m = c.stock[resId];
  const tiers = Object.keys(m).map(Number).sort((a, b) => b - a); // highest tier first
  for (const t of tiers) { while (qty > 0 && m[t] > 0) { m[t]--; qty--; gain += game.tierInfo(resId, t).price; } }
  if (c === game.player) game._invDirty = true;
  return { gain, units: asked - qty };
}
function settleSale(game, c, sale) {
  c.money += sale.gain; c.salesThisRound += sale.gain;
  c.revenue += sale.gain; // revenus cumulés : LA métrique du classement (dépenser ne fait pas reculer)
  c.unitsThisRound = (c.unitsThisRound || 0) + sale.units; // parts de marché en volume (camembert de fin de round)
}

export function spawnCustomer(game) {
  const need = pickNeed(game.market.def, game.cfg.resourceOrder);
  const m = game.market; m.active++;
  const lane = $("#customer-lane");
  const cust = el("div", "customer");

  // CHOIX DU SHOP DÈS L'APPARITION (plus au dernier moment) : on regarde qui a le
  // stock MAINTENANT, on tire le vainqueur, et on réserve sa marchandise. Le client
  // descend alors DEVANT ce comptoir. S'il n'y a personne, il est déjà « perdu ».
  const eligible = game.competitors.filter((c) => game.stockOf(c, need.resId) >= need.qty);
  const winner = eligible.length ? chooseShop(game, eligible, need.resId) : null;
  const sale = winner ? reserveSale(game, winner, need.resId, need.qty) : null;

  // Servi : pile devant le comptoir choisi. Non servi (personne n'a la ressource) :
  // il prend une LIGNE au hasard — le comptoir d'un concurrent tiré au sort — et
  // ratera sa cible en bas. Petit jitter pour ne pas empiler un paquet.
  const laneRect = lane.getBoundingClientRect();
  const laneAt = (c) => {
    const cr = c._counter.getBoundingClientRect();
    const x = cr.left - laneRect.left + cr.width / 2 + randInt(-18, 18);
    return Math.max(10, Math.min(laneRect.width - 10, x)) + "px";
  };
  const laneTarget = winner || game.competitors[randInt(0, game.competitors.length - 1)];
  cust.style.left = laneTarget && laneTarget._counter ? laneAt(laneTarget) : randInt(12, 88) + "%";

  const custSprite = game.cfg.customerSprites[need.resId]; // sprite chosen by demanded resource
  const custSrc = custSprite ? sprite(custSprite, "Characters") : sprite("Customer", "UI"); // else generic UI customer
  cust.innerHTML = `<div class="bubble"><span>${need.qty}×</span><img src="${game.tierSrc(need.resId, 1)}"></div><img class="cust-sprite" src="${custSrc}">`;
  const fall = FALL_TIME / (game.cfg.g.customerSpeed || 1); // customerSpeed: higher = faster
  cust.style.setProperty("--fall", fall + "s");
  // tap the bubble to inspect the wanted resource, the sprite to inspect the client
  cust.querySelector(".bubble").onclick = (e) => { e.stopPropagation(); openResource(need.resId); };
  cust.querySelector(".cust-sprite").onclick = (e) => { e.stopPropagation(); const cid = game.customerForResource(need.resId); if (cid) openCodexCustomer(cid); };
  lane.appendChild(cust);
  requestAnimationFrame(() => cust.classList.add("falling"));

  setTimeout(() => {
    if (winner && sale) {
      settleSale(game, winner, sale); // stock déjà réservé à l'apparition, on crédite l'argent ici
      cust.classList.add("toShop");
      game.flashStall(winner, sale.gain);
    } else {
      cust.classList.add("nobody"); // turns red : il a raté sa cible dans sa ligne
      requestAnimationFrame(() => cust.classList.add("done")); // fond sur place, pas de glissade hors écran
      // Demande non servie = part de marché PERDUE (camembert de fin de round).
      // Valorisée au prix T1 : on ignore quel tier aurait été vendu, c'est le
      // minimum que ce client aurait payé.
      m.lostUnits = (m.lostUnits || 0) + need.qty;
      m.lostValue = (m.lostValue || 0) + need.qty * game.tierInfo(need.resId, 1).price;
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
