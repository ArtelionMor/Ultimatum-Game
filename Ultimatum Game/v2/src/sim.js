// Pure game simulation: state + config + dt → new state and a list of events.
// No DOM, so the UI only renders and the tools can run whole games in Node.

import { stepMarket, createShareTracker, trackShares, marketShares, demandMultiplier } from './market.js';
import { stationsOf, stationRate, stationCost, throughput, bottleneck, playerQuality,
  stockCap, stockCost, unitCost, produce } from './factory.js';
import { createRival, repriceRival, upgradeRival } from './ai.js';

export const SAVE_VERSION = 1;

// Small seeded RNG (mulberry32) whose state lives in the save.
function rng(st) {
  return () => {
    let t = (st.seed = (st.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const productOf = cfg => cfg.product[0];

export function newGame(cfg, seed = 12345) {
  const product = productOf(cfg);
  const levels = {};
  for (const st of stationsOf(cfg, product.id)) levels[st.id] = 1;
  const you = { id: 'you', price: product.start_price, quality: 1, stock: 0, stockCap: 0, prodRate: 0 };
  const rivals = cfg.competitors.map(createRival);
  const st = {
    v: SAVE_VERSION, cfgVersion: cfg.meta.version, seed,
    t: 0, money: cfg.player.start_money,
    levels, stockLvl: 1,
    you, rivals,
    shares: createShareTracker(cfg, ['you', ...rivals.map(r => r.id)]),
    aiPriceT: 0, aiUpT: 0,
    goal: { hold: 0, won: false, wonAt: 0 },
    stats: { sold: 0, earned: 0, upgrades: 0, priceChanges: 0, stockFullSeen: false },
    unlocked: {}, seen: {}, lastReveal: -999,
  };
  derive(cfg, st);
  return st;
}

// Recompute what depends on levels (call after any purchase / load).
export function derive(cfg, st) {
  const pid = productOf(cfg).id;
  st.you.quality = playerQuality(cfg, pid, st.levels);
  st.you.prodRate = throughput(cfg, pid, st.levels);
  st.you.stockCap = stockCap(cfg, st.stockLvl);
  const b = priceBounds(cfg, st);
  if (st.you.price < b.min) st.you.price = b.min;
}

export const sellersOf = st => [st.you, ...st.rivals];
export const shareOf = st => marketShares(st.shares);

export function step(cfg, st, dt) {
  const ev = [];
  if (st.goal.won) return ev;
  const product = productOf(cfg);
  const sellers = sellersOf(st);
  st.t += dt;

  // Production
  const wasFull = st.you.stock >= st.you.stockCap - 1e-6;
  for (const s of sellers) produce(s, dt);
  if (!wasFull && st.you.stock >= st.you.stockCap - 1e-6) {
    st.stats.stockFullSeen = true;
    ev.push({ type: 'stockFull' });
  }

  // Market
  const res = stepMarket(cfg, product, sellers, dt, demandMultiplier(cfg, st.t));
  trackShares(st.shares, res, dt, cfg.market.share_smoothing_s);
  const sold = res.sold.you;
  if (sold > 0) {
    const gain = sold * (st.you.price - unitCost(product, st.you.quality));
    const before = Math.floor(st.stats.sold);
    st.money += gain;
    st.stats.sold += sold;
    st.stats.earned += gain;
    if (Math.floor(st.stats.sold) > before) ev.push({ type: 'sale', units: sold, gain });
  }
  for (const r of st.rivals) r.revenue += res.sold[r.id] * r.price;

  // Rivals
  const shares = shareOf(st);
  st.aiPriceT += dt;
  if (st.aiPriceT >= cfg.ai.price_interval_s) {
    st.aiPriceT = 0;
    const ctx = { you: st.you, sellers, shares, rng: rng(st) };
    cfg.competitors.forEach((def, i) => {
      const r = st.rivals[i], old = r.price;
      repriceRival(product, def, r, ctx);
      if (r.price !== old) ev.push({ type: 'rivalPrice', id: r.id, from: old, to: r.price });
    });
  }
  st.aiUpT += dt;
  if (st.aiUpT >= cfg.ai.upgrade_interval_s) {
    st.aiUpT = 0;
    cfg.competitors.forEach((def, i) => upgradeRival(def, st.rivals[i]));
    ev.push({ type: 'rivalsUpgrade' });
  }

  // Goal: hold the target share for hold_s seconds in a row.
  const g = cfg.goal;
  if (shares.you >= g.share_target) {
    st.goal.hold += dt;
    if (st.goal.hold >= g.hold_s) {
      st.goal.won = true;
      st.goal.wonAt = st.t;
      ev.push({ type: 'win' });
    }
  } else if (st.goal.hold > 0) {
    st.goal.hold = 0;
    ev.push({ type: 'holdLost' });
  }
  return ev;
}

// --- Player actions (return true when something happened) -------------------

export function upgradeInfo(cfg, st, stationId) {
  const s = cfg.stations.find(x => x.id === stationId);
  const lvl = st.levels[stationId];
  return {
    station: s, lvl,
    rate: stationRate(s, lvl), nextRate: stationRate(s, lvl + 1),
    cost: stationCost(s, lvl), affordable: st.money >= stationCost(s, lvl),
  };
}

export function buyStation(cfg, st, stationId) {
  const info = upgradeInfo(cfg, st, stationId);
  if (!info.affordable) return false;
  st.money -= info.cost;
  st.levels[stationId]++;
  st.stats.upgrades++;
  derive(cfg, st);
  return true;
}

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
export function priceBounds(cfg, st) {
  const product = productOf(cfg);
  const min = Math.max(product.price_min, Math.ceil(unitCost(product, st.you.quality) / product.price_step) * product.price_step);
  return { min, max: product.price_max, step: product.price_step };
}

export function setPrice(cfg, st, price) {
  const b = priceBounds(cfg, st);
  const p = Math.round(Math.max(b.min, Math.min(b.max, price)) / b.step) * b.step;
  if (p === st.you.price) return false;
  st.you.price = p;
  st.stats.priceChanges++;
  return true;
}

export const currentBottleneck = (cfg, st) => bottleneck(cfg, productOf(cfg).id, st.levels);
