// Factory screen: a top-down grid, larger than the screen, where the player
// buys and places 2×2 machines and draws conveyor belts.
// Tools: ✋ manage (drag = pan, tap = select), one per machine, belt, ⟳.
// Pan: one finger with ✋, two fingers with any tool, right/middle mouse or wheel.

import { DIRS, ports, machineAt, beltAt, machineDef, placeCost, canPlaceMachine, canPlaceBelt,
  setBeltDir, rotateMachine, moveMachine, countOf } from '../grid.js';
import { buyMachine, buyBelt, sellMachine, sellBelt, machineInfo, upgradeMachine, stockInfo, buyStock } from '../sim.js';
import { money, perMin, fmt, stars } from '../format.js';
import { floatText, retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const ARROWS = ['→', '↓', '←', '↑'];
const STAGE_COLORS = ['#ffe14a', '#ffa53a', '#3ddc84'];
const CELL = 34;
const PAN_SLOP = 6;        // px a finger may move before a tap becomes a pan

let G, canvas, ctx, bound = false;
let tool = 'hand', rot = 0;
let cam = { x: 0, y: 0 }, viewW = 0, viewH = 0, camReady = false;
let ghost = null;          // { x, y, ok } machine preview while the finger is down
let drag = null;           // belt drawing: { last: [x, y], moved, startedOn }
let sel = null;            // { kind: 'machine', m } | { kind: 'belt', x, y }
let moving = null;         // machine being moved: the next tap on the grid drops it
let tap = null;            // ✋ pending tap { x, y, cell }
let pan = null;            // { x, y } last pan anchor (screen px)
const pointers = new Map();
const flashUntil = new Map();

export function initFactory(game) {
  G = game;
  sel = null; moving = null; tool = 'hand'; camReady = false;
  buildToolbar();
  if (bound) return;
  bound = true;
  canvas = $('floor');
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); ghost = null; drag = null; tap = null; pan = null; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); panBy(e.deltaX, e.deltaY); }, { passive: false });
  requestAnimationFrame(draw);
}

// --- Toolbar ------------------------------------------------------------------

function buildToolbar() {
  const bar = $('toolbar');
  const tools = [{ id: 'hand', icon: '✋', label: 'Gérer' },
    ...G.cfg.machines.map(m => ({ id: m.id, icon: m.icon })), { id: 'belt', icon: '⇉' }];
  bar.innerHTML = tools.map(t => `<button class="tool" data-tool="${t.id}"><span class="ti">${t.icon}</span><small>${t.label || ''}</small></button>`).join('')
    + `<button class="tool" id="rotate-btn" title="Tourner"><span class="ti">⟳</span><small>${ARROWS[rot]}</small></button>`;
  bar.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
    tool = b.dataset.tool; sel = null; moving = null; play('tick', 0.2);
    G.onAction('tool', tool);
    renderFactory();
  }));
  $('rotate-btn').addEventListener('click', () => {
    rot = (rot + 1) % 4; play('tick', 0.2);
    $('rotate-btn').querySelector('small').textContent = ARROWS[rot];
  });
}

const toolUnlocked = id => id === 'hand' || id === 'belt' || id === 'harvest' || !!G.st.unlocked[id];
export const currentTool = () => tool;

export function renderFactory() {
  const { cfg, st } = G;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => {
    const id = b.dataset.tool;
    b.classList.toggle('hidden', !toolUnlocked(id));
    b.classList.toggle('active', id === tool);
    b.classList.toggle('pulse', toolUnlocked(id) && id !== 'hand' && id !== 'belt' && !st.seen['tool_' + id]);
    if (id !== 'hand') {
      const c = placeCost(cfg, st.grid, id);
      b.querySelector('small').textContent = money(c);
      b.classList.toggle('cant', st.money < c);
    }
  });
  $('rotate-btn').classList.toggle('hidden', tool === 'hand' || tool === 'outcome');
  renderStock();
  renderSelection();
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

