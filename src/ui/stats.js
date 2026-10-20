// Stats sheet (pie icon in the HUD): the player's sales ($/min) over the last
// minutes, one coloured line per product, so it's clear where the money comes from.

import { money } from '../format.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
// Same colours as the items on the belts.
const COLORS = ['#ffe14a', '#ffa53a', '#3ddc84', '#ff8a1f', '#ffc46b', '#ff4d6d', '#b5523b'];
let G;

export function initStats(game) {
  G = game;
  $('stats-btn').addEventListener('click', () => { $('stats').classList.remove('hidden'); play('tab', 0.25); renderStats(); });
  $('stats-close').addEventListener('click', () => $('stats').classList.add('hidden'));
  $('stats').addEventListener('click', e => { if (e.target.id === 'stats') $('stats').classList.add('hidden'); });
}

export function renderStats() {
  if ($('stats').classList.contains('hidden')) return;
  const { cfg, st } = G, h = st.hist;
  const lines = cfg.markets.map(r => ({ r, pts: h.rev[r.id] || [], color: COLORS[r.stage] }))
    .filter(l => l.pts.some(v => v > 0));
  const n = Math.max(2, ...lines.map(l => l.pts.length));
  const max = Math.max(1, ...lines.flatMap(l => l.pts));
  const W = 320, H = 170, L = 38, B = 20, T = 8, R = 6;
  const x = i => L + (i / (n - 1)) * (W - L - R);
  const y = v => T + (1 - v / max) * (H - T - B);
  // Axis: 3 gridlines, minutes ago along the bottom.
  const grid = [0, 0.5, 1].map(k => `<line x1="${L}" x2="${W - R}" y1="${y(max * k)}" y2="${y(max * k)}" class="sc-grid"/>
    <text x="${L - 4}" y="${y(max * k) + 4}" class="sc-ax" text-anchor="end">${money(max * k).replace(' $', '')}</text>`).join('');
  const minutes = Math.round(n * h.every / 60);
  const axis = `<text x="${L}" y="${H - 4}" class="sc-ax">−${minutes} min</text><text x="${W - R}" y="${H - 4}" class="sc-ax" text-anchor="end">maintenant</text>`;
  const paths = lines.map(l => {
    const off = n - l.pts.length;
    return `<polyline fill="none" stroke="${l.color}" stroke-width="2.5" stroke-linejoin="round" points="${l.pts.map((v, i) => `${x(i + off).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
  }).join('');
  const total = lines.reduce((a, l) => a + l.pts.reduce((s, v) => s + v, 0), 0) || 1;
  const legend = lines.length ? lines.map(l => {
    const now = l.pts[l.pts.length - 1] || 0, part = l.pts.reduce((s, v) => s + v, 0) / total;
    return `<div class="sc-row"><em><i style="background:${l.color}"></i>${l.r.icon} ${l.r.name}</em><span>${money(now)}/min</span><b>${Math.round(part * 100)} %</b></div>`;
  }).join('') : '<div class="rc-empty">Pas encore de ventes enregistrées : reviens dans une minute.</div>';
  const html = `<div class="sc-title">💰 Tes ventes ($/min) par produit</div>
    <svg viewBox="0 0 ${W} ${H}" class="sc-svg" role="img" aria-label="Ventes par produit">${grid}${axis}${paths}</svg>
    <div class="sc-legend"><div class="sc-row sc-headrow"><span></span><span>maintenant</span><b>part</b></div>${legend}</div>`;
  if ($('stats-body').dataset.html !== html) { $('stats-body').dataset.html = html; $('stats-body').innerHTML = html; }
}
