// Factory screen: a top-down grid where the player buys and places 2×2
// machines and draws conveyor belts. Tools: ✋ manage, one per machine, belt, ⟳.

import { DIRS, ports, machineAt, beltAt, machineDef, placeCost, canPlaceMachine, canPlaceBelt,
  setBeltDir, rotateMachine } from '../grid.js';
import { buyMachine, buyBelt, sellMachine, sellBelt, machineInfo, upgradeMachine, stockInfo, buyStock } from '../sim.js';
import { money, perMin, fmt, stars } from '../format.js';
import { floatText, retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const ARROWS = ['→', '↓', '←', '↑'];
const STAGE_COLORS = ['#ffe14a', '#ffa53a', '#3ddc84'];

let G, canvas, ctx, bound = false;
let tool = 'hand', rot = 0, cell = 34;
let ghost = null;          // { x, y, ok } machine preview while the finger is down
let drag = null;           // belt drawing: { last: [x, y], moved, startedOn }
let sel = null;            // { kind: 'machine', m } | { kind: 'belt', x, y }
const flashUntil = new Map();

export function initFactory(game) {
  G = game;
  sel = null; tool = 'hand';
  buildToolbar();
  if (bound) return;
  bound = true;
  canvas = $('floor');
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { ghost = null; drag = null; });
  $('stock-btn').addEventListener('click', doBuyStock);
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
    tool = b.dataset.tool; sel = null; play('tick', 0.2);
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
  $('rotate-btn').classList.toggle('hidden', tool === 'hand');
  renderStock();
  renderSelection();
}

function renderStock() {
  const { cfg, st } = G;
  const sk = stockInfo(cfg, st);
  const fill = st.you.stock / st.you.stockCap;
  $('stock-text').textContent = `${fmt(Math.floor(st.you.stock))} / ${fmt(st.you.stockCap)}` + (fill >= 0.999 ? ' · PLEIN' : '');
  $('stock-fill').style.width = (fill * 100).toFixed(1) + '%';
  $('stock-fill').classList.toggle('full', fill >= 0.999);
  $('prod-text').textContent = `Production ${perMin(st.you.prodRate)}`;
  const sb = $('stock-btn');
  sb.classList.toggle('hidden', !st.unlocked.stock);
  sb.classList.toggle('cant', !sk.affordable);
  sb.classList.toggle('reco', fill >= 0.999 && sk.affordable);
  sb.classList.toggle('pulse', !!st.unlocked.stock && !st.seen.stock);
  sb.innerHTML = `<span>Agrandir → ${fmt(sk.nextCap)}</span><span>${money(sk.cost)}</span>`;
}

function doBuyStock() {
  if (buyStock(G.cfg, G.st)) {
    play('buy');
    retrigger($('stock-card'), 'flash');
    floatText($('stock-btn'), `Entrepôt ${fmt(G.st.you.stockCap)}`, 'gold');
    G.onAction('stock');
  } else floatText($('stock-btn'), 'Pas assez d\'argent', 'bad');
}

// --- Selection sheet ------------------------------------------------------------

const STATUS = {
  ok: '✅ Tourne',
  starved: '💤 Attend sa matière : amène un tapis sur son entrée (flèche orange).',
  blocked: '⛔ Sortie bloquée : pose un tapis sur sa sortie (flèche verte).',
  idle: '…',
};

function renderSelection() {
  const panel = $('sel-panel');
  if (!sel || G.tab !== 'factory') { panel.classList.add('hidden'); return; }
  const { cfg, st } = G;
  const close = '<button class="btn small" data-act="close">✕</button>';
  let html;
  if (sel.kind === 'machine' && sel.m.type === 'warehouse') {
    html = `<div class="sel-title">📦 Entrepôt</div>
      <div class="sel-meta">Stock ${fmt(Math.floor(st.you.stock))} / ${fmt(st.you.stockCap)} · reçoit les bouteilles 🍾 par tous les côtés.</div>
      <div class="sel-btns">${close}</div>`;
  } else if (sel.kind === 'machine') {
    const m = sel.m, info = machineInfo(cfg, st, m);
    html = `<div class="sel-title">${info.def.icon} ${info.def.name} <span class="muted">Niv. ${m.lvl}</span></div>
      <div class="sel-meta">${perMin(info.rate)}${info.def.quality_per_level ? ' · qualité ' + stars(st.you.quality) : ''} · ${STATUS[m.status]}</div>
      ${st.unlocked.upgrades ? `<button class="btn up ${info.affordable ? '' : 'cant'}" data-act="up"><span>Améliorer → ${perMin(info.nextRate)}</span><span>${money(info.cost)}</span></button>` : ''}
      <div class="sel-btns">
        <button class="btn small" data-act="rot">⟳ Tourner</button>
        <button class="btn small danger" data-act="sell">Vendre</button>
        ${close}
      </div>`;
  } else {
    const b = beltAt(st.grid, sel.x, sel.y);
    if (!b) { sel = null; panel.classList.add('hidden'); return; }
    html = `<div class="sel-title">⇉ Tapis <span class="muted">${ARROWS[b.dir]}</span></div>
      <div class="sel-btns">
        <button class="btn small" data-act="rot">⟳ Tourner</button>
        <button class="btn small danger" data-act="sell">Vendre</button>
        ${close}
      </div>`;
  }
  if (panel.dataset.html !== html) {
    panel.innerHTML = html;
    panel.dataset.html = html;
    panel.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => onSelAction(b.dataset.act, b)));
  }
  panel.classList.remove('hidden');
}