// --- Selection sheet ------------------------------------------------------------

const STATUS = {
  ok: '✅ Tourne',
  starved: '💤 Attend sa matière : amène un tapis sur son entrée (flèche orange).',
  blocked: '⛔ Sortie bloquée : pose un tapis sur sa sortie (flèche verte), ou ton stock est plein.',
  idle: '…',
};

function sheet(html, handlers) {
  const panel = $('sel-panel');
  if (panel.dataset.html !== html) {
    panel.innerHTML = html;
    panel.dataset.html = html;
    panel.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => handlers(b.dataset.act, b)));
  }
  panel.classList.remove('hidden');
}

function renderSelection() {
  const panel = $('sel-panel');
  const { cfg, st } = G;
  if (G.tab !== 'factory') { panel.classList.add('hidden'); return; }
  if (moving) {
    sheet(`<div class="sel-title">✥ Déplacement</div><div class="sel-meta">Touche la grille où poser la machine (glisse pour ajuster).</div>
      <div class="sel-btns"><button class="btn small" data-act="cancel">Annuler</button></div>`, () => { moving = null; renderFactory(); });
    return;
  }
  if (!sel) { panel.classList.add('hidden'); return; }
  const close = '<button class="btn small" data-act="close">✕</button>';
  if (sel.kind === 'machine' && machineDef(cfg, sel.m.type).sink) {
    const lines = cfg.markets.map(r => `${r.icon} ${fmt(Math.floor(st.mk[r.id].you.stock))}/${fmt(st.mk[r.id].you.stockCap)}`).join(' · ');
    sheet(`<div class="sel-title">📤 Outcome</div>
      <div class="sel-meta">Envoie à la vente tout ce qui y entre, par tous les côtés. Stock : ${lines}</div>
      <div class="sel-btns">
        <button class="btn small" data-act="move">✥ Déplacer</button>
        ${countOf(st.grid, 'outcome') > 1 ? '<button class="btn small danger" data-act="sell">Vendre</button>' : ''}
        ${close}
      </div>`, onSelAction);
  } else if (sel.kind === 'machine') {
    const m = sel.m, info = machineInfo(cfg, st, m);
    const q = cfg.markets.find(r => r.stage === info.def.output_stage);
    sheet(`<div class="sel-title">${info.def.icon} ${info.def.name} <span class="muted">Niv. ${m.lvl}</span></div>
      <div class="sel-meta">${perMin(info.rate)} · qualité ${q.icon} ${stars(st.mk[q.id].you.quality)} · ${STATUS[m.status]}</div>
      ${st.unlocked.upgrades ? `<button class="btn up ${info.affordable ? '' : 'cant'}" data-act="up"><span>Améliorer → ${perMin(info.nextRate)}</span><span>${money(info.cost)}</span></button>` : ''}
      <div class="sel-btns">
        <button class="btn small" data-act="move">✥ Déplacer</button>
        <button class="btn small" data-act="rot">⟳ Tourner</button>
        <button class="btn small danger" data-act="sell">Vendre</button>
        ${close}
      </div>`, onSelAction);
  } else {
    const b = beltAt(st.grid, sel.x, sel.y);
    if (!b) { sel = null; panel.classList.add('hidden'); return; }
    sheet(`<div class="sel-title">⇉ Tapis <span class="muted">${ARROWS[b.dir]}</span></div>
      <div class="sel-btns">
        <button class="btn small" data-act="rot">⟳ Tourner</button>
        <button class="btn small danger" data-act="sell">Vendre</button>
        ${close}
      </div>`, onSelAction);
  }
}

