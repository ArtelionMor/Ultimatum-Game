/* Market Ultimatum — game-cheats.js
 * Dev cheat console extracted from main.js. Kept as methods on the Game object
 * (they use `this` for state + DOM), reassembled via Object.assign(Game, cheatMethods).
 * Gated at runtime by cheatsEnabled() (general `enableCheats` flag).
 */
"use strict";

import { $ } from "./helpers.js";
import { S } from "./constants.js";
import { Meta } from "./meta.js";
import { renderMenu } from "./menu.js";

export const cheatMethods = {
  // Killswitch: the whole cheat console is gated by the general `enableCheats`
  // flag so it can be shipped disabled for release without ripping the code out.
  // Accepts true / "TRUE" / 1 / "yes" / "on" (Sheets exports booleans loosely).
  cheatsEnabled() {
    const v = this.cfg && this.cfg.g && this.cfg.g.enableCheats;
    return v === true || v === 1 || (typeof v === "string" && /^(true|1|yes|on)$/i.test(v.trim()));
  },
  // Show/hide the toggle button and force the overlay closed based on the flag.
  applyCheatMode() {
    const on = this.cheatsEnabled();
    const toggle = $("#cheat-toggle"), overlay = $("#cheat-overlay");
    if (toggle) toggle.style.display = on ? "" : "none";
    if (!on) { this.timeScale = 1; if (overlay) overlay.classList.add("hidden"); }
  },
  // Multiply the play-loop dt (production, prep countdown, wave spawning). 1 = normal.
  setTimeScale(s) {
    if (!this.cheatsEnabled()) return;
    this.timeScale = s > 0 ? s : 1;
    const val = $("#cheat-speed-val"); if (val) val.textContent = "×" + this.timeScale;
    const wrap = $("#cheat-speeds");
    if (wrap) wrap.querySelectorAll("button[data-speed]").forEach((b) => b.classList.toggle("active", +b.dataset.speed === this.timeScale));
  },
  // Give (or take) money to the player and refresh anything money-dependent.
  cheatAddMoney(v) {
    if (!this.cheatsEnabled() || !this.player || !Number.isFinite(v)) return;
    this.player.money = Math.max(0, this.player.money + v);
    this.refreshHud(); this.renderShop(); this.refreshAffordability(); this.refreshSuppliers();
  },
  // Instantly end the current run as a win (richest) or a loss (eliminated).
  cheatWinLevel() {
    if (!this.cheatsEnabled() || !this.levelCfg || !this.player || this.state === S.Menu) return;
    ["#tax-overlay", "#results-overlay", "#cheat-overlay", "#taxinfo-overlay"].forEach((id) => $(id)?.classList.add("hidden"));
    this.waveActive = false;
    this.round = this.levelCfg.totalRounds;
    this.player.eliminated = false;
    this.player.money = Math.max(this.player.money, ...this.competitors.map((c) => c.money)) + 1000;
    this.transitionTo(S.GameOver);
  },
  cheatLoseLevel() {
    if (!this.cheatsEnabled() || !this.levelCfg || !this.player || this.state === S.Menu) return;
    ["#tax-overlay", "#results-overlay", "#cheat-overlay", "#taxinfo-overlay"].forEach((id) => $(id)?.classList.add("hidden"));
    this.waveActive = false;
    this.player.eliminated = true;
    this.transitionTo(S.GameOver);
  },

  // ---------- Meta cheats (work from the menu or mid-run) ----------
  // Every mutation goes through Meta.save() + a menu re-render (no-op when the
  // menu is hidden) + onMetaChanged so an ongoing run refreshes its workers.
  _cheatMetaDone() { Meta.save(); renderMenu(); this.onMetaChanged(); },
  cheatAddCurrency(kind, v) {
    if (!this.cheatsEnabled() || !Number.isFinite(v)) return;
    Meta.state[kind] = Math.max(0, (Meta.state[kind] || 0) + v);
    this._cheatMetaDone();
  },
  // Shards are nominative now: a rarity button tops up every character of that
  // profile (e.g. "common_shard" -> all common_character heroes).
  cheatAddShards(id, v) {
    if (!this.cheatsEnabled()) return;
    const profile = id.replace(/_shard$/, "") + "_character";
    this.cfg.characterOrder.forEach((cid) => {
      if (this.cfg.characters[cid].profile === profile) Meta.state.charShards[cid] = Math.max(0, (Meta.state.charShards[cid] || 0) + v);
    });
    this._cheatMetaDone();
  },
  cheatAddChest(id, v) {
    if (!this.cheatsEnabled()) return;
    Meta.state.chests[id] = Math.max(0, (Meta.state.chests[id] || 0) + v);
    this._cheatMetaDone();
  },
  // Unlock every character (level 1, existing levels kept).
  cheatUnlockChars() {
    if (!this.cheatsEnabled()) return;
    this.cfg.characterOrder.forEach((id) => { const c = Meta.state.characters[id]; c.level = Math.max(1, c.level); });
    this._cheatMetaDone();
  },
  // +1 level to every owned character (free, capped at each max).
  cheatLevelUpChars() {
    if (!this.cheatsEnabled()) return;
    this.cfg.characterOrder.forEach((id) => {
      const c = Meta.state.characters[id];
      if (c.level >= 1) c.level = Math.min(this.cfg.characters[id].maxLevel, c.level + 1);
    });
    this._cheatMetaDone();
  },
  // Complete the next one-shot level (grants its reward, like a real win).
  cheatCompleteNextLevel() {
    if (!this.cheatsEnabled()) return;
    const next = Meta.nextLevel();
    if (next && !Meta.isEndless(next.id)) Meta.completeLevel(next.id);
    this._cheatMetaDone();
  },
  // Mark every one-shot level completed (pure unlock, no rewards granted).
  cheatUnlockAllLevels() {
    if (!this.cheatsEnabled()) return;
    Meta.state.completedLevels = this.cfg.worldLevels.filter((l) => !Meta.isEndless(l.id)).map((l) => l.id);
    this._cheatMetaDone();
  },
  // Wipe the meta save and go back to a fresh menu.
  cheatResetSave() {
    if (!this.cheatsEnabled()) return;
    Meta.reset();
    $("#cheat-overlay")?.classList.add("hidden");
    this.toMenu();
  },

  // Jump straight to the prep phase of wave `n`: unlock every machine due by then,
  // reset the wave/market, and rebuild the round from startPrep (income, bots, HUD).
  cheatGoToWave(n) {
    if (!this.cheatsEnabled() || !this.cfg || !this.player || !this.levelCfg) return;
    n = Math.max(1, Math.floor(n || 1));
    ["#tax-overlay", "#results-overlay", "#gameover-overlay", "#cheat-overlay"].forEach((id) => $(id)?.classList.add("hidden"));
    if (!this._screenReady) this.setupScreen();
    this.waveActive = false;
    this.market = null;
    const lane = $("#customer-lane"); if (lane) lane.innerHTML = "";
    this.cfg.machines.forEach((m) => { const r = this.machineUnlockRound(m.id); if (r != null && r <= n) this.giveMachine(this.player, m.id); });
    this.round = n - 1;      // startPrep() increments to n
    this.state = S.Play;
    this.startPrep();
  },
};
