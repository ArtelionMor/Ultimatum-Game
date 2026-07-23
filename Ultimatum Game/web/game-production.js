/* Market Ultimatum — game-production.js
 * Per-frame machine production — run by EVERY competitor, player and bots alike.
 *  - rollTier / pickOutput: pure over cfg.
 *  - effTime / hasInputs / consumeInputs: module-local, take game + owner.
 *  - tickProduction: exported orchestration (runs every frame).
 * game.lvl stays on the Game object (shared machine-level accessor).
 *
 * The DOM helpers below (setProgress / flyToInventory / showSpawnPopup) all bail
 * on a machine with no `_node`. Only the player's machines are ever rendered, so
 * bots run through the exact same code path without touching the UI.
 */
"use strict";

import { crewSpeedBonus, crewProba2x } from "./game-workers.js";

// A bot's rationalized character loadout (competitors_buffs) lands here: it has no
// real characters on its crew, so its flat speed/proba2x buffs add on top of what
// the crew itself gives. The player scores 0 here — their bonuses ride on the
// workers themselves (Meta.speedBonus / Meta.proba2x in game-workers.js).
const buffSpeed = (p) => (p.buffs ? (p.buffs.speed || 0) / 100 : 0);
const buffProba2x = (p) => (p.buffs ? (p.buffs.proba2x || 0) / 100 : 0);

// Les bonus s'additionnent en VITESSE, pas en réduction de temps (rework 2026-07-19) :
// temps = base / (1 + somme des bonus). Chaque +100% ajoute « une machine de base »
// de débit — linéaire, jamais zéro, pas d'explosion au cumul (l'ancien modèle
// base × (1 − somme) plafonnait au plancher dès ~100% de bonus).
export function effTime(game, p, machine) {
  const L = game.lvl(machine);
  return Math.max(0.3, L.productionTime / (1 + crewSpeedBonus(L, machine) + buffSpeed(p)));
}
function hasInputs(game, p, def) { return def.inputs.every((i) => game.stockOf(p, i.type) >= i.quantity); }
// Returns the tier of EVERY unit actually taken off the shelf (one entry per unit,
// lowest tiers first) — that list is what the cycle later rolls its quality bonus on.
function consumeInputs(game, p, def) {
  const taken = [];
  def.inputs.forEach((i) => {
    let need = i.quantity; const m = p.stock[i.type];
    for (const t of Object.keys(m).sort((a, b) => a - b)) { while (need > 0 && m[t] > 0) { m[t]--; need--; taken.push(+t); } }
  });
  if (p === game.player) game._invDirty = true;
  return taken;
}

export function tickProduction(game, dt) {
  game.competitors.forEach((p) => tickOne(game, dt, p));
}

function tickOne(game, dt, p) {
  p.machines.forEach((m) => {
    const def = game.machineDef(m.id), L = game.lvl(m);
    // Rework « rabatteur » : une machine en mode "sell" ne produit RIEN — son
    // équipe est dehors, à rabattre les clients. Et au retour en mode "prod", la
    // production ne reprend que l'équipe AU COMPLET À LA BASE (w._hawk pas encore
    // rentré = machine en pause) : pas de téléportation en switchant les modes.
    // Pause = comme le sous-staffing d'avant : elapsed conservé, barre figée.
    const staffed = m.crew.length >= L.workersRequired && m.mode !== "sell" && !m.crew.some((w) => w._hawk);
    if (!staffed) { m.producing = false; game.setProgress(m, Math.min(1, m.elapsed / (m._cycle || effTime(game, p, m)))); return; }
    const converts = def.inputs.length > 0;
    // A converter pays for its cycle UP FRONT: the ingredients leave the stock when
    // the cycle STARTS, not when it finishes. Same rule as above — a machine that
    // cannot start just waits, it doesn't lose what it had — and a cycle already
    // paid for always runs to the end, whatever happens to the stock meanwhile.
    if (converts && !m.charged) {
      if (!hasInputs(game, p, def)) { m.producing = false; game.setProgress(m, Math.min(1, m.elapsed / (m._cycle || effTime(game, p, m)))); return; }
      m._inTiers = consumeInputs(game, p, def);
      m.charged = true;
    }
    // Storage full: only pure generators pause. Converters keep running — they
    // consume inputs (freeing space) before storing output, so they never deadlock.
    if (!converts && game.stockTotal(p) >= p.storageCap) { m.producing = false; game.setProgress(m, 1); return; }
    m.producing = true;
    m.elapsed += dt;
    const time = m._cycle = effTime(game, p, m);
    game.setProgress(m, Math.min(1, m.elapsed / time), Math.max(0, time - m.elapsed));
    if (m.elapsed >= time) {
      m.elapsed = 0;
      m.charged = false;                  // the next cycle buys its own ingredients
      const inTiers = m._inTiers; m._inTiers = null;   // spent: the next cycle rolls on its own ingredients
      const out = pickOutput(game.cfg, def.outputs, m.level);
      if (!out) return;                   // resource with no drop table: skip rather than throw
      // one tier for the whole spawn (matches the "+N Tier T" popup); drops above
      // the feature-unlock cap are clamped to the best unlocked tier, same quantity
      const cap = game.maxUnlockedTier();
      const base = Math.min(rollTier(out.tiers), cap);
      // Quality bonus: each ingredient this cycle burnt gets its own roll at +1 tier
      // (odds = ressources_tier.increase of THAT ingredient's tier), so a 2-ingredient
      // recipe can stack +2. Clamped like any other drop — a bonus eaten by the cap
      // isn't announced.
      const bonusTiers = rollIngredientBonus(game.cfg, inTiers);
      const tier = Math.min(base + bonusTiers.length, cap);
      const shownBonus = bonusTiers.slice(0, tier - base);
      // characters' "2x proba" (affinity + gear for the player, flat buff for a bot)
      const doubled = Math.random() < crewProba2x(m) + buffProba2x(p);
      const qty = out.quantity * (doubled ? 2 : 1);
      let added = 0;
      for (let i = 0; i < qty; i++) {
        if (game.stockTotal(p) >= p.storageCap) break;
        game.addStock(p, def.outputs, tier, 1);
        game.flyToInventory(m, def.outputs, tier);
        added++;
      }
      if (added > 0) game.showSpawnPopup(m, def.outputs, added, tier, out.group, shownBonus);
    }
  });
}

// Exported: bots roll their production through the very same tables at their own
// machine's level, so a competitor gets the same group A/B/C/D/E luck the player
// does — and pays for better odds with the same machine upgrades.
export function pickOutput(cfg, resId, level) {
  const list = cfg._outputs[resId + "_" + Math.min(level, 15)] || cfg._outputs[resId + "_1"];
  if (!list) return null;
  const total = list.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of list) { r -= o.weight; if (r <= 0) return o; }
  return list[list.length - 1];
}

// One roll per ingredient unit consumed by the cycle, at that unit's own tier odds
// (ressources_tier.increase). Returns the tiers that WON, so the popup can name the
// good ingredient — a T3 at 20% then a T4 at 40% is two independent tries for +1 each.
export function rollIngredientBonus(cfg, inTiers) {
  const won = [];
  (inTiers || []).forEach((t) => { if (Math.random() < (cfg.tierBonusChance[t] || 0)) won.push(t); });
  return won;
}

export function rollTier(tierWeights) {
  const total = tierWeights.reduce((s, w) => s + (w || 0), 0);
  if (total <= 0) return 1;
  let r = Math.random() * total;
  for (let i = 0; i < tierWeights.length; i++) { r -= tierWeights[i] || 0; if (r <= 0) return i + 1; }
  return 1;
}
