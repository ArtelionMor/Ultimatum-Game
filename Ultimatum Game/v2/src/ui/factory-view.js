// Factory screen: a top-down grid, larger than the screen, where the player
// buys and places 2×2 machines and draws conveyor belts.
//
// Toolbar: one button per product (opens a menu: Production / Amélioration),
// then Outcome and Belt.
//
// Gestures
// - Machine tool: press where the machine goes, drag towards where its output
//   should face, release to build. Building on belts breaks them.
// - Belt tool: drag to draw belts (each points to the next); tap a belt to turn it.
// - Touch an existing machine: drag it to move it; or tap it to edit it — the
//   rest of the floor greys out and a widget above it offers upgrade / sell.
//   While editing: press elsewhere (+ drag for the direction) to move it there,
//   press on it and drag to turn it, tap it again (or ✕) to close.
// - ⬚ Selection tool: drag a rectangle to select machines + belts; then drag
//   inside the selection to move the whole block, or sell it from the widget.
// - Pan: one finger on empty floor with no tool, two fingers anytime,
//   right/middle mouse or wheel.

import { DIRS, ports, machineAt, beltAt, machineDef, placeCost, canPlaceMachine, canPlaceBelt,
  setBeltDir, setMachineRot, moveMachine, countOf, stageOf, tierOf, beltsUnder,
  selectRect, groupBox, groupMoveCheck, moveGroup } from '../grid.js';
import { buyMachine, buyBelt, sellMachine, sellValue, sellBelt, machineInfo, upgradeMachine, stockInfo, buyStock,
  expandInfo, buyExpand, sellGroup } from '../sim.js';
import { usableRecipes, applyRecipeAll, unseenRecipes, equipRecipe } from '../auction.js';
import { recipeOf } from '../grid.js';
import { recipeText } from './auction-view.js';
import { money, perMin, fmt, stars } from '../format.js';
import { floatText, retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const ARROWS = ['→', '↓', '←', '↑'];
// One colour per item stage: lemon, juice, bottle, orange, orange juice, strawberry, jam.
const STAGE_COLORS = ['#ffe14a', '#ffa53a', '#3ddc84', '#ff8a1f', '#ffc46b', '#ff4d6d', '#b5523b'];
const TIER_COLORS = [null, null, '#e6ecf5', '#ffcf4a', '#c58cff', '#ff5d8f'];   // ring per ★ (★1 has none)
const CELL = 34;
const SLOP = 6;            // px a finger may move before a tap becomes a drag

let G, canvas, ctx, bound = false;
let tool = null;           // null | machine id | 'belt'
let menuGroup = null;      // product whose Production / Amélioration menu is open
let lastRot = 0;           // direction used for the previous build
let cam = { x: 0, y: 0 }, viewW = 0, viewH = 0, camReady = false;
let edit = null;           // { kind: 'machine', m } | { kind: 'belt', x, y }
let press = null;          // gesture in progress (see onDown)
let ghost = null;          // { x, y, rot, ok, type, lvl } preview footprint
let pan = null;            // last pan anchor (screen px)
let group = null;          // { machines, belts } selected with the ⬚ tool
const pointers = new Map();
const flashUntil = new Map();

export function initFactory(game) {
  G = game;
  edit = null; press = null; ghost = null; tool = null; group = null; camReady = false;
  buildToolbar();
  if (bound) return;
  bound = true;
  canvas = $('floor');
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); press = null; ghost = null; pan = null; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); panBy(e.deltaX, e.deltaY); }, { passive: false });
  $('confirm-no').addEventListener('click', () => { $('confirm').classList.add('hidden'); renderFactory(); });
  requestAnimationFrame(draw);
}

// --- Toolbar ----------------------------------------------------------------

function buildToolbar() {
  const { cfg } = G;
  const groups = cfg.markets.map(r => `<button class="tool" data-group="${r.id}"><span class="ti">${r.icon}</span><small></small></button>`).join('');
  const singles = ['outcome', 'belt', 'select'].map(id => {
    const icon = id === 'belt' ? '⇉' : id === 'select' ? '⬚' : machineDef(cfg, id).icon;
    return `<button class="tool" data-tool="${id}"><span class="ti">${icon}</span><small></small></button>`;
  }).join('');
  const bar = $('toolbar');
  bar.innerHTML = groups + singles;
  bar.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.group;
    if (groupOf(tool) === g) { tool = null; menuGroup = null; }      // put the tool down
    else menuGroup = menuGroup === g ? null : g;
    edit = null;
    play('tick', 0.2);
    renderFactory();
  }));
  bar.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
    tool = tool === b.dataset.tool ? null : b.dataset.tool;
    menuGroup = null; edit = null; group = null;
    play('tick', 0.2);
    G.onAction('tool', tool);
    renderFactory();
  }));
}

// Machines unlock with the player level (st.unlocked[machine id]); a product
// shows up in the toolbar once one of its machines is unlocked.
const groupOf = id => (id && id !== 'belt' ? machineDef(G.cfg, id)?.group : null) || null;
const machineUnlocked = d => !!G.st.unlocked[d.id];
const groupUnlocked = g => G.cfg.machines.some(d => d.group === g && machineUnlocked(d));
const toolUnlocked = id => id === 'belt' || id === 'select' || machineUnlocked(machineDef(G.cfg, id));
export const currentTool = () => tool;
export function openToolMenu(group) { tool = null; edit = null; menuGroup = group; renderFactory(); }

