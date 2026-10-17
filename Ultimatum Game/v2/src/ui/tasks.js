// Player level + task list (Chainsaw Juice King style): a level badge and a
// task progress bar in the HUD; the 📋 panel lists the level's tasks with
// "Valider" (claim the reward) or "Aller" (jump to where it's done), and the
// "Niveau suivant" button once everything is claimed.

import { tasksOf, taskState, claimTask, levelProgress, canLevelUp, levelUp, levelRow, unlockNames } from '../progress.js';
import { machineDef } from '../grid.js';
import { money, pct } from '../format.js';
import { floatText, toast } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
let G;

export function initTasks(game) {
  G = game;
  $('tasks-btn').addEventListener('click', () => { G.st.seen.tasks = true; openTasks(); });
  $('tasks-close').addEventListener('click', closeTasks);
  $('tasks').addEventListener('click', e => { if (e.target.id === 'tasks') closeTasks(); });
}

export const openTasks = () => { $('tasks').classList.remove('hidden'); renderPanel(); play('tab', 0.25); };
const closeTasks = () => $('tasks').classList.add('hidden');

const marketOf = id => G.cfg.markets.find(m => m.id === id);

export function taskLabel(t) {
  const m = marketOf(t.param), d = machineDef(G.cfg, t.param);
  switch (t.type) {
    case 'build': return `Construis ${t.target > 1 ? t.target + ' × ' : ''}${d.icon} ${d.name}`;
    case 'sell': return `Vends ${t.target} ${m.icon} ${m.name}`;
    case 'tier': return `Livre un ${m.icon} ${m.name} ★${t.target}`;
    case 'upgrade': return `Monte ${d.icon} ${d.name} au niveau ${t.target}`;
    case 'share': return `Atteins ${pct(t.target)} du marché ${m.icon} ${m.name}`;
    case 'earn': return `Gagne ${money(t.target)} au total`;
    case 'stock': return `Agrandis le stock au niveau ${t.target}`;
    case 'own_recipe': return t.target > 1 ? `Obtiens ${t.target} recettes alternatives (enchère ou rachat)` : 'Obtiens une recette alternative (enchère ou rachat)';
    case 'use_recipe': return t.target > 1 ? `Fais tourner ${t.target} machines avec une recette alternative` : 'Fais tourner une machine avec une recette alternative';
    case 'monopoly': return t.param === 'any' ? 'Prends un monopole, sur n’importe quel marché' : `Prends le monopole ${m.icon} ${m.name}`;
    default: return t.type;
  }
}

// Progress 0..1. Levels (machine, stock) start at 1, so count from there.
export function taskFrac(t, s) {
  const base = t.type === 'upgrade' || t.type === 'stock' ? 1 : 0;
  return Math.max(0, Math.min(1, (s.value - base) / Math.max(1e-9, t.target - base)));
}

// The task to show in the quest box: a claimable one first, else the most
// advanced (value / target), ties going to the first listed.
export function featuredTask(cfg, st) {
  let best = null, bestFrac = -1;
  for (const t of tasksOf(cfg, st.level)) {
    const s = taskState(cfg, st, t);
    if (s.claimed) continue;
    if (s.ready) return { t, s };
    const frac = taskFrac(t, s);
    if (frac > bestFrac) { best = { t, s }; bestFrac = frac; }
  }
  return best;
}

// Quest box (the hint area under the money): featured task + tip.
let questKey = '';
export function renderQuest(tip) {
  const { cfg, st } = G;
  const box = $('hint');
  const up = canLevelUp(cfg, st), f = up ? null : featuredTask(cfg, st);
  let title, sub, frac, act = '';
  if (up) {
    title = '⭐ Toutes les tâches sont faites !'; frac = 1; act = 'up';
    sub = tip || 'Passe au niveau suivant pour débloquer la suite.';
  } else if (f) {
    title = taskLabel(f.t); frac = taskFrac(f.t, f.s);
    act = f.s.ready ? 'claim' : 'go';
    sub = tip || `${fmtValue(f.t, f.s.value)} / ${fmtTarget(f.t)} · 🎁 ${money(f.t.reward)}`;
  } else {
    title = tip || '👉 Vise un monopole : le marché où ta part est la plus haute.'; sub = ''; frac = 0;
  }
  const btn = act === 'up' ? '<button class="btn small q-btn q-ready" data-q="up">Niveau +</button>'
    : act === 'claim' ? '<button class="btn small q-btn q-ready" data-q="claim">Valider</button>'
    : act === 'go' ? '<button class="btn small q-btn" data-q="go">Aller</button>' : '';
  const key = [title, sub, (frac * 100).toFixed(0), btn].join('|');
  if (key === questKey) return;
  const changedTask = questKey.split('|')[0] !== title;
  questKey = key;
  box.innerHTML = `<div class="q-main"><div class="q-title">${title}</div>
      ${act ? `<div class="q-bar"><span style="width:${(frac * 100).toFixed(0)}%"></span></div>` : ''}
      ${sub ? `<div class="q-sub">${sub}</div>` : ''}</div>${btn}`;
  box.classList.toggle('ready', act === 'claim' || act === 'up');
  if (changedTask) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
  const b = box.querySelector('[data-q]');
  if (b) b.addEventListener('click', () => {
    if (b.dataset.q === 'claim') {
      if (claimTask(cfg, st, f.t)) { play('buy'); floatText(b, `+${money(f.t.reward)}`, 'gold'); G.onAction('task'); }
    } else if (b.dataset.q === 'go') G.goto(f.t);
    else openTasks();
  });
}

