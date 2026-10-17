// Runs the pure market model with no UI: the player at a fixed price (low / mid /
// high) against the 3 rivals at their fixed start prices, for 10 simulated minutes.
// Prints market share per segment and answers: is there a price strategy that
// always dominates?
//
//   node tools/check-market.js            (from v2/)
//   node tools/check-market.js --minutes 5

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stepMarket, createShareTracker, trackShares, marketShares, segmentShare } from '../src/market.js';
import { produce, unitCost } from '../src/factory.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
const product = cfg.product[0];
const argMin = process.argv.indexOf('--minutes');
const MINUTES = argMin > 0 ? Number(process.argv[argMin + 1]) : 10;
const DT = 0.1;

const PRICES = { bas: 6, moyen: 10, haut: 16 };
const QUALITIES = [1, 2.5, 4];          // start, mid-game, late-game player
const PLAYER_PROD = 5000;               // units/min: capacity never limits, isolates the price effect

function rivals() {
  return cfg.competitors.map(c => ({
    id: c.id, price: c.start_price, quality: c.quality,
    stock: c.stock_cap / 2, stockCap: c.stock_cap, prodRate: c.prod_per_min,
  }));
}

function run(price, quality, minutes = MINUTES) {
  const you = { id: 'you', price, quality, stock: 500, stockCap: 5000, prodRate: PLAYER_PROD };
  const sellers = [you, ...rivals()];
  const tr = createShareTracker(cfg, sellers.map(s => s.id));
  const tau = cfg.market.share_smoothing_s;
  const margin = price - unitCost(product, quality);
  const segProfit = {};
  for (const sg of cfg.segments) segProfit[sg.id] = 0;
  for (let t = 0; t < minutes * 60; t += DT) {
    for (const s of sellers) produce(s, DT);
    const res = stepMarket(cfg, product, sellers, DT);
    for (const sg of cfg.segments) segProfit[sg.id] += res.seg[sg.id].by.you * margin / minutes;
    trackShares(tr, res, DT, tau);
  }
  const seg = {};
  for (const sg of cfg.segments) {
    seg[sg.id] = {};
    for (const s of sellers) seg[sg.id][s.id] = segmentShare(tr, sg.id, s.id);
    seg[sg.id].lost = (tr.seg[sg.id].refused + tr.seg[sg.id].noStock) / tr.seg[sg.id].demand;
  }
  const profitPerMin = Object.values(segProfit).reduce((a, b) => a + b, 0);
  return { total: marketShares(tr), seg, segProfit, profitPerMin };
}

const pct = x => (x * 100).toFixed(0).padStart(3) + '%';
const ids = ['you', ...cfg.competitors.map(c => c.id)];
const short = { you: 'TOI', cheap: 'Cass', premium: 'Prem', follower: 'Suiv', lost: 'perdu' };

console.log(`\n=== check-market — ${MINUTES} min simulées, T=${cfg.market.temperature}, prix réf ${product.ref_price} ===`);
console.log('Rivaux (prix fixes) : ' + cfg.competitors.map(c => `${c.name} ${c.start_price}$ q${c.quality}`).join(' · '));
console.log('Segments : ' + cfg.segments.map(s => `${s.name} ${s.demand_per_min}/min a=${s.a} b=${s.b} seuil=${s.refuse_below}`).join(' · '));
console.log('Capacité du joueur illimitée pour isoler l\'effet du prix.');

const results = {};
for (const q of QUALITIES) {
  console.log(`\n--- Joueur qualité ${q} (coût unitaire ${unitCost(product, q)}$) ---`);
  console.log('prix        segment     ' + [...ids, 'lost'].map(i => short[i].padStart(5)).join(' ') + '   profit/min');
  for (const [name, price] of Object.entries(PRICES)) {
    const r = run(price, q);
    results[`${q}|${name}`] = r;
    for (const sg of cfg.segments) {
      console.log(`${(name + ' ' + price + '$').padEnd(11)} ${sg.name.padEnd(11)} ` + [...ids, 'lost'].map(i => pct(r.seg[sg.id][i]).padStart(5)).join(' ') + `   ${r.segProfit[sg.id].toFixed(0).padStart(6)}$`);
    }
    console.log(`${''.padEnd(11)} ${'TOTAL'.padEnd(11)} ` + ids.map(i => pct(r.total[i]).padStart(5)).join(' ') + `         ${r.profitPerMin.toFixed(0).padStart(6)}$`);
  }
}

// --- Verdicts ---------------------------------------------------------------
console.log('\n=== Verdicts ===');

// 1. Share: is the cheapest price always the share winner?
let cheapestAlways = true;
for (const q of QUALITIES) for (const sg of cfg.segments) {
  const v = Object.keys(PRICES).map(n => results[`${q}|${n}`].seg[sg.id].you);
  if (Math.max(...v) > 0.01 && v[0] + 1e-9 < Math.max(...v)) cheapestAlways = false;
}
console.log(cheapestAlways
  ? '• Part de marché : « le moins cher » gagne toujours la part brute (attendu : à qualité égale, le score baisse avec le prix).'
  : '• Part de marché : le prix le plus bas ne gagne pas toujours la part.');

// 2. Profit per segment, on a fine price sweep — the real positioning question.
const SWEEP = [];
for (let p = 3; p <= 30; p += 0.5) SWEEP.push(p);
let profitDominant = true;
for (const q of QUALITIES) {
  const best = {};
  for (const sg of cfg.segments) best[sg.id] = { p: null, v: 0 };
  for (const p of SWEEP) {
    if (p < unitCost(product, q)) continue;
    const r = run(p, q, 2);
    for (const sg of cfg.segments) if (r.segProfit[sg.id] > best[sg.id].v + 1e-6) best[sg.id] = { p, v: r.segProfit[sg.id] };
  }
  const prices = cfg.segments.map(sg => best[sg.id].p).filter(p => p !== null);
  if (new Set(prices).size > 1) profitDominant = false;
  console.log(`• q${q} prix le plus rentable par segment : ` + cfg.segments.map(sg => `${sg.name} ${best[sg.id].p === null ? '— (refus)' : best[sg.id].p + '$'}`).join(' · '));
}
console.log(profitDominant
  ? '⚠ Un même prix est le plus rentable pour tous les segments : stratégie dominante.'
  : '✓ Le prix rentable dépend du segment : pas de stratégie de prix dominante, il faut se positionner.');

// 3. Natural favourite of each segment among the rivals (player at mid price, start quality).
const ref = results[`${QUALITIES[0]}|moyen`];
console.log('• Favori naturel par segment (joueur au prix moyen q1) :');
const favs = new Set();
for (const sg of cfg.segments) {
  let best = null, v = -1;
  for (const c of cfg.competitors) if (ref.seg[sg.id][c.id] > v) { v = ref.seg[sg.id][c.id]; best = c; }
  favs.add(best.id);
  console.log(`    ${sg.name.padEnd(10)} → ${best.name} (${pct(v)})`);
}
console.log(favs.size === cfg.segments.length ? '✓ Chaque segment a un favori différent.' : '⚠ Un même rival est favori de plusieurs segments.');