const costLabel = c => (c === 0 ? 'Gratuit' : money(c));

export function renderFactory() {
  const { cfg, st } = G;
  document.querySelectorAll('#toolbar [data-group]').forEach(b => {
    const g = b.dataset.group, active = groupOf(tool) === g;
    const make = cfg.machines.find(d => d.group === g && d.kind === 'make');
    b.classList.toggle('hidden', !groupUnlocked(g));
    b.classList.toggle('active', active || menuGroup === g);
    b.classList.toggle('pulse', groupUnlocked(g) && !st.seen['tool_' + make.id]);
    b.querySelector('small').textContent = active
      ? (machineDef(cfg, tool).kind === 'refine' ? 'Amélioration' : 'Production')
      : costLabel(placeCost(cfg, st.grid, make.id));
  });
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => {
    const id = b.dataset.tool;
    b.classList.toggle('hidden', !toolUnlocked(id));
    b.classList.toggle('active', id === tool);
    if (id === 'select') { b.querySelector('small').textContent = 'Sélection'; return; }
    const c = placeCost(cfg, st.grid, id);
    b.querySelector('small').textContent = costLabel(c);
    b.classList.toggle('cant', st.money < c);
  });
  renderMenu();
  renderStock();
  renderWidget();
}

// Production / Amélioration choice under the product button.
function renderMenu() {
  const menu = $('tool-menu');
  if (!menuGroup || G.tab !== 'factory') { menu.classList.add('hidden'); return; }
  const { cfg, st } = G;
  const html = cfg.machines.filter(d => d.group === menuGroup).map(d => {
    const open = machineUnlocked(d), c = placeCost(cfg, st.grid, d.id);
    const what = d.kind === 'refine' ? `Amélioration · fusion ${d.merge_n} → ★+1` : 'Production';
    const lock = G.cfg.levels.find(l => (l.unlock || '').split(/\s+/).includes(d.id));
    return `<button class="tm-item ${open ? '' : 'locked'} ${st.money < c ? 'cant' : ''}" data-pick="${open ? d.id : ''}">
      <span class="tm-icon">${d.icon}</span><span class="tm-text"><b>${d.name}</b><small>${open ? what : `🔒 Niveau ${lock ? lock.level : '?'}`}</small></span>
      <span class="tm-cost">${open ? costLabel(c) : ''}</span></button>`;
  }).join('');
  if (menu.dataset.html !== html) {
    menu.innerHTML = html;
    menu.dataset.html = html;
    menu.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      if (!b.dataset.pick) return;
      tool = b.dataset.pick; menuGroup = null;
      play('tick', 0.25);
      G.onAction('tool', tool);
      renderFactory();
    }));
  }
  const btn = document.querySelector(`#toolbar [data-group="${menuGroup}"]`);
  menu.style.left = Math.max(0, btn.offsetLeft) + 'px';
  menu.classList.remove('hidden');
}

// One line: each item's stock + the shared "grow storage" button.
function renderStock() {
  const { cfg, st } = G;
  const sk = stockInfo(cfg, st);
  let anyFull = false;
  const chips = cfg.markets.filter(r => st.stats.delivered[r.id] > 0 || r.stage === 0).map(r => {
    const y = st.mk[r.id].you, full = y.stock >= y.stockCap - 1e-6;
    anyFull ||= full;
    return `<span class="schip ${full ? 'full' : ''}">${r.icon} ${fmt(Math.floor(y.stock))}/${fmt(y.stockCap)}</span>`;
  }).join('');
  if ($('stock-chips').dataset.html !== chips) { $('stock-chips').innerHTML = chips; $('stock-chips').dataset.html = chips; }
  const sb = $('stock-btn');
  sb.classList.toggle('hidden', !st.unlocked.stock);
  sb.classList.toggle('cant', !sk.affordable);
  sb.classList.toggle('reco', anyFull && sk.affordable);
  sb.classList.toggle('pulse', !!st.unlocked.stock && !st.seen.stock);
  sb.innerHTML = `📦 ${fmt(sk.nextCap)} · ${money(sk.cost)}`;
  // Buy more floor.
  const xb = $('expand-btn'), xi = expandInfo(cfg, st);
  xb.classList.toggle('hidden', xi.maxed);
  xb.classList.toggle('cant', !xi.affordable);
  xb.innerHTML = `🧱 +${xi.step} · ${money(xi.cost)}`;
  xb.title = `Agrandir l'usine : ${xi.cols}×${xi.rows} → ${xi.cols + xi.step}×${xi.rows + xi.step}`;
  if (!xb.dataset.bound) {
    xb.dataset.bound = 1;
    xb.addEventListener('click', () => {
      if (buyExpand(G.cfg, G.st)) { play('buy'); floatText(xb, `Usine ${G.st.grid.cols}×${G.st.grid.rows}`, 'gold'); G.onAction('expand'); }
      else floatText(xb, 'Pas assez d\'argent', 'bad');
    });
  }
  if (!sb.dataset.bound) {
    sb.dataset.bound = 1;
    sb.addEventListener('click', () => {
      if (buyStock(G.cfg, G.st)) {
        play('buy');
        floatText(sb, `Stock ${fmt(G.st.mk[G.cfg.markets[0].id].you.stockCap)}`, 'gold');
        G.onAction('stock');
      } else floatText(sb, 'Pas assez d\'argent', 'bad');
    });
  }
}

// --- Edit widget (floats above the edited machine / belt) ------------------------

