// Pure game simulation: state + config + dt → new state and a list of events.
// No DOM, so the UI only renders and the tools can run whole games in Node.
//
// One factory floor (grid.js) feeds several markets — one per item (fruit,
// juice, bottle). Each market has its own price, stock, rivals, shares and
// monopoly bonuses.

import { marketCfg, stepMarket, createShareTracker, trackShares, marketShares, demandMultiplier } from './market.js';
import { stockCap, stockCost, unitCost, produce } from './factory.js';
import { createGrid, stepGrid, placeCost, machineDef, machineRate, upgradeCost, item, stageOf, tierOf,
  placeMachine, placeBelt, removeMachine, removeBelt, beltAt, countOf } from './grid.js';
import { createRival, repriceRival, approachRival } from './ai.js';
import { initProgress, migrateProgress } from './progress.js';
import { createBrand, stepBrand } from './monopoly.js';

export const SAVE_VERSION = 3;

// Small seeded RNG (mulberry32) whose state lives in the save.
function rng(st) {
  return () => {
    let t = (st.seed = (st.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mkCache = new WeakMap();
// Market config (row + segments), cached per cfg object.
export function mkOf(cfg, id) {
  let c = mkCache.get(cfg);
  if (!c) { c = {}; mkCache.set(cfg, c); }
  return c[id] || (c[id] = marketCfg(cfg, id));
}
export const marketOfStage = (cfg, stage) => cfg.markets.find(m => m.stage === stage);
const rivalDefs = (cfg, id) => cfg.rivals.filter(r => r.market === id);

export function newGame(cfg, seed = 12345) {
  const st = {
    v: SAVE_VERSION, cfgVersion: cfg.meta.version, seed,
    t: 0, money: cfg.player.start_money,
    grid: createGrid(cfg), stockLvl: 1,
    mk: {},
    stats: { sold: {}, earned: 0, upgrades: 0, priceChanges: 0, stockFullSeen: false, delivered: {}, built: {}, bestTier: {}, bestShare: {}, monopolies: {} },
    unlocked: {}, seen: {}, lastReveal: -999,
  };
  for (const row of cfg.markets) {
    const mk = mkOf(cfg, row.id);
    // tiers[t] = units of quality ★t in stock (fractional once sales start).
    const you = { id: 'you', price: row.start_price, quality: 1, stock: 0, tiers: [0, 0, 0, 0, 0, 0], stockCap: 0, prodRate: 0, brand: 0 };
    const rivals = rivalDefs(cfg, row.id).map(createRival);
    const ids = ['you', ...rivals.map(r => r.id)];
    st.mk[row.id] = {
      you, rivals,
      shares: createShareTracker(mk, ids),
      brands: Object.fromEntries(ids.map(id => [id, createBrand()])),
      aiPriceT: 0,
    };
    st.stats.sold[row.id] = 0;
    st.stats.delivered[row.id] = 0;
  }
  initProgress(cfg, st);
  derive(cfg, st);
  return st;
}

// Recompute what depends on the layout / levels (call after any purchase / load).
export function derive(cfg, st) {
  for (const row of cfg.markets) {
    const m = st.mk[row.id];
    m.you.quality = stockQuality(m.you);
    m.you.stockCap = stockCap(cfg, st.stockLvl);
    const b = priceBounds(cfg, st, row.id);
    if (m.you.price < b.min) m.you.price = b.min;
  }
}

// The quality customers see: average ★ of what is in stock (kept when empty).
export function stockQuality(you) {
  let n = 0, sum = 0;
  you.tiers.forEach((c, t) => { n += c; sum += c * t; });
  return n > 1e-6 ? sum / n : you.quality;
}

// Bring a save from before quality tiers up to date (items were bare stages).
export function migrate(cfg, st) {
  // Markets added since the save was made (before anything reads them).
  const fresh = newGame(cfg, st.seed);
  for (const row of cfg.markets) if (!st.mk[row.id]) {
    st.mk[row.id] = fresh.mk[row.id];
    st.stats.sold[row.id] = 0;
    st.stats.delivered[row.id] = 0;
  }
  for (const row of cfg.markets) {
    const y = st.mk[row.id].you;
    if (!y.tiers) y.tiers = [0, y.stock, 0, 0, 0, 0];
  }
  const up = it => (it === null || it >= 8 ? it : item(it, 1));
  for (const m of st.grid.machines) {
    const d = machineDef(cfg, m.type);
    if (typeof m.buf === 'number') m.buf = Array.from({ length: m.buf }, () => item(d.input_stage ?? 0, 1));
    m.out = up(m.out);
  }
  for (const k in st.grid.belts) st.grid.belts[k].item = up(st.grid.belts[k].item);
  st.stats.bestTier ||= {};
  st.stats.bestShare ||= {};
  st.stats.monopolies ||= {};
  migrateProgress(cfg, st);
  return st;
}

export const sellersOf = (st, id) => [st.mk[id].you, ...st.mk[id].rivals];
export const shareOf = (st, id) => marketShares(st.mk[id].shares);
export const monopolistOf = (st, id) => Object.keys(st.mk[id].brands).find(k => st.mk[id].brands[k].active) || null;
export const totalSold = st => Object.values(st.stats.sold).reduce((a, b) => a + b, 0);

export function step(cfg, st, dt) {
  const ev = [];
  st.t += dt;
  const mult = demandMultiplier(cfg, st.t);

  // Factory floor → one stock per item.
  const delivered = {};
  stepGrid(cfg, st.grid, dt, {
    room: stage => { const m = st.mk[marketOfStage(cfg, stage).id]; return m.you.stockCap - m.you.stock; },
    deliver: it => {
      const id = marketOfStage(cfg, stageOf(it)).id, you = st.mk[id].you;
      you.stock++;
      you.tiers[tierOf(it)]++;
      st.stats.bestTier[id] = Math.max(st.stats.bestTier[id] || 0, tierOf(it));
      delivered[id] = (delivered[id] || 0) + 1;
    },
  });

  for (const row of cfg.markets) {
    const id = row.id, m = st.mk[id], mk = mkOf(cfg, id), you = m.you;
    const d = delivered[id] || 0;
    if (d) {
      st.stats.delivered[id] += d;
      ev.push({ type: 'delivered', market: id, units: d });
      if (you.stock >= you.stockCap - 1e-6) st.stats.stockFullSeen = true;
    }
    you.prodRate += (d * 60 / dt - you.prodRate) * (1 - Math.exp(-dt / 10));   // measured, ~10 s smoothing

    for (const r of m.rivals) produce(r, dt);
    const sellers = sellersOf(st, id);
    you.quality = stockQuality(you);
    const before = you.stock;
    const res = stepMarket(mk, sellers, dt, mult);
    trackShares(m.shares, res, dt, cfg.market.share_smoothing_s);
    const sold = res.sold.you;
    // Sales take every tier in proportion, so the average quality stays put.
    if (sold > 0 && before > 0) { const k = you.stock / before; you.tiers = you.tiers.map(c => c * k); }
    if (sold > 0) {
      const gain = sold * (you.price - unitCost(row, you.quality));
      const before = Math.floor(st.stats.sold[id]);
      st.money += gain;
      st.stats.sold[id] += sold;
      st.stats.earned += gain;
      if (Math.floor(st.stats.sold[id]) > before) ev.push({ type: 'sale', market: id, gain });
    }
    for (const r of m.rivals) r.revenue += res.sold[r.id] * r.price;

    // Monopoly bonus for every seller of this market.
    const shares = marketShares(m.shares);
    if (st.stats.delivered[id] > 0) st.stats.bestShare[id] = Math.max(st.stats.bestShare[id] || 0, shares.you);
    for (const s of sellers) {
      const e = stepBrand(cfg.monopoly, m.brands[s.id], shares[s.id], dt);
      s.brand = m.brands[s.id].M;
      if (e === 'start') { ev.push({ type: 'monopolyStart', market: id, id: s.id }); if (s.id === 'you') st.stats.monopolies[id] = true; }
      else if (e === 'lost') ev.push({ type: 'monopolyLost', market: id, id: s.id });
    }

    // Rivals
    const defs = rivalDefs(cfg, id);
    m.aiPriceT += dt;
    if (m.aiPriceT >= cfg.ai.price_interval_s) {
      m.aiPriceT = 0;
      const ctx = { you, sellers, shares, rng: rng(st) };
      defs.forEach((def, i) => {
        const r = m.rivals[i], old = r.price;
        repriceRival(row, def, r, ctx);
        if (r.price !== old) ev.push({ type: 'rivalPrice', market: id, id: r.id, from: old, to: r.price });
      });
    }
    defs.forEach((def, i) => approachRival(def, m.rivals[i], st.level, dt, cfg.ai.level_tau_s));
  }
  return ev;
}

// --- Player actions ------------------------------------------------------------

// Build a machine (type from cfg.machines) with its top-left corner at (x, y).
export function buyMachine(cfg, st, type, x, y, rot) {
  const cost = placeCost(cfg, st.grid, type);
  if (st.money < cost) return { ok: false, why: 'money' };
  const m = placeMachine(st.grid, type, x, y, rot);
  if (!m) return { ok: false, why: 'place' };
  const broken = m.broken; delete m.broken;
  st.money -= cost;
  st.stats.built[type] = (st.stats.built[type] || 0) + 1;
  derive(cfg, st);
  return { ok: true, cost, broken };
}

export function buyBelt(cfg, st, x, y, dir) {
  const cost = placeCost(cfg, st.grid, 'belt');
  if (st.money < cost) return { ok: false, why: 'money' };
  if (!placeBelt(st.grid, x, y, dir)) return { ok: false, why: 'place' };
  st.money -= cost;
  st.stats.built.belt = (st.stats.built.belt || 0) + 1;
  return { ok: true, cost };
}

// What selling `m` gives back: part of what rebuilding it would cost (the
// price of the last copy of its type) plus its upgrades.
export function sellValue(cfg, st, m) {
  const d = machineDef(cfg, m.type);
  const n = countOf(st.grid, m.type) - 1;
  let spent = d.first_free && n === 0 ? 0 : Math.ceil(d.cost * Math.pow(d.cost_mult, n));
  for (let l = 1; l < m.lvl; l++) spent += upgradeCost(d, l);
  return Math.floor(spent * cfg.grid.sell_refund);
}

// Returns the refund, or -1 if it can't be sold (the last Outcome).
export function sellMachine(cfg, st, m) {
  const back = sellValue(cfg, st, m);
  if (!removeMachine(st.grid, m)) return -1;
  st.money += back;
  derive(cfg, st);
  return back;
}

export function sellBelt(cfg, st, x, y) {
  if (!beltAt(st.grid, x, y)) return 0;
  removeBelt(st.grid, x, y);
  const back = Math.floor(cfg.grid.belt_cost * cfg.grid.sell_refund);
  st.money += back;
  return back;
}

export function machineInfo(cfg, st, m) {
  const d = machineDef(cfg, m.type);
  const cost = upgradeCost(d, m.lvl);
  return { def: d, lvl: m.lvl, rate: machineRate(d, m.lvl), nextRate: machineRate(d, m.lvl + 1), cost, affordable: st.money >= cost };
}

export function upgradeMachine(cfg, st, m) {
  const info = machineInfo(cfg, st, m);
  if (info.def.sink || !info.affordable) return false;
  st.money -= info.cost;
  m.lvl++;
  st.stats.upgrades++;
  derive(cfg, st);
  return true;
}

// One stock level for every item.
export function stockInfo(cfg, st) {
  const cost = stockCost(cfg, st.stockLvl);
  return { lvl: st.stockLvl, cap: stockCap(cfg, st.stockLvl), nextCap: stockCap(cfg, st.stockLvl + 1), cost, affordable: st.money >= cost };
}

export function buyStock(cfg, st) {
  const info = stockInfo(cfg, st);
  if (!info.affordable) return false;
  st.money -= info.cost;
  st.stockLvl++;
  st.stats.upgrades++;
  derive(cfg, st);
  return true;
}

// Price can't go under the unit cost (resale at a loss is not allowed).
export function priceBounds(cfg, st, id) {
  const row = cfg.markets.find(m => m.id === id);
  const step = row.price_step;
  const min = Math.max(row.price_min, Math.ceil(unitCost(row, st.mk[id].you.quality) / step - 1e-9) * step);
  return { min: Math.round(min * 100) / 100, max: row.price_max, step };
}

export function setPrice(cfg, st, id, price) {
  const b = priceBounds(cfg, st, id);
  const p = Math.round(Math.round(Math.max(b.min, Math.min(b.max, price)) / b.step) * b.step * 100) / 100;
  const you = st.mk[id].you;
  if (p === you.price) return false;
  you.price = p;
  st.stats.priceChanges++;
  return true;
}
