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

  const machines = raw.machines.map((m) => ({
    id: m.id, displayName: m.displayName, spriteId: m.spriteId, outputs: m.outputs,
    unlockAtRound: m.unlockAtRound,
    inputs: inputsByMachine[m.id] || [],
    levels: raw.upgrades.filter((u) => u.id === m.id).sort((a, b) => a.level - b.level)
      .map((u) => ({ level: u.level, cost: u.cost, workersRequired: u.workersRequired, maxWorkers: u.maxWorkers, workerSpeedBonus: u.workerSpeedBonus, productionTime: u.productionTime })),
  }));

  const purchases = { increaseWorker: [], increaseMarketting: [], increaseStorage: [] };
  raw.purshases.forEach((p) => { if (purchases[p.type]) purchases[p.type].push({ effect: p.effect, price: p.price }); });

  // market profiles: market_config rows share a profile `id` and carry their `round` (round_N)
  const marketProfiles = {};
  raw.market_config.forEach((m) => {
    const round = parseInt(String(m.round).replace(/\D+/g, ""), 10);
    if (!round) return;
    (marketProfiles[m.id] = marketProfiles[m.id] || {})[round] = {
      customers: m.customers, avg: m["average amount"],
      // data-driven: one weight per known resource id (column named like the resource)
      weights: Object.fromEntries(resourceOrder.map((rid) => [rid, m[rid] || 0])),
    };
  });

  // tax profiles: one row per profile, "round N" columns hold the cost (0 = no tax)
  const taxProfiles = {};
  raw.tax.forEach((t) => {
    const prof = {};
    for (const k in t) {
      const m = /^round (\d+)$/.exec(k);
      if (m && t[k] > 0) prof[+m[1]] = t[k];
    }
    taxProfiles[t.id] = prof;
  });

  // unlock profiles: which machines exist in a level and the round they unlock
  const unlockProfiles = {};
  raw.unlock_config.forEach((u) => { (unlockProfiles[u.id] = unlockProfiles[u.id] || {})[u.machine] = u.unlock; });

  // world configs: one row per (level config, competitor)
  const worldConfigs = {};
  raw.world_config.forEach((w) => {
    const wc = (worldConfigs[w.id] = worldConfigs[w.id] || {
      id: w.id, competitors: [], nbOfRounds: w.nbOfRounds,
      taxConfig: w.taxConfig, marketConfig: w.marketConfig, unlockConfig: w.unlockConfig,
    });
    if (w.competitors) wc.competitors.push(w.competitors);
  });

  // ordered level list (menu order = sheet order)
  const worldLevels = raw.world_level.map((l) => ({ id: l.id, config: l.config, reward: l.reward }));

  // rewards: rolls grouped by reward id then group letter; a row without content = "nothing"
  const rewards = {};
  raw.rewards.forEach((r) => {
    const byGroup = (rewards[r.id] = rewards[r.id] || {});
    (byGroup[r.group] = byGroup[r.group] || []).push({ weight: r.weights || 0, amount: r.amount || 0, content: r.content || null });
  });

  // gears: two rows per gear id (speed + 2x proba); slot inferred from the id prefix.
  // fuzeValue = fuel this gear yields when consumed in a fuse; numberToUpgrade =
  // total fuel value needed to upgrade a gear of this rarity to the next one.
  const gears = {};
  raw.gears.forEach((gr) => {
    const it = (gears[gr.id] = gears[gr.id] || {
      id: gr.id, rarity: gr.rarity, slot: gr.id.split("_")[0], speed: 0, proba2x: 0,
      fuzeValue: gr.fuzeValue || 0, numberToUpgrade: gr.numberToUpgrade || 0,
    });
    if (gr.condition === "speed") it.speed = gr.value || 0;
    if (gr.condition === "2x proba") it.proba2x = gr.value || 0;
  });

  // characters: one row per (character, level) with up to 3 machine speed bonuses
  const characters = {}; const characterOrder = [];
  raw.characters.forEach((c) => {
    if (!characters[c.id]) { characters[c.id] = { id: c.id, profile: c.upgrade_profile, mainMachine: c.condition, levels: {} }; characterOrder.push(c.id); }
    const speeds = {};
    [1, 2, 3].forEach((n) => { const mach = c["condition_" + n]; if (mach) speeds[mach] = c["speed_" + n] || 0; });
    characters[c.id].levels[c.level] = { speeds, proba2x: c["2x proba"] || 0 };
  });
  for (const id in characters) characters[id].maxLevel = Math.max(...Object.keys(characters[id].levels).map(Number));

  // upgrade profiles: shard cost to reach each level (level 1 = unlock cost)
  const upgradeProfiles = {};
  raw.upgrade_profile.forEach((u) => { (upgradeProfiles[u.id] = upgradeProfiles[u.id] || {})[u.level] = { amount: u.amount, content: u.content }; });

  // convert: N units of (id, tier) -> result_quantity (default 1) of (result_ressource, result_tier)
  const convert = {};
  (raw.convert || []).forEach((c) => {
    (convert[c.id] = convert[c.id] || {})[c.tier] = { quantity: c.quantity, resultRes: c.result_ressource, resultTier: c.result_tier, resultQty: c.result_quantity || 1 };
  });

  // slots: rarity/luck styling for a produced output, keyed by its output `group` (A..F)
  const slots = {};
  (raw.slots || []).forEach((s) => { slots[s.id] = { description: s.description || "", color: s.color || "", font: s.font || 12 }; });

  // customers: each demanded resource ("Need") maps to the sprite shown for that client
  const customerSprites = {};
  (raw.customers || []).forEach((c) => { if (c.Need) customerSprites[c.Need] = c.Sprite; });

  const roundIncome = {}; raw.roundIncome.forEach((r) => (roundIncome[r.round] = { coins: r.coins, tier: r.ressource_tier }));

  const behavior = {};
  raw.competitors_behavior.forEach((b) => { (behavior[b.id] = behavior[b.id] || {})[b.ressources] = b.weights || 0; });
  const competitors = raw.competitors.map((c) => ({ ...c, behavior: behavior[c.id] || {} }));

  return {
    g, resources, resourceOrder, maxTier, machines, purchases, roundIncome, competitors, convert, slots, customerSprites,
    marketProfiles, taxProfiles, unlockProfiles, worldConfigs, worldLevels, rewards, gears, characters, characterOrder, upgradeProfiles,
  };
}

// ============================================================
// Level resolution: world_level -> effective per-game config
// ============================================================
// Returns everything the engine needs to run one level: rounds, market rows,
// tax schedule, machine unlocks and the exact bot lineup.
export function resolveLevel(cfg, levelId) {
  const level = cfg.worldLevels.find((l) => l.id === levelId);
  if (!level) throw new Error("Unknown level: " + levelId);
  const wc = cfg.worldConfigs[level.config];
  if (!wc) throw new Error("Unknown world config: " + level.config);
  const market = cfg.marketProfiles[wc.marketConfig] || {};
  const tax = cfg.taxProfiles[wc.taxConfig] || {};
  const unlocks = cfg.unlockProfiles[wc.unlockConfig] || {};
  const bots = wc.competitors.map((id) => cfg.competitors.find((c) => c.id === id)).filter(Boolean);
  return { id: level.id, reward: level.reward, totalRounds: wc.nbOfRounds, market, tax, unlocks, bots };
}
