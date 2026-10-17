// Boot, game loop, tabs, hints, reveal, monopoly effects, save. The simulation
// lives in sim.js (pure); this file only wires it to the DOM.

import { newGame, step, derive, migrate, SAVE_VERSION, sellersOf, stockInfo, mkOf, totalSold, monopolistOf } from './sim.js';
import { countOf, stageCapacity } from './grid.js';
import { unitCost } from './factory.js';
import { previewPreference } from './market.js';
import { checkReveal } from './reveal.js';
import { initHud, renderHud } from './ui/hud.js';
import { initMarket, renderMarket, openMarkets } from './ui/market-view.js';
import { initFactory, renderFactory, currentTool } from './ui/factory-view.js';
import { initDebug } from './ui/debug.js';
import { toast, floatText } from './ui/fx.js';
import { play } from './ui/sound.js';
import { money, perMin, pct } from './format.js';

const $ = id => document.getElementById(id);
const DT = 0.05;                      // fixed simulation step (s)
const SAVE_KEY = 'mu_v2_save';
const NO_SAVE = new URLSearchParams(location.search).has('nosave'); // test sessions

const G = {
  cfg: null, st: null, speed: 1, tab: 'factory', market: 'fruit',
  onAction,
  // Sales margin of every market.
  incomePerMin: () => {
    let inc = 0;
    for (const r of G.cfg.markets) {
      const m = G.st.mk[r.id];
      inc += m.shares.flow.you * 60 * (m.you.price - unitCost(r, m.you.quality));
    }
    return inc;
  },
  reset,
};
window.G = G; // handy from the console

async function boot() {
  G.cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  G.st = load() || newGame(G.cfg, (Math.random() * 2 ** 31) | 0);
  derive(G.cfg, G.st);
  initHud(G);
  initMarket(G);
  initFactory(G);
  initDebug(G);
  initTabs();
  render();
  startLoop();
  addEventListener('visibilitychange', save);
  addEventListener('pagehide', save);
}

// --- Save -------------------------------------------------------------------

function save() {
  if (NO_SAVE) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(G.st)); } catch { /* private mode: play without saving */ }
}

function load() {
  if (NO_SAVE) return null;
  try {
    const st = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (st && st.v === SAVE_VERSION && st.cfgVersion === G.cfg.meta.version) return migrate(G.cfg, st);
  } catch { /* corrupted or unavailable */ }
  return null;
}

function reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  G.st = newGame(G.cfg, (Math.random() * 2 ** 31) | 0);
  derive(G.cfg, G.st);
  initMarket(G);
  initFactory(G);
  showTab('factory');
}

// --- Tabs -------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'market' && !G.st.unlocked.market) {
      toast('🔒 Amène ta première production à l’📤 Outcome pour ouvrir le Marché.');
      return;
    }
    if (btn.dataset.tab !== G.tab) play('tab', 0.3);
    showTab(btn.dataset.tab);
  }));
}

function showTab(tab) {
  G.tab = tab;
  if (tab === 'market') G.st.seen.market = true;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + tab));
  $('app').querySelector('main').scrollTop = 0;
  render();
}

// --- Player actions -----------------------------------------------------------

function onAction(kind) {
  if (kind === 'stock') G.st.seen.stock = true;
  render();
}

// --- Loop: fixed-step sim on a timer (keeps running in background tabs) ------

let acc = 0, last = 0, saleAcc = 0, saleT = 0, saveT = 0;
const introduced = {};

function startLoop() {
  last = performance.now();
  setInterval(tick, 50);
  setInterval(render, 200);
}

function tick() {
  const now = performance.now();
  acc += Math.min(2, (now - last) / 1000) * G.speed;
  last = now;
  let steps = 0;
  while (acc >= DT && steps++ < 4000) {
    acc -= DT;
    const wasHolding = holdingMarkets();
    for (const e of step(G.cfg, G.st, DT)) handle(e);
    for (const id of holdingMarkets()) if (!wasHolding.includes(id)) {
      const r = G.cfg.markets.find(m => m.id === id);
      toast(`⏱ ${pct(G.cfg.monopoly.share)} du marché ${r.icon} ${r.name} ! Tiens ${G.cfg.monopoly.hold_s} s pour le monopole.`);
    }
    const r = checkReveal(G.cfg, G.st);
    if (r) { toast(r.toast); render(); }
  }
  saleT += 0.05;
  if (saleT >= 0.7 && saleAcc > 0.5) {
    floatText($('money'), '+' + money(saleAcc));
    saleAcc = 0; saleT = 0;
  }
  saveT += 0.05;
  if (saveT >= 3) { saveT = 0; save(); }
}

const holdingMarkets = () => G.cfg.markets.filter(r => { const b = G.st.mk[r.id].brands.you; return b.hold > 0 && !b.active; }).map(r => r.id);

const nameOf = (market, id) => id === 'you' ? 'Tu' : G.cfg.rivals.find(r => r.market === market && r.id === id)?.name;

function handle(e) {
  const r = e.market && G.cfg.markets.find(m => m.id === e.market);
  if (e.type === 'sale') saleAcc += e.gain;
  else if (e.type === 'rivalPrice') {
    const key = e.market + e.id;
    if (!introduced[key] && G.st.seen.market && G.market === e.market) {
      introduced[key] = true;
      const def = G.cfg.rivals.find(c => c.market === e.market && c.id === e.id);
      toast(`${def.icon} ${def.name} passe de ${e.from} $ à ${e.to} $.`);
    }
  } else if (e.type === 'rivalsUpgrade' && !introduced.upgrade && G.st.seen.market) {
    introduced.upgrade = true;
    toast('⚔️ Tes rivaux améliorent leurs usines eux aussi, chaque minute.');
  } else if (e.type === 'monopolyStart') {
    if (e.id === 'you') { monoFlash(`👑 MONOPOLE ${r.icon} ${r.name.toUpperCase()} !`); play('buy', 0.6); }
    else toast(`⚠️ ${nameOf(e.market, e.id)} a le monopole ${r.icon} ${r.name} : ses clients lui deviennent fidèles.`);
  } else if (e.type === 'monopolyLost') {
    toast(e.id === 'you'
      ? `😬 Tu as perdu le monopole ${r.icon} ${r.name}. Ton bonus d'attrait s'effrite lentement.`
      : `💥 ${nameOf(e.market, e.id)} a perdu le monopole ${r.icon} ${r.name} !`);
  }
}