const fmtValue = (t, v) => (t.type === 'share' ? pct(v) : t.type === 'earn' ? money(v) : `${Math.min(v, t.target)}`);
const fmtTarget = t => (t.type === 'share' ? pct(t.target) : t.type === 'earn' ? money(t.target) : `${t.target}`);

// HUD: level badge + "Tâches 2/4" bar, pulsing when something can be claimed.
export function renderTasksHud() {
  const { cfg, st } = G;
  const p = levelProgress(cfg, st), up = canLevelUp(cfg, st);
  $('lvl-badge').textContent = `⭐ ${st.level}`;
  $('tasks-text').textContent = up ? 'Niveau suivant !' : `Tâches ${p.done}/${p.total}`;
  $('tasks-reward').textContent = p.ready ? `${p.ready} à valider` : '';
  $('goal-fill').style.width = (p.total ? p.done / p.total * 100 : 100) + '%';
  $('tasks-btn').classList.toggle('pulse', up || p.ready > 0);
  $('tasks-btn').classList.toggle('ready', up);
  if (!$('tasks').classList.contains('hidden')) renderPanel();
}

function renderPanel() {
  const { cfg, st } = G;
  $('tasks-title').textContent = `⭐ Niveau ${st.level}`;
  const rows = tasksOf(cfg, st.level).map(t => {
    const s = taskState(cfg, st, t);
    const frac = taskFrac(t, s);
    const btn = s.claimed ? '<span class="tk-done">✓</span>'
      : s.ready ? `<button class="btn small tk-claim" data-claim="${t.id}">Valider</button>`
      : `<button class="btn small" data-go="${t.id}">Aller</button>`;
    return `<div class="tk ${s.claimed ? 'claimed' : ''}">
      <div class="tk-main"><div class="tk-label">${taskLabel(t)}</div>
        <div class="tk-bar"><span style="width:${(frac * 100).toFixed(0)}%"></span></div>
        <div class="tk-meta"><span>${fmtValue(t, s.value)} / ${fmtTarget(t)}</span><span>🎁 ${money(t.reward)}</span></div></div>
      ${btn}</div>`;
  }).join('');
  const next = levelRow(cfg, st.level + 1);
  let foot = '';
  if (next) {
    const unlocks = unlockNames(cfg, next).map(d => `${d.icon} ${d.name}`).join(', ');
    foot = `<div class="tk-next">Niveau ${next.level} : 🎁 ${money(next.reward)}${unlocks ? ` · débloque ${unlocks}` : ''}</div>
      <button class="btn ${canLevelUp(cfg, st) ? 'primary' : 'disabled'}" id="tk-levelup" ${canLevelUp(cfg, st) ? '' : 'disabled'}>Niveau suivant</button>`;
  } else foot = '<div class="tk-next">Dernier niveau du prototype : vise les monopoles !</div>';
  const html = rows + '|' + foot;
  if ($('tasks-list').dataset.html === html) return;
  $('tasks-list').dataset.html = html;
  $('tasks-list').innerHTML = rows;
  $('tasks-foot').innerHTML = foot;
  $('tasks-list').querySelectorAll('[data-claim]').forEach(b => b.addEventListener('click', () => {
    const t = cfg.tasks.find(x => x.id === b.dataset.claim);
    if (claimTask(cfg, st, t)) { play('buy'); floatText(b, `+${money(t.reward)}`, 'gold'); G.onAction('task'); renderTasksHud(); renderPanel(); }
  }));
  $('tasks-list').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    closeTasks();
    G.goto(cfg.tasks.find(x => x.id === b.dataset.go));
  }));
  const up = $('tk-levelup');
  if (up) up.addEventListener('click', () => {
    const row = levelUp(cfg, st);
    if (!row) return;
    play('buy', 0.6);
    const unlocks = unlockNames(cfg, row).map(d => `${d.icon} ${d.name}`).join(', ');
    G.levelFlash(`⭐ NIVEAU ${row.level} !`);
    toast(`⭐ Niveau ${row.level} : +${money(row.reward)}${unlocks ? ` · nouveau : ${unlocks}` : ''}`);
    G.onAction('levelup');
    closeTasks();
  });
}
