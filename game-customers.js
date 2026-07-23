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
//
// RÉSERVE ≠ COMPTOIR : la marchandise réservée sort du stock mais ne s'évapore pas,
// elle est POSÉE SUR LE COMPTOIR (putOnCounter) et y reste visible jusqu'à ce que le
// client descende la prendre. `tiers` liste le tier de chaque unité servie, dans
// l'ordre où elle a été piochée — c'est ce qui est affiché sur le comptoir.
function reserveSale(game, c, resId, qty) {
  let gain = 0; const asked = qty; const taken = [];
  const m = c.stock[resId];
  const tiers = Object.keys(m).map(Number).sort((a, b) => b - a); // highest tier first
  for (const t of tiers) { while (qty > 0 && m[t] > 0) { m[t]--; qty--; gain += game.tierInfo(resId, t).price; taken.push(t); } }
  if (c === game.player) game._invDirty = true;
  return { gain, units: asked - qty, resId, tiers: taken };
}
function settleSale(game, c, sale) {
  c.money += sale.gain; c.salesThisRound += sale.gain;
  c.revenue += sale.gain; // revenus cumulés : LA métrique du classement (dépenser ne fait pas reculer)
  c.unitsThisRound = (c.unitsThisRound || 0) + sale.units; // parts de marché en volume (camembert de fin de round)
}

// --- Anti-chevauchement des colonnes -----------------------------------------
// Le jitter aléatoire d'avant (±18 px pour un sprite de 46) laissait deux clients
// tomber quasiment au même x : côte à côte dans le temps (même paquet, même
// comptoir), ils se superposaient. On choisit maintenant des CRÉNEAUX espacés et on
// écarte ceux qu'occupe déjà un client encore en haut de la lane.
const LANE_SLOT = 52;   // px : sprite 46 + marge ; en-deçà deux clients se recouvrent
const LANE_BUSY = 80;   // px sous le haut de la lane : au-delà, le client a assez descendu

// x (centre, en px dans la lane) des clients encore trop hauts pour être doublés.
function busyLaneXs(lane, laneRect) {
  return [...lane.querySelectorAll(".customer")]
    .filter((c) => c.getBoundingClientRect().top - laneRect.top < LANE_BUSY)
    .map((c) => parseFloat(c.style.left))
    .filter((x) => !Number.isNaN(x));
}

// band = { center, half } : la plage autorisée (le comptoir visé, ou la lane entière).
// On balaie cette plage et on garde le meilleur x selon un score à deux étages :
// d'abord s'écarter des voisins (plafonné à LANE_SLOT : au-delà c'est déjà « libre »),
// ensuite, à égalité, viser au plus près du comptoir. Un comptoir saturé ne peut plus
// espacer tout le monde — on prend alors le point le MOINS mauvais, jamais un doublon.
function freeLaneX(lane, laneRect, band) {
  const taken = busyLaneXs(lane, laneRect);
  const aim = band.center + randInt(-8, 8);              // léger flou : pas toujours pile au centre
  let lo = Math.max(10, band.center - band.half + LANE_SLOT / 2);
  let hi = Math.min(laneRect.width - 10, band.center + band.half - LANE_SLOT / 2);
  if (hi < lo) lo = hi = Math.max(10, Math.min(laneRect.width - 10, band.center)); // comptoir minuscule
  if (!taken.length) return Math.max(lo, Math.min(hi, aim));
  const gap = (x) => Math.min(...taken.map((t) => Math.abs(t - x)));
  let best = lo, score = -Infinity;
  for (let x = lo; x <= hi; x += 4) {
    const s = Math.min(gap(x), LANE_SLOT) * 1000 - Math.abs(x - aim);
    if (s > score) { score = s; best = x; }
  }
  return best;
}

// Place (ou re-place) un client dans la file du comptoir visé. Appelé à l'apparition,
// et de nouveau si un client « en attente » trouve preneur en cours de chute : la
// transition CSS sur `left` (.55 s) le fait alors GLISSER vers la bonne ligne.
function aimAtCounter(game, cust, target) {
  const lane = $("#customer-lane");
  const laneRect = lane.getBoundingClientRect();
  const counter = target && target._counter ? target._counter.getBoundingClientRect() : null;
  const band = counter
    ? { center: counter.left - laneRect.left + counter.width / 2, half: counter.width / 2 }
    : { center: laneRect.width / 2, half: laneRect.width * .38 };   // pas de comptoir : toute la lane
  cust.style.left = freeLaneX(lane, laneRect, band) + "px";
}

// Un client apparu alors que PERSONNE n'avait sa ressource n'est pas condamné : tant
// qu'il descend, on retente sa réservation. Dès qu'un comptoir peut le servir (ta
// machine vient de sortir la pièce), la marchandise part sur ce comptoir et le client
// glisse vers cette ligne — au lieu de se cogner contre un stand vide alors que la
// commande existe. Appelé ~10×/s depuis updatePlay.
export function retryWaiting(game) {
  const m = game.market; if (!m || !m.waiting || !m.waiting.length) return;
  m.waiting = m.waiting.filter((o) => {
    if (o.order.arrived || !o.cust.isConnected) return false;   // trop tard / déjà retiré
    const eligible = game.competitors.filter((c) => game.stockOf(c, o.need.resId) >= o.need.qty);
    if (!eligible.length) return true;                          // toujours rien : il continue d'attendre
    const winner = chooseShop(game, eligible, o.need.resId);
    o.order.winner = winner;
    o.order.sale = reserveSale(game, winner, o.need.resId, o.need.qty);
    game.putOnCounter(winner, o.order.sale);
    aimAtCounter(game, o.cust, winner);
    return false;
  });
}

export function spawnCustomer(game) {
  const need = pickNeed(game.market.def, game.cfg.resourceOrder);
  const m = game.market; m.active++;
  const lane = $("#customer-lane");
  const cust = el("div", "customer");

  // CHOIX DU SHOP DÈS L'APPARITION (plus au dernier moment) : on regarde qui a le
  // stock MAINTENANT, on tire le vainqueur, et on réserve sa marchandise. Le client
  // descend alors DEVANT ce comptoir. Personne ne peut le servir ? Il part quand même,
  // en ATTENTE (retryWaiting) — la commande peut encore sortir d'une machine.
  // `order` est mutable exprès : c'est le seul lien entre le tir initial, une
  // réservation tardive et le règlement en bas.
  const eligible = game.competitors.filter((c) => game.stockOf(c, need.resId) >= need.qty);
  const order = { winner: eligible.length ? chooseShop(game, eligible, need.resId) : null, sale: null, arrived: false };
  if (order.winner) {
    order.sale = reserveSale(game, order.winner, need.resId, need.qty);
    game.putOnCounter(order.winner, order.sale);   // la marchandise sort du stock et se pose sur le comptoir
  } else {
    (m.waiting = m.waiting || []).push({ need, cust, order });
  }

  // Servi : pile devant le comptoir choisi. En attente : il prend une LIGNE au hasard
  // — le comptoir d'un concurrent tiré au sort — quitte à changer de file s'il trouve
  // preneur en route. La colonne exacte vient de freeLaneX (anti-chevauchement).
  aimAtCounter(game, cust, order.winner || game.competitors[randInt(0, game.competitors.length - 1)]);

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
    order.arrived = true;   // ferme la fenêtre de rattrapage : retryWaiting ne doit plus le servir
    const { winner, sale } = order;
    if (winner && sale) {
      settleSale(game, winner, sale); // stock déjà réservé, on crédite l'argent ici
      game.takeFromCounter(winner, sale, cust); // le client emporte enfin sa commande posée sur le comptoir
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
