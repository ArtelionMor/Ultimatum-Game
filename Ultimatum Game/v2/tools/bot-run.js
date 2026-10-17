// Plays a game with a simple greedy bot (no UI) to check pacing.
// It first places the free Cueillette under the Outcome to sell lemons, then
// builds up to 4 bottle lines from a fixed template wired to the starting
// Outcome, upgrades the slowest machine, grows the stock when bottles pile up,
// and every few seconds sets the bottle price that maximises expected
// profit/min — or, once its output can cover a monopoly, the highest price
// that wins it. Reports when the player first holds a monopoly.
//
//   node tools/bot-run.js [--minutes 40]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newGame, step, buyMachine, buyBelt, upgradeMachine, machineInfo, buyStock, stockInfo,
  setPrice, priceBounds, sellersOf, shareOf, mkOf, monopolistOf } from '../src/sim.js';
import { placeCost, stageCapacity } from '../src/grid.js';
import { previewPreference } from '../src/market.js';
import { unitCost } from '../src/factory.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
const argMin = process.argv.indexOf('--minutes');
const MAX_MIN = argMin > 0 ? Number(process.argv[argMin + 1]) : 40;
const DT = 0.1;
const M = 'bottle';
const row = cfg.markets.find(r => r.id === M);
const DOWN = 1, RIGHT = 0, LEFT = 2;
const OX = cfg.grid.outcome_x, OY = cfg.grid.outcome_y;

// Line at column c: machines stacked downwards from row 0, then belts down to
// the row above the Outcome and along it, entering the Outcome from the top.
const LINES = [OX - 2, OX + 3, OX - 4, OX + 5];
function lineCost(st) {
  return ['harvest', 'press', 'bottle'].reduce((a, t) => a + placeCost(cfg, st.grid, t), 0) + 10 * cfg.grid.belt_cost;
}
function buildLine(st, c) {
  buyMachine(cfg, st, 'harvest', c, 0, DOWN);
  buyBelt(cfg, st, c, 2, DOWN);
  buyMachine(cfg, st, 'press', c, 3, DOWN);
  buyBelt(cfg, st, c, 5, DOWN);
  buyMachine(cfg, st, 'bottle', c, 6, DOWN);
  for (let y = 8; y < OY - 1; y++) buyBelt(cfg, st, c, y, DOWN);
  const target = c < OX ? OX : OX + 1, dir = c < OX ? RIGHT : LEFT;
  for (let x = c; x !== target; x += c < OX ? 1 : -1) buyBelt(cfg, st, x, OY - 1, dir);
  buyBelt(cfg, st, target, OY - 1, DOWN);
}

function bestPrice(st) {
  const b = priceBounds(cfg, st, M);
  const you = st.mk[M].you, mk = mkOf(cfg, M);
  const cost = unitCost(row, you.quality);
  const total = mk.segments.reduce((a, sg) => a + sg.demand_per_min, 0);
  const cap = Math.max(stageCapacity(cfg, st.grid, row.stage), 1);
  const old = you.price;
  let profitP = old, profitV = -Infinity, shareP = null;
  for (let p = b.min; p <= Math.min(b.max, row.ref_price * 3); p += b.step) {
    you.price = p;
    const pref = previewPreference(mk, sellersOf(st, M));
    let want = 0;
    for (const sg of mk.segments) want += sg.demand_per_min * pref[sg.id].probs.you;
    const v = Math.min(want, cap) * (p - cost);
    if (v > profitV) { profitV = v; profitP = p; }
    if (cap >= total * cfg.monopoly.share && want >= total * (cfg.monopoly.share + 0.05) && p > cost) shareP = p;
  }
  you.price = old;
  return shareP ?? profitP;
}

const st = newGame(cfg);
// Starter: free harvester just below the Outcome, facing up, one belt into it.
buyMachine(cfg, st, 'harvest', OX, OY + 3, 3);
buyBelt(cfg, st, OX, OY + 2, 3);
let built = 0, nextLog = 0, priceT = 0, firstMono = null;
for (let t = 0; t < MAX_MIN * 60; t += DT) {
  step(cfg, st, DT);
  if (firstMono === null && monopolistOf(st, M) === 'you') firstMono = st.t;
  if (built < LINES.length && st.money >= lineCost(st)) buildLine(st, LINES[built++]);
  else if (built > 0) {
    const machines = st.grid.machines.filter(m => !cfg.machines.find(d => d.id === m.type).sink);
    const slowest = machines.reduce((a, m) => machineInfo(cfg, st, m).rate < machineInfo(cfg, st, a).rate ? m : a);
    const you = st.mk[M].you;
    if (you.stock >= you.stockCap - 1 && stockInfo(cfg, st).affordable) buyStock(cfg, st);
    else if (built >= LINES.length || machineInfo(cfg, st, slowest).cost < lineCost(st) / 3) upgradeMachine(cfg, st, slowest);
  }
  priceT += DT;
  if (priceT >= 5) { priceT = 0; setPrice(cfg, st, M, bestPrice(st)); }
  if (st.t >= nextLog) {
    nextLog += 60;
    const you = st.mk[M].you, holder = monopolistOf(st, M);
    console.log(`t=${(st.t / 60).toFixed(0).padStart(2)}min  $${st.money.toFixed(0).padStart(6)}  lignes ${built}  capa ${stageCapacity(cfg, st.grid, row.stage).toFixed(0).padStart(4)}/min  livré ${you.prodRate.toFixed(0).padStart(4)}/min  q${you.quality.toFixed(2)}  prix ${you.price}  part ${(shareOf(st, M).you * 100).toFixed(0)}%${holder ? '  👑 ' + holder : ''}`);
  }
}
console.log(firstMono !== null ? `\n👑 Premier monopole Bouteille du joueur à ${(firstMono / 60).toFixed(1)} min` : `\n✗ Pas de monopole Bouteille en ${MAX_MIN} min`);