function onSelAction(act, btn) {
  const { cfg, st } = G;
  if (act === 'close') sel = null;
  else if (sel?.kind === 'machine') {
    const m = sel.m;
    if (act === 'up') {
      if (upgradeMachine(cfg, st, m)) {
        play('buy');
        flashUntil.set(m, performance.now() + 600);
        floatText(btn, perMin(machineInfo(cfg, st, m).rate), 'gold');
        G.onAction('upgrade');
      } else floatText(btn, 'Pas assez d\'argent', 'bad');
    } else if (act === 'move') { moving = m; sel = null; play('tick', 0.3); }
    else if (act === 'rot') { rotateMachine(st.grid, m); play('tick', 0.3); }
    else if (act === 'sell') {
      const back = sellMachine(cfg, st, m);
      if (back >= 0) { floatText(btn, `+${money(back)}`, 'gold'); sel = null; G.onAction('sell'); }
    }
  } else if (sel?.kind === 'belt') {
    if (act === 'rot') {
      const b = beltAt(st.grid, sel.x, sel.y);
      if (b) setBeltDir(st.grid, sel.x, sel.y, (b.dir + 1) % 4);
      play('tick', 0.3);
    } else if (act === 'sell') { sellBelt(cfg, st, sel.x, sel.y); sel = null; G.onAction('sell'); }
  }
  renderFactory();
}

// --- Camera -------------------------------------------------------------------

function clampCam() {
  const g = G.st.grid;
  cam.x = Math.max(0, Math.min(Math.max(0, g.cols * CELL - viewW), cam.x));
  cam.y = Math.max(0, Math.min(Math.max(0, g.rows * CELL - viewH), cam.y));
}
function panBy(dx, dy) { cam.x += dx; cam.y += dy; clampCam(); }
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

// The 2×2 footprint is centred on the finger.
function machineGhost(p) {
  const { cols, rows } = G.st.grid;
  const x = Math.max(0, Math.min(cols - 2, Math.round(p.fx - 1)));
  const y = Math.max(0, Math.min(rows - 2, Math.round(p.fy - 1)));
  return { x, y, ok: canPlaceMachine(G.st.grid, x, y, moving) };
}

const midpoint = () => {
  const ps = [...pointers.values()];
  return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length };
};

