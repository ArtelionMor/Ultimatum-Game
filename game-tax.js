/* Market Ultimatum — game-tax.js
 * Tax logic extracted from main.js.
 *  - Pure helpers: plain functions over config/round values (no game state).
 *  - Orchestration: functions taking the Game object explicitly (state + DOM).
 */
"use strict";

import { $ } from "./helpers.js";
import { S } from "./constants.js";

// ---------- Pure helpers ----------

// The upcoming tax the player still has to face: the earliest tax round that is
// this round or later (a tax is charged at the END of its round's wave, so the
// current round still counts as "upcoming"). null once no tax remains this game.
export function nextTaxInfo(levelCfg, round) {
  let r0 = Infinity, cost = 0;
  const last = levelCfg.totalRounds;
  for (const r in levelCfg.tax) {
    const rn = +r;
    if (rn >= round && rn <= last && rn < r0) { r0 = rn; cost = levelCfg.tax[r]; }
  }
  return r0 === Infinity ? null : { round: r0, cost };
}

// Round income guaranteed to land before a given tax is charged: rounds after the
// current one up to and including the tax round (that round's income arrives at its
// prep, before its wave-end tax). Sales are excluded (unpredictable).
export function incomeUntilTax(cfg, round, taxRound) {
  let sum = 0;
  for (let k = round + 1; k <= taxRound; k++) { const ri = cfg.roundIncome[k]; sum += ri ? ri.coins : 0; }
  return sum;
}

// Base early-payment rate (0..1) per step. Configurable via general `earlyTaxDiscount`
// (accepts 0.05, "5%" or 5); defaults to 5%.
export function earlyTaxBaseRate(cfg) {
  let d = cfg.g.earlyTaxDiscount;
  if (d == null) return 0.05;
  if (typeof d === "string") d = parseFloat(d) / (d.includes("%") ? 100 : 1);
  if (!(d >= 0)) return 0.05;
  return d > 1 ? d / 100 : d;
}

// Discount stacks the earlier you pay: (base)+(base-1)+(base-2)+… percentage points,
// one term per wave remaining before the tax, each term floored at 0. E.g. base 5%
// paid 3 waves early -> 5+4+3 = 12%. Returns the list of percentage-point terms.
export function earlyTaxTerms(cfg, round, taxRound) {
  const k = Math.max(0, taxRound - round);      // waves left before the tax lands
  const basePts = earlyTaxBaseRate(cfg) * 100;
  const terms = [];
  for (let i = 0; i < k; i++) { const t = basePts - i; if (t <= 0) break; terms.push(t); }
  return terms;
}

export function earlyTaxDiscountRate(cfg, round, taxRound) {
  const sum = earlyTaxTerms(cfg, round, taxRound).reduce((s, t) => s + t, 0);
  return Math.min(0.95, sum / 100);             // never make the tax fully free
}

export function earlyTaxAmount(cfg, round, cost, taxRound) {
  return Math.max(0, Math.round(cost * (1 - earlyTaxDiscountRate(cfg, round, taxRound))));
}

// ---------- Orchestration (take the Game object) ----------

export function enterTax(game) {
  const cost = game.taxFor(game.round);
  const p = game.player;
  const prepaid = p.prepaidTaxRound === game.round; // player already settled this tax in advance
  // Charge every alive competitor; the player is skipped when they've prepaid.
  // Failing the tax is FATAL. That is what turns an exponential tax curve into a
  // clock: the market only carries a shrinking number of companies, and each
  // death hands its share of the demand to the survivors — which is the only
  // reason anyone can pay the next one.
  const elimNow = [];
  if (cost > 0) game.competitors.forEach((c) => {
    if (c.eliminated || (c === p && prepaid)) return;
    if (c.money < cost) { c.money = 0; c.eliminated = true; elimNow.push(c); return; }
    c.money -= cost;
  });
  game._elimNow = elimNow;
  if (prepaid) p.prepaidTaxRound = null;
  const charged = cost > 0 && !p.eliminated && !prepaid ? cost : 0;
  $("#tax-before").textContent = p.money + charged;
  $("#tax-amount").textContent = prepaid && cost > 0 ? "réglé d'avance ✅" : "-" + cost;
  $("#tax-after").textContent = p.money;
  $("#tax-title").textContent = cost > 0
    ? (prepaid ? `Impôt réglé d'avance — Round ${game.round}` : `Impôt — Round ${game.round}`)
    : "Pas d'impôt ce round";
  $("#tax-overlay").classList.remove("hidden");
  setTimeout(() => { $("#tax-overlay").classList.add("hidden"); game.transitionTo(S.Results); }, cost > 0 ? 1900 : 800);
}

