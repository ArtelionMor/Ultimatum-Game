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

  // the exporter renames sections over time: read the new name, fall back to the old
  const rawUpgrades = raw.upgrade_machines_profile || raw.upgrades || [];

  const machines = raw.machines.map((m) => ({
    id: m.id, displayName: m.displayName, spriteId: m.spriteId, outputs: m.outputs,
    unlockAtRound: m.unlockAtRound,
    inputs: inputsByMachine[m.id] || [],
    // new schema: the machine's `upgrades` column names its profile; old flat format keyed rows by machine id
    levels: rawUpgrades.filter((u) => u.id === (m.upgrades || m.id)).sort((a, b) => a.level - b.level)
      .map((u) => ({ level: u.level, cost: u.cost, workersRequired: u.workersRequired, maxWorkers: u.maxWorkers, workerSpeedBonus: u.workerSpeedBonus, productionTime: u.productionTime })),
  }));

  const purchases = { increaseWorker: [], increaseMarketting: [], increaseStorage: [] };
  raw.purshases.forEach((p) => { if (purchases[p.type]) purchases[p.type].push({ effect: p.effect, price: p.price }); });

  // market profiles: market_config rows share a profile `id` and carry their `round` (round_N).
  // The sheet no longer carries this section — it comes from the level designer.
  const marketProfiles = {};
  (raw.market_config || []).forEach((m) => {
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

  // characters (2026-07 rework): ONE row per character. It boosts the machines
  // it lists (machine1/machine_1…); the per-level bonus is a percent taken from
  // its progress profile, scaled by `multiplier` (legendaries > commons).
  const characters = {}; const characterOrder = [];
  raw.characters.forEach((c) => {
    if (characters[c.id]) return;
    const machines = Object.keys(c).filter((k) => /^machine[_ ]?\d+$/i.test(k)).sort()
      .map((k) => c[k]).filter(Boolean);
    characters[c.id] = {
      id: c.id, displayName: c.name || c.id, profile: c.upgrade_profile,
      typeSlot: c.typeSlot, spriteId: c.spriteIngame || null,
      progressProfile: c.progress_profile, multiplier: c.multiplier || 1,
      machines, mainMachine: machines[0] || null,
    };
    characterOrder.push(c.id);
  });

  // per-level progress percentages (5 = +5% production speed at that level).
  // level_profile_N rows: {id, level, <value>} — the value column is exported
  // under a shifting header (currently "machine1"), so take the first column
  // that isn't id/level. The section also holds multiplier_profile_N rows
  // (no level column): reference data, skipped here.
  const progressProfiles = {};
  (raw.character_progress_profile || []).forEach((p) => {
    if (p.id == null || p.level == null) return;
    const valueKey = Object.keys(p).find((k) => k !== "id" && k !== "level");
    (progressProfiles[p.id] = progressProfiles[p.id] || {})[p.level] = (valueKey && p[valueKey]) || 0;
  });

  // character slots: one per resource; `containment` = the race (typeSlot) it accepts
  const characterSlots = (raw.character_slot || [])
    .map((s) => ({ id: s.id, order: s.order || 0, containment: s.containment }))
    .sort((a, b) => a.order - b.order);

  // upgrade profiles: shard cost to reach each level (level 1 = unlock cost)
  const upgradeProfiles = {};
  (raw.upgrade_character_profile || raw.upgrade_profile || []).forEach((u) => { (upgradeProfiles[u.id] = upgradeProfiles[u.id] || {})[u.level] = { amount: u.amount, content: u.content }; });
  // a character's max level = the last level its upgrade profile can pay for
  for (const id in characters) {
    const lv = Object.keys(upgradeProfiles[characters[id].profile] || {}).map(Number);
    characters[id].maxLevel = lv.length ? Math.max(...lv) : 1;
  }

  // convert: N units of (id, tier) -> result_quantity (default 1) of (result_ressource, result_tier)
  const convert = {};
  (raw.convert_profile || raw.convert || []).forEach((c) => {
    (convert[c.id] = convert[c.id] || {})[c.tier] = { quantity: c.quantity, resultRes: c.result_ressource, resultTier: c.result_tier, resultQty: c.result_quantity || 1 };
  });

  // slots: rarity/luck styling for a produced output, keyed by its output `group` (A..F)
  const slots = {};
  (raw.slots || []).forEach((s) => { slots[s.id] = { description: s.description || "", color: s.color || "", font: s.font || 12 }; });

  // customers: each demanded resource ("Need") maps to the sprite shown for that
  // client, plus a full per-customer view (id, sprite, every need — a customer
  // may span several rows once multiple needs land in the sheet).
  const customerSprites = {};
  const customerDefs = {}; const customerOrder = [];
  (raw.customers || []).forEach((c) => {
    if (!customerDefs[c.id]) { customerDefs[c.id] = { id: c.id, spriteId: c.Sprite, needs: [] }; customerOrder.push(c.id); }
    if (c.Need && !customerDefs[c.id].needs.includes(c.Need)) customerDefs[c.id].needs.push(c.Need);
    if (c.Need) customerSprites[c.Need] = c.Sprite;
  });

  const roundIncome = {}; raw.roundIncome.forEach((r) => (roundIncome[r.round] = { coins: r.coins, tier: r.ressource_tier }));

  // competitors_behavior v2: one row per (level, bot, wave). `config` = the
  // world_level id, `round` = round_N; weight columns are named by resource id
  // plus the 3 purchase actions (same data-driven style as market_config).
  const PURCHASE_ACTIONS = ["increaseWorker", "increaseMarketting", "increaseStorage"];
  const behaviorProfiles = {};
  (raw.competitors_behavior || []).forEach((b) => {
    const round = parseInt(String(b.round).replace(/\D+/g, ""), 10);
    if (!round) return; // old-format rows (no round column) are ignored
    const w = {};
    resourceOrder.forEach((rid) => { if (b[rid]) w[rid] = b[rid]; });
    PURCHASE_ACTIONS.forEach((p) => { if (b[p]) w[p] = b[p]; });
    const byBot = (behaviorProfiles[b.config] = behaviorProfiles[b.config] || {});
    (byBot[b.id] = byBot[b.id] || {})[round] = w;
  });

  // competitors_buffs: one row per non-zero (level, bot, buff).
  // speed & proba2x are percents (0..100), marketing is a flat attractiveness bonus.
  const buffProfiles = {};
  (raw.competitors_buffs || []).forEach((b) => {
    const byBot = (buffProfiles[b.config] = buffProfiles[b.config] || {});
    (byBot[b.id] = byBot[b.id] || {})[b.buff] = b.value || 0;
  });

  const competitors = raw.competitors.map((c) => ({ ...c }));

  return {
    g, resources, resourceOrder, maxTier, machines, purchases, roundIncome, competitors, convert, slots, customerSprites, customerDefs, customerOrder,
    marketProfiles, taxProfiles, unlockProfiles, worldConfigs, worldLevels, rewards, gears, characters, characterOrder, upgradeProfiles,
    behaviorProfiles, buffProfiles, progressProfiles, characterSlots,
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
  // same id chain as the bots below: marketConfig column, else the ids themselves
  const market = cfg.marketProfiles[wc.marketConfig] || cfg.marketProfiles[level.id] || cfg.marketProfiles[wc.id] || {};
  const tax = cfg.taxProfiles[wc.taxConfig] || {};
  const unlocks = cfg.unlockProfiles[wc.unlockConfig] || {};
  // behavior/buffs are scoped by world_level id: the same bot can play
  // differently in every level (competitors_behavior v2). Fallbacks on the
  // marketConfig id then the world_config id, so any of those columns can
  // carry the designer level id and wire market + bots + buffs at once.
  const scope = [level.id, wc.marketConfig, wc.id].find((k) => cfg.behaviorProfiles[k]) || level.id;
  const behavior = cfg.behaviorProfiles[scope] || {};
  const buffs = cfg.buffProfiles[scope] || {};
  // the designer's bot lineup IS the level's lineup; the sheet `competitors`
  // column only drives levels that were not designed in the tool.
  const lineup = Object.keys(behavior).length ? Object.keys(behavior) : wc.competitors;
  const bots = lineup
    .map((id) => cfg.competitors.find((c) => c.id === id)).filter(Boolean)
    .map((c) => ({ ...c, behaviorByRound: behavior[c.id] || {}, buffs: buffs[c.id] || {} }));
  // the market profile defines the level's length; sheet nbOfRounds is only a fallback
  const rounds = Object.keys(market).map(Number);
  const totalRounds = rounds.length ? Math.max(...rounds) : (wc.nbOfRounds || 0);
  return { id: level.id, reward: level.reward, totalRounds, market, tax, unlocks, bots };
}
