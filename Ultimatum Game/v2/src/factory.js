// Pure factory math — stations, stock, quality, unit cost. No DOM.

export const stationsOf = (cfg, productId) =>
  cfg.stations.filter(s => s.product === productId).sort((a, b) => a.order - b.order);

// Units/min a station outputs at `lvl` (1-based).
export const stationRate = (st, lvl) => st.base_rate * Math.pow(st.rate_mult, lvl - 1);

// Price to go from `lvl` to `lvl + 1`.
export const stationCost = (st, lvl) => Math.ceil(st.base_cost * Math.pow(st.cost_mult, lvl - 1));

// The chain only goes as fast as its slowest station.
export function throughput(cfg, productId, levels) {
  let min = Infinity;
  for (const st of stationsOf(cfg, productId)) min = Math.min(min, stationRate(st, levels[st.id]));
  return min;
}

export function bottleneck(cfg, productId, levels) {
  let best = null, min = Infinity;
  for (const st of stationsOf(cfg, productId)) {
    const r = stationRate(st, levels[st.id]);
    if (r < min) { min = r; best = st; }
  }
  return best;
}

export function playerQuality(cfg, productId, levels) {
  let q = cfg.player.start_quality;
  for (const st of stationsOf(cfg, productId)) q += st.quality_per_level * (levels[st.id] - 1);
  return Math.min(cfg.player.quality_max, q);
}

export const stockCap = (cfg, lvl) => Math.round(cfg.player.stock_base * Math.pow(cfg.player.stock_mult, lvl - 1));
export const stockCost = (cfg, lvl) => Math.ceil(cfg.player.stock_base_cost * Math.pow(cfg.player.stock_cost_mult, lvl - 1));

// Better quality costs more per unit (everyone, player and rivals).
export const unitCost = (product, quality) => product.unit_cost_base + product.unit_cost_per_quality * (quality - 1);

// Fill a seller's stock for `dt` seconds of production. Returns units produced.
export function produce(seller, dt) {
  const room = Math.max(0, seller.stockCap - seller.stock);
  const made = Math.min(room, seller.prodRate * dt / 60);
  seller.stock += made;
  return made;
}
