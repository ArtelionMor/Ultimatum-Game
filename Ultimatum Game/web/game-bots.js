/* Market Ultimatum — game-bots.js
 * Competitor (bot) AI.
 *
 * A bot runs the PLAYER'S economy, not a parallel one: same machines, same
 * workers, same drop tables, same production clock (game-production.js), same
 * shop prices, same storage. It gets no allocation and no free units — every
 * unit it owns, it produced; every coin it holds, it sold for. Its tier access
 * comes from upgrading its machines, exactly like the player's.
 *
 * All it does differently is DECIDE, once per round (botPlanRound):
 *   1. what to buy;
 *   2. which machines to staff.
 * Step 2 is its whole downside: staffing the wrong machine wastes the round, the
 * same way the player misreads the demand.
 *
 * Its per-wave weights (competitors_behavior v2, tool-generated) are read as that
 * staffing mix: weight per resource -> share of its workers on the machine that
 * makes it. The 3 purchase columns drive its appetite for buying.
 */
"use strict";

import { nextMachineLevel } from "./game-shop.js";
import { Meta } from "./meta.js";

const PURCHASES = ["increaseWorker", "increaseMarketting", "increaseStorage"];
// Bots obey the player's feature_unlock locks — same economy, same handicaps.
const PURCHASE_FEATURE = { increaseMarketting: "marketting", increaseStorage: "storage" };

// Weights driving the bot for a given wave (competitors_behavior v2). Falls
// back to the nearest earlier wave so a shorter table still drives late rounds.
export function botBehavior(b, round) {
  const byRound = b.behaviorByRound || {};
  if (byRound[round]) return byRound[round];
  let best = 0;
  for (const r in byRound) { const rn = +r; if (rn <= round && rn > best) best = rn; }
  return byRound[best] || {};
}

// Every machine the bot needs RUNNING to serve this wave's mix: the machine whose
// output is demanded, plus — recursively — whatever feeds it. Selling a converted
// resource means making its inputs too, so the whole chain is wanted.
// Weight decays upstream, so the machine whose output actually SELLS outranks its
// suppliers when workers are scarce.
const DEPTH_DECAY = 0.9;
const MAX_CHAIN = 8;    // guard: a recipe cycle in config must not hang the round

function wantedChain(game, b, behavior) {
  const byOutput = {};
  b.machines.forEach((m) => { const def = game.machineDef(m.id); if (def) byOutput[def.outputs] = m; });
  const want = new Map();                      // machine -> inherited weight
  const visit = (resId, w, depth) => {
    const m = byOutput[resId]; if (!m || depth > MAX_CHAIN) return;
    if ((want.get(m) || 0) >= w) return;       // already wanted at least this much
    want.set(m, w);
    game.machineDef(m.id).inputs.forEach((i) => visit(i.type, w * DEPTH_DECAY, depth + 1));
  };
  game.cfg.resourceOrder.forEach((r) => { if (behavior[r] > 0) visit(r, behavior[r], 0); });
  return want;
}

// Machine upgrades have no column of their own — the tool writes one appetite
// into the three purchase columns, so we reuse it.
const upgradeAppetite = (behavior) => Math.max(...PURCHASES.map((a) => behavior[a] || 0), 0);

// One decision per round: spend, then staff. Producing is left to
// game-production.js, on the same clock as the player's.
export function botPlanRound(game, b) {
  botInvest(game, b);
  staffBot(game, b);
}

// Everything the bot could buy right now, each with its pick weight.
function affordable(game, b, behavior, reserve) {
  const out = [];
  PURCHASES.forEach((a) => {
    if (a === "increaseWorker") return; // rework rabatteur : les équipes sont fixes, plus d'achat d'ouvriers
    if (PURCHASE_FEATURE[a] && !Meta.featureUnlocked(PURCHASE_FEATURE[a])) return;
    const n = game.cfg.purchases[a][b.buys[a]];
    if (!n || !(behavior[a] > 0) || b.money - n.price < reserve) return;
    out.push({ w: behavior[a], buy: () => buyShop(game, b, a, n) });
  });
  const uw = Meta.featureUnlocked("upgrade_machine") ? upgradeAppetite(behavior) : 0;
  // The whole chain is upgradable, not just the machine that sells: a starved
  // converter is fixed by a faster supplier as much as by itself.
  if (uw > 0) [...wantedChain(game, b, behavior).keys()].forEach((m) => {
    const nx = nextMachineLevel(game, m);
    // Upgrading is how a bot buys better drop odds — the player's exact deal.
    // fillCrew : un niveau qui ouvre des sièges les remplit aussitôt (équipes fixes).
    if (nx && b.money - nx.cost >= reserve) out.push({ w: uw, buy: () => { b.money -= nx.cost; m.level++; game.fillCrew(b, m); } });
  });
  return out;
}