const STATUS = {
  ok: '✅ Tourne',
  starved: '💤 Attend sa matière (entrée = triangle creux)',
  blocked: '⛔ Sortie bloquée (sortie = triangle plein) ou stock plein',
  wrong: '❌ Le mauvais produit arrive sur son entrée : vérifie tes tapis',
  idle: '…',
};

function renderWidget() {
  const w = $('edit-widget');
  // Hidden while the sell confirmation is open, so the dialog is the only thing to answer.
  if (G.tab !== 'factory' || !$('confirm').classList.contains('hidden') || (!edit && !group)) { w.classList.add('hidden'); return; }
  const { cfg, st } = G;
  let html;
  if (group) {
    const nm = group.machines.length, nb = group.belts.length;
    html = `<div class="ew-title">⬚ Sélection</div>
      <div class="ew-meta">${nm} machine${nm > 1 ? 's' : ''} · ${nb} tapis · glisse la sélection pour la déplacer</div>
      <div class="ew-btns"><button class="btn small danger" data-act="gsell">Vendre</button><button class="btn small" data-act="gclose">✕</button></div>`;
    if (w.dataset.html !== html) {
      w.innerHTML = html; w.dataset.html = html;
      w.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => onGroupWidget(b.dataset.act)));
    }
    w.classList.remove('hidden');
    placeWidget();
    return;
  }
  if (edit.kind === 'belt') {
    if (!beltAt(st.grid, edit.x, edit.y)) { edit = null; w.classList.add('hidden'); return; }
    html = `<div class="ew-title">⇉ Tapis</div>
      <div class="ew-btns"><button class="btn small" data-act="rot">⟳</button><button class="btn small danger" data-act="sell">Vendre</button><button class="btn small" data-act="close">✕</button></div>`;
  } else {
    const m = edit.m, d = machineDef(cfg, m.type);
    if (d.sink) {
      html = `<div class="ew-title">📤 Outcome</div><div class="ew-meta">Glisse-le ailleurs pour le déplacer</div>
        <div class="ew-btns">${countOf(st.grid, 'outcome') > 1 ? '<button class="btn small danger" data-act="sell">Vendre</button>' : ''}<button class="btn small" data-act="close">✕</button></div>`;
    } else {
      const info = machineInfo(cfg, st, m);
      const r = cfg.markets.find(x => x.stage === d.output_stage);
      const counts = {};
      for (const it of m.buf) counts[tierOf(it)] = (counts[tierOf(it)] || 0) + 1;
      const inside = Object.keys(counts).map(t => `★${t}×${counts[t]}`).join(' ') || 'vide';
      const meta = d.kind === 'refine'
        ? `Fusionne ${d.merge_n} ${r.icon} de même ★ en 1 ★ supérieur · ${perMin(info.rate)} · contient ${inside}`
        : `${perMin(info.rate)} · ${STATUS[m.status]}`;
      const rec = recipeOf(cfg, m), usable = usableRecipes(cfg, st, m.type);
      html = `<div class="ew-title">${d.icon} ${d.name} <span class="muted">Niv. ${m.lvl}</span></div>
        <div class="ew-meta">${meta}</div>
        <div class="ew-recipe">📜 ${rec.name} · ${recipeText(cfg, rec)}${usable.length > 1
          ? ` <button class="btn small ${!m.recipe && unseenRecipes(cfg, st).some(r => r.machine === m.type) ? 'red-dot' : ''}" data-act="recipe">⇄</button>
             <button class="btn small" data-act="recipeAll">Pour toutes</button>` : ''}</div>
        <div class="ew-btns">
          <button class="btn small up-mini ${info.affordable ? '' : 'cant'}" data-act="up">⬆ ${perMin(info.nextRate)} · ${money(info.cost)}</button>
          <button class="btn small danger" data-act="sell">Vendre</button>
          <button class="btn small" data-act="close">✕</button>
        </div>`;
    }
  }
  if (w.dataset.html !== html) {
    w.innerHTML = html;
    w.dataset.html = html;
    w.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => onWidget(b.dataset.act, b)));
  }
  w.classList.remove('hidden');
  placeWidget();
}

// Keep the widget above its target (below it near the top edge).
function placeWidget() {
  const w = $('edit-widget');
  if ((!edit && !group) || w.classList.contains('hidden')) return;
  const a = $('app').getBoundingClientRect(), r = canvas.getBoundingClientRect();
  let cx, top, bottom;
  if (group) {
    const bx = groupBox(group);
    cx = (bx.x0 + bx.x1 + 1) / 2 * CELL; top = bx.y0 * CELL; bottom = (bx.y1 + 1) * CELL;
  } else {
    cx = edit.kind === 'belt' ? (edit.x + 0.5) * CELL : (edit.m.x + 1) * CELL;
    top = edit.kind === 'belt' ? edit.y * CELL : edit.m.y * CELL;
    bottom = top + (edit.kind === 'belt' ? 1 : 2) * CELL;
  }
  const sx = r.left - a.left + cx - cam.x;
  let sy = r.top - a.top + top - cam.y - w.offsetHeight - 8;
  if (sy < r.top - a.top) sy = r.top - a.top + bottom - cam.y + 8;
  const half = w.offsetWidth / 2;
  w.style.left = Math.max(8, Math.min(a.width - w.offsetWidth - 8, sx - half)) + 'px';
  w.style.top = sy + 'px';
}