function onSelAction(act, btn) {
  const { cfg, st } = G;
  if (act === 'close') sel = null;
  else if (sel.kind === 'machine') {
    const m = sel.m;
    if (act === 'up') {
      if (upgradeMachine(cfg, st, m)) {
        play('buy');
        flashUntil.set(m, performance.now() + 600);
        floatText(btn, perMin(machineInfo(cfg, st, m).rate), 'gold');
        G.onAction('upgrade');
      } else floatText(btn, 'Pas assez d\'argent', 'bad');
    } else if (act === 'rot') { rotateMachine(st.grid, m); play('tick', 0.3); }
    else if (act === 'sell') { const back = sellMachine(cfg, st, m); floatText(btn, `+${money(back)}`, 'gold'); sel = null; G.onAction('sell'); }
  } else if (act === 'rot') {
    const b = beltAt(st.grid, sel.x, sel.y);
    if (b) setBeltDir(st.grid, sel.x, sel.y, (b.dir + 1) % 4);
    play('tick', 0.3);
  } else if (act === 'sell') { sellBelt(cfg, st, sel.x, sel.y); sel = null; G.onAction('sell'); }
  renderFactory();
}

// --- Pointer input --------------------------------------------------------------

function toCell(e) {
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / cell, fy = (e.clientY - r.top) / cell;
  return { fx, fy, x: Math.floor(fx), y: Math.floor(fy) };
}

// The 2×2 footprint is centred on the finger.
function machineGhost(p) {
  const { cols, rows } = G.st.grid;
  const x = Math.max(0, Math.min(cols - 2, Math.round(p.fx - 1)));
  const y = Math.max(0, Math.min(rows - 2, Math.round(p.fy - 1)));
  return { x, y, ok: canPlaceMachine(G.st.grid, x, y) };
}

