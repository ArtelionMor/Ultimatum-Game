// Runs the pure market model with no UI, for every market (citron, jus,
// bouteille): the player at a fixed price (low / mid / high = 0.6 / 1 / 1.6 ×
// the reference price) against that market's 3 rivals at their fixed start
// prices, for 10 simulated minutes. Prints market share per segment and
// answers: is there a price strategy that always dominates?
//
//   node tools/check-market.js            (from the repo root)
//   node tools/check-market.js --minutes 5 --market bottle

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { marketCfg, stepMarket, createShareTracker, trackShares, marketShares, segmentShare } from '../src/market.js';
import { produce, unitCost } from '../src/factory.js';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const MINUTES = Number(arg('--minutes') || 10);
const ONLY = arg('--market');
const DT = 0.1;
const QUALITIES = [1, 2.5, 4];          // start, mid-game, late-game player
const PLAYER_PROD = 5000;               // units/min: capacity never limits, isolates the price effect
const pct = x => (x * 100).toFixed(0).padStart(3) + '%';

function run(mk, rivalsDef, price, quality, minutes = MINUTES) {
  const you = { id: 'you', price, quality, stock: 500, stockCap: 5000, prodRate: PLAYER_PROD };
  const rivals = rivalsDef.map(c => ({ id: c.id, price: c.start_price, quality: c.quality, stock: c.stock_cap / 2, stockCap: c.stock_cap, prodRate: c.prod_per_min }));
  const sellers = [you, ...rivals];
  const tr = createShareTracker(mk, sellers.map(s => s.id));
  const margin = price - unitCost(mk, quality);
  const segProfit = {};
  for (const sg of mk.segments) segProfit[sg.id] = 0;
  for (let t = 0; t < minutes * 60; t += DT) {
    for (const s of sellers) produce(s, DT);
    const res = stepMarket(mk, sellers, DT);
    for (const sg of mk.segments) segProfit[sg.id] += res.seg[sg.id].by.you * margin / minutes;
    trackShares(tr, res, DT, cfg.market.share_smoothing_s);
  }
  const seg = {};
  for (const sg of mk.segments) {
    seg[sg.id] = {};
    for (const s of sellers) seg[sg.id][s.id] = segmentShare(tr, sg.id, s.id);
    seg[sg.id].lost = (tr.seg[sg.id].refused + tr.seg[sg.id].noStock) / tr.seg[sg.id].demand;
  }
  return { total: marketShares(tr), seg, segProfit, profitPerMin: Object.values(segProfit).reduce((a, b) => a + b, 0) };
}

function checkMarket(row) {
  const mk = marketCfg(cfg, row.id);
  const rivalsDef = cfg.rivals.filter(r => r.market === row.id);
  const PRICES = { bas: row.ref_price * 0.6, moyen: row.ref_price, haut: row.ref_price * 1.6 };
  const ids = ['you', ...rivalsDef.map(c => c.id)];
  const short = id => id === 'you' ? 'TOI' : id === 'lost' ? 'perdu' : id.slice(0, 5);

  console.log(`\n================ ${row.icon} ${row.name} — ${MINUTES} min simulées, T=${mk.temperature}, prix réf ${row.ref_price} ================`);
  console.log('Rivaux (prix fixes) : ' + rivalsDef.map(c => `${c.name} ${c.start_price}$ q${c.quality}`).join(' · '));
  const results = {};
  for (const q of QUALITIES) {
    console.log(`\n--- Joueur qualité ${q} (coût unitaire ${unitCost(mk, q).toFixed(2)}$) ---`);
    console.log('prix          segment     ' + [...ids, 'lost'].map(i => short(i).padStart(5)).join(' ') + '   profit/min');
    for (const [name, price] of Object.entries(PRICES)) {
      const r = run(mk, rivalsDef, price, q);
      results[`${q}|${name}`] = r;
      for (const sg of mk.segments) {
        console.log(`${(name + ' ' + price.toFixed(2) + '$').padEnd(13)} ${sg.name.padEnd(11)} ` + [...ids, 'lost'].map(i => pct(r.seg[sg.id][i]).padStart(5)).join(' ') + `   ${r.segProfit[sg.id].toFixed(0).padStart(6)}$`);
      }
      console.log(`${''.padEnd(13)} ${'TOTAL'.padEnd(11)} ` + ids.map(i => pct(r.total[i]).padStart(5)).join(' ') + `         ${r.profitPerMin.toFixed(0).padStart(6)}$`);
    }
  }

  console.log('\n=== Verdicts ===');
  // Profit per segment, on a fine price sweep — the real positioning question.
  let profitDominant = true;
  for (const q of QUALITIES) {
    const best = {};
    for (const sg of mk.segments) best[sg.id] = { p: null, v: 0 };
    for (let p = row.price_step; p <= row.ref_price * 3; p += row.price_step) {
      if (p < unitCost(mk, q)) continue;
      const r = run(mk, rivalsDef, p, q, 2);
      for (const sg of mk.segments) if (r.segProfit[sg.id] > best[sg.id].v + 1e-6) best[sg.id] = { p, v: r.segProfit[sg.id] };
    }
    const prices = mk.segments.map(sg => best[sg.id].p).filter(p => p !== null);
    if (new Set(prices.map(p => p.toFixed(2))).size > 1) profitDominant = false;
    console.log(`• q${q} prix le plus rentable par segment : ` + mk.segments.map(sg => `${sg.name} ${best[sg.id].p === null ? '— (refus)' : best[sg.id].p.toFixed(2) + '$'}`).join(' · '));
  }
  console.log(profitDominant
    ? '⚠ Un même prix est le plus rentable pour tous les segments : stratégie dominante.'
    : '✓ Le prix rentable dépend du segment : pas de stratégie de prix dominante.');

  // Natural favourite of each segment among the rivals (player at mid price, start quality).
  const ref = results[`${QUALITIES[0]}|moyen`];
  const favs = new Set();
  for (const sg of mk.segments) {
    let best = null, v = -1;
    for (const c of rivalsDef) if (ref.seg[sg.id][c.id] > v) { v = ref.seg[sg.id][c.id]; best = c; }
    favs.add(best.id);
    console.log(`    ${sg.name.padEnd(10)} → favori naturel : ${best.name} (${pct(v)})`);
  }
  console.log(favs.size === mk.segments.length ? '✓ Chaque segment a un favori différent.' : '⚠ Un même rival est favori de plusieurs segments.');
}

for (const row of cfg.markets) if (!ONLY || row.id === ONLY) checkMarket(row);
