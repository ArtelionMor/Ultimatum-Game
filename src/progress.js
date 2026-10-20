// Player level and tasks — pure. Each level has a few tasks (cfg.tasks); a
// task is "ready" once its condition holds and gives its reward when claimed.
// When every task of the level is claimed the player can level up, which pays
// the next level's reward and unlocks its machines (cfg.levels[].unlock).

import { countOf, machineDef } from './grid.js';

export const levelRow = (cfg, lvl) => cfg.levels.find(l => l.level === lvl) || null;
export const tasksOf = (cfg, lvl) => cfg.tasks.filter(t => t.level === lvl);
export const maxLevel = cfg => Math.max(...cfg.levels.map(l => l.level));
const unlocksOf = row => (row?.unlock || '').split(/\s+/).filter(Boolean);

export function initProgress(cfg, st) {
  st.level = 1;
  st.claimed = {};
  for (const id of unlocksOf(levelRow(cfg, 1))) st.unlocked[id] = true;
}

// Current value of a task's condition (comparable with task.target).
export function taskValue(cfg, st, t) {
  const s = st.stats;
  switch (t.type) {
    case 'build': return countOf(st.grid, t.param);
    case 'sell': return Math.floor(s.sold[t.param] || 0);
    case 'tier': return s.bestTier?.[t.param] || 0;
    case 'upgrade': return Math.max(0, ...st.grid.machines.filter(m => m.type === t.param).map(m => m.lvl));
    case 'share': return s.bestShare?.[t.param] || 0;
    case 'earn': return Math.floor(s.earned);
    case 'stock': return st.stockLvl;
    case 'own_recipe': return Object.keys(st.auc?.owned || {}).length;
    case 'use_recipe': return st.grid.machines.filter(m => m.recipe).length;
    case 'monopoly': {
      const mono = s.monopolies || {};
      return t.param === 'any' ? (Object.keys(mono).length ? 1 : 0) : (mono[t.param] ? 1 : 0);
    }
    default: return 0;
  }
}

// Once reached, a task stays reached (selling the machine doesn't undo it).
export function taskState(cfg, st, t) {
  st.reached ||= {};
  let value = taskValue(cfg, st, t);
  if (value >= t.target) st.reached[t.id] = true;
  if (st.reached[t.id] || st.claimed[t.id]) value = Math.max(value, t.target);
  return { value, target: t.target, ready: value >= t.target, claimed: !!st.claimed[t.id] };
}

export function claimTask(cfg, st, t) {
  const s = taskState(cfg, st, t);
  if (!s.ready || s.claimed) return false;
  st.claimed[t.id] = true;
  st.money += t.reward;
  return true;
}

// Tasks of the current level: { done (claimed), total, ready (claimable) }.
export function levelProgress(cfg, st) {
  const list = tasksOf(cfg, st.level);
  let done = 0, ready = 0;
  for (const t of list) {
    const s = taskState(cfg, st, t);
    if (s.claimed) done++;
    else if (s.ready) ready++;
  }
  return { done, total: list.length, ready };
}

export function canLevelUp(cfg, st) {
  const p = levelProgress(cfg, st);
  return p.done === p.total && !!levelRow(cfg, st.level + 1);
}

// Returns the row of the level reached, or null.
export function levelUp(cfg, st) {
  if (!canLevelUp(cfg, st)) return null;
  st.level++;
  const row = levelRow(cfg, st.level);
  st.money += row.reward;
  for (const id of unlocksOf(row)) st.unlocked[id] = true;
  return row;
}

export const unlockNames = (cfg, row) => unlocksOf(row).map(id => machineDef(cfg, id)).filter(Boolean);

// Saves from before levels: put the player at the highest level whose unlocks
// they already use, unlock everything up to there, and count older tasks as done.
export function migrateProgress(cfg, st) {
  if (st.level) return;
  let lvl = 1;
  // Every game starts with one Outcome, so only a second one says something.
  const owns = id => countOf(st.grid, id) > (id === 'outcome' ? 1 : 0);
  for (const row of cfg.levels) if (unlocksOf(row).some(owns)) lvl = Math.max(lvl, row.level);
  st.level = lvl;
  st.claimed = {};
  for (const row of cfg.levels) if (row.level <= lvl) for (const id of unlocksOf(row)) st.unlocked[id] = true;
  for (const t of cfg.tasks) if (t.level < lvl) st.claimed[t.id] = true;
}
