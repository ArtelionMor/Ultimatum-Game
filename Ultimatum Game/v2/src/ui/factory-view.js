// Factory screen: top-down conveyor on a canvas + one card per station.
// The canvas is purely visual — the real production numbers come from sim.js.

import { stationsOf } from '../factory.js';
import { productOf, upgradeInfo, buyStation, stockInfo, buyStock, currentBottleneck } from '../sim.js';
import { money, perMin, fmt, stars } from '../format.js';
import { floatText, retrigger } from './fx.js';

const $ = id => document.getElementById(id);
let G, cards = {}, canvas, ctx, items = [], coins = [], spawnAcc = 0, beltOff = 0, lastT = 0;
const flashUntil = {};
const BELT_SPEED = 55; // px/s

export function initFactory(game) {
  G = game;
  const box = $('stations');
  box.innerHTML = '';
  for (const st of stationsOf(G.cfg, productOf(G.cfg).id)) {
    const d = document.createElement('div');
    d.className = 'card station';
    d.innerHTML = `<div class="ico">${st.icon}</div>
      <div class="name">${st.name}<span class="tag bn hidden">GOULOT</span>${st.quality_per_level ? '<span class="tag q">QUALITÉ</span>' : ''}</div>
      <div class="meta"></div>
      <button class="btn up"></button>`;
    d.querySelector('.btn').addEventListener('click', () => {
      if (buyStation(G.cfg, G.st, st.id)) {
        flashUntil[st.id] = performance.now() + 600;
        retrigger(d, 'flash');
        const info = upgradeInfo(G.cfg, G.st, st.id);
        floatText(d.querySelector('.btn'), `${st.name} ${perMin(info.rate)}`, 'gold');
        if (st.quality_per_level) setTimeout(() => floatText(d.querySelector('.ico'), `Qualité ${stars(G.st.you.quality)}`, 'gold'), 250);
        G.onAction('upgrade', st.id);
        renderFactory();
      } else floatText(d.querySelector('.btn'), 'Pas assez d\'argent', 'bad');
    });
    box.appendChild(d);
    cards[st.id] = d;
  }
  $('stock-btn').addEventListener('click', () => {
    if (buyStock(G.cfg, G.st)) {
      retrigger($('stock-card'), 'flash');
      floatText($('stock-btn'), `Entrepôt ${fmt(G.st.you.stockCap)}`, 'gold');
      G.onAction('stock');
      renderFactory();
    } else floatText($('stock-btn'), 'Pas assez d\'argent', 'bad');
  });
  canvas = $('floor');
  ctx = canvas.getContext('2d');
  requestAnimationFrame(draw);
}

export function renderFactory() {
  const { cfg, st } = G;
  const bn = currentBottleneck(cfg, st);
  const allOpen = !!st.unlocked.upgrades;
  for (const s of stationsOf(cfg, productOf(cfg).id)) {
    const d = cards[s.id], info = upgradeInfo(cfg, st, s.id);
    const isBn = s.id === bn.id;
    d.querySelector('.tag.bn').classList.toggle('hidden', !isBn);
    d.querySelector('.meta').textContent = `Niv. ${info.lvl} · ${perMin(info.rate)}` + (s.quality_per_level ? ` · qualité ${stars(st.you.quality)}` : '');
    const btn = d.querySelector('.btn');
    btn.classList.toggle('hidden', !allOpen && !isBn);
    btn.classList.toggle('cant', !info.affordable);
    btn.classList.toggle('reco', isBn && info.affordable);
    btn.innerHTML = `<span>Améliorer → ${perMin(info.nextRate)}${s.quality_per_level ? ' ★+' + s.quality_per_level : ''}</span><span>${money(info.cost)}</span>`;
  }
  const sk = stockInfo(cfg, st);
  const fill = st.you.stock / st.you.stockCap;
  $('stock-text').textContent = `${fmt(Math.floor(st.you.stock))} / ${fmt(st.you.stockCap)}` + (fill >= 0.999 ? ' · PLEIN' : '');
  $('stock-fill').style.width = (fill * 100).toFixed(1) + '%';
  $('stock-fill').classList.toggle('full', fill >= 0.999);
  const sb = $('stock-btn');
  sb.classList.toggle('hidden', !st.unlocked.stock);
  sb.classList.toggle('cant', !sk.affordable);
  sb.classList.toggle('reco', fill >= 0.999 && sk.affordable);
  sb.innerHTML = `<span>Agrandir → ${fmt(sk.nextCap)}</span><span>${money(sk.cost)}</span>`;
}

export function saleCoin() { if (coins.length < 12) coins.push({ t: 0, dx: Math.random() * 20 - 10 }); }

// --- Canvas ---------------------------------------------------------------

function layout(w) {
  const right = w - 64;                       // warehouse starts here
  const n = 3, x0 = 46, span = right - 30 - x0;
  return { right, xs: Array.from({ length: n }, (_, i) => x0 + i * span / (n - 1)), beltY: 98 };
}

