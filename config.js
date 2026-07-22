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

  // per-tier background colors (sheet tab `ressources_tier`: {id:"Tier2", color:"ACFF47"});
  // tolerant of older exports without the tab (tierColor() falls back to neutral grey).
  // `increase` on the same row = the chance that ONE consumed ingredient of that tier
  // pushes the converter's output up a tier (see rollIngredientBonus in game-production).
  const tierColors = {}, tierBonusChance = {};
  (raw.ressources_tier || []).forEach((t) => {
    const m = /^tier\s*(\d+)$/i.exec(t.id || "");
    if (!m) return;
    if (t.color) tierColors[+m[1]] = "#" + String(t.color).replace(/^#/, "");
    tierBonusChance[+m[1]] = +t.increase || 0;
  });

  // `inputs` is a RECIPE table keyed by recipe name (which reads like the produced
  // resource: "nest", "bottle"…), and each machine names its recipe in its own
  // `inputs` column — the same profile indirection as outputs_profiles / upgrade
  // profiles / convert_profile. Looking recipes up by MACHINE id (nestFactory)
  // silently handed every machine an empty recipe, so no converter ever existed.
  // Fall back to the machine id for the old flat format.
  const inputsByRecipe = {};
  raw.inputs.forEach((i) => { (inputsByRecipe[i.id] = inputsByRecipe[i.id] || []).push({ type: i.type, quantity: i.quantity }); });

  // the exporter renames sections over time: read the new name, fall back to the old
  const rawUpgrades = raw.upgrade_machines_profile || raw.upgrades || [];

  const machines = raw.machines.map((m) => ({
    id: m.id, displayName: m.displayName, spriteId: m.spriteId, outputs: m.outputs,
    unlockAtRound: m.unlockAtRound,
    inputs: inputsByRecipe[m.inputs] || inputsByRecipe[m.id] || [],
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
      // qty_spread (tool checkbox, 1/0): opt back IN to the ±1 random quantity.
      // Absent or 0, every customer asks EXACTLY `avg` — "average 1" means 1.
      spread: !!m.qty_spread,
      // customerBatch (level designer, défaut 2) : nombre max de clients par paquet.
      // Absent = repli sur la constante moteur (SPAWN_BATCH_MAX).
      customerBatch: m.customerBatch != null && m.customerBatch !== "" ? +m.customerBatch : null,
      // data-driven: one weight per known resource id (column named like the resource)
      weights: Object.fromEntries(resourceOrder.map((rid) => [rid, m[rid] || 0])),
    };
  });

  // tax profiles: one row per profile, "round N" columns hold the cost (0 = no tax)
  // unlock profiles: which machines exist in a level and the round they unlock
  // `|| []`: unlock_config now lives in config_levels.json (tool-owned), so the
  // sheet may drop it entirely — an absent section must default to empty, not
  // crash, exactly like market_config / competitors_behavior above.
  const unlockProfiles = {};
  (raw.unlock_config || []).forEach((u) => { (unlockProfiles[u.id] = unlockProfiles[u.id] || {})[u.machine] = u.unlock; });

  // world configs: one row per (level config, competitor)
  const worldConfigs = {};
  raw.world_config.forEach((w) => {
    const wc = (worldConfigs[w.id] = worldConfigs[w.id] || {
      id: w.id, competitors: [], nbOfRounds: w.nbOfRounds,
      marketConfig: w.marketConfig, unlockConfig: w.unlockConfig,
    });
    if (w.competitors) wc.competitors.push(w.competitors);
  });

  // ordered level list (menu order = sheet order); topX = rank the player must
  // reach (1 = finish first, 2 = top 2…) to win the level on cumulative revenue.
  // preparationTime (seconds) is the per-level prep window; blank falls back to
  // the global general.tycoonPhaseDuration at resolve time (see startPrep).
  // safeAssign (TRUE) = the wave refuses to start while the player still has an
  // idle worker on the bench (see the assign-gate in updatePlay). The exporter
  // may hand us a real boolean (checkbox column) or the string "TRUE".
  const worldLevels = raw.world_level.map((l) => ({ id: l.id, config: l.config, reward: l.reward, topX: l.topX || 1, preparationTime: l.preparationTime != null && l.preparationTime !== "" ? +l.preparationTime : null, safeAssign: l.safeAssign === true || String(l.safeAssign).toUpperCase() === "TRUE" }));

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

  // character slots: one per resource, MULTIPLE rows per slot — each row adds one
  // accepted race to `containments`. Group them here; `resource` is the id minus
  // the "slot_" prefix (slot_tennisBall -> tennisBall).
  const characterSlots = [];
  (raw.character_slot || []).forEach((s) => {
    if (!s.id) return;
    let slot = characterSlots.find((x) => x.id === s.id);
    if (!slot) characterSlots.push(slot = { id: s.id, resource: String(s.id).replace(/^slot_/, ""), order: s.order || 0, containments: [] });
    if (s.containment && !slot.containments.includes(s.containment)) slot.containments.push(s.containment);
  });
  characterSlots.sort((a, b) => a.order - b.order);

  // feature unlocks: {id, tutorial, target, trigger, value}. The feature turns on
  // when its `trigger` is satisfied — either an atomic trigger from the `triggers`
  // tab (reach_level_[number], enter_level_[number], reach_[number]_in_stock,
  // reach_[number]_of_[ressource], optain_[character_typeSlot]) or the id of an
  // AND/OR group in `triggers_group`. `tutorial` (black_mask | red_dot) and the
  // `target` chain drive the onboarding overlay (tutorial.js); a row with no
  // tutorial just gates the feature silently.
  const featureUnlocks = {};
  (raw.feature_unlock || []).forEach((f) => {
    if (!f.id) return;
    featureUnlocks[f.id] = {
      id: f.id,
      // "back_mask" is a recurring typo in the sheet — same thing as black_mask,
      // and silently ignoring the row would just make the tutorial not show up.
      tutorial: f.tutorial === "back_mask" ? "black_mask" : (f.tutorial || null),
      // "character_tab, dog, equip_hat" -> a chain the player walks one click at a time
      targets: String(f.target == null ? "" : f.target).split(",").map((s) => s.trim()).filter(Boolean),
      trigger: f.trigger || null,
      value: f.value,
    };
  });

  // trigger groups: several rows share one id, each adding a term. `logic` is
  // carried by every row of the group (AND / OR) and a term may itself be another
  // group id — that is how unlock_merge nests reach_3_common_ressources.
  const triggerGroups = {};
  (raw.triggers_group || []).forEach((g) => {
    if (!g.id) return;
    const grp = (triggerGroups[g.id] = triggerGroups[g.id] || { id: g.id, logic: "AND", terms: [] });
    if (g.logic) grp.logic = String(g.logic).toUpperCase();
    if (g.trigger) grp.terms.push({ trigger: g.trigger, value: g.value });
  });

  // upgrade profiles: shard cost to reach each level (level 1 = unlock cost)
  const upgradeProfiles = {};
  (raw.upgrade_character_profile || raw.upgrade_profile || []).forEach((u) => { (upgradeProfiles[u.id] = upgradeProfiles[u.id] || {})[u.level] = { amount: u.amount, content: u.content }; });
  // a character's max level = the last level its upgrade profile can pay for
  for (const id in characters) {
    const lv = Object.keys(upgradeProfiles[characters[id].profile] || {}).map(Number);
    characters[id].maxLevel = lv.length ? Math.max(...lv) : 1;
  }

  // convert (refining): N units of a resource at one tier -> 1 unit at the next.
  // `convert_profile` became a PROFILE table (same indirection as `profil` ->
  // outputs_profiles): its `id` names the PROFILE, and each resource picks its
  // profile through the `convert` column of the `outputs` table. Resolve that here,
  // or cfg.convert[resourceId] never exists and the Raffiner button never shows
  // (resource.js) — which is exactly what happened when the sheet was reshaped.
  // Columns also moved: tier -> tier_A, quantity -> number, result_tier -> tier_B,
  // and there is no result_ressource any more (refining stays within one resource).
  const convert = {};
  const convertRows = raw.convert_profile || raw.convert || [];
  if (convertRows.length && convertRows[0].tier_A != null) {
    const profiles = {};
    convertRows.forEach((c) => { (profiles[c.id] = profiles[c.id] || {})[c.tier_A] = { quantity: c.number, resultTier: c.tier_B }; });
    (raw.outputs || []).forEach((o) => {
      const prof = profiles[o.convert]; if (!prof) return;
      const rules = (convert[o.id] = convert[o.id] || {});
      for (const t in prof) rules[t] = { quantity: prof[t].quantity, resultRes: o.id, resultTier: prof[t].resultTier, resultQty: 1 };
    });
  } else {
    // old flat shape: one row per resource, already keyed by resource id
    convertRows.forEach((c) => {
      (convert[c.id] = convert[c.id] || {})[c.tier] = { quantity: c.quantity, resultRes: c.result_ressource, resultTier: c.result_tier, resultQty: c.result_quantity || 1 };
    });
  }

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
    g, resources, resourceOrder, maxTier, tierColors, tierBonusChance, machines, purchases, roundIncome, competitors, convert, slots, customerSprites, customerDefs, customerOrder,
    marketProfiles, unlockProfiles, worldConfigs, worldLevels, rewards, gears, characters, characterOrder, upgradeProfiles,
    behaviorProfiles, buffProfiles, progressProfiles, characterSlots, featureUnlocks, triggerGroups,
  };
}

// ============================================================
// Level resolution: world_level -> effective per-game config
// ============================================================
// Returns everything the engine needs to run one level: rounds, market rows,
// machine unlocks, the exact bot lineup and the topX win condition.
export function resolveLevel(cfg, levelId) {
  const level = cfg.worldLevels.find((l) => l.id === levelId);
  if (!level) throw new Error("Unknown level: " + levelId);
  const wc = cfg.worldConfigs[level.config];
  if (!wc) throw new Error("Unknown world config: " + level.config);
  // same id chain as the bots below: marketConfig column, else the ids themselves
  const market = cfg.marketProfiles[wc.marketConfig] || cfg.marketProfiles[level.id] || cfg.marketProfiles[wc.id] || {};
  // same id chain as market/behavior: the designer scopes unlock_config by the
  // world_level id, so fall back to it (then wc.id) when the world_config column
  // doesn't name a profile of its own.
  const unlocks = cfg.unlockProfiles[wc.unlockConfig] || cfg.unlockProfiles[level.id] || cfg.unlockProfiles[wc.id] || {};
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
  return { id: level.id, reward: level.reward, totalRounds, market, unlocks, bots, topX: level.topX || 1, preparationTime: level.preparationTime, safeAssign: level.safeAssign };
}
