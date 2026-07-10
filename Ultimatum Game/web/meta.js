/* Market Ultimatum — meta.js
 * Persistent meta-progression: level completion, currencies, chests,
 * characters (the player's workers) and their gear. Saved in localStorage.
 *
 * Economy model (per-character):
 *  - Character shards are NOMINATIVE: each character has its own shard stock,
 *    used to unlock (level 1) and level it up.
 *  - Gear is a pool of item INSTANCES { uid, slot, rarity, progress }. An
 *    instance is equipped on one character/slot at a time; unequipped ones are
 *    "orphans". Fusing feeds orphan gears into another gear: their fuzeValue
 *    fills the base's progress bar and, once it reaches numberToUpgrade, the
 *    base changes rarity (common -> rare -> epic -> legendary).
 */

import { RARITIES } from "./constants.js";

const SAVE_KEY = "mu_meta_v2";   // bumped from v1: gear/shard model changed

const nextRarity = (r) => RARITIES[RARITIES.indexOf(r) + 1] || null;

export const Meta = {
  cfg: null,
  state: null,

  init(cfg) {
    this.cfg = cfg;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { /* corrupt save -> restart fresh */ }
    this.state = Object.assign(this.defaultState(), saved || {});
    // Merge in characters added to the config after the save was created.
    cfg.characterOrder.forEach((id) => {
      if (!this.state.characters[id]) this.state.characters[id] = { level: 0 };
      if (!this.state.equipment[id]) this.state.equipment[id] = { hat: null, suit: null, shoes: null };
      if (this.state.charShards[id] == null) this.state.charShards[id] = 0;
    });
    // The player always starts with the first character of the roster.
    const first = cfg.characterOrder[0];
    if (first && this.state.characters[first].level < 1) this.state.characters[first].level = 1;
    this.save();
  },

  defaultState() {
    return {
      completedLevels: [],           // level ids finished for good (endless never enters here)
      coins: 0, gems: 0,
      charShards: {},                // charId -> count (nominative shards)
      chests: {},                    // "common_chest" -> count
      gears: [],                     // [{ uid, slot, rarity, progress }]
      nextGearUid: 1,                // instance id counter
      characters: {},                // charId -> { level } (0 = locked)
      equipment: {},                 // charId -> { hat, suit, shoes } (gear uid or null)
    };
  },

  save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); } catch (e) { /* storage full/blocked */ } },
  // Wipe the save and rebuild a fresh state (debug console).
  reset() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } this.state = null; this.init(this.cfg); },

  // ---------- Levels ----------
  // The last entry of world_level is the endless mode: always replayable, its
  // reward is granted on every win. Other levels are one-shot, in sheet order.
  isEndless(levelId) { const ls = this.cfg.worldLevels; return ls.length > 0 && ls[ls.length - 1].id === levelId; },
  isCompleted(levelId) { return this.state.completedLevels.includes(levelId); },
  isUnlocked(levelId) {
    const ls = this.cfg.worldLevels;
    const i = ls.findIndex((l) => l.id === levelId);
    if (i < 0) return false;
    // unlocked when every previous (non-endless) level is completed
    return ls.slice(0, i).every((l) => this.isEndless(l.id) || this.isCompleted(l.id));
  },
  // First playable level: the endless mode if everything else is done, else the next one-shot.
  nextLevel() {
    const ls = this.cfg.worldLevels;
    return ls.find((l) => !this.isEndless(l.id) && !this.isCompleted(l.id)) || ls[ls.length - 1] || null;
  },
  // Player won a level: grant its reward (once for one-shots, every time for endless).
  completeLevel(levelId) {
    const level = this.cfg.worldLevels.find((l) => l.id === levelId);
    if (!level) return [];
    if (!this.isEndless(levelId)) {
      if (this.isCompleted(levelId)) return [];
      this.state.completedLevels.push(levelId);
    }
    const drops = this.grantReward(level.reward);
    this.save();
    return drops;
  },

  // ---------- Rewards & chests ----------
  // Roll a reward table: one weighted pick per group (A..E). Rows without content
  // are "nothing". Returns the list of applied drops for the UI.
  grantReward(rewardId) {
    const table = this.cfg.rewards[rewardId];
    if (!table) return [];
    const drops = [];
    Object.keys(table).sort().forEach((group) => {
      const row = this.weightedPick(table[group]);
      if (!row || !row.content) return;
      drops.push(...this.applyDrop(row.content, row.amount));
    });
    this.save();
    return drops;
  },
  weightedPick(rows) {
    const total = rows.reduce((s, r) => s + r.weight, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const row of rows) { r -= row.weight; if (r <= 0) return row; }
    return rows[rows.length - 1];
  },
  // Apply one drop line to the state. Returns the list of applied drops for the UI.
  //  - "X_shard" -> `amount` shards to a random character of profile "X_character"
  //    (locked characters included: you need their shards to unlock them).
  //  - "X_gear"  -> one gear instance of rarity X (random slot) per unit, but only
  //    once the player owns at least one character to gear up.
  applyDrop(content, amount) {
    const s = this.state;
    if (content === "coins") { s.coins += amount; return [{ type: "coins", amount }]; }
    if (content === "gems") { s.gems += amount; return [{ type: "gems", amount }]; }
    if (content.endsWith("_chest")) { s.chests[content] = (s.chests[content] || 0) + amount; return [{ type: "chest", id: content, amount }]; }
    if (content.endsWith("_shard")) {
      const profile = content.replace(/_shard$/, "") + "_character";
      const pool = this.cfg.characterOrder.filter((id) => this.cfg.characters[id].profile === profile);
      if (!pool.length) return [];
      const charId = pool[Math.floor(Math.random() * pool.length)];
      s.charShards[charId] = (s.charShards[charId] || 0) + amount;
      return [{ type: "shard", charId, amount }];
    }
    if (content.endsWith("_gear")) {
      const rarity = content.replace(/_gear$/, "");
      const owners = this.ownedCharacters();
      if (!owners.length) return [];
      const slots = ["hat", "suit", "shoes"];
      const drops = [];
      for (let i = 0; i < amount; i++) {
        const slot = slots[Math.floor(Math.random() * slots.length)];
        const owner = owners[Math.floor(Math.random() * owners.length)];
        const uid = s.nextGearUid++;
        s.gears.push({ uid, owner, slot, rarity, progress: 0 });
        drops.push({ type: "gear", uid, owner, slot, rarity, amount: 1 });
      }
      return drops;
    }
    return [];
  },
  // Open one chest from the inventory. Its content table is `reward_<chest id>`.
  openChest(chestId) {
    const s = this.state;
    if (!s.chests[chestId]) return null;
    s.chests[chestId]--;
    const drops = this.grantReward("reward_" + chestId);
    this.save();
    return drops;
  },

  // ---------- Characters ----------
  charLevel(charId) { const c = this.state.characters[charId]; return c ? c.level : 0; },
  isOwned(charId) { return this.charLevel(charId) >= 1; },
  ownedCharacters() { return this.cfg.characterOrder.filter((id) => this.isOwned(id)); },
  charShards(charId) { return this.state.charShards[charId] || 0; },
  // Cost to bring a character to its next level (level 1 = unlock), paid in its
  // own nominative shards.
  upgradeCost(charId) {
    const ch = this.cfg.characters[charId];
    const next = this.charLevel(charId) + 1;
    if (next > ch.maxLevel) return null;
    const cost = (this.cfg.upgradeProfiles[ch.profile] || {})[next];
    return cost ? { level: next, amount: cost.amount } : null;
  },
  canUpgrade(charId) {
    const c = this.upgradeCost(charId);
    return !!c && this.charShards(charId) >= c.amount;
  },
  upgradeCharacter(charId) {
    const c = this.upgradeCost(charId);
    if (!c || this.charShards(charId) < c.amount) return false;
    this.state.charShards[charId] -= c.amount;
    this.state.characters[charId].level = c.level;
    this.save();
    return true;
  },

  // ---------- Gear (item instances) ----------
  gearInst(uid) { return this.state.gears.find((g) => g.uid === uid) || null; },
  // Config row backing an instance at its current rarity.
  gearDef(inst) { return inst && this.cfg.gears[`${inst.slot}_${inst.rarity}`]; },
  gearSpeed(inst) { const d = this.gearDef(inst); return d ? d.speed : 0; },
  gearProba(inst) { const d = this.gearDef(inst); return d ? d.proba2x : 0; },
  gearFuel(inst) { const d = this.gearDef(inst); return d ? d.fuzeValue : 0; },        // fuel this instance yields as material
  gearThreshold(inst) { const d = this.gearDef(inst); return d ? d.numberToUpgrade : 0; }, // fuel needed to reach the next rarity
  canUpgradeGear(inst) { return !!inst && nextRarity(inst.rarity) !== null; },

  // Which character/slot currently wears this gear instance, or null if orphan.
  gearWornAt(uid) {
    for (const cid in this.state.equipment) {
      const eq = this.state.equipment[cid];
      for (const slot in eq) if (eq[slot] === uid) return { charId: cid, slot };
    }
    return null;
  },
  isEquipped(uid) { return this.gearWornAt(uid) !== null; },
  // A character's own gears that aren't currently equipped (optionally one slot).
  orphanGears(charId, slot) {
    return this.state.gears.filter((g) => g.owner === charId && (!slot || g.slot === slot) && !this.isEquipped(g.uid));
  },
  equip(charId, uid) {
    const inst = this.gearInst(uid);
    if (!inst || inst.owner !== charId || !this.isOwned(charId) || this.isEquipped(uid)) return false;
    this.state.equipment[charId][inst.slot] = uid;
    this.save();
    return true;
  },
  unequip(charId, slot) { this.state.equipment[charId][slot] = null; this.save(); },

  // ---------- Fuse ----------
  // Feed a character's orphan gears (fuelUids) into one of their gears (the base,
  // which may be equipped): each fuel's fuzeValue fills the base's progress bar and,
  // once it reaches numberToUpgrade, the base's rarity goes up one tier (remainder
  // carried over). Fuel gears are consumed.
  fuse(baseUid, fuelUids) {
    const base = this.gearInst(baseUid);
    if (!base || !this.canUpgradeGear(base)) return false;
    // valid fuel = same owner, not the base, not equipped
    const consume = new Set((fuelUids || []).filter((u) => {
      const f = this.gearInst(u);
      return f && u !== baseUid && f.owner === base.owner && !this.isEquipped(u);
    }));
    let added = 0;
    consume.forEach((u) => { added += this.gearFuel(this.gearInst(u)); });
    if (added <= 0) return false;
    this.state.gears = this.state.gears.filter((g) => !consume.has(g.uid));
    base.progress += added;
    // cascade rarity upgrades while enough progress and not yet at max
    while (this.canUpgradeGear(base) && base.progress >= this.gearThreshold(base)) {
      base.progress -= this.gearThreshold(base);
      base.rarity = nextRarity(base.rarity);
    }
    if (!this.canUpgradeGear(base)) base.progress = 0; // maxed: no bar to fill
    this.save();
    return true;
  },

  // ---------- In-game bonuses ----------
  // Production-speed bonus a character adds on a given machine (character affinity
  // at its current level + the speed of every gear worn).
  speedBonus(charId, machineId) {
    const ch = this.cfg.characters[charId];
    const data = ch && ch.levels[this.charLevel(charId)];
    let v = data ? (data.speeds[machineId] || 0) : 0;
    const eq = this.state.equipment[charId] || {};
    for (const slot in eq) { const inst = eq[slot] && this.gearInst(eq[slot]); if (inst) v += this.gearSpeed(inst); }
    return v;
  },
  // Chance (0..1) that this character's machine doubles its production spawn.
  proba2x(charId) {
    const ch = this.cfg.characters[charId];
    const data = ch && ch.levels[this.charLevel(charId)];
    let v = data ? data.proba2x : 0;
    const eq = this.state.equipment[charId] || {};
    for (const slot in eq) { const inst = eq[slot] && this.gearInst(eq[slot]); if (inst) v += this.gearProba(inst); }
    return v;
  },
};
