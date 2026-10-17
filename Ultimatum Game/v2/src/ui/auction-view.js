// Recipes UI:
// - Auction tab: the current auction EVENT (recipe cards, bids, timers) or the
//   countdown to the next one, and the offers received / sent.
// - Recipes drawer (📜 in the HUD): the player's recipes (apply to all machines,
//   back to base) and the rivals' (make them an offer).
// - Offer notification: a rival's buy offer stays at the bottom of the screen
//   until the player accepts or refuses it.

import { bid, bidPrice, acceptOffer, refuseOffer, makeOffer, rarityOf, rivalByRef, applyRecipeAll, recipeUse,
  unseenRecipes, markRecipesSeen, eventRunning, listRecipe, unlistRecipe, saleState } from '../auction.js';
import { baseRecipe, machineDef } from '../grid.js';
import { money } from '../format.js';
import { floatText } from './fx.js';
import { play } from './sound.js';

const $ = id => document.getElementById(id);
let G, sub = 'lots', bound = false;

export function setAuctionSub(s) { sub = s; if ($('auc-body')) $('auc-body').dataset.html = ''; }

export function initAuction(game) {
  G = game;
  if (bound) return;
  bound = true;
  $('auc-tabs').querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => {
    sub = b.dataset.sub; play('tick', 0.2);
    $('auc-body').dataset.html = '';
    renderAuction();
  }));
  $('recipes-btn').addEventListener('click', openRecipes);
  $('recipes-close').addEventListener('click', closeRecipes);
  $('recipes-close-bottom').addEventListener('click', closeRecipes);   // in thumb reach
  $('recipes-drawer').addEventListener('click', e => { if (e.target.id === 'recipes-drawer') closeRecipes(); });
  // Rebuilt often: clicks are caught on the containers.
  $('recipes-body').addEventListener('click', onRecipesClick);
  $('auc-body').addEventListener('click', onAuctionClick);
  $('offer-notif').addEventListener('click', onNotifClick);
}

const iconOfStage = s => G.cfg.markets.find(m => m.stage === s)?.icon || '?';
const rec = id => G.cfg.recipes.find(r => r.id === id);

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

// The recipe most of the player's machines of that type run (null if none built).
function equippedOn(type) {
  const ms = G.st.grid.machines.filter(m => m.type === type);
  if (!ms.length) return null;
  const count = {};
  for (const m of ms) { const id = m.recipe || baseRecipe(G.cfg, type).id; count[id] = (count[id] || 0) + 1; }
  const id = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
  return { r: rec(id) || baseRecipe(G.cfg, type), n: count[id], total: ms.length };
}

// Card: the struck line is what the player runs today (or the base recipe),
// the green line is this card; a chip says what is equipped.
// Boxed "E" next to a recipe the player owns: equipped somewhere or not.
function eqBadge(r) {
  if (!G.st.auc.owned[r.id]) return '';
  const u = recipeUse(G.st, r);
  return u.using ? `<span class="eq-badge on" title="Équipée ${u.using}/${u.total}">E</span>`
    : '<span class="eq-badge" title="Pas équipée">E</span>';
}

// The one number a recipe card shows, compared with the machine's base recipe:
// harvests -> speed (outputs/min); transformers -> outputs per input item.
// A transformer with the same yield but a faster pace shows its speed instead.
function recipeGain(cfg, r) {
  const b = baseRecipe(cfg, r.machine), num = x => String(Math.round(x * 100) / 100).replace('.', ',');
  const speed = (r.outputs * r.rate_mult) / (b.outputs * b.rate_mult);
  if (!r.inputs) return `⚡ ×${num(speed)}`;
  const yieldGain = (r.outputs / r.inputs) / (b.outputs / b.inputs);
  if (Math.abs(yieldGain - 1) < 1e-9 && r.rate_mult !== b.rate_mult) return `⚡ ×${num(r.rate_mult / b.rate_mult)}`;
  return `♻️ ×${num(yieldGain)} <small>par matière</small>`;
}

function card(r, body) {
  const { cfg } = G, rar = rarityOf(cfg, r), d = machineDef(cfg, r.machine);
  const eq = equippedOn(r.machine), isEq = eq && eq.r.id === r.id;
  const ref = !eq || isEq ? baseRecipe(cfg, r.machine) : eq.r;
  // Rarity rank: C < PC < R < SR < UR < L; a base recipe has no rank (-1).
  const rank = x => (x.base ? -1 : cfg.rarities.findIndex(k => k.id === x.rarity));
  const tag = x => (x.base ? '<span class="rc-mini base">Base</span>'
    : `<span class="rc-mini" style="--rar:${rarityOf(cfg, x).color}">${x.rarity}</span>`);
  let chip = '';
  if (isEq) chip = '';   // the boxed E next to the name already says it
  else if (eq) {
    const diff = rank(r) - rank(eq.r);
    const verdict = diff > 0 ? '<span class="rc-vs up">⬆ Meilleur rang</span>'
      : diff < 0 ? '<span class="rc-vs down">⬇ Rang inférieur</span>' : '<span class="rc-vs same">= Même rang</span>';
    chip = verdict;
  }
  return `<div class="rcard" style="--rar:${rar.color}">
    <div class="rc-top"><span class="rc-rar">${rar.id}</span><span class="rc-machine">${d.icon} ${d.name}</span></div>
    <div class="rc-namerow"><div class="rc-name">${r.name} ${eqBadge(r)}</div>${chip ? `<div class="rc-eqrow">${chip}</div>` : ''}</div>
    <div class="rc-speed">${recipeGain(cfg, r)}</div>
    ${body}</div>`;
}