export function openTaxInfo(game) { game._taxOpen = true; game._taxTimer = 0.3; renderTaxInfo(game); $("#taxinfo-overlay").classList.remove("hidden"); }
export function closeTaxInfo(game) { game._taxOpen = false; $("#taxinfo-overlay").classList.add("hidden"); }

// Player settles the whole of the next tax now, at a discount. One tax at a time.
export function prepayTax(game) {
  const info = nextTaxInfo(game.levelCfg, game.round);
  if (!info || game.player.prepaidTaxRound === info.round) return;
  const amount = earlyTaxAmount(game.cfg, game.round, info.cost, info.round);
  if (game.player.money < amount) return;
  game.player.money -= amount;
  game.player.prepaidTaxRound = info.round;
  renderTaxInfo(game); game.refreshHud();
}

export function renderTaxInfo(game) {
  const body = $("#taxinfo-body"); if (!body) return;
  const p = game.player, total = game.levelCfg.totalRounds;
  const info = nextTaxInfo(game.levelCfg, game.round);

  // Round timeline with tax markers (🏛️ = tax round).
  let dots = "";
  for (let r = 1; r <= total; r++) {
    const taxHere = game.taxFor(r) > 0;
    const cls = ["tx-dot"];
    if (r < game.round) cls.push("past");
    if (r === game.round) cls.push("now");
    if (taxHere) cls.push("tax");
    if (info && r === info.round) cls.push("next");
    dots += `<div class="${cls.join(" ")}" title="Round ${r}${taxHere ? " · impôt " + game.taxFor(r) + "$" : ""}">${taxHere ? "🏛️" : ""}</div>`;
  }

  let card;
  if (!info) {
    card = `<div class="tx-card"><div class="tx-none">Plus aucun impôt d'ici la fin de la partie 🎉</div></div>`;
  } else {
    const prepaid = p.prepaidTaxRound === info.round;
    const inN = info.round - game.round;
    const when = inN <= 0 ? "à la fin de cette vague" : `dans ${inN} vague${inN > 1 ? "s" : ""}`;
    const income = incomeUntilTax(game.cfg, game.round, info.round);
    const projected = p.money + income - (prepaid ? 0 : info.cost);
    const amount = earlyTaxAmount(game.cfg, game.round, info.cost, info.round);
    const saved = info.cost - amount;
    const terms = earlyTaxTerms(game.cfg, game.round, info.round);
    const pct = Math.round(earlyTaxDiscountRate(game.cfg, game.round, info.round) * 100);
    const breakdown = terms.length > 1 ? ` (${terms.map((t) => +t.toFixed(1)).join("+")})` : "";
    const afford = p.money >= amount;

    const rows =
      `<div class="tx-row"><span>Impôt à payer</span><b class="danger">${info.cost}$</b></div>` +
      `<div class="tx-row"><span>Ton solde actuel</span><b>${p.money}$</b></div>` +
      `<div class="tx-row"><span>Revenu garanti d'ici là</span><b class="ok">+${income}$</b></div>` +
      `<div class="tx-row tx-proj"><span>Solde projeté après impôt</span><b class="${projected < 0 ? "danger" : "ok"}">${projected}$</b></div>`;

    let prepay;
    if (prepaid) {
      prepay = `<div class="tx-paid">✅ Impôt du Round ${info.round} déjà réglé d'avance</div>`;
    } else {
      prepay =
        `<div class="tx-prepay-line">Payer maintenant : <b>${amount}$</b><span class="tx-save">−${pct}%${breakdown} · tu économises ${saved}$</span></div>` +
        `<button id="tx-prepay-btn"${afford ? "" : " disabled"}>Payer l'impôt d'avance</button>` +
        (afford ? "" : `<div class="tx-warn">Solde insuffisant</div>`);
    }

    card =
      `<div class="tx-card">
         <div class="tx-card-head"><span class="tx-card-title">Prochain impôt</span><span class="tx-when">Round ${info.round} · ${when}</span></div>
         <div class="tx-rows">${rows}</div>
         <div class="tx-prepay">${prepay}</div>
       </div>`;
  }

  body.innerHTML =
    `<div class="tx-topline">Round <b>${game.round}</b> / ${total}</div>` +
    `<div class="tx-progress">${dots}</div>` +
    card;

  const btn = body.querySelector("#tx-prepay-btn");
  if (btn) btn.onclick = () => prepayTax(game);
}