function onWidget(act, btn) {
  const { cfg, st } = G;
  if (act === 'close') { edit = null; renderFactory(); return; }
  if (edit.kind === 'belt') {
    if (act === 'rot') {
      const b = beltAt(st.grid, edit.x, edit.y);
      if (b) setBeltDir(st.grid, edit.x, edit.y, (b.dir + 1) % 4);
      play('tick', 0.3);
    } else if (act === 'sell') { sellBelt(cfg, st, edit.x, edit.y); edit = null; G.onAction('sell'); }
    renderFactory();
    return;
  }
  const m = edit.m;
  if (act === 'up') {
    if (upgradeMachine(cfg, st, m)) {
      play('buy');
      flashUntil.set(m, performance.now() + 600);
      floatText(btn, perMin(machineInfo(cfg, st, m).rate), 'gold');
      G.onAction('upgrade');
    } else floatText(btn, 'Pas assez d\'argent', 'bad');
  } else if (act === 'sell') confirmSell(m);
  else if (act === 'recipeAll') {
    // Give every machine of this type the recipe this one runs.
    const n = applyRecipeAll(cfg, st, m.type, m.recipe);
    play('buy', 0.4);
    floatText(btn, `${n} autre${n > 1 ? 's' : ''} → ${recipeOf(cfg, m).name}`, 'gold');
    G.onAction('recipe');
  }
  else if (act === 'recipe') {
    // Next recipe this machine can run (base + the player's alternates).
    const list = usableRecipes(cfg, st, m.type), cur = recipeOf(cfg, m);
    const next = list[(list.findIndex(r => r.id === cur.id) + 1) % list.length];
    m.recipe = next.base ? null : next.id;
    equipRecipe(st, m.type, m.recipe);   // next machines of this type start with it
    m.buf = [];   // ingredients of the old recipe are lost
    play('tick', 0.3);
    floatText(btn, next.name, 'gold');
  }
  renderFactory();
}

function onGroupWidget(act) {
  if (act === 'gclose') { group = null; renderFactory(); return; }
  const { cfg, st } = G, sel = group;
  const nm = sel.machines.length, nb = sel.belts.length;
  $('confirm-text').textContent = `Vendre la sélection (${nm} machine${nm > 1 ? 's' : ''}, ${nb} tapis) ?`;
  $('confirm').classList.remove('hidden');
  renderWidget();
  $('confirm-yes').onclick = () => {
    $('confirm').classList.add('hidden');
    const got = sellGroup(cfg, st, sel);
    floatText($('money'), `+${money(got)}`, 'gold'); play('tick', 0.4);
    group = null;
    G.onAction('sell');
    renderFactory();
  };
}

function confirmSell(m) {
  const { cfg, st } = G, d = machineDef(cfg, m.type);
  const back = sellValue(cfg, st, m);
  $('confirm-text').textContent = `Vendre ${d.icon} ${d.name}${d.sink ? '' : ` (niv. ${m.lvl})`} ? Tu récupères ${money(back)}.`;
  $('confirm').classList.remove('hidden');
  renderWidget();
  $('confirm-yes').onclick = () => {
    $('confirm').classList.add('hidden');
    const got = sellMachine(cfg, st, m);
    if (got >= 0) { floatText($('money'), `+${money(got)}`, 'gold'); play('tick', 0.4); }
    edit = null;
    G.onAction('sell');
    renderFactory();
  };
}

// --- Camera -------------------------------------------------------------------

function clampCam() {
  const g = G.st.grid;
  cam.x = Math.max(0, Math.min(Math.max(0, g.cols * CELL - viewW), cam.x));
  cam.y = Math.max(0, Math.min(Math.max(0, g.rows * CELL - viewH), cam.y));
}
function panBy(dx, dy) { cam.x += dx; cam.y += dy; clampCam(); placeWidget(); }
function centerOn(m) {
  cam.x = (m.x + 1) * CELL - viewW / 2;
  cam.y = (m.y + 1) * CELL - viewH / 2;
  clampCam();
}

// --- Pointer input --------------------------------------------------------------

function toCell(e) {
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left + cam.x) / CELL, fy = (e.clientY - r.top + cam.y) / CELL;
  return { fx, fy, x: Math.floor(fx), y: Math.floor(fy) };
}

// 2×2 footprint centred on the finger.
function footprintAt(p) {
  const { cols, rows } = G.st.grid;
  return {
    x: Math.max(0, Math.min(cols - 2, Math.round(p.fx - 1))),
    y: Math.max(0, Math.min(rows - 2, Math.round(p.fy - 1))),
  };
}

// Direction from the footprint centre to the finger; `fallback` while the
// finger is still on the machine.
function dirTowards(g, p, fallback) {
  const dx = p.fx - (g.x + 1), dy = p.fy - (g.y + 1);
  if (Math.hypot(dx, dy) < 1.1) return fallback;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
}

function makeGhost(x, y, rot, type, lvl, ignore) {
  return { x, y, rot, type, lvl, ok: canPlaceMachine(G.st.grid, x, y, ignore) };
}

const midpoint = () => {
  const ps = [...pointers.values()];
  return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length };
};

