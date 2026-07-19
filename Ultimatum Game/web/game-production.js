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

function effTime(game, p, machine) {
  const L = game.lvl(machine);
  return Math.max(0.3, L.productionTime * (1 - crewSpeedBonus(L, machine) - buffSpeed(p)));
}
function hasInputs(game, p, def) { return def.inputs.every((i) => game.stockOf(p, i.type) >= i.quantity); }
function consumeInputs(game, p, def) { def.inputs.forEach((i) => { let need = i.quantity; const m = p.stock[i.type]; for (const t of Object.keys(m).sort((a, b) => a - b)) { while (need > 0 && m[t] > 0) { m[t]--; need--; } } }); if (p === game.player) game._invDirty = true; }

export function tickProduction(game, dt) {
  game.competitors.forEach((p) => tickOne(game, dt, p));
}

function tickOne(game, dt, p) {
  p.machines.forEach((m) => {
    const def = game.machineDef(m.id), L = game.lvl(m);
    const staffed = m.crew.length >= L.workersRequired;
    if (!staffed) { m.producing = false; m.elapsed = 0; game.setProgress(m, 0); return; }
    const converts = def.inputs.length > 0;
    // A converter needs its inputs to even run.
    if (converts && !hasInputs(game, p, def)) { m.producing = false; m.elapsed = 0; game.setProgress(m, 0); return; }
    // Storage full: only pure generators pause. Converters keep running — they
    // consume inputs (freeing space) before storing output, so they never deadlock.
    if (!converts && game.stockTotal(p) >= p.storageCap) { m.producing = false; game.setProgress(m, 1); return; }
    m.producing = true;
    m.elapsed += dt;
    const time = effTime(game, p, m);
    game.setProgress(m, Math.min(1, m.elapsed / time));
    if (m.elapsed >= time) {
      m.elapsed = 0;
      // Roll BEFORE consuming: a resource with no drop table would otherwise eat the
      // converter's inputs and hand back nothing at all.
      const out = pickOutput(game.cfg, def.outputs, m.level);
      if (!out) return;                   // resource with no drop table: skip rather than throw
      if (converts) { if (!hasInputs(game, p, def)) return; consumeInputs(game, p, def); }
      // one tier for the whole spawn (matches the "+N Tier T" popup); drops above
      // the feature-unlock cap are clamped to the best unlocked tier, same quantity
      const tier = Math.min(rollTier(out.tiers), game.maxUnlockedTier());
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
      if (added > 0) game.showSpawnPopup(m, def.outputs, added, tier, out.group);
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

export function rollTier(tierPcts) {
  let r = Math.random() * 100;
  for (let i = 0; i < tierPcts.length; i++) { r -= tierPcts[i]; if (r <= 0) return i + 1; }
  return 1;
}