function botInvest(game, b) {
  const behavior = botBehavior(b, game.round);
  const reserve = 0; // plus d'impôts (rework 2026-07) : tout est investissable
  let guard = 100;
  while (guard-- > 0) {
    const pool = affordable(game, b, behavior, reserve);
    if (!pool.length) break;
    pickWeighted(pool).buy();
  }
}

function buyShop(game, b, a, n) {
  b.money -= n.price; b.buys[a]++; b.upgradesBought++;
  // keep the character buff on top: `n.effect` is the shop level's flat value,
  // not the bot's total (the old code overwrote the buff on the first purchase).
  if (a === "increaseMarketting") b.marketing = n.effect + (b.buffs.marketing || 0);
  if (a === "increaseStorage") b.storageCap += n.effect;
}

function pickWeighted(pool) {
  const tot = pool.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * tot;
  for (const o of pool) { r -= o.w; if (r <= 0) return o; }
  return pool[0];
}

// The bot folds its stock exactly like the player's auto-merge: every doable
// conversion, lowest tier first so fresh T2s cascade into T3+. Same upside
// (value compression: sell few expensive units into a unit-capped market, and
// bestTier feeds attractiveness) and same risk (fewer units — a 3× customer may
// find the shelf too short). Opt-out comes from the LEVEL TOOL: the per-bot
// "Auto-merge" checkbox exports a competitors_buffs row `autoMerge` (1/0);
// absent (older exports) means merge.
function mergeBotStock(game, b) {
  if (!Meta.featureUnlocked("merge")) return; // same lock as the player's merge sheet
  if (b.buffs.autoMerge === 0 || (b.def && b.def.autoMerge === false)) return;
  let guard = 200;
  game.cfg.resourceOrder.forEach((rid) => {
    const rules = game.cfg.convert[rid]; if (!rules) return;
    Object.keys(rules).map(Number).sort((a, z) => a - z).forEach((t) => {
      const rule = rules[t];
      if (rule.resultTier > game.maxUnlockedTier()) return; // locked tier: no folding into it
      while (guard-- > 0 && (b.stock[rid][t] || 0) >= rule.quantity) {
        b.stock[rid][t] -= rule.quantity;
        game.addStock(b, rule.resultRes, rule.resultTier, rule.resultQty);
      }
    });
  });
}

// Rework rabatteur : les équipes sont FIXES, le bot ne déplace plus d'ouvriers —
// il décide le MODE de chaque machine, exactement le verbe du joueur. Appelé une
// fois par round ET ~1×/s pendant (main.js updatePlay), comme l'ancien staffing.
//
// Heuristique : une machine passe en Rabatteur quand son produit se VEND (poids
// de vague > 0) et que son stock est déjà confortable — produire de plus n'ajoute
// rien, autant sortir crier. Elle repasse en prod dès que le stock retombe. Les
// convertisseurs et les fournisseurs de chaîne restent en prod (leur sortie ne se
// vend pas directement, un rabatteur n'y capterait personne).
export function staffBot(game, b) {
  mergeBotStock(game, b); // fold before deciding: merged stock changes the thresholds
  const behavior = botBehavior(b, game.round);
  const min = Number.isFinite(game.cfg.g.hawkerStockMin) ? game.cfg.g.hawkerStockMin : 4;
  b.machines.forEach((m) => {
    const out = game.machineDef(m.id).outputs;
    const sells = (behavior[out] || 0) > 0;
    const stock = game.stockOf(b, out);
    // Hystérésis grossière : sortir à `min`, rentrer sous `min - 2` — pas de
    // flip-flop à chaque unité vendue (le trajet de retour coûte déjà assez).
    if (m.mode === "sell") { if (!sells || stock < Math.max(1, min - 2)) m.mode = "prod"; }
    else if (sells && stock >= min && game.waveActive) m.mode = "sell";
  });
}