function draw(now) {
  requestAnimationFrame(draw);
  if (!G || G.tab !== 'factory' || !canvas.offsetParent) { lastT = now; return; }
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 180;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dt = Math.min(0.1, (now - (lastT || now)) / 1000) * Math.min(G.speed, 3);
  lastT = now;

  const { cfg, st } = G;
  const stations = stationsOf(cfg, productOf(cfg).id);
  const L = layout(w);
  const full = st.you.stock >= st.you.stockCap - 1e-6;
  const bn = currentBottleneck(cfg, st);
  const running = !full;

  // floor
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1a1e27';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.035)';
  for (let x = 0; x < w; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // belt
  if (running) beltOff = (beltOff + BELT_SPEED * dt) % 16;
  ctx.fillStyle = '#2c313d';
  ctx.fillRect(8, L.beltY - 12, L.right - 8, 24);
  ctx.strokeStyle = '#3c4354';
  ctx.lineWidth = 2;
  for (let x = 8 + beltOff; x < L.right; x += 16) {
    ctx.beginPath(); ctx.moveTo(x, L.beltY - 8); ctx.lineTo(x + 5, L.beltY); ctx.lineTo(x, L.beltY + 8); ctx.stroke();
  }

  // items: spawned at the first station at the chain's throughput (capped for readability)
  if (running) {
    spawnAcc += dt * Math.min(5, st.you.prodRate / 60);
    while (spawnAcc >= 1) { spawnAcc -= 1; items.push({ x: L.xs[0] }); }
    for (const it of items) it.x += BELT_SPEED * dt;
  }
  items = items.filter(it => it.x < L.right + 6);
  for (const it of items) {
    const stage = it.x < L.xs[1] ? 0 : it.x < L.xs[2] ? 1 : 2;
    drawItem(it.x, L.beltY, stage);
  }

  // stations
  ctx.textAlign = 'center';
  stations.forEach((s, i) => {
    const x = L.xs[i], y = L.beltY;
    const flashing = (flashUntil[s.id] || 0) > now;
    const bob = running ? Math.sin(now / 120 + i) * 1.5 : 0;
    ctx.fillStyle = flashing ? '#3d6b4d' : '#323849';
    roundRect(x - 27, y - 27 + bob, 54, 54, 12); ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = s.id === bn.id ? '#ff5d5d' : '#4a5266';
    roundRect(x - 27, y - 27 + bob, 54, 54, 12); ctx.stroke();
    ctx.font = '26px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.icon, x, y + bob + 1);
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillStyle = '#cfd6e4';
    ctx.fillText(`Niv. ${st.levels[s.id]}`, x, y + 42);
    ctx.fillStyle = s.id === bn.id ? '#ff9c9c' : '#9aa3b5';
    ctx.fillText(perMin(upgradeInfo(cfg, st, s.id).rate), x, y - 40);
  });

  // warehouse
  const wx = L.right + 4, wy = L.beltY - 40, ww = w - wx - 8, wh = 80;
  ctx.fillStyle = '#323849';
  roundRect(wx, wy, ww, wh, 10); ctx.fill();
  const fill = st.you.stock / st.you.stockCap;
  ctx.fillStyle = full ? '#ff5d5d' : '#5aa9ff';
  roundRect(wx + 6, wy + 6 + (wh - 12) * (1 - fill), ww - 12, (wh - 12) * fill, 6); ctx.fill();
  ctx.font = '22px system-ui, "Segoe UI Emoji", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText('📦', wx + ww / 2, wy + wh / 2 - 6);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.fillText(fmt(Math.floor(st.you.stock)), wx + ww / 2, wy + wh / 2 + 16);
  if (full) {
    ctx.fillStyle = '#ff5d5d';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('PLEIN', wx + ww / 2, wy + wh + 14);
  }

  // coins leaving the warehouse on each sale
  ctx.font = '14px system-ui, "Segoe UI Emoji", sans-serif';
  for (const c of coins) {
    c.t += dt / Math.max(1, Math.min(G.speed, 3));
    ctx.globalAlpha = Math.max(0, 1 - c.t);
    ctx.fillText('🪙', wx + ww / 2 + c.dx, wy - 4 - c.t * 40);
  }
  ctx.globalAlpha = 1;
  coins = coins.filter(c => c.t < 1);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`Production : ${perMin(st.you.prodRate)}`, 10, 16);
}

function drawItem(x, y, stage) {
  if (stage === 0) { ctx.fillStyle = '#ffe14a'; ctx.beginPath(); ctx.ellipse(x, y, 6, 5, 0, 0, Math.PI * 2); ctx.fill(); }
  else if (stage === 1) { ctx.fillStyle = '#ffa53a'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.fillStyle = '#3ddc84'; roundRect(x - 4, y - 8, 8, 16, 3); ctx.fill(); ctx.fillStyle = '#d9ffe8'; ctx.fillRect(x - 2, y - 11, 4, 4); }
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
