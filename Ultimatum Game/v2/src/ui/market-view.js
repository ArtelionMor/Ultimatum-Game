// Market screen: one tab per item market. For the selected market: monopoly
// status, the price, then swipeable pie-chart cards (all customers, then one
// per segment once revealed).

import { previewPreference, segmentShare, score } from '../market.js';
import { unitCost } from '../factory.js';
import { mkOf, sellersOf, shareOf, priceBounds, setPrice, monopolistOf, nudgePrice, priceToPos, posToPrice } from '../sim.js';
import { price as fPrice, pct, stars, money } from '../format.js';
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
  // The slider runs 0..1000 on a log scale (see priceToPos).
  slider.addEventListener('input', () => apply(posToPrice(G.cfg, priceBounds(G.cfg, G.st, G.market), Number(slider.value) / 1000)));
  holdRepeat($('price-minus'), () => apply(nudgePrice(G.cfg, G.st.mk[G.market].you.price, -1), 'btn'));
  holdRepeat($('price-plus'), () => apply(nudgePrice(G.cfg, G.st.mk[G.market].you.price, 1), 'btn'));
  $('cards').addEventListener('scroll', paintDots, { passive: true });
  // Cards are refreshed in place, so "?" clicks are caught on the container.
  $('cards').addEventListener('click', e => { const b = e.target.closest('[data-help]'); if (b) openHelp(b.dataset.help); });
  $('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
  $('help').addEventListener('click', e => { if (e.target.id === 'help') $('help').classList.add('hidden'); });
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
  if (document.activeElement !== slider) slider.value = Math.round(priceToPos(cfg, b, you.price) * 1000);
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

function card(title, sub, parts, legend, crown = '', help = '') {
  return `<div class="pcard">${help ? `<button class="pc-help" data-help="${help}" aria-label="Explications">?</button>` : ''}<div class="pcard-title">${title}</div><div class="pcard-sub">${sub}</div>
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
  const seller = id => (id === 'you' ? m.you : m.rivals.find(r => r.id === id));
  const cards = [card('📊 Tout le marché', `Ta part : <b>${pct(sh.you)}</b>`,
    meta.map(s => ({ value: sh[s.id], color: s.color })),
    meta.map(s => row(s, sh[s.id], `<span>${s.id === holder ? '👑 ' : ''}${fPrice(seller(s.id).price)} · <span class="q">${stars(seller(s.id).quality)}</span></span>`)).join(''),
    holder ? '👑' : '', 'all')];

  if (st.unlocked.segments) {
    const pref = previewPreference(mk, sellersOf(st, G.market));
    for (const sg of mk.segments) {
      const t = m.shares.seg[sg.id], tot = t.demand || 1, lost = t.refused + t.noStock;
      const verdict = pref[sg.id].refused.you ? refusal(sg, mk) : verdictOf(sg, segmentShare(m.shares, sg.id, 'you'));
      const legend = meta.map(s => row(s, t.by[s.id] / tot)).join('')
        + (lost / tot > 0.02 ? row({ id: 'lost', color: '#3a3f4d', icon: '🚶', name: 'Sans achat' }, lost / tot) : '');
      cards.push(card(`${sg.icon} ${sg.name}`, verdict,
        [...meta.map(s => ({ value: t.by[s.id], color: s.color })), { value: lost, color: '#3a3f4d' }], legend, '', sg.id));
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

// --- "?" help sheet ------------------------------------------------------------------

const SCALE = [
  { key: 'love', icon: '❤️', name: "t'adorent", what: "50 % ou plus d'entre eux achètent chez toi." },
  { key: 'like', icon: '🙂', name: "t'apprécient", what: 'Entre 25 et 50 % achètent chez toi.' },
  { key: 'doubt', icon: '🤔', name: 'hésitent', what: 'Entre 5 et 25 % : un ou plusieurs rivaux leur plaisent plus.' },
  { key: 'flee', icon: '🏃', name: 'te fuient', what: 'Moins de 5 % : un rival leur plaît bien plus que toi.' },
  { key: 'refuse', icon: '🚫', name: 'te refusent', what: "Ton offre est sous leur seuil (trop cher ou qualité trop faible) : ils n'achètent rien chez toi." },
];
const scaleKey = mine => (mine >= 0.5 ? 'love' : mine >= 0.25 ? 'like' : mine >= 0.05 ? 'doubt' : 'flee');
const gauge = (v, max) => { const n = v > 0 ? Math.max(1, Math.round(v / max * 4)) : 0; return '●'.repeat(n) + '○'.repeat(4 - n); };

function openHelp(key) {
  const { cfg, st } = G;
  const mk = mkOf(cfg, G.market), m = st.mk[G.market], you = m.you;
  const row = cfg.markets.find(r => r.id === G.market);
  let title, body;
  if (key === 'all') {
    title = `📊 ${row.icon} ${row.name} : tout le marché`;
    body = `<p>Le camembert montre <b>qui vend</b> sur ce marché, sur les dernières secondes. Ta part = tes ventes ÷ toutes les ventes.</p>
      <p>Les clients sont de 3 types (fais glisser les cartes) : chacun pèse le <b>prix</b> et la <b>qualité ★</b> à sa façon, puis se répartit entre les vendeurs qu'il accepte. Le meilleur rapport attire le plus, mais pas tout le monde.</p>
      <p>👑 <b>Monopole</b> : tiens ${pct(cfg.monopoly.share)} du marché pendant ${cfg.monopoly.hold_s} s. Les clients deviennent alors fidèles à toi (bonus d'attrait), et plus le monopole dure, plus il est dur à casser.</p>
      <p>Ta part est aussi limitée par ta <b>production</b> : si ton stock est vide, les clients vont ailleurs.</p>`;
  } else {
    const sg = mk.segments.find(x => x.id === key);
    const segs = mk.segments, maxA = Math.max(...segs.map(x => x.a)), maxB = Math.max(...segs.map(x => x.b)), maxC = Math.max(...segs.map(x => x.c || 0)) || 1;
    const sellers = sellersOf(st, G.market), pref = previewPreference(mk, sellers);
    const sc = s => score(sg, s, mk.ref_price);
    const t = m.shares.seg[sg.id], mine = segmentShare(m.shares, sg.id, 'you');
    const refused = pref[sg.id].refused.you;
    const cur = refused ? 'refuse' : scaleKey(mine);
    const starWorth = sg.b * mk.ref_price / sg.a;     // $ of price a customer trades for +1★
    // Their favourite rival right now.
    let fav = null, favShare = -1;
    for (const r of m.rivals) { const v = (t.by[r.id] || 0) / (t.demand || 1); if (v > favShare) { favShare = v; fav = r; } }
    const favDef = fav && cfg.rivals.find(x => x.market === G.market && x.id === fav.id);
    const bounds = priceBounds(cfg, st, G.market);
    let tip;
    if (refused) {
      // Highest price they accept at your quality, lowest quality they accept at your floor price.
      const maxP = (sg.b * you.quality + (sg.c || 0) * you.brand - sg.refuse_below) * mk.ref_price / sg.a;
      const minQ = (sg.refuse_below + sg.a * bounds.min / mk.ref_price - (sg.c || 0) * you.brand) / sg.b;
      tip = maxP >= bounds.min
        ? `👉 Ils n'acceptent pas plus de <b>${fPrice(Math.floor(maxP / bounds.step) * bounds.step)}</b> pour ta qualité ${stars(you.quality)} : baisse ton prix sous ce seuil.`
        : `👉 Même à ton prix le plus bas, il leur faut au moins <b>★${Math.ceil(minQ * 10) / 10}</b> : monte ta qualité avec l'Amélioration.`;
    } else if (cur === 'love') {
      tip = '👉 Ils t\'adorent : tu peux essayer de monter un peu ton prix pour gagner plus par vente.';
    } else if (fav) {
      const gap = sc(fav) - sc(you);
      if (gap <= 0) tip = '👉 Tu les intéresses autant que leur favori : produis plus pour ne jamais être en rupture.';
      else {
        const dp = gap * mk.ref_price / sg.a, dq = gap / sg.b;
        const newP = Math.max(0, you.price - dp);
        const priceWay = newP >= bounds.min ? `baisse ton prix d'environ <b>${fPrice(Math.ceil(dp * 10) / 10)}</b> (→ ${fPrice(Math.floor(newP / bounds.step) * bounds.step)})` : null;
        const qualWay = `gagne <b>+${(Math.ceil(dq * 10) / 10)}★</b> de qualité`;
        tip = `👉 Pour faire jeu égal avec ${favDef.icon} ${favDef.name} : ${priceWay ? (sg.a / sg.b > 2 ? `${priceWay}, ou ${qualWay}` : `${qualWay}, ou ${priceWay}`) : `${qualWay} (baisser ton prix ne suffirait pas : tu serais sous ton coût)`}.`;
      }
    } else tip = '';
    title = `${sg.icon} ${sg.name} · ${row.icon} ${row.name}`;
    body = `<p class="h-lead">${sg.demand_per_min} clients/min sur ce marché.</p>
      <div class="h-head">Ce qui compte pour eux</div>
      <div class="h-gauges"><div>💰 Prix bas <b>${gauge(sg.a, maxA)}</b></div><div>⭐ Qualité <b>${gauge(sg.b, maxB)}</b></div><div>👑 Fidélité au monopole <b>${gauge(sg.c || 0, maxC)}</b></div></div>
      <p>Pour eux, <b>+1★ vaut ${money(starWorth)}</b> de prix en plus.</p>
      <div class="h-head">Ce que veut dire le verdict</div>
      <ul class="h-scale">${SCALE.map(x => `<li class="${x.key === cur ? 'on' : ''}"><span>${x.icon}</span><div><b>${x.name}</b><br>${x.what}</div></li>`).join('')}</ul>
      <div class="h-head">Chez toi maintenant</div>
      <p><b>${pct(mine)}</b> d'entre eux achètent chez toi, à ${fPrice(you.price)} en ${stars(you.quality)}.${favDef ? ` Leur favori : ${favDef.icon} ${favDef.name} (${fPrice(fav.price)}, ${stars(fav.quality)}, ${pct(favShare)}).` : ''}</p>
      ${tip ? `<p class="h-tip">${tip}</p>` : ''}`;
  }
  $('help-title').textContent = title;
  $('help-body').innerHTML = body;
  $('help').classList.remove('hidden');
  play('tab', 0.25);
}
