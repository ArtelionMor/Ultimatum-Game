// Pure market model — no DOM, no globals. Shared by the game (sim.js) and
// tools/check-market.js. A "seller" is any object with
// { id, price, quality, stock }.

const EPS = 1e-6;

// How much a customer of segment `seg` likes `seller`.
export function score(seg, seller, refPrice) {
  return seg.b * seller.quality - seg.a * (seller.price / refPrice);
}

// One segment's choice: softmax(score / T) over the sellers it accepts.
// A seller is excluded when its score is under the segment's refusal threshold
// (price perceived as unfair / quality too low) or, if `needStock`, when it has
// nothing to sell. probs[id] = 0 for excluded sellers.
export function segmentChoice(seg, sellers, refPrice, temperature, needStock = true) {
  const scores = {}, probs = {}, refused = {};
  const cands = [];
  let max = -Infinity;
  for (const s of sellers) {
    const sc = score(seg, s, refPrice);
    scores[s.id] = sc;
    probs[s.id] = 0;
    refused[s.id] = sc < seg.refuse_below;
    if (refused[s.id]) continue;
    if (needStock && s.stock <= EPS) continue;
    cands.push(s);
    if (sc > max) max = sc;
  }
  let sum = 0;
  for (const s of cands) { const w = Math.exp((scores[s.id] - max) / temperature); probs[s.id] = w; sum += w; }
  for (const s of cands) probs[s.id] /= sum;
  return { scores, probs, refused, anyone: cands.length > 0 };
}

// Advance the market by `dt` seconds. Customers arrive as a continuous flow
// (demand_per_min) and are split by the softmax — this is the expected value of
// the weighted draw, so shares are smooth and reproducible. Sellers' stock is
// consumed in place. A seller asked for more than it holds serves every segment
// pro rata; the customers it could not serve pick again among those who still
// have stock.
// `demandMult` scales every segment's demand (rush hours).
// Returns { sold: {id: units}, seg: {segId: {by: {id: units}, refused, noStock, demand}} }.
export function stepMarket(cfg, product, sellers, dt, demandMult = 1) {
  const T = cfg.market.temperature, ref = product.ref_price;
  const out = { sold: {}, seg: {} };
  const left = {};
  for (const s of sellers) out.sold[s.id] = 0;
  for (const seg of cfg.segments) {
    const row = { by: {}, refused: 0, noStock: 0, demand: seg.demand_per_min * demandMult * dt / 60 };
    for (const s of sellers) row.by[s.id] = 0;
    out.seg[seg.id] = row;
    left[seg.id] = row.demand;
  }
  for (let pass = 0; pass < 4; pass++) {
    const wants = {}, totalWant = {};
    for (const s of sellers) totalWant[s.id] = 0;
    let any = false;
    for (const seg of cfg.segments) {
      if (left[seg.id] <= EPS) continue;
      const ch = segmentChoice(seg, sellers, ref, T, true);
      if (!ch.anyone) continue;
      wants[seg.id] = ch.probs;
      for (const s of sellers) totalWant[s.id] += left[seg.id] * ch.probs[s.id];
      any = true;
    }
    if (!any) break;
    const ratio = {};
    for (const s of sellers) ratio[s.id] = totalWant[s.id] > s.stock ? s.stock / totalWant[s.id] : 1;
    for (const seg of cfg.segments) {
      const probs = wants[seg.id];
      if (!probs) continue;
      let unserved = 0;
      for (const s of sellers) {
        const want = left[seg.id] * probs[s.id];
        if (want <= 0) continue;
        const got = want * ratio[s.id];
        out.seg[seg.id].by[s.id] += got;
        out.sold[s.id] += got;
        unserved += want - got;
      }
      left[seg.id] = unserved;
    }
    for (const s of sellers) s.stock = Math.max(0, s.stock - totalWant[s.id] * ratio[s.id]);
  }
  for (const seg of cfg.segments) {
    if (left[seg.id] <= EPS) continue;
    // Nobody acceptable at all → refusal; acceptable sellers but all empty → no stock.
    const acceptable = sellers.some(s => score(seg, s, ref) >= seg.refuse_below);
    if (acceptable) out.seg[seg.id].noStock += left[seg.id]; else out.seg[seg.id].refused += left[seg.id];
  }
  return out;
}

// Instant preference (ignores stock): what share of each segment would pick each
// seller if everybody could deliver. Used for the live "part prévue" while dragging the price.
export function previewPreference(cfg, product, sellers) {
  const res = {};
  for (const seg of cfg.segments) res[seg.id] = segmentChoice(seg, sellers, product.ref_price, cfg.market.temperature, false);
  return res;
}

// Rush hours: demand oscillates around its average, so a bigger stock sells more at the peaks.
export function demandMultiplier(cfg, t) {
  const { demand_wave_amp: amp = 0, demand_wave_period_s: period = 60 } = cfg.market;
  return 1 + amp * Math.sin(2 * Math.PI * t / period);
}

// --- Share tracking: exponential moving average of sales flows --------------

export function createShareTracker(cfg, ids) {
  const tr = { flow: {}, seg: {} };
  for (const id of ids) tr.flow[id] = 0;
  for (const seg of cfg.segments) {
    tr.seg[seg.id] = { by: {}, refused: 0, noStock: 0, demand: 0 };
    for (const id of ids) tr.seg[seg.id].by[id] = 0;
  }
  return tr;
}

// Flows are stored in units/second.
export function trackShares(tr, res, dt, tau) {
  const k = 1 - Math.exp(-dt / tau);
  for (const id in tr.flow) tr.flow[id] += ((res.sold[id] || 0) / dt - tr.flow[id]) * k;
  for (const segId in tr.seg) {
    const t = tr.seg[segId], r = res.seg[segId];
    if (!r) continue;
    for (const id in t.by) t.by[id] += ((r.by[id] || 0) / dt - t.by[id]) * k;
    t.refused += (r.refused / dt - t.refused) * k;
    t.noStock += (r.noStock / dt - t.noStock) * k;
    t.demand += (r.demand / dt - t.demand) * k;
  }
}

// Share of total sales per seller (0..1).
export function marketShares(tr) {
  let total = 0;
  for (const id in tr.flow) total += tr.flow[id];
  const sh = {};
  for (const id in tr.flow) sh[id] = total > EPS ? tr.flow[id] / total : 0;
  return sh;
}

// Share of a segment's customers who bought from `id` (0..1; refusals count as lost).
export function segmentShare(tr, segId, id) {
  const t = tr.seg[segId];
  return t && t.demand > EPS ? t.by[id] / t.demand : 0;
}
