// Market screen: one tab per item market. For the selected market: monopoly
// status, the price, then swipeable pie-chart cards (all customers, then one
// per segment once revealed).

import { previewPreference, segmentShare, score } from '../market.js';
import { unitCost } from '../factory.js';
import { mkOf, sellersOf, shareOf, priceBounds, setPrice, monopolistOf } from '../sim.js';
import { price as fPrice, pct, stars } from '../format.js';
import { retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const YOU_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--you').trim() || '#3ddc84';

let G, bound = false;

// Markets the player can see: the ones whose item has reached an Outcome.
export const openMarkets = (cfg, st) => cfg.markets.filter(r => st.stats.delivered[r.id] > 0);

export function initMarket(game) {
  G = game;
  if (bound) return;
  bound = true;
  const slider = $('price-slider');
  const apply = (p, src) => {
    if (setPrice(G.cfg, G.st, G.market, p)) {
      G.onAction('price');
      renderPrice();
      if (src) { retrigger($('price-value'), 'bump'); play('tick', 0.25); }
    }
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  const step = () => priceBounds(G.cfg, G.st, G.market).step;
  holdRepeat($('price-minus'), () => apply(G.st.mk[G.market].you.price - step(), 'btn'));
  holdRepeat($('price-plus'), () => apply(G.st.mk[G.market].you.price + step(), 'btn'));
  $('cards').addEventListener('scroll', paintDots, { passive: true });
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

function renderTabs() {
  const { cfg, st } = G;
  const open = openMarkets(cfg, st);
  if (!open.find(r => r.id === G.market)) G.market = (open[0] || cfg.markets[0]).id;
  const html = open.map(r => `<button class="mtab ${r.id === G.market ? 'active' : ''}" data-m="${r.id}">${r.icon} ${r.name}${
    monopolistOf(st, r.id) ? `<span class="crown">${monopolistOf(st, r.id) === 'you' ? '👑' : '⚠️'}</span>` : ''}</button>`).join('');
  const box = $('market-tabs');
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
    box.classList.toggle('hidden', open.length < 2);
    box.querySelectorAll('.mtab').forEach(b => b.addEventListener('click', () => {
      G.market = b.dataset.m; play('tab', 0.25);
      $('cards').innerHTML = ''; $('cards').scrollLeft = 0;
      renderMarket();
    }));
  }
}

function renderPrice() {
  const { cfg, st } = G;
  const row = cfg.markets.find(r => r.id === G.market), you = st.mk[G.market].you;
  const b = priceBounds(cfg, st, G.market);
  const slider = $('price-slider');
  slider.min = b.min; slider.max = b.max; slider.step = b.step;
  if (document.activeElement !== slider) slider.value = you.price;
  const m = you.price - unitCost(row, you.quality);
  $('price-value').textContent = fPrice(you.price);
  $('margin').textContent = (m >= 0 ? '+' : '') + fPrice(m);
  $('margin').classList.toggle('neg', m <= 0);
  $('quality').textContent = stars(you.quality);
}

const sellersMeta = () => [
  { id: 'you', name: 'Toi', icon: '🏭', color: YOU_COLOR },
  ...G.cfg.rivals.filter(r => r.market === G.market).map(c => ({ id: c.id, name: c.name, icon: c.icon, color: c.color })),
];

function renderBanner(meta) {
  const { cfg, st } = G;
  const m = st.mk[G.market], holder = monopolistOf(st, G.market), mono = cfg.monopoly;
  const el = $('mono-banner');
  let html = '', cls = 'mono';
  if (holder) {
    const who = meta.find(s => s.id === holder);
    html = holder === 'you'
      ? `👑 Tu as le monopole ! Bonus d'attrait +${m.brands.you.M.toFixed(2)}`
      : `⚠️ ${who.icon} ${who.name} a le monopole (attrait +${m.brands[holder].M.toFixed(2)}). Casse-le !`;
    cls += holder === 'you' ? ' you' : ' rival';
  } else {
    const b = m.brands.you, sh = shareOf(st, G.market).you;
    html = b.hold > 0
      ? `⏱ Monopole dans ${Math.ceil(mono.hold_s - b.hold)} s : garde ${pct(mono.share)} du marché !`
      : `🎯 Monopole : tiens ${pct(mono.share)} de ce marché pendant ${mono.hold_s} s (tu as ${pct(sh)})`;
    html += `<div class="bar"><div class="bar-fill" style="width:${(b.hold > 0 ? b.hold / mono.hold_s : sh / mono.share) * 100}%;background:var(--gold)"></div></div>`;
    if (b.M > 0.01) html += `<div class="small">Il te reste un bonus d'attrait de +${b.M.toFixed(2)}</div>`;
  }
  if (el.dataset.html !== html + cls) { el.innerHTML = html; el.className = cls; el.dataset.html = html + cls; }
}

// CSS conic-gradient pie from [{ value, color }].
function pie(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return 'var(--panel2)';
  let acc = 0;
  const stops = parts.map(p => {
    const a0 = acc / total * 360; acc += p.value;
    return `${p.color} ${a0.toFixed(1)}deg ${(acc / total * 360).toFixed(1)}deg`;
  });
  return `conic-gradient(${stops.join(',')})`;
}

const row = (s, value, extra = '') =>
  `<div class="${s.id === 'you' ? 'you' : ''}"><i style="background:${s.color}"></i>${s.icon} ${s.name}${extra}<b>${pct(value)}</b></div>`;

function card(title, sub, parts, legend, crown = '') {
  return `<div class="pcard"><div class="pcard-title">${title}</div><div class="pcard-sub">${sub}</div>
    <div class="pie-wrap"><div class="pie" style="background:${pie(parts)}"></div>${crown ? `<span class="crown">${crown}</span>` : ''}</div>
    <div class="pleg">${legend}</div></div>`;
}

export function renderMarket() {
  const { cfg, st } = G;
  renderTabs();
  renderPrice();
  const meta = sellersMeta();
  renderBanner(meta);
  const m = st.mk[G.market], mk = mkOf(cfg, G.market);
  const sh = shareOf(st, G.market);
  const holder = monopolistOf(st, G.market);
  const priceOf = id => id === 'you' ? m.you.price : m.rivals.find(r => r.id === id).price;
  const cards = [card('📊 Tout le marché', `Ta part : <b>${pct(sh.you)}</b>`,
    meta.map(s => ({ value: sh[s.id], color: s.color })),
    meta.map(s => row(s, sh[s.id], `<span>${s.id === holder ? '👑 ' : ''}${fPrice(priceOf(s.id))}</span>`)).join(''),
    holder ? '👑' : '')];

  if (st.unlocked.segments) {
    const pref = previewPreference(mk, sellersOf(st, G.market));
    for (const sg of mk.segments) {
      const t = m.shares.seg[sg.id], tot = t.demand || 1, lost = t.refused + t.noStock;
      const verdict = pref[sg.id].refused.you ? refusal(sg, mk) : verdictOf(sg, segmentShare(m.shares, sg.id, 'you'));
      const legend = meta.map(s => row(s, t.by[s.id] / tot)).join('')
        + (lost / tot > 0.02 ? row({ id: 'lost', color: '#3a3f4d', icon: '🚶', name: 'Sans achat' }, lost / tot) : '');
      cards.push(card(`${sg.icon} ${sg.name}`, verdict,
        [...meta.map(s => ({ value: t.by[s.id], color: s.color })), { value: lost, color: '#3a3f4d' }], legend));
    }
  }

  const box = $('cards');
  if (box.children.length !== cards.length) {
    box.innerHTML = cards.join('');
    $('card-dots').innerHTML = cards.map(() => '<i></i>').join('');
    $('card-dots').classList.toggle('hidden', cards.length < 2);
    box.classList.toggle('pulse', cards.length > 1 && !st.seen.segments);
  } else {
    // Update in place so the swipe position is kept.
    const tmp = document.createElement('div');
    tmp.innerHTML = cards.join('');
    [...box.children].forEach((el, i) => { if (el.innerHTML !== tmp.children[i].innerHTML) el.innerHTML = tmp.children[i].innerHTML; });
  }
  paintDots();
}

function paintDots() {
  const box = $('cards');
  const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
  [...$('card-dots').children].forEach((d, k) => d.classList.toggle('on', k === i));
  if (i > 0 && G.st.unlocked.segments && !G.st.seen.segments) { G.st.seen.segments = true; box.classList.remove('pulse'); }
}

function verdictOf(sg, mine) {
  if (mine >= 0.5) return `Les ${sg.name} t'adorent`;
  if (mine >= 0.25) return `Les ${sg.name} t'apprécient`;
  if (mine >= 0.05) return `Les ${sg.name} hésitent`;
  return `Les ${sg.name} te fuient`;
}

// Too expensive if the lowest allowed price would be accepted, else quality.
function refusal(sg, mk) {
  const { cfg, st } = G;
  const you = st.mk[G.market].you;
  const atMin = score(sg, { quality: you.quality, price: priceBounds(cfg, st, G.market).min, brand: you.brand }, mk.ref_price);
  return atMin >= sg.refuse_below ? `Les ${sg.name} te trouvent trop cher` : `Les ${sg.name} trouvent ta qualité trop faible`;
}
