/* Level Designer — model.js
 * Data model, block compilation and market economics.
 *
 * The economics here mirror the engine exactly (see web/game-customers.js
 * pickNeed + web/game-bots.js target): a customer picks resource r with
 * probability w[r]/totalW, then buys EXACTLY `avg` units — unless the block
 * re-enables the ±1 spread (qtySpread → qty drawn from {avg-1, avg, avg+1},
 * floored at 1). Either way the expected demand for r in a round is
 *     customers * (w[r] / totalW) * avg
 * (spread only adds variance — except at avg=1 where the floor skews E to ~4/3).
 * Any change to the engine's demand rule must be mirrored in expectedUnits().
 */

export const PURCHASE_ACTIONS = ["increaseWorker", "increaseMarketting", "increaseStorage"];

// ============================================================
// Curves — how a value evolves across the rounds of one block
// ============================================================
// const: flat · ramp: linear from->to across the block · list: values cycled
export function curveAt(c, i, n) {
  if (!c) return 0;
  if (c.mode === "ramp") return Math.round(c.from + (c.to - c.from) * (n > 1 ? i / (n - 1) : 0));
  if (c.mode === "list") { const v = c.values || [0]; return v.length ? v[i % v.length] : 0; }
  return c.value || 0;
}
export const curveConst = (value) => ({ mode: "const", value });

// A block is a reusable pattern of `rounds` rounds. Its mix targets *roles*
// ("focus", "second"), not resources — a level instance binds roles to real
// resource ids, so one block yields many variants. defaultBind lets a block
// behave as a concrete one when a role should almost always be the same thing.
export function makeBlock(id, name) {
  return {
    id, name, rounds: 3,
    category: "", // free grouping label for the block picker ("mono", "duo", "filler", "complexity 2"…)
    roles: ["focus", "second"],
    customers: curveConst(20),
    avg: curveConst(3),
    // false = chaque client demande EXACTEMENT `avg` (le moteur ne tire plus le
    // ±1) ; true réactive le tirage {avg-1, avg, avg+1} historique.
    qtySpread: false,
    mix: [{ role: "focus", weight: curveConst(3) }, { role: "second", weight: curveConst(1) }],
    defaultBind: {},
  };
}

// A level has ONE id. It keys its market rows and its bot rows alike — they used
// to be able to diverge (a separate `marketConfigId`, editable behind a ⚙), and
// renaming a level silently left the market under the old name: the game then
// looked it up by the new one, found nothing, and the level loaded with 0 rounds.
// Two levels could even collide on the same market id. Not worth the flexibility.
export function makeLevel(id, biomeId) {
  return { id, biomeId, instances: [], competitors: [] };
}

// Biomes are display clusters ("Meadow", "Town"…): they group levels in the
// editor and never reach the game's export.
export function emptyDoc() {
  return { version: 2, blocks: [], biomes: [{ id: "biome_1", name: "Meadow" }], levels: [] };
}

// ============================================================
// Compilation: level (blocks + bindings) -> one row per round
// ============================================================
// Unbound roles and roles bound to nothing are dropped, so a half-configured
// block still compiles instead of poisoning the whole level with NaN.
export function compileLevel(level, blocks) {
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  const out = [];
  let round = 1;
  (level.instances || []).forEach((inst, instIdx) => {
    const b = byId[inst.blockId];
    if (!b) return;
    const n = Math.max(1, b.rounds | 0);
    for (let i = 0; i < n; i++) {
      const weights = {};
      (b.mix || []).forEach((m) => {
        const res = (inst.bind && inst.bind[m.role]) || (b.defaultBind && b.defaultBind[m.role]);
        if (!res) return;
        const w = Math.max(0, Math.round(curveAt(m.weight, i, n)));
        if (w > 0) weights[res] = (weights[res] || 0) + w;
      });
      const ov = inst.overrides || {};
      out.push({
        round: round++,
        blockId: b.id, blockName: b.name, instIdx, localIndex: i, blockRounds: n,
        customers: Math.max(0, Math.round(ov.customers != null ? ov.customers : curveAt(b.customers, i, n))),
        avg: Math.max(1, Math.round(ov.avg != null ? ov.avg : curveAt(b.avg, i, n))),
        spread: !!b.qtySpread,
        weights,
      });
    }
  });
  return out;
}

// ============================================================
// Economics
// ============================================================
export function expectedUnits(row, resId) {
  const totalW = Object.values(row.weights).reduce((s, w) => s + w, 0);
  if (!totalW) return 0;
  return row.customers * ((row.weights[resId] || 0) / totalW) * row.avg;
}

// Unit price of a resource at a given tier, falling back to the nearest lower
// tier that exists (not every resource is defined up to maxTier).
export function priceOf(cfg, resId, tier) {
  const r = cfg.resources[resId];
  if (!r) return 0;
  for (let t = tier; t >= 1; t--) if (r.tiers[t]) return r.tiers[t].price || 0;
  return 0;
}

