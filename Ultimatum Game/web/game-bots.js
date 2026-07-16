/* Market Ultimatum — game-bots.js
 * Competitor (bot) AI extracted from main.js.
 *  - taxReserve: pure (config + bot math).
 *  - simulate/plan/release + botUseful/botDo: take game (use game stock/market helpers).
 */
"use strict";

// Reserve for the next upcoming tax, minus the guaranteed income the bot will still
// collect before that tax is charged (round income + passive per-round gain, for every
// round from the next one up to and including the tax round — that round's income lands
// before its tax). Lets bots invest early instead of hoarding the full tax from round 1.
export function taxReserve(cfg, levelCfg, b, round) {
  let taxRound = Infinity, cost = 0;
  for (const r in levelCfg.tax) { const rn = +r; if (rn >= round && rn < taxRound) { taxRound = rn; cost = levelCfg.tax[r]; } }
  if (!cost) return 0;
  const passive = b.def.increaseByRound + b.def.upgradeEffect * b.upgradesBought;
  let future = 0;
  for (let k = round + 1; k <= taxRound; k++) { const ri = cfg.roundIncome[k]; future += (ri ? ri.coins : 0) + passive; }
  return Math.max(0, cost - future);
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

// speed buff (%): the bot produces cheaper — the economic analog of "produces
// faster" for bots, which buy units instead of running machines.
function unitCost(b, ti) { return Math.ceil(ti.price / (1 + (b.buffs.speed || 0) / 100)); }

export function simulateBot(game, b) {
  const inc = game.cfg.roundIncome[game.round];
  b.money += b.def.increaseByRound + b.def.upgradeEffect * b.upgradesBought;
  b.salesThisRound = 0;
  b.stock = game.emptyStock();
  const tier = inc ? inc.tier : 1;

  // Keep enough to survive the upcoming tax, net of income still to come before it.
  const reserve = taxReserve(game.cfg, game.levelCfg, b, game.round);

  // "Will I sell it?" — estimate how many units of each resource are worth making
  // this round, so the bot doesn't overproduce stock it can't move.
  const mk = game.marketFor(game.round);
  const order = game.cfg.resourceOrder;
  const totalW = order.reduce((s, r) => s + (mk.weights[r] || 0), 0) || 1;
  const numAlive = game.competitors.filter((c) => !c.eliminated).length || 1;
  const target = {};
  order.forEach((r) => { const demand = mk.customers * ((mk.weights[r] || 0) / totalW) * mk.avg; target[r] = Math.ceil(demand / numAlive * 1.3); });

  const behavior = botBehavior(b, game.round);
  const actions = Object.keys(behavior).filter((k) => behavior[k] > 0);
  let guard = 600;
  while (guard-- > 0) {
    const pool = actions.filter((a) => botUseful(game, b, a, tier, reserve, target));
    if (!pool.length) break;
    const tot = pool.reduce((s, a) => s + behavior[a], 0);
    let r = Math.random() * tot; let pick = pool[0];
    for (const a of pool) { r -= behavior[a]; if (r <= 0) { pick = a; break; } }
    botDo(game, b, pick, tier);
  }
}

export function botUseful(game, b, a, tier, reserve, target) {
  if (a === "increaseWorker") { const n = game.cfg.purchases.increaseWorker[b.buys.increaseWorker]; return n && b.money - n.price >= reserve; }
  if (a === "increaseMarketting") { const n = game.cfg.purchases.increaseMarketting[b.buys.increaseMarketting]; return n && b.money - n.price >= reserve; }
  if (a === "increaseStorage") { const n = game.cfg.purchases.increaseStorage[b.buys.increaseStorage]; return n && b.money - n.price >= reserve; }
  // produce only above the tax reserve, with storage room, and not past the sellable target
  const ti = game.tierInfo(a, tier);
  return ti && b.money - unitCost(b, ti) >= reserve && game.stockTotal(b) < b.storageCap && game.stockOf(b, a) < target[a];
}

export function botDo(game, b, a, tier) {
  if (a === "increaseWorker") { const n = game.cfg.purchases.increaseWorker[b.buys.increaseWorker]; b.money -= n.price; b.buys.increaseWorker++; b.upgradesBought++; return; }
  if (a === "increaseMarketting") { const n = game.cfg.purchases.increaseMarketting[b.buys.increaseMarketting]; b.money -= n.price; b.buys.increaseMarketting++; b.marketing = n.effect; b.upgradesBought++; return; }
  if (a === "increaseStorage") { const n = game.cfg.purchases.increaseStorage[b.buys.increaseStorage]; b.money -= n.price; b.buys.increaseStorage++; b.storageCap += n.effect; b.upgradesBought++; return; }
  const ti = game.tierInfo(a, tier); b.money -= unitCost(b, ti);
  // proba2x buff (%): chance to double the unit, like the characters' 2x
  game.addStock(b, a, tier, Math.random() * 100 < (b.buffs.proba2x || 0) ? 2 : 1);
}

// Plan a bot's whole round (money/upgrades resolved now), then queue its target
// stock to be revealed unit-by-unit over the prep so the counter fills gradually.
export function planBot(game, b) {
  simulateBot(game, b);                    // produces the round's target into b.stock, spends money
  const queue = [];
  for (const rid in b.stock) for (const t in b.stock[rid]) for (let i = 0; i < b.stock[rid][t]; i++) queue.push({ resId: rid, tier: +t });
  for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; } // shuffle for a mixed reveal
  b._queue = queue; b._queueTotal = queue.length; b._released = 0;
  b.stock = game.emptyStock();            // start the round empty; reveal over time
}

// Reveal queued units up to `progress` (0..1) of the prep.
export function releaseBotStock(game, b, progress) {
  if (!b._queue) return;
  const target = Math.min(b._queueTotal, Math.floor(progress * b._queueTotal));
  while (b._released < target) { const u = b._queue[b._released++]; game.addStock(b, u.resId, u.tier, 1); }
}