function onDown(e) {
  if (G.st.goal.won) return;
  const p = toCell(e);
  if (tool === 'hand') {
    const m = machineAt(G.st.grid, p.x, p.y);
    if (m) sel = { kind: 'machine', m };
    else if (beltAt(G.st.grid, p.x, p.y)) sel = { kind: 'belt', x: p.x, y: p.y };
    else sel = null;
    renderFactory();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (tool === 'belt') {
    const existing = beltAt(G.st.grid, p.x, p.y);
    drag = { last: [p.x, p.y], moved: false, startedOn: !!existing };
    if (!existing) tryBelt(p.x, p.y, rot, e);
  } else ghost = machineGhost(p);
}

function onMove(e) {
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
  if (ghost) {
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
  cell = Math.floor(canvas.parentElement.clientWidth / grid.cols);
  const W = cell * grid.cols, H = cell * grid.rows;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.style.touchAction = tool === 'hand' ? 'pan-y' : 'none';

  // floor
  ctx.fillStyle = '#1a1e27';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1e232d';
  for (let x = 0; x < grid.cols; x++) for (let y = 0; y < grid.rows; y++) if ((x + y) % 2) ctx.fillRect(x * cell, y * cell, cell, cell);

  // belts
  const t = now / 1000;
  for (const k in grid.belts) {
    const [x, y] = k.split(',').map(Number), b = grid.belts[k];
    ctx.fillStyle = '#2f3542';
    ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    ctx.save();
    ctx.translate(x * cell + cell / 2, y * cell + cell / 2);
    ctx.rotate(b.dir * Math.PI / 2);
    ctx.strokeStyle = '#4f586d';
    ctx.lineWidth = 2;
    const off = (t * cfg.grid.belt_speed * cell * 0.5) % (cell / 2);
    for (let i = -1; i < 2; i++) {
      const sx = -cell / 4 + off + i * cell / 2;
      if (sx < -cell / 2 + 3 || sx > cell / 2 - 8) continue;
      ctx.beginPath(); ctx.moveTo(sx, -cell / 4); ctx.lineTo(sx + 5, 0); ctx.lineTo(sx, cell / 4); ctx.stroke();
    }
    ctx.restore();
    if (sel && sel.kind === 'belt' && sel.x === x && sel.y === y) outline(x * cell, y * cell, cell, cell, '#5aa9ff');
  }
  for (const k in grid.belts) {
    const b = grid.belts[k];
    if (b.item === null) continue;
    const [x, y] = k.split(',').map(Number), [dx, dy] = DIRS[b.dir];
    drawItem(x * cell + cell / 2 + dx * (b.p - 0.5) * cell, y * cell + cell / 2 + dy * (b.p - 0.5) * cell, b.item);
  }

  for (const m of grid.machines) drawMachine(m, now);

  if (ghost) {
    ctx.globalAlpha = 0.6;
    drawMachine({ type: tool, x: ghost.x, y: ghost.y, rot, lvl: 1, prog: 0, status: 'ok', out: null }, now);
    ctx.globalAlpha = 1;
    outline(ghost.x * cell, ghost.y * cell, cell * 2, cell * 2, ghost.ok ? '#3ddc84' : '#ff5d5d');
  }
}

function drawMachine(m, now) {
  const { cfg, st } = G;
  const x = m.x * cell, y = m.y * cell, s = cell * 2;
  const isWh = m.type === 'warehouse';
  const d = isWh ? null : machineDef(cfg, m.type);
  const flashing = (flashUntil.get(m) || 0) > now;
  ctx.fillStyle = flashing ? '#3d6b4d' : isWh ? '#3a3f52' : d.color;
  roundRect(x + 3, y + 3, s - 6, s - 6, 9); ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = sel && sel.m === m ? '#5aa9ff' : 'rgba(255,255,255,.18)';
  roundRect(x + 3, y + 3, s - 6, s - 6, 9); ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(cell * 0.8)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.fillStyle = '#fff';
  if (isWh) {
    const fill = st.you.stock / st.you.stockCap;
    ctx.fillStyle = fill >= 0.999 ? '#ff5d5d' : '#5aa9ff';
    ctx.fillRect(x + 8, y + s - 12, (s - 16) * fill, 5);
    ctx.fillStyle = '#fff';
    ctx.fillText('📦', x + s / 2, y + s / 2 - 5);
    ctx.font = `bold ${Math.round(cell * 0.32)}px system-ui, sans-serif`;
    ctx.fillText(fmt(Math.floor(st.you.stock)), x + s / 2, y + s / 2 + cell * 0.45);
    return;
  }
  const bob = m.status === 'ok' ? Math.sin(now / 140 + m.x) * 1.2 : 0;
  ctx.fillText(d.icon, x + s / 2, y + s / 2 + bob - 3);
  // level badge + progress bar
  ctx.font = `bold ${Math.round(cell * 0.3)}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  roundRect(x + 6, y + 6, cell * 0.6, cell * 0.38, 4); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(`${m.lvl}`, x + 6 + cell * 0.3, y + 6 + cell * 0.2);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(x + 8, y + s - 11, s - 16, 4);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(x + 8, y + s - 11, (s - 16) * Math.min(1, m.prog), 4);
  if (m.status === 'starved' || m.status === 'blocked') {
    ctx.font = `${Math.round(cell * 0.42)}px system-ui, "Segoe UI Emoji", sans-serif`;
    ctx.fillText(m.status === 'starved' ? '💤' : '⛔', x + s - cell * 0.42, y + cell * 0.42);
  }
  // ports: orange = input, green = output
  const p = ports(m), [dx, dy] = DIRS[m.rot];
  if (d.input_stage !== null) arrow(p.inCell, dx, dy, '#ffa53a', -1);
  arrow(p.outCell, dx, dy, '#3ddc84', 1);
  if (m.out !== null) drawItem(p.outCell[0] * cell + cell / 2 + dx * cell * 0.2, p.outCell[1] * cell + cell / 2 + dy * cell * 0.2, m.out);
}

// Triangle on the machine edge of cell `c`, pointing along the flow.
function arrow(c, dx, dy, color, side) {
  const cx = c[0] * cell + cell / 2 + dx * (cell / 2 - 6) * side;
  const cy = c[1] * cell + cell / 2 + dy * (cell / 2 - 6) * side;
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