// Full economic picture of a compiled level, at a chosen valuation tier.
export function econ(rows, cfg, tier) {
  const order = cfg.resourceOrder.filter((r) => rows.some((row) => row.weights[r] > 0));
  const perRound = rows.map((row) => {
    const units = {}; const value = {};
    let totalUnits = 0; let totalValue = 0;
    order.forEach((r) => {
      const u = expectedUnits(row, r);
      const v = u * priceOf(cfg, r, tier);
      units[r] = u; value[r] = v; totalUnits += u; totalValue += v;
    });
    return { ...row, units, value, totalUnits, totalValue };
  });

  const byRes = {};
  order.forEach((r) => {
    const units = perRound.map((p) => p.units[r]);
    const value = perRound.map((p) => p.value[r]);
    const totalUnits = units.reduce((s, x) => s + x, 0);
    byRes[r] = {
      units, value, totalUnits,
      totalValue: value.reduce((s, x) => s + x, 0),
      cumUnits: cumulate(units), cumValue: cumulate(value),
    };
  });

  const totalUnits = perRound.reduce((s, p) => s + p.totalUnits, 0);
  const totalValue = perRound.reduce((s, p) => s + p.totalValue, 0);
  order.forEach((r) => { byRes[r].shareUnits = totalUnits ? byRes[r].totalUnits / totalUnits : 0; });

  return {
    order, perRound, byRes, totalUnits, totalValue,
    cumTotalValue: cumulate(perRound.map((p) => p.totalValue)),
    rounds: perRound.length,
  };
}

function cumulate(a) { let s = 0; return a.map((x) => (s += x)); }

// ============================================================
// Competitors
// ============================================================
// Bot weights are relative pick odds among the actions the bot considers
// (see game-bots.js). They are derived PER WAVE from that round's own expected
// demand, so the bot re-aims as the market shifts inside the level.
// Specialization sharpens each wave's profile — 0 flattens it to a generalist,
// 1 tracks the wave's demand exactly, >1 turns the bot into a specialist of
// whatever that wave asks for most.
export function deriveBotWeightsPerWave(e, opts) {
  const { specialization = 1, focus = null, focusBoost = 1 } = opts || {};
  return e.perRound.map((p) => {
    const raw = {}; let max = 0;
    e.order.forEach((r) => {
      const share = p.totalUnits ? p.units[r] / p.totalUnits : 0;
      let s = share > 0 ? Math.pow(share, specialization) : 0;
      if (focus && r === focus) s *= focusBoost;
      raw[r] = s; if (s > max) max = s;
    });
    const w = {};
    e.order.forEach((r) => { w[r] = max && raw[r] > 0 ? Math.max(1, Math.round((raw[r] / max) * 100)) : 0; });
    return w;
  });
}

// Wave-by-wave fit between a bot's weights and the demand, as cosine similarity
// (1 = aligned, 0 = it wants what nobody buys, null = the wave has no demand).
// Purchase actions are excluded: they aren't resources and would skew the angle.
export function adaptationPerWave(e, weightsPerWave) {
  return e.perRound.map((p, i) => {
    const w = weightsPerWave[i] || {};
    let dot = 0; let na = 0; let nb = 0;
    e.order.forEach((r) => {
      const a = p.totalUnits ? p.units[r] / p.totalUnits : 0;
      const b = w[r] || 0;
      dot += a * b; na += a * a; nb += b * b;
    });
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : null;
  });
}

// Rationalized character loadout for a bot: instead of simulating equipped
// characters, a bot carries flat buffs the engine can apply directly.
export const BOT_BUFFS = [
  ["speed", "Vitesse prod %"],       // production speed bonus, like crew speed
  ["proba2x", "Proba ×2 %"],         // double-output chance, like character 2x
  ["marketing", "Marketing +"],      // flat attractiveness bonus
];

// ============================================================
// Export to the game's config_export.json shape
// ============================================================
// normalize() in web/config.js reads a market_config weight column by *resource
// id* (weights[rid] = m[rid] || 0), so that is what we emit — a column named
// anything else is silently read as zero by the engine.
export function toMarketConfigRows(level, blocks, cfg) {
  return compileLevel(level, blocks).map((row) => {
    const o = { id: level.id, round: "round_" + row.round, customers: row.customers, "average amount": row.avg, qty_spread: row.spread ? 1 : 0 };
    cfg.resourceOrder.forEach((r) => (o[r] = row.weights[r] || 0));
    return o;
  });
}

