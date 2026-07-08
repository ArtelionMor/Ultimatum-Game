/* Market Ultimatum — meta.js
 * Persistent meta-progression: level completion, currencies, chests,
 * characters (the player's workers) and their gear. Saved in localStorage.
 */

const SAVE_KEY = "mu_meta_v1";

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
      shards: {},                    // "common_shard" -> count
      chests: {},                    // "common_chest" -> count
      gearsOwned: {},                // "hat_common" -> count
      characters: {},                // charId -> { level } (0 = locked)
      equipment: {},                 // charId -> { hat, suit, shoes } (gear ids or null)
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
  // Apply one drop line to the state. "X_gear" resolves to `amount` random
  // concrete gears of that rarity; everything else is a simple counter.
  applyDrop(content, amount) {
    const s = this.state;
    if (content === "coins") { s.coins += amount; return [{ type: "coins", amount }]; }
    if (content === "gems") { s.gems += amount; return [{ type: "gems", amount }]; }
    if (content.endsWith("_shard")) { s.shards[content] = (s.shards[content] || 0) + amount; return [{ type: "shard", id: content, amount }]; }
    if (content.endsWith("_chest")) { s.chests[content] = (s.chests[content] || 0) + amount; return [{ type: "chest", id: content, amount }]; }
    if (content.endsWith("_gear")) {
      const rarity = content.replace(/_gear$/, "");
      const pool = Object.values(this.cfg.gears).filter((g) => g.rarity === rarity);
      if (!pool.length) return [];
      const out = {};
      for (let i = 0; i < amount; i++) { const g = pool[Math.floor(Math.random() * pool.length)]; out[g.id] = (out[g.id] || 0) + 1; }
      const drops = [];
      for (const id in out) { s.gearsOwned[id] = (s.gearsOwned[id] || 0) + out[id]; drops.push({ type: "gear", id, amount: out[id] }); }
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
  // Cost to bring a character to its next level (level 1 = unlock).
  upgradeCost(charId) {
    const ch = this.cfg.characters[charId];
    const next = this.charLevel(charId) + 1;
    if (next > ch.maxLevel) return null;
    const cost = (this.cfg.upgradeProfiles[ch.profile] || {})[next];
    return cost ? { level: next, amount: cost.amount, content: cost.content } : null;
  },
  canUpgrade(charId) {
    const c = this.upgradeCost(charId);
    return !!c && (this.state.shards[c.content] || 0) >= c.amount;
  },
  upgradeCharacter(charId) {
    const c = this.upgradeCost(charId);
    if (!c || (this.state.shards[c.content] || 0) < c.amount) return false;
    this.state.shards[c.content] -= c.amount;
    this.state.characters[charId].level = c.level;
    this.save();
    return true;
  },

  // ---------- Gear ----------
  gearDef(gearId) { return this.cfg.gears[gearId]; },
  // Copies of a gear not currently worn by anyone.
  equippedCount(gearId) {
    let n = 0;
    for (const cid in this.state.equipment) { const eq = this.state.equipment[cid]; for (const slot in eq) if (eq[slot] === gearId) n++; }
    return n;
  },
  freeCount(gearId) { return (this.state.gearsOwned[gearId] || 0) - this.equippedCount(gearId); },
  equip(charId, gearId) {
    const g = this.cfg.gears[gearId];
    if (!g || !this.isOwned(charId) || this.freeCount(gearId) <= 0) return false;
    this.state.equipment[charId][g.slot] = gearId;
    this.save();
    return true;
  },
  unequip(charId, slot) { this.state.equipment[charId][slot] = null; this.save(); },

  // ---------- In-game bonuses ----------
  // Production-speed bonus a character adds on a given machine (character affinity
  // at its current level + the speed of every gear worn).
  speedBonus(charId, machineId) {
    const ch = this.cfg.characters[charId];
    const data = ch && ch.levels[this.charLevel(charId)];
    let v = data ? (data.speeds[machineId] || 0) : 0;
    const eq = this.state.equipment[charId] || {};
    for (const slot in eq) { const g = eq[slot] && this.cfg.gears[eq[slot]]; if (g) v += g.speed; }
    return v;
  },
  // Chance (0..1) that this character's machine doubles its production spawn.
  proba2x(charId) {
    const ch = this.cfg.characters[charId];
    const data = ch && ch.levels[this.charLevel(charId)];
    let v = data ? data.proba2x : 0;
    const eq = this.state.equipment[charId] || {};
    for (const slot in eq) { const g = eq[slot] && this.cfg.gears[eq[slot]]; if (g) v += g.proba2x; }
    return v;
  },
};