function onDown(e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || pointers.size >= 2) {
    // Second finger or right/middle mouse: pan, and drop the gesture in progress.
    press = null; ghost = null;
    pan = midpoint();
    return;
  }
  if (menuGroup) { menuGroup = null; renderFactory(); }
  const p = toCell(e), grid = G.st.grid;
  const m = machineAt(grid, p.x, p.y);
  const sx = e.clientX, sy = e.clientY;

  // A selection is active: press inside it to drag the block, elsewhere to drop it.
  if (group) {
    const bx = groupBox(group);
    if (p.x >= bx.x0 && p.x <= bx.x1 && p.y >= bx.y0 && p.y <= bx.y1) {
      press = { mode: 'gmove', start: p, d: { dx: 0, dy: 0 }, ok: true, sx, sy };
      return;
    }
    group = null; renderFactory();
    if (tool !== 'select') { press = { mode: 'empty', cell: p, sx, sy }; return; }
  }
  if (tool === 'select') { edit = null; press = { mode: 'rect', a: p, b: p, sx, sy }; return; }

  if (edit?.kind === 'machine') {
    const em = edit.m;
    if (m === em) {
      // On the edited machine: drag to turn it, tap to close.
      press = { mode: 'turn', m: em, sx, sy };
      ghost = makeGhost(em.x, em.y, em.rot, em.type, em.lvl, em);
    } else if (m) {
      edit = { kind: 'machine', m };
      press = { mode: 'tap', sx, sy };
    } else {
      // Elsewhere: that's where it goes; drag for the direction.
      const f = footprintAt(p);
      press = { mode: 'move', m: em, sx, sy };
      ghost = makeGhost(f.x, f.y, em.rot, em.type, em.lvl, em);
    }
    renderFactory();
    return;
  }
  if (m) {
    // Touch a machine: drag it to move it, or tap to edit it.
    press = { mode: 'grab', m, sx, sy };
    return;
  }
  if (tool === 'belt') {
    const existing = beltAt(grid, p.x, p.y);
    press = { mode: 'belt', last: [p.x, p.y], moved: false, startedOn: !!existing, sx, sy };
    if (!existing) tryBelt(p.x, p.y, lastRot, e);
  } else if (tool) {
    const f = footprintAt(p);
    press = { mode: 'place', sx, sy };
    ghost = makeGhost(f.x, f.y, lastRot, tool, 1, null);
  } else {
    press = { mode: beltAt(grid, p.x, p.y) ? 'beltTap' : 'empty', cell: p, sx, sy };
  }
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pan) {
    const mp = midpoint();
    panBy(pan.x - mp.x, pan.y - mp.y);
    pan = mp;
    return;
  }
  if (!press) return;
  const far = Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > SLOP;
  const p = toCell(e);
  switch (press.mode) {
    case 'empty':
    case 'beltTap':
      if (far) { pan = { x: press.sx, y: press.sy }; press = null; onMove(e); }
      break;
    case 'grab': {
      const m = press.m;
      const inside = p.x >= m.x && p.x < m.x + 2 && p.y >= m.y && p.y < m.y + 2;
      if (far && !inside) { press = { mode: 'drag', m, sx: press.sx, sy: press.sy }; edit = null; renderFactory(); }
      break;
    }
    case 'drag': {
      const f = footprintAt(p);
      ghost = makeGhost(f.x, f.y, press.m.rot, press.m.type, press.m.lvl, press.m);
      break;
    }
    case 'place':
    case 'move':
    case 'turn':
      ghost = { ...ghost, rot: dirTowards(ghost, p, press.mode === 'place' ? lastRot : press.m.rot) };
      if (press.mode === 'turn' && far) press.turned = true;
      break;
    case 'belt':
      drawBelt(p, e);
      break;
    case 'rect':
      press.b = p;
      break;
    case 'gmove': {
      const d = { dx: p.x - press.start.x, dy: p.y - press.start.y };
      if (d.dx !== press.d.dx || d.dy !== press.d.dy) { press.d = d; press.ok = groupMoveCheck(G.st.grid, group, d.dx, d.dy).ok; }
      break;
    }
  }
}

