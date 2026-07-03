/* Market Ultimatum — config.js
 * Config normalization (export format -> engine format).
 */

// ============================================================
// Config normalization (export format -> engine format)
// ============================================================
export function normalize(raw) {
  const g = {}; raw.general.forEach((x) => (g[x.id] = x.value));

  const resources = {}; const resourceOrder = [];
  raw.resources.forEach((r) => {
    if (!resources[r.id]) { resources[r.id] = { id: r.id, displayName: r.displayName.replace(/ tier.*$/i, ""), spriteId: r.spriteId, description: "", tiers: {} }; resourceOrder.push(r.id); }
    if (r.description && !resources[r.id].description) resources[r.id].description = r.description; // resource-level (first found)
    resources[r.id].tiers[r.tier] = { price: r.baseSellPrice, influence: r.influence, spriteId: r.spriteId, description: r.description || "" };
  });
  const maxTier = Math.max(...raw.resources.map((r) => r.tier));

  const inputsByMachine = {};
  raw.inputs.forEach((i) => { (inputsByMachine[i.id] = inputsByMachine[i.id] || []).push({ type: i.type, quantity: i.quantity }); });

  const outputsByResLevel = {};
  raw.outputs.forEach((o) => {
    const k = o.id + "_" + o.level;
    (outputsByResLevel[k] = outputsByResLevel[k] || []).push({
      group: o.group, quantity: o.quantity, weight: o.weight,
      tiers: [o.tier1, o.tier2, o.tier3, o.tier4, o.tier5, o.tier6],
    });
  });

  const machines = raw.machines.map((m) => ({
    id: m.id, displayName: m.displayName, spriteId: m.spriteId, outputs: m.outputs,
    unlockAtRound: m.unlockAtRound,
    inputs: inputsByMachine[m.id] || [],
    levels: raw.upgrades.filter((u) => u.id === m.id).sort((a, b) => a.level - b.level)
      .map((u) => ({ level: u.level, cost: u.cost, workersRequired: u.workersRequired, maxWorkers: u.maxWorkers, workerSpeedBonus: u.workerSpeedBonus, productionTime: u.productionTime })),
  }));

  const purchases = { increaseWorker: [], increaseMarketting: [], increaseStorage: [] };
  raw.purshases.forEach((p) => { if (purchases[p.type]) purchases[p.type].push({ effect: p.effect, price: p.price }); });

  const market = {}; raw.market.forEach((m, i) => {
    market[i + 1] = { customers: m.customers, avg: m["average amount"], weights: { wood: m.wood, iron: m.iron, plank: m.plank, sword: m.sword } };
  });

  // convert: N units of (id, tier) -> result_quantity (default 1) of (result_ressource, result_tier)
  const convert = {};
  (raw.convert || []).forEach((c) => {
    (convert[c.id] = convert[c.id] || {})[c.tier] = { quantity: c.quantity, resultRes: c.result_ressource, resultTier: c.result_tier, resultQty: c.result_quantity || 1 };
  });

  // slots: rarity/luck styling for a produced output, keyed by its output `group` (A..F)
  const slots = {};
  (raw.slots || []).forEach((s) => { slots[s.id] = { description: s.description || "", color: s.color || "", font: s.font || 12 }; });

  const tax = {}; raw.tax.forEach((t) => (tax[t.round] = t.cost));
  const roundIncome = {}; raw.roundIncome.forEach((r) => (roundIncome[r.round] = { coins: r.coins, tier: r.ressource_tier }));

  const behavior = {};
  raw.competitors_behavior.forEach((b) => { (behavior[b.id] = behavior[b.id] || {})[b.ressources] = b.weights || 0; });
  const competitors = raw.competitors.map((c) => ({ ...c, behavior: behavior[c.id] || {} }));

  return { g, resources, resourceOrder, maxTier, machines, purchases, market, tax, roundIncome, competitors, convert, slots };
}