// Timers tick in place: rebuilding would swap buttons under the finger.
function fill(box, html) {
  const tick = () => box.querySelectorAll('[data-ends]').forEach(el => { el.textContent = '⏱ ' + timeLeft(Number(el.dataset.ends) - G.st.t); });
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  tick();
}

// --- Auction tab -------------------------------------------------------------------

export function renderAuction() {
  const { cfg, st } = G, a = st.auc;
  $('auc-tabs').querySelectorAll('[data-sub]').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  $('auc-offers-dot').classList.toggle('hidden', !a.offersIn.length);
  let html;
  if (sub === 'lots') {
    if (eventRunning(st)) {
      const ends = Math.max(...a.lots.map(l => l.ends));
      html = `<div class="auc-banner live">🔨 En cours · <span data-ends="${ends}"></span></div>`
        + a.lots.map(l => {
          const r = rec(l.recipe), price = bidPrice(l), lead = l.bidder === 'you', mine = l.seller === 'you';
          return card(r, `<div class="rc-bid"><span><b>${money(l.bid)}</b>${l.bidder ? ` · ${who(l.bidder)}` : ''}</span><span class="rc-time" data-ends="${l.ends}"></span></div>
            ${mine ? `<div class="rc-lead">📤 Ta recette</div>`
              : lead ? '<div class="rc-lead">✓ Tu mènes</div>'
              : `<button class="btn small rc-btn ${st.money < price ? 'cant' : ''}" data-bid="${l.id}">Enchérir ${money(price)}</button>`}
            ${l.seller && !mine ? `<div class="rc-note">🔁 ${who(l.seller)}</div>` : ''}`);
        }).join('');
    } else {
      html = `<div class="auc-banner">🔨 Prochaine vente <b data-ends="${a.eventAt}"></b></div>`;
    }
  } else {
    const ins = a.offersIn.map(o => card(rec(o.recipe), `<div class="rc-bid"><span>${who(o.from)} · <b>${money(o.price)}</b></span></div>
      <div class="rc-offers"><button class="btn small danger" data-refuse="${o.id}">Refuser</button><button class="btn small rc-btn" data-accept="${o.id}">Vendre</button></div>`)).join('');
    const outs = a.offersOut.map(o => `<div class="rc-empty">⏳ ${money(o.amount)} → ${who(o.to)}</div>`).join('');
    html = '<div class="rc-head">✉️ Offres reçues</div>' + (ins || '<div class="rc-empty">Aucune offre.</div>')
      + (outs ? '<div class="rc-head">📤 Tes offres</div>' + outs : '');
  }
  fill($('auc-body'), html);
}

function onAuctionClick(e) {
  const { cfg, st } = G, b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.bid) {
    const r = bid(cfg, st, Number(b.dataset.bid));
    if (r.ok) { play('buy'); floatText(b, `-${money(r.price)}`, 'bad'); G.onAction('bid'); }
    else floatText(b, 'Pas assez d’argent', 'bad');
  } else if (b.dataset.accept) { if (acceptOffer(cfg, st, Number(b.dataset.accept))) { play('buy'); G.onAction('sellRecipe'); } }
  else if (b.dataset.refuse) { refuseOffer(cfg, st, Number(b.dataset.refuse)); G.onAction('refuse'); }
}

// --- Recipes drawer ------------------------------------------------------------------

function openRecipes() {
  markRecipesSeen(G.st);          // red dots light up only once
  $('recipes-drawer').classList.remove('hidden');
  play('tab', 0.25);
  renderRecipes();
  G.onAction('recipesSeen');
}
const closeRecipes = () => $('recipes-drawer').classList.add('hidden');
export const openRecipesDrawer = openRecipes;

