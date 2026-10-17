// Rival factories. Same stock / production / sale rules as the player
// (simplified): they produce into a capped stock and sell through the market model.
// Behaviour is scripted: a price rule every `ai.price_interval_s`; production,
// stock and quality drift slowly (time constant `ai.level_tau_s`) towards a
// target set by the PLAYER's level, so rivals never run away from the player.

import { unitCost } from './factory.js';

export function createRival(def) {
  return {
    id: def.id, isAI: true,
    price: def.start_price, quality: def.quality,
    stock: def.stock_cap / 2, stockCap: def.stock_cap, prodRate: def.prod_per_min,
    revenue: 0, brand: 0,
  };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// `ctx` = { you, sellers, shares, rng }
export function repriceRival(mk, def, r, ctx) {
  const floor = unitCost(mk, r.quality) * (1 + def.price_floor_margin);
  let p = r.price;
  if (def.behavior === 'undercut') {
    // Always a bit under the player, never above its own list price.
    p = Math.min(def.start_price, ctx.you.price * (1 - def.behavior_param));
  } else if (def.behavior === 'premium') {
    // Keeps a high price; discounts when unsold stock piles up, raises when it sells out.
    const fill = r.stock / r.stockCap;
    if (fill > 0.8) p = r.price * (1 - def.behavior_param);
    else if (fill < 0.2) p = r.price * (1 + def.behavior_param);
    p = clamp(p, def.start_price * 0.7, def.start_price * 1.3);
  } else if (def.behavior === 'follow') {
    // Copies the current leader (highest share, not itself) at ±param.
    let leader = null, best = -1;
    for (const s of ctx.sellers) if (s.id !== r.id && (ctx.shares[s.id] || 0) > best) { best = ctx.shares[s.id] || 0; leader = s; }
    if (leader) p = leader.price * (1 + (ctx.rng() * 2 - 1) * def.behavior_param);
  }
  // Snap to the market's price step; never under the floor.
  const step = mk.price_step, snap = x => Math.round(x * 100) / 100;
  r.price = snap(Math.max(Math.ceil(floor / step - 1e-9) * step, Math.round(p / step) * step));
}

// What a rival aims for when the player is at `level`.
export function rivalTarget(def, level) {
  const k = Math.pow(1 + def.prod_per_level, level - 1);
  return {
    prodRate: def.prod_per_min * k,
    stockCap: def.stock_cap * k,
    quality: Math.min(def.quality_max, def.quality + def.quality_per_level * (level - 1)),
  };
}

export function approachRival(def, r, level, dt, tau) {
  const t = rivalTarget(def, level), k = 1 - Math.exp(-dt / tau);
  r.prodRate += (t.prodRate - r.prodRate) * k;
  r.stockCap += (t.stockCap - r.stockCap) * k;
  r.quality += (t.quality - r.quality) * k;
}
