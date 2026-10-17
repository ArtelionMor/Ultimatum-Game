// Plays a whole game with a simple greedy bot (no UI) to check pacing.
// It builds up to 4 vertical production lines from a fixed template, upgrades
// the slowest machine, grows the warehouse when it is full, and every few
// seconds sets the price that maximises expected profit/min — or, once its
// output can cover the target share, the highest price that wins it.
//
//   node tools/bot-run.js [--minutes 40]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newGame, step, buyMachine, buyBelt, upgradeMachine, machineInfo, buyStock, stockInfo,
  setPrice, priceBounds, sellersOf, shareOf, productOf } from '../src/sim.js';
import { placeCost, gridCapacity } from '../src/grid.js';
import { previewPreference } from '../src/market.js';
import { unitCost } from '../src/factory.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
const argMin = process.argv.indexOf('--minutes');
const MAX_MIN = argMin > 0 ? Number(process.argv[argMin + 1]) : 40;
const DT = 0.1;
const product = productOf(cfg);
const DOWN = 1, RIGHT = 0, LEFT = 2;

// Line at column c: machines stacked downwards, then a belt along row 10 to
// the warehouse (cols 4-5, rows 11-12), entering from above.
const LINES = [0, 6, 2, 8];
function lineCost(st) {
  return ['harvest', 'press', 'bottle'].reduce((a, t) => a + placeCost(cfg, st.grid, t), 0) + 8 * cfg.grid.belt_cost;
}
function buildLine(st, c) {
  buyMachine(cfg, st, 'harvest', c, 0, DOWN);
  buyBelt(cfg, st, c, 2, DOWN);
  buyMachine(cfg, st, 'press', c, 3, DOWN);
  buyBelt(cfg, st, c, 5, DOWN);
  buyMachine(cfg, st, 'bottle', c, 6, DOWN);
  buyBelt(cfg, st, c, 8, DOWN);
  buyBelt(cfg, st, c, 9, DOWN);
  const toward = c < 4 ? RIGHT : LEFT;
  for (let x = c; x !== (c < 4 ? 4 : 5); x += c < 4 ? 1 : -1) buyBelt(cfg, st, x, 10, toward);
  buyBelt(cfg, st, c < 4 ? 4 : 5, 10, DOWN);
}

function bestPrice(st) {
  const b = priceBounds(cfg, st);
  const cost = unitCost(product, st.you.quality);
  const total = cfg.segments.reduce((a, sg) => a + sg.demand_per_min, 0);
  const cap = Math.max(gridCapacity(cfg, st.grid), 1);
  const old = st.you.price;
  let profitP = old, profitV = -Infinity, shareP = null;
  for (let p = b.min; p <= Math.min(b.max, 30); p += b.step) {
    st.you.price = p;
    const pref = previewPreference(cfg, product, sellersOf(st));
    let want = 0;
    for (const sg of cfg.segments) want += sg.demand_per_min * pref[sg.id].probs.you;
    const v = Math.min(want, cap) * (p - cost);
    if (v > profitV) { profitV = v; profitP = p; }
    // Highest price that still wins the target share (if the factory can serve it).
    if (cap >= total * cfg.goal.share_target * 1.1 && want >= total * (cfg.goal.share_target + 0.05) && p > cost) shareP = p;
  }
  st.you.price = old;
  return shareP ?? profitP;
}

const st = newGame(cfg);
let built = 0, nextLog = 0, priceT = 0;
for (let t = 0; t < MAX_MIN * 60 && !st.goal.won; t += DT) {
  step(cfg, st, DT);
  if (built < LINES.length && st.money >= lineCost(st)) buildLine(st, LINES[built++]);
  else if (built > 0) {
    const machines = st.grid.machines.filter(m => m.type !== 'warehouse');
    // Bottlers first when they are the slowest stage; they also raise quality.
    const slowest = machines.reduce((a, m) => machineInfo(cfg, st, m).rate < machineInfo(cfg, st, a).rate ? m : a);
    const sk = stockInfo(cfg, st);
    if (st.you.stock >= st.you.stockCap - 1 && sk.affordable) buyStock(cfg, st);
    else if (built >= LINES.length || machineInfo(cfg, st, slowest).cost < lineCost(st) / 3) upgradeMachine(cfg, st, slowest);
  }
  priceT += DT;
  if (priceT >= 5) { priceT = 0; setPrice(cfg, st, bestPrice(st)); }
  if (st.t >= nextLog) {
    nextLog += 60;
    const sh = shareOf(st);
    console.log(`t=${(st.t / 60).toFixed(0).padStart(2)}min  $${st.money.toFixed(0).padStart(6)}  lignes ${built}  capa ${gridCapacity(cfg, st.grid).toFixed(0).padStart(4)}/min livré ${st.you.prodRate.toFixed(0).padStart(4)}/min  stock ${st.you.stockCap}  q${st.you.quality.toFixed(2)}  prix ${st.you.price}  part ${(sh.you * 100).toFixed(0)}%`);
  }
}
console.log(st.goal.won ? `\n👑 Victoire à ${(st.goal.wonAt / 60).toFixed(1)} min` : `\n✗ Pas de victoire en ${MAX_MIN} min`);