export function renderRecipes() {
  if ($('recipes-drawer').classList.contains('hidden')) return;
  const { cfg, st } = G, a = st.auc;
  const mine = Object.keys(a.owned).map(rec);
  const theirs = Object.entries(a.rivalOwned).map(([id, ref]) => ({ r: rec(id), ref }));
  const html = '<div class="rc-head">📜 Tes recettes</div>'
    + (mine.length ? mine.map(r => {
      const u = recipeUse(st, r), d = machineDef(cfg, r.machine), sale = saleState(st, r.id);
      const sell = sale === 'live' ? '<div class="rc-lead">📤 En vente</div>'
        : sale === 'queued' ? `<div class="rc-offers"><span class="rc-note">📤 Prochaine vente</span><button class="btn small" data-unlist="${r.id}">Retirer</button></div>`
        : `<div class="rc-offers"><button class="btn small" data-list="${r.id}">📤 Vendre aux enchères</button></div>`;
      const btns = u.total === 0
        ? ''
        : `<div class="rc-offers">${u.using > 0 ? `<button class="btn small" data-base="${r.machine}">Base</button>` : ''}${u.using < u.total
            ? `<button class="btn small rc-btn" data-apply="${r.id}">Équiper ${d.icon} ×${u.total}</button>` : ''}</div>`;
      return card(r, `${btns}${sell}`);
    }).join('') : '<div class="rc-empty">Aucune.</div>')
    + '<div class="rc-head">⚔️ Chez tes rivaux</div>'
    + (theirs.length ? theirs.map(({ r, ref }) => {
      const pending = a.offersOut.find(o => o.recipe === r.id);
      const asks = [1, 1.3, 1.7].map(k => Math.ceil(r.value * k));
      return card(r, `<div class="rc-bid"><span>${who(ref)}</span></div>
        ${pending ? `<div class="rc-lead">⏳ ${money(pending.amount)}…</div>`
          : `<div class="rc-offers">${asks.map(p => `<button class="btn small ${st.money < p ? 'cant' : ''}" data-offer="${r.id}" data-amount="${p}">Offrir ${money(p)}</button>`).join('')}</div>`}`);
    }).join('') : '<div class="rc-empty">Aucune.</div>');
  fill($('recipes-body'), html);
}

function onRecipesClick(e) {
  const { cfg, st } = G, b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.apply) {
    const r = rec(b.dataset.apply);
    const n = applyRecipeAll(cfg, st, r.machine, r.id);
    play('buy'); floatText(b, `${n} machine${n > 1 ? 's' : ''} → ${r.name}`, 'gold'); G.onAction('recipe');
  } else if (b.dataset.base) {
    const n = applyRecipeAll(cfg, st, b.dataset.base, null);
    play('tick', 0.3); floatText(b, `${n} en recette de base`, 'gold'); G.onAction('recipe');
  } else if (b.dataset.list) {
    const running = eventRunning(st);
    if (listRecipe(cfg, st, b.dataset.list)) { play('tick', 0.4); floatText(b, running ? 'En vente maintenant !' : 'À la prochaine enchère', 'gold'); G.onAction('list'); }
  } else if (b.dataset.unlist) {
    unlistRecipe(st, b.dataset.unlist); play('tick', 0.3); G.onAction('unlist');
  } else if (b.dataset.offer) {
    if (makeOffer(cfg, st, b.dataset.offer, Number(b.dataset.amount))) { play('tick', 0.4); G.onAction('offer'); }
    else floatText(b, 'Pas assez d’argent', 'bad');
  }
  renderRecipes();
}

export const recipesDot = () => unseenRecipes(G.cfg, G.st).length > 0;

// --- Offer notification (stays until answered) ----------------------------------------

export function renderOfferNotif() {
  const { st } = G, o = st.auc.offersIn[0], box = $('offer-notif');
  $('app').classList.toggle('has-notif', !!o);
  if (!o) { box.classList.add('hidden'); box.dataset.html = ''; return; }
  const r = rec(o.recipe), more = st.auc.offersIn.length - 1, d = machineDef(G.cfg, r.machine);
  const tier = `<span class="rc-mini" style="--rar:${rarityOf(G.cfg, r).color}">${r.rarity}</span> ${d.icon} ${eqBadge(r)}`;
  // Short: who, which recipe (rank + machine + E), how much.
  const html = `<div class="on-text">✉️ <b>${who(o.from)}</b> · ${tier} → <b>${money(o.price)}</b>${more ? ` <span class="muted">(+${more})</span>` : ''}</div>
    <div class="on-btns"><button class="btn small danger" data-refuse="${o.id}">Refuser</button><button class="btn small rc-btn" data-accept="${o.id}">Vendre</button></div>`;
  fill(box, html);
  box.classList.remove('hidden');
}

function onNotifClick(e) {
  const { cfg, st } = G, b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.accept) { if (acceptOffer(cfg, st, Number(b.dataset.accept))) { play('buy'); floatText($('money'), 'Recette vendue', 'gold'); } }
  else if (b.dataset.refuse) { refuseOffer(cfg, st, Number(b.dataset.refuse)); play('tick', 0.3); }
  G.onAction('offerAnswer');
}
