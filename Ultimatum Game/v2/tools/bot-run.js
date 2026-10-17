// Plays a whole game with a simple greedy bot (no UI) to check pacing:
// buys the bottleneck station when affordable, grows the stock when it is full,
// and every few seconds sets the price that maximises expected profit/min —
// or, once production can cover the target share, the highest price that wins it.
//
//   node tools/bot-run.js [--minutes 40]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newGame, step, buyStation, buyStock, stockInfo, upgradeInfo, currentBottleneck,
  setPrice, priceBounds, sellersOf, shareOf, productOf } from '../src/sim.js';
import { previewPreference } from '../src/market.js';
import { unitCost } from '../src/factory.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
const argMin = process.argv.indexOf('--minutes');
const MAX_MIN = argMin > 0 ? Number(process.argv[argMin + 1]) : 40;
const DT = 0.1;
const product = productOf(cfg);

function bestPrice(st) {
  const b = priceBounds(cfg, st);
  const cost = unitCost(product, st.you.quality);
  let best = st.you.price, bestV = -Infinity;
  const old = st.you.price;
  for (let p = b.min; p <= Math.min(b.max, 30); p += b.step) {
    st.you.price = p;
    const pref = previewPreference(cfg, product, sellersOf(st));
    let want = 0;
    for (const sg of cfg.segments) want += sg.demand_per_min * pref[sg.id].probs.you;
    // Once the factory can serve the monopoly, chase share instead of profit.
    const total = cfg.segments.reduce((a, sg) => a + sg.demand_per_min, 0);
    const v = st.you.prodRate >= total * cfg.goal.share_target * 1.1
      ? (want >= total * (cfg.goal.share_target + 0.05) ? p : -1)
      : Math.min(want, st.you.prodRate) * (p - cost);
    if (v > bestV) { bestV = v; best = p; }
  }
  st.you.price = old;
  return best;
}

const st = newGame(cfg);
let nextLog = 0, priceT = 0;
for (let t = 0; t < MAX_MIN * 60 && !st.goal.won; t += DT) {
  step(cfg, st, DT);
  const bn = currentBottleneck(cfg, st);
  const up = upgradeInfo(cfg, st, bn.id);
  const sk = stockInfo(cfg, st);
  if (st.you.stock >= st.you.stockCap - 1 && sk.cost <= up.cost) buyStock(cfg, st);
  else buyStation(cfg, st, bn.id);
  priceT += DT;
  if (priceT >= 5) { priceT = 0; setPrice(cfg, st, bestPrice(st)); }
  if (st.t >= nextLog) {
    nextLog += 60;
    const sh = shareOf(st);
    console.log(`t=${(st.t / 60).toFixed(0).padStart(2)}min  $${st.money.toFixed(0).padStart(7)}  prod ${st.you.prodRate.toFixed(0).padStart(4)}/min  stock ${st.you.stockCap}  q${st.you.quality.toFixed(2)}  prix ${st.you.price}  part ${(sh.you * 100).toFixed(0)}%  | ` +
      st.rivals.map(r => `${r.id} ${r.price}$ q${r.quality.toFixed(1)} ${(sh[r.id] * 100).toFixed(0)}%`).join(' · '));
  }
}
console.log(st.goal.won ? `\n👑 Victoire à ${(st.goal.wonAt / 60).toFixed(1)} min` : `\n✗ Pas de victoire en ${MAX_MIN} min`);
