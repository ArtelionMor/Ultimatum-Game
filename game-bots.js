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
 *   1. what to buy, out of whatever sits above its tax reserve;
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
import { addWorker } from "./game-workers.js";

const PURCHASES = ["increaseWorker", "increaseMarketting", "increaseStorage"];

// 1 = reaches the tax holding exactly its cost · 0.6 = arrives 40% short and
// gambles on covering it with that wave's sales. Per-bot personality, meant to
// come from the level tool.
const RISK_APPETITE = 1.0;
const riskAppetite = (b) => b.def.riskAppetite ?? RISK_APPETITE;

// Cash held back for the next tax, as a LINEAR RAMP from the previous tax to the
// next. The original rule counted every future round's income as already earned,
// which made the reserve ~0 on round 1 (the bot blew its whole bankroll) and
// ~full one round before the tax (it froze). A ramp keeps it investing every
// round instead — more or less, never all-or-nothing.
export function taxReserve(levelCfg, b, round) {
  let next = Infinity, cost = 0, prev = 0;
  for (const r in levelCfg.tax) {
    const rn = +r;
    if (rn >= round && rn < next) { next = rn; cost = levelCfg.tax[r]; }
    if (rn < round && rn > prev) prev = rn;
  }
  if (!cost) return 0;
  const span = next - prev;
  return Math.max(0, cost * riskAppetite(b) * (span > 0 ? (round - prev) / span : 1));
}

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

// A converter with nothing to convert produces strictly nothing, so it is not worth
// a worker yet — its supplier is. Handing the worker back and forth IS the bot
// playing the chain: fill the input buffer, then switch over. What you do by hand.
function machineReady(game, b, m) {
  return game.machineDef(m.id).inputs.every((i) => game.stockOf(b, i.type) >= i.quantity);
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
    const n = game.cfg.purchases[a][b.buys[a]];
    if (!n || !(behavior[a] > 0) || b.money - n.price < reserve) return;
    if (a === "increaseWorker" && b.workers.length >= game.cfg.g.maxWorkersTotal) return; // même plafond que le joueur
    out.push({ w: behavior[a], buy: () => buyShop(game, b, a, n) });
  });
  const uw = upgradeAppetite(behavior);
  // The whole chain is upgradable, not just the machine that sells: a starved
  // converter is fixed by a faster supplier as much as by itself.
  if (uw > 0) [...wantedChain(game, b, behavior).keys()].forEach((m) => {
    const nx = nextMachineLevel(game, m);
    // Upgrading is how a bot buys better drop odds — the player's exact deal.
    if (nx && b.money - nx.cost >= reserve) out.push({ w: uw, buy: () => { b.money -= nx.cost; m.level++; } });
  });
  return out;
}

function botInvest(game, b) {
  const behavior = botBehavior(b, game.round);
  const reserve = taxReserve(game.levelCfg, b, game.round);
  let guard = 100;
  while (guard-- > 0) {
    const pool = affordable(game, b, behavior, reserve);
    if (!pool.length) break;
    pickWeighted(pool).buy();
  }
}

function buyShop(game, b, a, n) {
  b.money -= n.price; b.buys[a]++; b.upgradesBought++;
  if (a === "increaseWorker") for (let i = 0; i < n.effect; i++) addWorker(game, b);
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
  if (b.buffs.autoMerge === 0 || (b.def && b.def.autoMerge === false)) return;
  let guard = 200;
  game.cfg.resourceOrder.forEach((rid) => {
    const rules = game.cfg.convert[rid]; if (!rules) return;
    Object.keys(rules).map(Number).sort((a, z) => a - z).forEach((t) => {
      const rule = rules[t];
      while (guard-- > 0 && (b.stock[rid][t] || 0) >= rule.quantity) {
        b.stock[rid][t] -= rule.quantity;
        game.addStock(b, rule.resultRes, rule.resultTier, rule.resultQty);
      }
    });
  });
}

// Decide the crew, then move only the workers that differ. Called once per round
// AND periodically during it (main.js updatePlay): a production chain only flows if
// the bot can hand a worker over the moment an input buffer fills or runs dry.
export function staffBot(game, b) {
  mergeBotStock(game, b); // fold before staffing: merged stock changes what machineReady sees
  const want = wantedChain(game, b, botBehavior(b, game.round));
  const entries = [...want.entries()];

  // Rank by STOCK DEFICIT, not by raw weight. Sorting on weight alone broke ties
  // by Map insertion order — i.e. by resourceOrder — which buried late-listed
  // resources (bottle is 8th): with equal 33/33/33 demand a bot needed enough
  // workers to staff every OTHER wanted machine before its converter ever got
  // one. Instead, produce what is missing relative to the wanted mix, the way
  // the player does: a machine whose output is under-represented in stock beats
  // one whose output is already piled up. Uses only the bot's own stock — no
  // omniscience — and self-regulates the chain: the converter outranks its
  // supplier while inputs are stocked, drops out when they run dry (ready
  // filter), and the worker flows back upstream.
  let totW = 0, totS = 0;
  entries.forEach(([m, w]) => { totW += w; totS += game.stockOf(b, game.machineDef(m.id).outputs); });
  const score = ([m, w]) => {
    const deficit = Math.max(0, (totW ? w / totW : 0) - (totS ? game.stockOf(b, game.machineDef(m.id).outputs) / totS : 0));
    return w * (0.15 + deficit); // 0.15 baseline: balanced stock still ranks by demand weight
  };
  const ready = entries.filter(([m]) => machineReady(game, b, m)).sort((a, z) => score(z) - score(a));

  const target = new Map();
  let pool = b.workers.length;
  // 1. Get as many wanted machines RUNNING as possible: fill each one's minimum,
  //    heaviest first. Below workersRequired a machine produces strictly nothing,
  //    so a half-staffed crew is worth less than no crew at all.
  ready.forEach(([m]) => { const need = game.lvl(m).workersRequired; if (pool >= need) { target.set(m, need); pool -= need; } });
  // 2. Pile the leftovers onto the heaviest running machines — crew size buys speed
  //    (crewSpeedBonus), not just eligibility.
  ready.forEach(([m]) => {
    if (!target.has(m)) return;
    const max = game.lvl(m).maxWorkers;
    while (target.get(m) < max && pool > 0) { target.set(m, target.get(m) + 1); pool--; }
  });

  // Release the excess first (that is what frees workers), then fill. A machine that
  // keeps its crew keeps its progress — tickProduction wipes `elapsed` the instant a
  // machine drops below its required crew, so never re-seat someone who was fine.
  b.machines.forEach((m) => { const n = target.get(m) || 0; while (m.crew.length > n) { const w = m.crew.pop(); w.machineId = null; } });
  b.machines.forEach((m) => {
    const n = target.get(m) || 0;
    while (m.crew.length < n) { const w = b.workers.find((x) => !x.machineId); if (!w) break; w.machineId = m.id; m.crew.push(w); }
  });
}
