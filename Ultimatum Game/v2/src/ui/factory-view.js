// Factory screen: a top-down grid, larger than the screen, where the player
// buys and places 2×2 machines and draws conveyor belts.
//
// Gestures
// - Machine tool: press where the machine goes, drag towards where its output
//   should face, release to build.
// - Belt tool: drag to draw belts (each points to the next); tap a belt to turn it.
// - Touch an existing machine: drag it to move it; or tap it to edit it — the
//   rest of the floor greys out and a widget above it offers upgrade / sell.
//   While editing: press elsewhere (+ drag for the direction) to move it there,
//   press on it and drag to turn it, tap it again (or ✕) to close.
// - Pan: one finger on empty floor with no tool, two fingers anytime,
//   right/middle mouse or wheel.

import { DIRS, ports, machineAt, beltAt, machineDef, placeCost, canPlaceMachine, canPlaceBelt,
  setBeltDir, setMachineRot, moveMachine, countOf } from '../grid.js';
import { buyMachine, buyBelt, sellMachine, sellValue, sellBelt, machineInfo, upgradeMachine, stockInfo, buyStock } from '../sim.js';
import { money, perMin, fmt, stars } from '../format.js';
import { floatText, retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const ARROWS = ['→', '↓', '←', '↑'];
const STAGE_COLORS = ['#ffe14a', '#ffa53a', '#3ddc84'];
const CELL = 34;
const SLOP = 6;            // px a finger may move before a tap becomes a drag

let G, canvas, ctx, bound = false;
let tool = null;           // null | machine id | 'belt'
let lastRot = 0;           // direction used for the previous build
let cam = { x: 0, y: 0 }, viewW = 0, viewH = 0, camReady = false;
let edit = null;           // { kind: 'machine', m } | { kind: 'belt', x, y }
let press = null;          // gesture in progress (see onDown)
let ghost = null;          // { x, y, rot, ok, type, lvl } preview footprint
let pan = null;            // last pan anchor (screen px)
const pointers = new Map();
const flashUntil = new Map();

export function initFactory(game) {
  G = game;
  edit = null; press = null; ghost = null; tool = null; camReady = false;
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

// --- Toolbar (tap the active tool again to put it down) -------------------------

function buildToolbar() {
  const tools = [...G.cfg.machines.map(m => ({ id: m.id, icon: m.icon })), { id: 'belt', icon: '⇉' }];
  const bar = $('toolbar');
  bar.innerHTML = tools.map(t => `<button class="tool" data-tool="${t.id}"><span class="ti">${t.icon}</span><small></small></button>`).join('');
  bar.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
    tool = tool === b.dataset.tool ? null : b.dataset.tool;
    edit = null;
    play('tick', 0.2);
    G.onAction('tool', tool);
    renderFactory();
  }));
}

const toolUnlocked = id => id === 'belt' || id === 'harvest' || !!G.st.unlocked[id];
export const currentTool = () => tool;

export function renderFactory() {
  const { cfg, st } = G;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => {
    const id = b.dataset.tool;
    b.classList.toggle('hidden', !toolUnlocked(id));
    b.classList.toggle('active', id === tool);
    b.classList.toggle('pulse', toolUnlocked(id) && id !== 'belt' && !st.seen['tool_' + id]);
    const c = placeCost(cfg, st.grid, id);
    b.querySelector('small').textContent = c === 0 ? 'Gratuit' : money(c);
    b.classList.toggle('cant', st.money < c);
  });
  renderStock();
  renderWidget();
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
  starved: '💤 Attend sa matière (flèche orange)',
  blocked: '⛔ Sortie bloquée (flèche verte) ou stock plein',
  idle: '…',
};

