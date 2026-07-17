/* Market Ultimatum — game-workers.js
 * Worker & crew management extracted from main.js.
 *  - Pure helpers: freeWorkers, crewSpeedBonus, crewProba2x (no game state).
 *  - Orchestration: addWorker / select / assign / remove / unassign (take game).
 */
"use strict";

import { Meta } from "./meta.js";

// ---------- Pure helpers ----------

export function freeWorkers(player) { return player.workers.filter((w) => !w.machineId); }

// Total speed bonus of a machine's crew: base per-worker bonus from the machine
// level L + each character's affinity/gear speed on this machine.
export function crewSpeedBonus(L, m) {
  return m.crew.reduce((s, w) => s + L.workerSpeedBonus + (w.charId ? Meta.speedBonus(w.charId, m.id) : 0), 0);
}

// Chance the whole spawn doubles: characters roll together (1 - prod of misses).
export function crewProba2x(m) {
  let miss = 1;
  m.crew.forEach((w) => { if (w.charId) miss *= 1 - Math.min(1, Meta.proba2x(w.charId)); });
  return 1 - miss;
}

// ---------- Orchestration (take the Game object) ----------

// Workers are individuals: the player's unlocked characters staff the pool first
// (they carry affinity + gear bonuses), then anonymous hires fill the rest.
// A bot hires anonymously — its rationalized character loadout is a flat buff
// (competitors_buffs, applied in game-production.js), not real characters.
export function addWorker(game, p) {
  const w = p.workers;
  let nextChar = null;
  if (p.isPlayer) {
    const usedChars = new Set(w.map((x) => x.charId).filter(Boolean));
    nextChar = Meta.ownedCharacters().find((id) => !usedChars.has(id)) || null;
  }
  w.push({ uid: (game._wuid = (game._wuid || 0) + 1), charId: nextChar, machineId: null });
}

// Tap a free worker to arm it, then tap a machine — or drag & drop directly.
export function selectWorker(game, w) { game.selectedWorker = game.selectedWorker === w ? null : w; game.renderWorkers(); }

// Assign a specific worker (defaults to the armed/first free one) to a machine.
export function assignWorker(game, m, worker) {
  const L = game.lvl(m);
  const w = worker || game.selectedWorker || freeWorkers(game.player)[0];
  if (!w || m.crew.length >= L.maxWorkers) return;
  if (w.machineId) unassignWorker(game, w, { silent: true }); // moving between machines
  w.machineId = m.id; m.crew.push(w);
  game.selectedWorker = null;
  game.renderWorkers(); game.refreshMachineCard(m);
}

// Pull one worker off a machine (a specific one when given, else the last added).
export function removeWorker(game, m, worker) {
  if (!m.crew.length) return;
  const w = worker || m.crew[m.crew.length - 1];
  unassignWorker(game, w, { silent: true });
  game.renderWorkers(); game.refreshMachineCard(m);
}

export function unassignWorker(game, w, opts) {
  if (!w.machineId) return;
  const m = game.player.machines.find((x) => x.id === w.machineId);
  w.machineId = null;
  if (m) {
    m.crew = m.crew.filter((x) => x !== w);
    if (m.crew.length < game.lvl(m).workersRequired) { m.producing = false; m.elapsed = 0; game.setProgress(m, 0); }
    if (!opts || !opts.silent) { game.renderWorkers(); game.refreshMachineCard(m); }
  }
}
