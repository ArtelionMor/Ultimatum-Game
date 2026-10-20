// Pure factory economics shared by the player and the rivals. The player's
// floor layout (machines, belts, items) lives in grid.js.

export const stockCap = (cfg, lvl) => Math.round(cfg.player.stock_base * Math.pow(cfg.player.stock_mult, lvl - 1));
export const stockCost = (cfg, lvl) => Math.ceil(cfg.player.stock_base_cost * Math.pow(cfg.player.stock_cost_mult, lvl - 1));

// Better quality costs more per unit (everyone, player and rivals).
export const unitCost = (mk, quality) => mk.unit_cost_base + mk.unit_cost_per_quality * (quality - 1);

// Abstract production (rivals): fill the stock for `dt` seconds. Returns units produced.
export function produce(seller, dt) {
  const room = Math.max(0, seller.stockCap - seller.stock);
  const made = Math.min(room, seller.prodRate * dt / 60);
  seller.stock += made;
  return made;
}