function drawBelt(p, e) {
  const [lx, ly] = press.last;
  if (p.x === lx && p.y === ly) return;
  // Walk one cell at a time towards the finger so fast swipes leave no holes;
  // each belt points to the next one.
  let cx = lx, cy = ly;
  while (cx !== p.x || cy !== p.y) {
    const step = Math.abs(p.x - cx) >= Math.abs(p.y - cy) ? [Math.sign(p.x - cx), 0] : [0, Math.sign(p.y - cy)];
    const dir = DIRS.findIndex(d => d[0] === step[0] && d[1] === step[1]);
    setBeltDir(G.st.grid, cx, cy, dir);
    const nx = cx + step[0], ny = cy + step[1];
    if (!beltAt(G.st.grid, nx, ny) && !tryBelt(nx, ny, dir, e)) break;
    setBeltDir(G.st.grid, nx, ny, dir);
    cx = nx; cy = ny;
    lastRot = dir;
  }
  press.last = [cx, cy];
  press.moved = true;
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (pan) { pan = pointers.size ? midpoint() : null; return; }
  const pr = press, g = ghost;
  press = null; ghost = null;
  if (!pr) return;
  const grid = G.st.grid;
  switch (pr.mode) {
    case 'empty': edit = null; break;
    case 'beltTap': { const c = pr.cell; edit = { kind: 'belt', x: c.x, y: c.y }; break; }
    case 'tap': break;
    case 'grab': edit = { kind: 'machine', m: pr.m }; play('tick', 0.2); break;
    case 'drag': {
      const broken = g ? moveMachine(grid, pr.m, g.x, g.y) : -1;
      if (broken >= 0) { dropped(pr.m); if (broken) floatAt(e, `🔨 ${broken} tapis`, 'gold'); }
      else floatAt(e, 'Place occupée', 'bad');
      break;
    }
    case 'turn':
      if (pr.turned && g) { setMachineRot(grid, pr.m, g.rot); flashUntil.set(pr.m, performance.now() + 400); play('tick', 0.3); }
      else edit = null;   // tap on the edited machine closes the editor
      break;
    case 'move':
      if (g && g.ok && moveMachine(grid, pr.m, g.x, g.y) >= 0) { setMachineRot(grid, pr.m, g.rot); dropped(pr.m); edit = null; }
      else floatAt(e, 'Place occupée', 'bad');
      break;
    case 'place': {
      const r = g ? buyMachine(G.cfg, G.st, tool, g.x, g.y, g.rot) : { ok: false, why: 'place' };
      if (r.ok) {
        lastRot = g.rot;
        play('buy');
        flashUntil.set(machineAt(grid, g.x, g.y), performance.now() + 600);
        floatAt(e, (r.cost ? `-${money(r.cost)}` : 'Gratuit !') + (r.broken ? ` · 🔨 ${r.broken} tapis` : ''), r.cost ? 'bad' : 'gold');
        G.st.seen['tool_' + tool] = true;
        G.onAction('build', tool);
      } else floatAt(e, r.why === 'money' ? 'Pas assez d\'argent' : 'Place occupée', 'bad');
      break;
    }
    case 'rect': {
      const x0 = Math.min(pr.a.x, pr.b.x), x1 = Math.max(pr.a.x, pr.b.x), y0 = Math.min(pr.a.y, pr.b.y), y1 = Math.max(pr.a.y, pr.b.y);
      const sel = selectRect(grid, x0, y0, x1, y1);
      if (sel.machines.length || sel.belts.length) { group = sel; play('tick', 0.3); }
      else floatAt(e, 'Rien à sélectionner ici', 'bad');
      break;
    }
    case 'gmove': {
      const { dx, dy } = pr.d;
      if (!dx && !dy) break;
      const broken = moveGroup(grid, group, dx, dy);
      if (broken >= 0) {
        play('buy', 0.3);
        for (const m of group.machines) flashUntil.set(m, performance.now() + 500);
        if (broken) floatAt(e, `🔨 ${broken} tapis`, 'gold');
        G.onAction('move');
      } else floatAt(e, 'Place occupée', 'bad');
      break;
    }
    case 'belt':
      // A tap on an existing belt turns it.
      if (!pr.moved && pr.startedOn) {
        const p = toCell(e), b = beltAt(grid, p.x, p.y);
        if (b) { setBeltDir(grid, p.x, p.y, (b.dir + 1) % 4); play('tick', 0.3); }
      }
      G.onAction('build', 'belt');
      break;
  }
  renderFactory();
}

function dropped(m) {
  play('buy', 0.3);
  flashUntil.set(m, performance.now() + 500);
  G.onAction('move');
}

function tryBelt(x, y, dir, e) {
  if (!canPlaceBelt(G.st.grid, x, y)) return false;
  const r = buyBelt(G.cfg, G.st, x, y, dir);
  if (!r.ok) { if (r.why === 'money') floatAt(e, 'Pas assez d\'argent', 'bad'); return false; }
  play('tick', 0.15);
  return true;
}

function floatAt(e, text, cls) {
  const a = $('app').getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'float ' + cls;
  d.textContent = text;
  d.style.left = (e.clientX - a.left) + 'px';
  d.style.top = (e.clientY - a.top - 20) + 'px';
  $('fx').appendChild(d);
  setTimeout(() => d.remove(), 1150);
}

// --- Canvas -------------------------------------------------------------------

