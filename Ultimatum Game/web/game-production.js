/* Market Ultimatum — game-production.js
 * Per-frame machine production extracted from main.js.
 *  - rollTier: pure. pickOutput: pure over cfg.
 *  - effTime / hasInputs / consumeInputs: module-local, take game.
 *  - tickProduction: exported orchestration (runs every frame during a wave).
 * game.lvl stays on the Game object (shared machine-level accessor).
 */
"use strict";

import { crewSpeedBonus, crewProba2x } from "./game-workers.js";

function effTime(game, machine) { const L = game.lvl(machine); return Math.max(0.3, L.productionTime * (1 - crewSpeedBonus(L, machine))); }
function hasInputs(game, p, def) { return def.inputs.every((i) => game.stockOf(p, i.type) >= i.quantity); }
function consumeInputs(game, p, def) { def.inputs.forEach((i) => { let need = i.quantity; const m = p.stock[i.type]; for (const t of Object.keys(m).sort((a, b) => a - b)) { while (need > 0 && m[t] > 0) { m[t]--; need--; } } }); if (p === game.player) game._invDirty = true; }

export function tickProduction(game, dt) {
  const p = game.player;
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
    const time = effTime(game, m);
    game.setProgress(m, Math.min(1, m.elapsed / time));
    if (m.elapsed >= time) {
      m.elapsed = 0;
      if (converts) { if (!hasInputs(game, p, def)) return; consumeInputs(game, p, def); }
      const out = pickOutput(game.cfg, def.outputs, m.level);
      const tier = rollTier(out.tiers);   // one tier for the whole spawn (matches the "+N Tier T" popup)
      // characters' "2x proba" (affinity + gear): chance to double the spawn
      const doubled = Math.random() < crewProba2x(m);
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

function pickOutput(cfg, resId, level) {
  const list = cfg._outputs[resId + "_" + Math.min(level, 15)] || cfg._outputs[resId + "_1"];
  const total = list.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of list) { r -= o.weight; if (r <= 0) return o; }
  return list[list.length - 1];
}

function rollTier(tierPcts) {
  let r = Math.random() * 100;
  for (let i = 0; i < tierPcts.length; i++) { r -= tierPcts[i]; if (r <= 0) return i + 1; }
  return 1;
}