function renderWidget() {
  const w = $('edit-widget');
  // Hidden while the sell confirmation is open, so the dialog is the only thing to answer.
  if (!edit || G.tab !== 'factory' || !$('confirm').classList.contains('hidden')) { w.classList.add('hidden'); return; }
  const { cfg, st } = G;
  let html;
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
      const q = cfg.markets.find(r => r.stage === d.output_stage);
      html = `<div class="ew-title">${d.icon} ${d.name} <span class="muted">Niv. ${m.lvl}</span></div>
        <div class="ew-meta">${perMin(info.rate)} · ${q.icon} ${stars(st.mk[q.id].you.quality)} · ${STATUS[m.status]}</div>
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
  if (!edit || w.classList.contains('hidden')) return;
  const a = $('app').getBoundingClientRect(), r = canvas.getBoundingClientRect();
  const cx = edit.kind === 'belt' ? (edit.x + 0.5) * CELL : (edit.m.x + 1) * CELL;
  const top = edit.kind === 'belt' ? edit.y * CELL : edit.m.y * CELL;
  const bottom = top + (edit.kind === 'belt' ? 1 : 2) * CELL;
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
  renderFactory();
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
  const p = toCell(e), grid = G.st.grid;
  const m = machineAt(grid, p.x, p.y);
  const sx = e.clientX, sy = e.clientY;

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
    case 'drag':
      if (g && moveMachine(grid, pr.m, g.x, g.y)) { dropped(pr.m); }
      else floatAt(e, 'Place occupée', 'bad');
      break;
    case 'turn':
      if (pr.turned && g) { setMachineRot(grid, pr.m, g.rot); flashUntil.set(pr.m, performance.now() + 400); play('tick', 0.3); }
      else edit = null;   // tap on the edited machine closes the editor
      break;
    case 'move':
      if (g && g.ok && moveMachine(grid, pr.m, g.x, g.y)) { setMachineRot(grid, pr.m, g.rot); dropped(pr.m); edit = null; }
      else floatAt(e, 'Place occupée', 'bad');
      break;
    case 'place': {
      const r = g ? buyMachine(G.cfg, G.st, tool, g.x, g.y, g.rot) : { ok: false, why: 'place' };
      if (r.ok) {
        lastRot = g.rot;
        play('buy');
        flashUntil.set(machineAt(grid, g.x, g.y), performance.now() + 600);
        floatAt(e, r.cost ? `-${money(r.cost)}` : 'Gratuit !', r.cost ? 'bad' : 'gold');
        G.st.seen['tool_' + tool] = true;
        G.onAction('build', tool);
      } else floatAt(e, r.why === 'money' ? 'Pas assez d\'argent' : 'Place occupée', 'bad');
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
  viewH = Math.max(240, Math.floor(main.clientHeight - canvas.offsetTop + main.offsetTop - 14));
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

  if (ghost) {
    ctx.globalAlpha = 0.75;
    drawMachine({ type: ghost.type, x: ghost.x, y: ghost.y, rot: ghost.rot, lvl: ghost.lvl, prog: 0, status: 'ok', out: null }, now);
    ctx.globalAlpha = 1;
    outline(ghost.x * c, ghost.y * c, c * 2, c * 2, ghost.ok ? '#3ddc84' : '#ff5d5d');
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
  // level badge + progress bar
  ctx.font = `bold ${Math.round(c * 0.3)}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  roundRect(x + 6, y + 6, c * 0.6, c * 0.38, 4); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(`${m.lvl}`, x + 6 + c * 0.3, y + 6 + c * 0.2);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(x + 8, y + s - 11, s - 16, 4);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(x + 8, y + s - 11, (s - 16) * Math.min(1, m.prog), 4);
  if (m.status === 'starved' || m.status === 'blocked') {
    ctx.font = `${Math.round(c * 0.42)}px system-ui, "Segoe UI Emoji", sans-serif`;
    ctx.fillText(m.status === 'starved' ? '💤' : '⛔', x + s - c * 0.42, y + c * 0.42);
  }
  // ports: orange = input, green = output
  const p = ports(m), [dx, dy] = DIRS[m.rot];
  if (d.input_stage !== null) arrow(p.inCell, dx, dy, '#ffa53a', -1);
  arrow(p.outCell, dx, dy, '#3ddc84', 1);
  if (m.out !== null) drawItem(p.outCell[0] * c + c / 2 + dx * c * 0.2, p.outCell[1] * c + c / 2 + dy * c * 0.2, m.out);
}

// Triangle on the machine edge of cell `cl`, pointing along the flow.
function arrow(cl, dx, dy, color, side) {
  const cx = cl[0] * CELL + CELL / 2 + dx * (CELL / 2 - 6) * side;
  const cy = cl[1] * CELL + CELL / 2 + dy * (CELL / 2 - 6) * side;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -7); ctx.lineTo(-4, 7); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawItem(x, y, stage) {
  ctx.fillStyle = STAGE_COLORS[stage];
  if (stage === 2) { roundRect(x - 4, y - 7, 8, 14, 3); ctx.fill(); ctx.fillStyle = '#d9ffe8'; ctx.fillRect(x - 2, y - 10, 4, 4); }
  else { ctx.beginPath(); ctx.arc(x, y, stage === 0 ? 6 : 5.5, 0, Math.PI * 2); ctx.fill(); }
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