function draw(now) {
  requestAnimationFrame(draw);
  if (!G || G.tab !== 'factory' || !canvas.offsetParent) return;
  const { cfg, st } = G;
  const grid = st.grid;
  const dpr = window.devicePixelRatio || 1;
  // The view fills the space left between the toolbar and the tabs.
  const main = canvas.closest('main');
  viewW = canvas.parentElement.clientWidth;
  // Measured on screen: from the canvas top to the bottom of <main>, minus the stock row and main's padding.
  const room = main.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top + main.scrollTop;
  viewH = Math.max(200, Math.floor(room - $('stock-row').offsetHeight - 26));
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
  if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(viewH * dpr)) { canvas.width = Math.round(viewW * dpr); canvas.height = Math.round(viewH * dpr); }
  if (!camReady) { centerOn(grid.machines.find(m => machineDef(cfg, m.type).sink) || { x: 0, y: 0 }); camReady = true; }
  clampCam();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#12151c';
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.translate(-Math.round(cam.x), -Math.round(cam.y));
  const c = CELL;

  // floor (only visible cells)
  const x0 = Math.max(0, Math.floor(cam.x / c)), y0 = Math.max(0, Math.floor(cam.y / c));
  const x1 = Math.min(grid.cols, Math.ceil((cam.x + viewW) / c)), y1 = Math.min(grid.rows, Math.ceil((cam.y + viewH) / c));
  ctx.fillStyle = '#1a1e27';
  ctx.fillRect(0, 0, grid.cols * c, grid.rows * c);
  ctx.fillStyle = '#1e232d';
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) if ((x + y) % 2) ctx.fillRect(x * c, y * c, c, c);
  ctx.strokeStyle = '#3a4152'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, grid.cols * c - 2, grid.rows * c - 2);

  // belts + items
  const t = now / 1000;
  for (const k in grid.belts) {
    const [x, y] = k.split(',').map(Number);
    if (x < x0 - 1 || x > x1 || y < y0 - 1 || y > y1) continue;
    drawBelt2(x, y, grid.belts[k], t);
  }
  for (const k in grid.belts) {
    const b = grid.belts[k];
    if (b.item === null) continue;
    const [x, y] = k.split(',').map(Number), [dx, dy] = DIRS[b.dir];
    drawItem(x * c + c / 2 + dx * (b.p - 0.5) * c, y * c + c / 2 + dy * (b.p - 0.5) * c, b.item);
  }

  const moving = press && (press.mode === 'drag' || press.mode === 'move' || press.mode === 'turn') ? press.m : null;
  for (const m of grid.machines) if (m !== moving) drawMachine(m, now);

  // Edit mode: grey everything but the edited thing.
  if (edit || moving) {
    ctx.fillStyle = 'rgba(8,10,14,.62)';
    ctx.fillRect(0, 0, grid.cols * c, grid.rows * c);
    if (edit?.kind === 'machine' && edit.m !== moving) { drawMachine(edit.m, now); outline(edit.m.x * c, edit.m.y * c, 2 * c, 2 * c, '#5aa9ff'); }
    if (edit?.kind === 'belt') { const b = beltAt(grid, edit.x, edit.y); if (b) drawBelt2(edit.x, edit.y, b, t); outline(edit.x * c, edit.y * c, c, c, '#5aa9ff'); }
  }
  if (moving && !ghost) drawMachine(moving, now);

  // ⬚ rectangle being drawn
  if (press?.mode === 'rect') {
    const x0 = Math.min(press.a.x, press.b.x), x1 = Math.max(press.a.x, press.b.x), y0 = Math.min(press.a.y, press.b.y), y1 = Math.max(press.a.y, press.b.y);
    ctx.fillStyle = 'rgba(90,169,255,.18)';
    ctx.fillRect(x0 * c, y0 * c, (x1 - x0 + 1) * c, (y1 - y0 + 1) * c);
    outline(x0 * c, y0 * c, (x1 - x0 + 1) * c, (y1 - y0 + 1) * c, '#5aa9ff');
  }
  // Selected block: everything else greys out; while dragging it follows the finger.
  if (group) {
    ctx.fillStyle = 'rgba(8,10,14,.62)';
    ctx.fillRect(0, 0, grid.cols * c, grid.rows * c);
    const d = press?.mode === 'gmove' ? press.d : { dx: 0, dy: 0 };
    ctx.save();
    ctx.translate(d.dx * c, d.dy * c);
    if (d.dx || d.dy) ctx.globalAlpha = 0.85;
    for (const k of group.belts) {
      const b = grid.belts[k]; if (!b) continue;
      const [x, y] = k.split(',').map(Number);
      drawBelt2(x, y, b, t);
      if (b.item !== null) { const [ddx, ddy] = DIRS[b.dir]; drawItem(x * c + c / 2 + ddx * (b.p - 0.5) * c, y * c + c / 2 + ddy * (b.p - 0.5) * c, b.item); }
    }
    for (const m of group.machines) drawMachine(m, now);
    const bx = groupBox(group);
    outline(bx.x0 * c - 2, bx.y0 * c - 2, (bx.x1 - bx.x0 + 1) * c + 4, (bx.y1 - bx.y0 + 1) * c + 4, press?.mode === 'gmove' && !press.ok ? '#ff5d5d' : '#5aa9ff');
    ctx.restore();
  }

  if (ghost) {
    ctx.globalAlpha = 0.75;
    drawMachine({ type: ghost.type, x: ghost.x, y: ghost.y, rot: ghost.rot, lvl: ghost.lvl, prog: 0, status: 'ok', out: null }, now);
    ctx.globalAlpha = 1;
    outline(ghost.x * c, ghost.y * c, c * 2, c * 2, ghost.ok ? '#3ddc84' : '#ff5d5d');
    // belts that building here will break
    ctx.strokeStyle = '#ff9c5d'; ctx.lineWidth = 2;
    for (const [bx, by] of beltsUnder(grid, ghost.x, ghost.y)) {
      ctx.beginPath(); ctx.moveTo(bx * c + 8, by * c + 8); ctx.lineTo(bx * c + c - 8, by * c + c - 8);
      ctx.moveTo(bx * c + c - 8, by * c + 8); ctx.lineTo(bx * c + 8, by * c + c - 8); ctx.stroke();
    }
    // big arrow showing where the output will face
    if (!machineDef(cfg, ghost.type).sink) {
      const [dx, dy] = DIRS[ghost.rot];
      ctx.save();
      ctx.translate((ghost.x + 1) * c + dx * c * 1.45, (ghost.y + 1) * c + dy * c * 1.45);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = '#3ddc84';
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -10); ctx.lineTo(-6, 10); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  placeWidget();
}

function drawBelt2(x, y, b, t) {
  const c = CELL;
  ctx.fillStyle = '#2f3542';
  ctx.fillRect(x * c + 2, y * c + 2, c - 4, c - 4);
  ctx.save();
  ctx.translate(x * c + c / 2, y * c + c / 2);
  ctx.rotate(b.dir * Math.PI / 2);
  ctx.strokeStyle = '#4f586d';
  ctx.lineWidth = 2;
  const off = (t * G.cfg.grid.belt_speed * c * 0.5) % (c / 2);
  for (let i = -1; i < 2; i++) {
    const sx = -c / 4 + off + i * c / 2;
    if (sx < -c / 2 + 3 || sx > c / 2 - 8) continue;
    ctx.beginPath(); ctx.moveTo(sx, -c / 4); ctx.lineTo(sx + 5, 0); ctx.lineTo(sx, c / 4); ctx.stroke();
  }
  ctx.restore();
}

