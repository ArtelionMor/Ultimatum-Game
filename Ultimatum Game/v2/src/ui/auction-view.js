// Auction screen (Wiki-Masters style): recipe cards up for auction, the
// player's recipes and the rivals' (make them an offer), and incoming offers.

import { bid, bidPrice, acceptOffer, refuseOffer, makeOffer, rarityOf, rivalByRef } from '../auction.js';
import { baseRecipe, machineDef } from '../grid.js';
import { money } from '../format.js';
import { floatText } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
let G, sub = 'lots', bound = false;

export function initAuction(game) {
  G = game;
  if (bound) return;
  bound = true;
  $('auc-tabs').querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => {
    sub = b.dataset.sub; play('tick', 0.2);
    $('auc-body').dataset.html = '';
    renderAuction();
  }));
}

const iconOfStage = s => G.cfg.markets.find(m => m.stage === s)?.icon || '?';

// "2 🍋 → 1 🧃 · vitesse ×1.5" — what a recipe does, in one line.
export function recipeText(cfg, r) {
  const d = machineDef(cfg, r.machine);
  const outI = iconOfStage(d.output_stage);
  let s;
  if (d.kind === 'refine') s = `${r.inputs} ${outI}★n → ${r.outputs} ${outI}★n+1`;
  else if (d.input_stage === null) s = `→ ${r.outputs} ${outI}${r.out_tier > 1 ? ` ★${r.out_tier}` : ''}`;
  else s = `${r.inputs} ${iconOfStage(d.input_stage)} → ${r.outputs} ${outI}`;
  if (r.rate_mult !== 1) s += ` · vitesse ×${r.rate_mult}`;
  return s;
}

const timeLeft = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const who = ref => { if (ref === 'you') return '🏭 Toi'; const r = rivalByRef(G.cfg, ref); return r ? `${r.icon} ${r.name}` : '—'; };

function card(r, body) {
  const { cfg } = G, rar = rarityOf(cfg, r), d = machineDef(cfg, r.machine), base = baseRecipe(cfg, r.machine);
  return `<div class="rcard" style="--rar:${rar.color}">
    <div class="rc-top"><span class="rc-rar">${rar.id}</span><span class="rc-machine">${d.icon} ${d.name}</span></div>
    <div class="rc-name">${r.name}</div>
    <div class="rc-formula"><s>${recipeText(cfg, base)}</s><b>${recipeText(cfg, r)}</b></div>
    ${body}</div>`;
}

export function renderAuction() {
  const { cfg, st } = G, a = st.auc;
  $('auc-tabs').querySelectorAll('[data-sub]').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  $('auc-offers-dot').classList.toggle('hidden', !a.offersIn.length);
  const rec = id => cfg.recipes.find(r => r.id === id);
  let html = '';
  if (sub === 'lots') {
    html = a.lots.length ? a.lots.map(l => {
      const r = rec(l.recipe), price = bidPrice(l), lead = l.bidder === 'you';
      return card(r, `<div class="rc-bid"><span>${l.bidder ? `Mise ${money(l.bid)} · ${who(l.bidder)}` : `Mise de départ ${money(l.bid)}`}</span><span class="rc-time" data-ends="${l.ends}"></span></div>
        ${lead ? '<div class="rc-lead">✓ Tu mènes l’enchère</div>'
          : `<button class="btn small rc-btn ${st.money < price ? 'cant' : ''}" data-bid="${l.id}">Enchérir ${money(price)}</button>`}
        ${l.seller ? `<div class="rc-note">Revendue par ${who(l.seller)}</div>` : ''}`);
    }).join('') : '<div class="rc-empty">Pas d’enchère en cours : une nouvelle carte arrive bientôt.</div>';
  } else if (sub === 'mine') {
    const mine = Object.keys(a.owned).map(rec);
    const theirs = Object.entries(a.rivalOwned).map(([id, ref]) => ({ r: rec(id), ref }));
    html = '<div class="rc-head">📜 Tes recettes</div>'
      + (mine.length ? mine.map(r => card(r, '<div class="rc-note">Choisis-la dans le widget d’une machine (⇄).</div>')).join('')
        : '<div class="rc-empty">Aucune pour l’instant : gagne une enchère ou rachète-en une à un rival.</div>')
      + '<div class="rc-head">⚔️ Chez tes rivaux</div>'
      + (theirs.length ? theirs.map(({ r, ref }) => {
        const pending = a.offersOut.find(o => o.recipe === r.id);
        const asks = [1, 1.3, 1.7].map(k => Math.ceil(r.value * k));
        return card(r, `<div class="rc-bid"><span>Chez ${who(ref)}</span></div>
          ${pending ? `<div class="rc-lead">⏳ Offre de ${money(pending.amount)} envoyée…</div>`
            : `<div class="rc-offers">${asks.map(p => `<button class="btn small ${st.money < p ? 'cant' : ''}" data-offer="${r.id}" data-amount="${p}">Offrir ${money(p)}</button>`).join('')}</div>`}`);
      }).join('') : '<div class="rc-empty">Aucun rival n’a de recette pour l’instant.</div>');
  } else {
    html = a.offersIn.length ? a.offersIn.map(o => {
      const r = rec(o.recipe);
      return card(r, `<div class="rc-bid"><span>${who(o.from)} t’en offre <b>${money(o.price)}</b></span><span class="rc-time" data-ends="${o.expires}"></span></div>
        <div class="rc-offers"><button class="btn small danger" data-refuse="${o.id}">Refuser</button><button class="btn small rc-btn" data-accept="${o.id}">Vendre</button></div>
        <div class="rc-note">Vendue, elle renforce ce rival et tes machines qui l’utilisent repassent en recette de base.</div>`);
    }).join('') : '<div class="rc-empty">Aucune offre reçue. Les rivaux te feront des offres pour tes recettes.</div>';
  }
  const box = $('auc-body');
  // Timers tick in place: rebuilding the cards would swap buttons under the finger.
  const tickTimers = () => box.querySelectorAll('[data-ends]').forEach(el => { el.textContent = '⏱ ' + timeLeft(Number(el.dataset.ends) - st.t); });
  if (box.dataset.html === html) { tickTimers(); return; }
  box.dataset.html = html;
  box.innerHTML = html;
  tickTimers();
  box.querySelectorAll('[data-bid]').forEach(b => b.addEventListener('click', () => {
    const r = bid(cfg, st, Number(b.dataset.bid));
    if (r.ok) { play('buy'); floatText(b, `-${money(r.price)}`, 'bad'); G.onAction('bid'); }
    else floatText(b, 'Pas assez d’argent', 'bad');
  }));
  box.querySelectorAll('[data-offer]').forEach(b => b.addEventListener('click', () => {
    if (makeOffer(cfg, st, b.dataset.offer, Number(b.dataset.amount))) { play('tick', 0.4); G.onAction('offer'); }
    else floatText(b, 'Pas assez d’argent', 'bad');
  }));
  box.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => {
    if (acceptOffer(cfg, st, Number(b.dataset.accept))) { play('buy'); G.onAction('sellRecipe'); }
  }));
  box.querySelectorAll('[data-refuse]').forEach(b => b.addEventListener('click', () => { refuseOffer(st, Number(b.dataset.refuse)); G.onAction('refuse'); }));
}
