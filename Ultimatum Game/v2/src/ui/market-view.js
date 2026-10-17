// Market screen: the one gesture here is setting the price.

import { previewPreference, segmentShare, score } from '../market.js';
import { unitCost } from '../factory.js';
import { productOf, sellersOf, shareOf, priceBounds, setPrice } from '../sim.js';
import { price as fPrice, pct, perMin, stars, fmt } from '../format.js';
import { floatText, retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const YOU_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--you').trim() || '#3ddc84';

let G; // { cfg, st, onAction }
const rivalEls = {};

let bound = false;
export function initMarket(game) {
  G = game;
  if (!bound) bindControls();
  bound = true;
  buildRivals();
}

function bindControls() {
  const slider = $('price-slider');
  const apply = (p, src) => {
    if (setPrice(G.cfg, G.st, p)) { G.onAction('price'); renderPrice(); if (src) { retrigger($('price-value'), 'bump'); play('tick', 0.25); } }
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  const b = () => priceBounds(G.cfg, G.st).step;
  holdRepeat($('price-minus'), () => apply(G.st.you.price - b(), 'btn'));
  holdRepeat($('price-plus'), () => apply(G.st.you.price + b(), 'btn'));
}

function buildRivals() {
  const box = $('rivals');
  box.innerHTML = '';
  for (const def of G.cfg.competitors) {
    const d = document.createElement('div');
    d.className = 'rival';
    d.innerHTML = `<div class="portrait" style="background:${def.color}33">${def.icon}</div>
      <div class="rname" style="color:${def.color}">${def.name}</div><div class="rshare">0 %</div>
      <div class="rdesc">${def.desc}</div>
      <div class="rstats"></div>`;
    box.appendChild(d);
    rivalEls[def.id] = d;
  }
}

// Tap = one step; press-and-hold repeats, so ± stays usable on mobile.
function holdRepeat(btn, fn) {
  let t1, t2, repeated = false;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', () => {
    stop();
    repeated = false;
    t1 = setTimeout(() => { repeated = true; fn(); t2 = setInterval(fn, 90); }, 400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener('click', () => { if (!repeated) fn(); repeated = false; });
}

export function flashRival(id) { const el = rivalEls[id]; if (el) retrigger(el, 'changed'); }

function renderPrice() {
  const { cfg, st } = G;
  const product = productOf(cfg);
  const b = priceBounds(cfg, st);
  const slider = $('price-slider');
  slider.min = b.min; slider.max = b.max; slider.step = b.step;
  if (document.activeElement !== slider) slider.value = st.you.price;
  const cost = unitCost(product, st.you.quality);
  const m = st.you.price - cost;
  $('price-value').textContent = fPrice(st.you.price);
  $('unit-cost').textContent = fPrice(cost);
  $('margin').textContent = (m >= 0 ? '+' : '') + fPrice(m);
  $('margin').classList.toggle('neg', m <= 0);
  $('quality').textContent = stars(st.you.quality);
}

// Expected demand for the player at the current price, if everybody had stock.
function predicted() {
  const { cfg, st } = G;
  const pref = previewPreference(cfg, productOf(cfg), sellersOf(st));
  let want = 0, total = 0;
  for (const sg of cfg.segments) { want += sg.demand_per_min * pref[sg.id].probs.you; total += sg.demand_per_min; }
  return { want, total, pref };
}

export function renderMarket() {
  const { cfg, st } = G;
  renderPrice();
  const sh = shareOf(st);
  const flowYou = st.shares.flow.you * 60;
  $('sales-rate').textContent = perMin(flowYou);

  const p = predicted();
  const canSell = Math.min(p.want, st.you.prodRate);
  $('pred-share').textContent = pct(canSell / p.total);

  // One line of advice: are we limited by demand or by production?
  let adv = '';
  if (p.want < 1) adv = '🚫 Personne n\'accepte ce prix : baisse-le.';
  else if (p.want > st.you.prodRate * 1.25) adv = `📈 Les clients veulent ${perMin(p.want)}, tu produis ${perMin(st.you.prodRate)} → monte ton prix ou produis plus.`;
  else if (p.want < st.you.prodRate * 0.75) adv = `📦 Tu produis ${perMin(st.you.prodRate)} mais on t'en demande ${perMin(p.want)} → baisse ton prix pour écouler.`;
  else adv = `✅ Demande (${perMin(p.want)}) ≈ production (${perMin(st.you.prodRate)}).`;
  $('price-advice').textContent = adv;

  // Share stack
  const sellers = [{ id: 'you', name: 'Toi', color: YOU_COLOR }, ...cfg.competitors.map(c => ({ id: c.id, name: c.name.replace(/^Le /, ''), color: c.color }))];
  $('share-stack').innerHTML = sellers.map(s => `<div style="width:${(sh[s.id] * 100).toFixed(1)}%;background:${s.color}"></div>`).join('');
  $('share-legend').innerHTML = sellers.map(s => `<span class="${s.id === 'you' ? 'you' : ''}"><i style="background:${s.color}"></i>${s.name} ${pct(sh[s.id])}</span>`).join('');

  // Segments
  if (!$('seg-card').classList.contains('hidden')) {
    $('segments').innerHTML = cfg.segments.map(sg => {
      const t = st.shares.seg[sg.id];
      const tot = t.demand || 1;
      const bars = sellers.map(s => `<div style="width:${(t.by[s.id] / tot * 100).toFixed(1)}%;background:${s.color}"></div>`).join('');
      const mine = segmentShare(st.shares, sg.id, 'you');
      const refused = p.pref[sg.id].refused.you;
      let say, cls = '';
      if (refused) { say = refusalReason(sg); cls = 'bad'; }
      else if (mine >= 0.5) { say = `Les ${sg.name} t'adorent`; cls = 'good'; }
      else if (mine >= 0.25) { say = `Les ${sg.name} t'apprécient`; cls = 'good'; }
      else if (mine >= 0.05) say = `Les ${sg.name} hésitent`;
      else { say = `Les ${sg.name} te fuient`; cls = 'bad'; }
      const lost = (t.refused + t.noStock) / tot;
      return `<div class="seg"><div class="seg-head"><span>${sg.icon} <b>${sg.name}</b> · ${fmt(sg.demand_per_min)}/min</span><span>chez toi <b>${pct(mine)}</b></span></div>
        <div class="stack small">${bars}</div>
        <div class="seg-say ${cls}">${say}${lost > 0.05 ? ` · ${pct(lost)} repartent sans rien` : ''}</div></div>`;
    }).join('');
  }

  // Rivals
  cfg.competitors.forEach((def, i) => {
    const r = st.rivals[i], el = rivalEls[def.id];
    el.querySelector('.rshare').textContent = pct(sh[r.id]);
    el.querySelector('.rstats').innerHTML = `Prix <b>${fPrice(r.price)}</b> · Qualité <b>${stars(r.quality)}</b> · ${perMin(r.prodRate)}`;
  });
}

// Too expensive if the lowest allowed price would be accepted, else quality.
function refusalReason(sg) {
  const { cfg, st } = G;
  const atMin = score(sg, { quality: st.you.quality, price: priceBounds(cfg, st).min }, productOf(cfg).ref_price);
  return atMin >= sg.refuse_below
    ? `Les ${sg.name} te trouvent trop cher`
    : `Les ${sg.name} trouvent ta qualité trop faible`;
}

export function priceFloat(text, cls) { floatText($('price-value'), text, cls); }
