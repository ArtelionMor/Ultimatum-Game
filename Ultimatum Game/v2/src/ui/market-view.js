// Market screen: set the price, then swipe pie-chart cards (all customers,
// then one per segment once revealed).

import { previewPreference, segmentShare, score } from '../market.js';
import { unitCost } from '../factory.js';
import { productOf, sellersOf, shareOf, priceBounds, setPrice } from '../sim.js';
import { price as fPrice, pct, stars } from '../format.js';
import { retrigger } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
const YOU_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--you').trim() || '#3ddc84';

let G, bound = false;

export function initMarket(game) {
  G = game;
  if (bound) return;
  bound = true;
  const slider = $('price-slider');
  const apply = (p, src) => {
    if (setPrice(G.cfg, G.st, p)) {
      G.onAction('price');
      renderPrice();
      if (src) { retrigger($('price-value'), 'bump'); play('tick', 0.25); }
    }
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  const step = () => priceBounds(G.cfg, G.st).step;
  holdRepeat($('price-minus'), () => apply(G.st.you.price - step(), 'btn'));
  holdRepeat($('price-plus'), () => apply(G.st.you.price + step(), 'btn'));
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

function renderPrice() {
  const { cfg, st } = G;
  const b = priceBounds(cfg, st);
  const slider = $('price-slider');
  slider.min = b.min; slider.max = b.max; slider.step = b.step;
  if (document.activeElement !== slider) slider.value = st.you.price;
  const m = st.you.price - unitCost(productOf(cfg), st.you.quality);
  $('price-value').textContent = fPrice(st.you.price);
  $('margin').textContent = (m >= 0 ? '+' : '') + fPrice(m);
  $('margin').classList.toggle('neg', m <= 0);
  $('quality').textContent = stars(st.you.quality);
}

const sellersMeta = () => [
  { id: 'you', name: 'Toi', icon: '🧃', color: YOU_COLOR },
  ...G.cfg.competitors.map(c => ({ id: c.id, name: c.name.replace(/^Le /, ''), icon: c.icon, color: c.color })),
];

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

function card(title, sub, parts, legend) {
  return `<div class="pcard"><div class="pcard-title">${title}</div><div class="pcard-sub">${sub}</div>
    <div class="pie" style="background:${pie(parts)}"></div><div class="pleg">${legend}</div></div>`;
}

export function renderMarket() {
  const { cfg, st } = G;
  renderPrice();
  const meta = sellersMeta();
  const sh = shareOf(st);
  const priceOf = id => id === 'you' ? st.you.price : st.rivals.find(r => r.id === id).price;
  const cards = [card('📊 Tout le marché', `Ta part : <b>${pct(sh.you)}</b>`,
    meta.map(s => ({ value: sh[s.id], color: s.color })),
    meta.map(s => row(s, sh[s.id], `<span>${fPrice(priceOf(s.id))}</span>`)).join(''))];

  if (st.unlocked.segments) {
    const pref = previewPreference(cfg, productOf(cfg), sellersOf(st));
    for (const sg of cfg.segments) {
      const t = st.shares.seg[sg.id], tot = t.demand || 1, lost = t.refused + t.noStock;
      const verdict = pref[sg.id].refused.you ? refusal(sg) : verdictOf(sg, segmentShare(st.shares, sg.id, 'you'));
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
function refusal(sg) {
  const { cfg, st } = G;
  const atMin = score(sg, { quality: st.you.quality, price: priceBounds(cfg, st).min }, productOf(cfg).ref_price);
  return atMin >= sg.refuse_below ? `Les ${sg.name} te trouvent trop cher` : `Les ${sg.name} trouvent ta qualité trop faible`;
}