function drawMachine(m, now) {
  const { cfg, st } = G;
  const c = CELL, x = m.x * c, y = m.y * c, s = c * 2;
  const d = machineDef(cfg, m.type);
  const flashing = (flashUntil.get(m) || 0) > now;
  ctx.fillStyle = flashing ? '#3d6b4d' : d.color;
  roundRect(x + 3, y + 3, s - 6, s - 6, 9); ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  roundRect(x + 3, y + 3, s - 6, s - 6, 9); ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(c * 0.8)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.fillStyle = '#fff';
  if (d.sink) {
    ctx.fillText(d.icon, x + s / 2, y + s / 2 - 7);
    // one mini gauge per item
    const n = cfg.markets.length, bw = (s - 16) / n;
    cfg.markets.forEach((r, i) => {
      const you = st.mk[r.id].you, fill = Math.min(1, you.stock / you.stockCap);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.fillRect(x + 8 + i * bw + 1, y + s - 16, bw - 2, 8);
      ctx.fillStyle = fill >= 0.999 ? '#ff5d5d' : STAGE_COLORS[r.stage];
      ctx.fillRect(x + 8 + i * bw + 1, y + s - 16, (bw - 2) * fill, 8);
    });
    return;
  }
  const bob = m.status === 'ok' ? Math.sin(now / 140 + m.x) * 1.2 : 0;
  ctx.fillText(d.icon, x + s / 2, y + s / 2 + bob - 3);
  // level bubble + progress bar
  const br = c * 0.27;
  ctx.fillStyle = '#10131a';
  ctx.beginPath(); ctx.arc(x + 4 + br, y + 4 + br, br, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke();
  ctx.font = `bold ${Math.round(c * 0.3)}px system-ui, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(`${m.lvl}`, x + 4 + br, y + 4 + br + 0.5);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(x + 8, y + s - 11, s - 16, 4);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(x + 8, y + s - 11, (s - 16) * Math.min(1, m.prog), 4);
  if (m.status === 'starved' || m.status === 'blocked' || m.status === 'wrong') {
    ctx.font = `${Math.round(c * 0.42)}px system-ui, "Segoe UI Emoji", sans-serif`;
    ctx.fillText(m.status === 'starved' ? '💤' : m.status === 'wrong' ? '❌' : '⛔', x + s - c * 0.42, y + c * 0.42);
  }
  // Ports, coloured like the item that goes in / comes out:
  // input = hollow triangle pointing into the machine, output = filled triangle pointing out.
  const p = ports(m), [dx, dy] = DIRS[m.rot];
  if (d.input_stage !== null) portArrow(p.inCell, dx, dy, STAGE_COLORS[d.input_stage], false);
  if (d.output_stage !== null) portArrow(p.outCell, dx, dy, STAGE_COLORS[d.output_stage], true);
  // Red dot: an owned alternate recipe could run here.
  if (!m.recipe && m.id !== undefined && G.st.auc && idleFor(m.type)) {
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath(); ctx.arc(x + s - 7, y + s - 16, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  if (m.out?.length) drawItem(p.outCell[0] * c + c / 2 + dx * c * 0.2, p.outCell[1] * c + c / 2 + dy * c * 0.2, m.out[0]);
}

let idleCache = { t: -1, types: new Set() };
const idleFor = type => {
  if (idleCache.t !== G.st.t) idleCache = { t: G.st.t, types: new Set(unseenRecipes(G.cfg, G.st).map(r => r.machine)) };
  return idleCache.types.has(type);
};

// Triangle on the machine edge of cell `cl`, pointing along the flow: filled
// (output, on the far edge) or hollow (input, on the near edge).
function portArrow(cl, dx, dy, color, out) {
  const side = out ? 1 : -1;
  const cx = cl[0] * CELL + CELL / 2 + dx * (CELL / 2 - 6) * side;
  const cy = cl[1] * CELL + CELL / 2 + dy * (CELL / 2 - 6) * side;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(Math.atan2(dy, dx));
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-5, -7.5); ctx.lineTo(-5, 7.5); ctx.closePath();
  ctx.lineJoin = 'round';
  if (out) {
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
  }
  ctx.restore();
}

// Colour = item; ring colour = quality (★2 silver, ★3 gold, ★4 purple, ★5 pink).
function drawItem(x, y, it) {
  const stage = stageOf(it), ring = TIER_COLORS[tierOf(it)];
  ctx.fillStyle = STAGE_COLORS[stage];
  if (stage === 2 || stage === 6) roundRect(x - 4, y - 7, 8, 14, 3);
  else { ctx.beginPath(); ctx.arc(x, y, stage === 0 ? 6 : 5.5, 0, Math.PI * 2); }
  ctx.fill();
  if (ring) { ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke(); }
  if (stage === 2 || stage === 6) { ctx.fillStyle = '#d9ffe8'; ctx.fillRect(x - 2, y - 10, 4, 4); }
}

function outline(x, y, w, h, color) {
  ctx.lineWidth = 2; ctx.strokeStyle = color;
  roundRect(x + 1, y + 1, w - 2, h - 2, 8); ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