// competitors_behavior v2: one row per (bot, wave), keyed by the level id, with
// one column per resource + purchase action — the same data-driven column style
// normalize() already uses for market_config. `config` scopes the rows to a
// level, so two levels tuning the same bot id can no longer collide.
export function toCompetitorRows(level, blocks, cfg, tier) {
  const rows = compileLevel(level, blocks);
  const e = econ(rows, cfg, tier);
  const out = [];
  (level.competitors || []).forEach((c) => {
    const perWave = c.auto ? deriveBotWeightsPerWave(e, c) : rows.map(() => ({ ...(c.weights || {}) }));
    rows.forEach((row, i) => {
      const o = { config: level.id, id: c.id, round: "round_" + row.round };
      cfg.resourceOrder.forEach((r) => (o[r] = perWave[i][r] || 0));
      const pw = Math.max(0, Math.round(curveAt(c.purchase, i, rows.length)));
      PURCHASE_ACTIONS.forEach((p) => (o[p] = pw));
      out.push(o);
    });
  });
  return out;
}

// competitors_buffs: one row per non-zero buff, scoped like the behavior rows.
// `autoMerge` is the exception to the skip-zero rule: it is ALWAYS emitted (1/0),
// because its absence means "default" (the engine merges) — an explicit 0 is the
// only way to opt a bot out.
export function toCompetitorBuffRows(level) {
  const out = [];
  (level.competitors || []).forEach((c) => {
    BOT_BUFFS.forEach(([k]) => {
      const v = (c.buffs || {})[k];
      if (v) out.push({ config: level.id, id: c.id, buff: k, value: v });
    });
    out.push({ config: level.id, id: c.id, buff: "autoMerge", value: c.autoMerge === false ? 0 : 1 });
  });
  return out;
}

// unlock_config: paces when each machine appears in a level. A machine is
// "needed" the first wave its output — or an ingredient of a demanded output,
// walking the recipe graph upward — is asked for. That first-need round IS the
// unlock, so a machine shows up exactly when the player first has a reason to run
// it (converters and their ingredient machines unlock on the same wave).
//
// Machines a level never needs are simply omitted: the engine reads an absent row
// as "never" (machineUnlockRound returns null), same as a blank `unlock` cell in
// the sheet. Rows are keyed by level.id, like market_config — buildLevelContext
// falls back to level.id when resolving unlockConfig.
export function toUnlockRows(level, blocks, cfg) {
  const rows = compileLevel(level, blocks);
  const producer = {};                       // resource id -> the machine that outputs it
  cfg.machines.forEach((m) => { if (m.outputs) producer[m.outputs] = m; });

  // Full ingredient closure of a resource: itself + everything upstream. Cycles
  // (should never happen in a recipe tree) are guarded by `seen`.
  const cache = {};
  function closure(resId) {
    if (cache[resId]) return cache[resId];
    const out = new Set(), seen = new Set();
    (function walk(r) {
      if (seen.has(r)) return; seen.add(r); out.add(r);
      const m = producer[r]; if (m) (m.inputs || []).forEach((i) => walk(i.type));
    })(resId);
    return (cache[resId] = out);
  }

  const firstRound = {};                      // machine id -> earliest wave it is needed
  rows.forEach((row) => {
    const needed = new Set();
    Object.keys(row.weights).forEach((rid) => { if (row.weights[rid] > 0) closure(rid).forEach((r) => needed.add(r)); });
    needed.forEach((rid) => { const m = producer[rid]; if (m && firstRound[m.id] == null) firstRound[m.id] = row.round; });
  });

  // config-order for a stable, reviewable export
  return cfg.machines
    .filter((m) => firstRound[m.id] != null)
    .map((m) => ({ id: level.id, machine: m.id, unlock: firstRound[m.id] }));
}

// The single file the game loads next to config_export.json
// (web/config_levels.json): every level of the document, all four sections.
export function toConfigLevels(doc, cfg, tier) {
  const out = { market_config: [], competitors_behavior: [], competitors_buffs: [], unlock_config: [] };
  doc.levels.forEach((l) => {
    out.market_config.push(...toMarketConfigRows(l, doc.blocks, cfg));
    out.competitors_behavior.push(...toCompetitorRows(l, doc.blocks, cfg, tier));
    out.competitors_buffs.push(...toCompetitorBuffRows(l));
    out.unlock_config.push(...toUnlockRows(l, doc.blocks, cfg));
  });
  return out;
}

// Columns the engine will read as zero, and resources with no column at all.
export function diagnoseColumns(rawMarketRows, cfg) {
  const ids = new Set(cfg.resourceOrder);
  const known = new Set(["id", "round", "customers", "average amount", "qty_spread"]);
  const stale = new Set(); const seen = new Set();
  (rawMarketRows || []).forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (known.has(k)) return;
      if (ids.has(k)) seen.add(k); else stale.add(k);
    });
  });
  return { stale: [...stale], missing: cfg.resourceOrder.filter((r) => !seen.has(r)) };
}