function onDown(e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || pointers.size >= 2) {
    // Second finger or right/middle mouse: pan, and drop whatever was being placed.
    ghost = null; drag = null; tap = null;
    pan = midpoint();
    return;
  }
  const p = toCell(e);
  if (moving) { ghost = machineGhost(p); return; }
  if (tool === 'hand') { tap = { x: e.clientX, y: e.clientY, cell: p }; return; }
  if (tool === 'belt') {
    const existing = beltAt(G.st.grid, p.x, p.y);
    drag = { last: [p.x, p.y], moved: false, startedOn: !!existing };
    if (!existing) tryBelt(p.x, p.y, rot, e);
  } else ghost = machineGhost(p);
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > PAN_SLOP) { pan = { x: tap.x, y: tap.y }; tap = null; }
  if (pan) {
    const m = midpoint();
    panBy(pan.x - m.x, pan.y - m.y);
    pan = m;
    return;
  }
  if (!ghost && !drag) return;
  const p = toCell(e);
  if (ghost) { ghost = machineGhost(p); return; }
  const [lx, ly] = drag.last;
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
    rot = dir;
  }
  $('rotate-btn').querySelector('small').textContent = ARROWS[rot];
  drag.last = [cx, cy];
  drag.moved = true;
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (pan) { if (!pointers.size) pan = null; else pan = midpoint(); return; }
  if (tap) {
    const p = tap.cell; tap = null;
    const m = machineAt(G.st.grid, p.x, p.y);
    if (m) sel = { kind: 'machine', m };
    else if (beltAt(G.st.grid, p.x, p.y)) sel = { kind: 'belt', x: p.x, y: p.y };
    else sel = null;
  } else if (ghost && moving) {
    const g = ghost, m = moving; ghost = null;
    if (moveMachine(G.st.grid, m, g.x, g.y)) {
      moving = null;
      play('buy');
      flashUntil.set(m, performance.now() + 600);
      sel = { kind: 'machine', m };
      G.onAction('move');
    } else floatAt(e, 'Place occupée', 'bad');
  } else if (ghost) {
    const g = ghost; ghost = null;
    const r = buyMachine(G.cfg, G.st, tool, g.x, g.y, rot);
    if (r.ok) {
      play('buy');
      flashUntil.set(machineAt(G.st.grid, g.x, g.y), performance.now() + 600);
      floatAt(e, `-${money(r.cost)}`, 'bad');
      G.st.seen['tool_' + tool] = true;
      G.onAction('build', tool);
    } else floatAt(e, r.why === 'money' ? 'Pas assez d\'argent' : 'Place occupée', 'bad');
  } else if (drag) {
    // A tap on an existing belt turns it.
    if (!drag.moved && drag.startedOn) {
      const p = toCell(e), b = beltAt(G.st.grid, p.x, p.y);
      if (b) { setBeltDir(G.st.grid, p.x, p.y, (b.dir + 1) % 4); play('tick', 0.3); }
    }
    drag = null;
    G.onAction('build', 'belt');
  }
  renderFactory();
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
  canvas.style.touchAction = 'none';
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

  // belts
  const t = now / 1000;
  for (const k in grid.belts) {
    const [x, y] = k.split(',').map(Number), b = grid.belts[k];
    if (x < x0 - 1 || x > x1 || y < y0 - 1 || y > y1) continue;
    ctx.fillStyle = '#2f3542';
    ctx.fillRect(x * c + 2, y * c + 2, c - 4, c - 4);
    ctx.save();
    ctx.translate(x * c + c / 2, y * c + c / 2);
    ctx.rotate(b.dir * Math.PI / 2);
    ctx.strokeStyle = '#4f586d';
    ctx.lineWidth = 2;
    const off = (t * cfg.grid.belt_speed * c * 0.5) % (c / 2);
    for (let i = -1; i < 2; i++) {
      const sx = -c / 4 + off + i * c / 2;
      if (sx < -c / 2 + 3 || sx > c / 2 - 8) continue;
      ctx.beginPath(); ctx.moveTo(sx, -c / 4); ctx.lineTo(sx + 5, 0); ctx.lineTo(sx, c / 4); ctx.stroke();
    }
    ctx.restore();
    if (sel && sel.kind === 'belt' && sel.x === x && sel.y === y) outline(x * c, y * c, c, c, '#5aa9ff');
  }
  for (const k in grid.belts) {
    const b = grid.belts[k];
    if (b.item === null) continue;
    const [x, y] = k.split(',').map(Number), [dx, dy] = DIRS[b.dir];
    drawItem(x * c + c / 2 + dx * (b.p - 0.5) * c, y * c + c / 2 + dy * (b.p - 0.5) * c, b.item);
  }

  for (const m of grid.machines) drawMachine(m, now);

  if (ghost) {
    ctx.globalAlpha = 0.6;
    const src = moving || { type: tool, rot, lvl: 1 };
    drawMachine({ type: src.type, x: ghost.x, y: ghost.y, rot: src.rot, lvl: src.lvl, prog: 0, status: 'ok', out: null }, now);
    ctx.globalAlpha = 1;
    outline(ghost.x * c, ghost.y * c, c * 2, c * 2, ghost.ok ? '#3ddc84' : '#ff5d5d');
  }
}

function drawMachine(m, now) {
  const { cfg, st } = G;
  const c = CELL, x = m.x * c, y = m.y * c, s = c * 2;
  const d = machineDef(cfg, m.type);
  const flashing = (flashUntil.get(m) || 0) > now;
  ctx.fillStyle = flashing ? '#3d6b4d' : d.color;
  roundRect(x + 3, y + 3, s - 6, s - 6, 9); ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = (sel && sel.m === m) || moving === m ? '#5aa9ff' : 'rgba(255,255,255,.18)';
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