// Big non-blocking banner for the player's monopolies.
function monoFlash(text) {
  const d = document.createElement('div');
  d.id = 'mono-flash';
  d.textContent = text;
  $('app').appendChild(d);
  setTimeout(() => d.remove(), 2700);
}

// --- What can I do now? -------------------------------------------------------

function hint() {
  const { cfg, st } = G;
  const g = st.grid, n = type => countOf(g, type);
  const tool = currentTool();
  // Onboarding: one harvester wired to the Outcome sells lemons.
  if (!n('harvest')) return tool === 'harvest'
    ? '👉 Appuie sur la grille, glisse vers où doivent sortir les citrons, puis lâche.'
    : '👉 Touche 🍋 dans la barre, puis « Cueillette » (gratuite).';
  if (!totalSold(st) && !Object.values(st.stats.delivered).some(Boolean)) {
    if (tool !== 'belt') return '👉 Choisis ⇉ Tapis (gratuit) et glisse le doigt de la sortie verte jusqu’à l’📤 Outcome.';
    if (g.machines.find(m => m.status === 'blocked')) return '👉 Tire un tapis depuis la sortie verte de la Cueillette jusqu’à l’📤 Outcome.';
    return '👉 Termine le tapis jusqu’à l’📤 Outcome (deux doigts pour déplacer la vue).';
  }
  if (st.unlocked.market && !st.seen.market) return '👉 Ouvre l’onglet Marché, en bas.';
  for (const r of openMarkets(cfg, st)) {
    const b = st.mk[r.id].brands.you;
    if (b.hold > 0 && !b.active) return `⏱ Garde ${pct(cfg.monopoly.share)} du marché ${r.icon} encore ${Math.ceil(cfg.monopoly.hold_s - b.hold)} s !`;
  }
  if (st.unlocked.refine && !n('refine_fruit') && !n('refine_juice') && !n('refine_bottle'))
    return '👉 Essaie l’Amélioration : touche 🍋 puis « Amélioration », et fais passer tes citrons dedans avant l’📤 Outcome.';
  if (st.unlocked.press && !n('press')) return '👉 Pose un ⚙️ Pressage : citrons → jus, qui se vend plus cher. Relie-le à l’📤 Outcome.';
  if (st.unlocked.bottle && !n('bottle')) return '👉 Pose un 🍾 Embouteillage : jus → bouteilles, le produit le plus cher.';
  const sk = stockInfo(cfg, st);
  const fullMk = openMarkets(cfg, st).find(r => st.mk[r.id].you.stock >= st.mk[r.id].you.stockCap - 1e-6);
  if (fullMk && st.unlocked.stock && sk.affordable) return `👉 Stock ${fullMk.icon} plein : agrandis le stock (${money(sk.cost)}).`;
  if (fullMk) return `👉 Ton stock ${fullMk.icon} dort : baisse ton prix ${fullMk.icon} dans le Marché.`;
  if (g.machines.find(m => m.status === 'blocked')) return '👉 Une machine est bloquée (⛔) : vérifie ses tapis de sortie.';
  if (st.unlocked.segments && !st.seen.segments) return '👉 Fais glisser les cartes du Marché pour voir chaque type de client.';
  // Market where the player sells least compared with what customers would take.
  for (const r of openMarkets(cfg, st)) {
    const pref = previewPreference(mkOf(cfg, r.id), sellersOf(st, r.id));
    let want = 0;
    for (const sg of mkOf(cfg, r.id).segments) want += sg.demand_per_min * pref[sg.id].probs.you;
    if (want < 1) return `👉 Personne n’accepte ton prix ${r.icon} : baisse-le dans le Marché.`;
    const cap = stageCapacity(cfg, g, r.stage);
    if (want > cap * 1.5 && cap > 0) return `👉 Les clients veulent ${perMin(want)} de ${r.icon}, tu en fais ${perMin(cap)} : améliore ou ajoute des machines.`;
  }
  const rivalMono = openMarkets(cfg, st).find(r => { const h = monopolistOf(st, r.id); return h && h !== 'you'; });
  if (rivalMono) return `👉 ${nameOf(rivalMono.id, monopolistOf(st, rivalMono.id))} tient le monopole ${rivalMono.icon} : casse-le avant qu’il ne s’installe.`;
  return '👉 Vise un monopole : le marché où ta part est la plus haute.';
}

// --- Render -------------------------------------------------------------------

function render() {
  const st = G.st;
  renderHud(hint());
  const mt = document.querySelector('.tab[data-tab="market"]');
  mt.classList.toggle('locked', !st.unlocked.market);
  mt.querySelector('.tab-label').textContent = st.unlocked.market ? '📈 Marché' : '🔒 Marché';
  mt.querySelector('.dot').classList.toggle('hidden', !(st.unlocked.market && !st.seen.market) && !(st.unlocked.segments && !st.seen.segments && G.tab !== 'market'));
  if (G.tab === 'market') renderMarket();
  else renderFactory();
}

boot();
