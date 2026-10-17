// Boot, game loop, tabs, hints, reveal, win, save. The simulation lives in
// sim.js (pure); this file only wires it to the DOM.

import { newGame, step, derive, SAVE_VERSION, productOf, sellersOf, upgradeInfo, stockInfo, currentBottleneck } from './sim.js';
import { unitCost } from './factory.js';
import { previewPreference } from './market.js';
import { checkReveal } from './reveal.js';
import { initHud, renderHud } from './ui/hud.js';
import { initMarket, renderMarket, flashRival } from './ui/market-view.js';
import { initFactory, renderFactory, saleCoin } from './ui/factory-view.js';
import { initDebug } from './ui/debug.js';
import { toast, floatText, retrigger } from './ui/fx.js';
import { play } from './ui/sound.js';
import { money, perMin, pct } from './format.js';

const $ = id => document.getElementById(id);
const DT = 0.1;                       // fixed simulation step (s)
const SAVE_KEY = 'mu_v2_save';

const G = {
  cfg: null, st: null, speed: 1, tab: 'factory',
  onAction,
  incomePerMin: () => G.st.shares.flow.you * 60 * (G.st.you.price - unitCost(productOf(G.cfg), G.st.you.quality)),
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
  $('win-replay').addEventListener('click', () => reset());
  if (G.st.goal.won) showWin();
  render();
  startLoop();
  addEventListener('visibilitychange', save);
  addEventListener('pagehide', save);
}

// --- Save -------------------------------------------------------------------

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(G.st)); } catch { /* private mode: play without saving */ }
}

function load() {
  try {
    const st = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (st && st.v === SAVE_VERSION && st.cfgVersion === G.cfg.meta.version) return st;
  } catch { /* corrupted or unavailable */ }
  return null;
}

function reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  G.st = newGame(G.cfg, (Math.random() * 2 ** 31) | 0);
  derive(G.cfg, G.st);
  $('win').classList.add('hidden');
  initMarket(G);
  initFactory(G);
  showTab('factory');
}

// --- Tabs -------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'market' && !G.st.unlocked.market) {
      toast('🔒 Vends ton premier jus pour ouvrir le Marché.');
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
  const st = G.st;
  if (kind === 'upgrade') st.seen.upgrades = st.stats.upgrades >= 2 || st.seen.upgrades;
  if (kind === 'stock') st.seen.stock = true;
  render();
}

// --- Loop: fixed-step sim on a timer (keeps running in background tabs) ------

let acc = 0, last = 0, saleAcc = 0, saleT = 0, saveT = 0;
const rivalIntroduced = {};

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
  while (acc >= DT && steps++ < 2000) {
    acc -= DT;
    const wasHolding = G.st.goal.hold > 0;
    for (const e of step(G.cfg, G.st, DT)) handle(e);
    if (!wasHolding && G.st.goal.hold > 0) toast(`⏱ Tu dépasses ${pct(G.cfg.goal.share_target)} ! Tiens ${G.cfg.goal.hold_s} s.`);
    const r = checkReveal(G.cfg, G.st);
    if (r) onReveal(r);
  }
  saleT += 0.05;
  if (saleT >= 0.7 && saleAcc > 0.5) {
    floatText($('money'), '+' + money(saleAcc));
    saleAcc = 0; saleT = 0;
  }
  saveT += 0.05;
  if (saveT >= 3) { saveT = 0; save(); }
}

function handle(e) {
  if (e.type === 'sale') { saleAcc += e.gain; saleCoin(); }
  else if (e.type === 'rivalPrice') {
    flashRival(e.id);
    if (!rivalIntroduced[e.id] && G.st.unlocked.market) {
      rivalIntroduced[e.id] = true;
      const def = G.cfg.competitors.find(c => c.id === e.id);
      toast(`${def.icon} ${def.name} passe de ${e.from} $ à ${e.to} $.`);
    }
  }
  else if (e.type === 'rivalsUpgrade' && !rivalIntroduced.upgrade && G.st.unlocked.market) {
    rivalIntroduced.upgrade = true;
    toast('⚔️ Tes rivaux améliorent leurs usines eux aussi, chaque minute.');
  }
  else if (e.type === 'holdLost') { toast('😬 Ta part est retombée : le chrono repart à zéro.'); retrigger($('goal-bar'), 'flash'); }
  else if (e.type === 'win') { save(); showWin(); }
}

function onReveal(r) {
  toast(r.toast);
  render();
}

function showWin() {
  const st = G.st, m = Math.floor(st.goal.wonAt / 60), s = Math.floor(st.goal.wonAt % 60);
  $('win-text').textContent = `Tu as tenu ${pct(G.cfg.goal.share_target)} du marché pendant ${G.cfg.goal.hold_s} s, en ${m} min ${String(s).padStart(2, '0')} de jeu.`;
  $('win').classList.remove('hidden');
}

// --- What can I do now? -------------------------------------------------------

function hint() {
  const { cfg, st } = G;
  if (st.goal.won) return '👑 Marché contrôlé !';
  const bn = currentBottleneck(cfg, st);
  const up = upgradeInfo(cfg, st, bn.id);
  const sk = stockInfo(cfg, st);
  const full = st.you.stock >= st.you.stockCap - 1e-6;
  if (st.unlocked.market && !st.seen.market) return '👉 Ouvre l\'onglet Marché, en bas.';
  if (st.goal.hold > 0) return `⏱ Garde ta part au-dessus de ${pct(cfg.goal.share_target)} encore ${Math.ceil(cfg.goal.hold_s - st.goal.hold)} s !`;
  let want = 0;
  if (st.unlocked.market) {
    const pref = previewPreference(cfg, productOf(cfg), sellersOf(st));
    for (const sg of cfg.segments) want += sg.demand_per_min * pref[sg.id].probs.you;
    if (want < 1) return '👉 Personne n\'accepte ton prix : baisse-le dans le Marché.';
  }
  if (full && st.unlocked.stock && sk.affordable) return `👉 Entrepôt plein : agrandis-le (${money(sk.cost)}).`;
  if (up.affordable) return `👉 Améliore ${bn.name} : c'est ton goulot (${perMin(up.rate)} → ${perMin(up.nextRate)}).`;
  if (st.unlocked.segments && !st.seen.segments) return '👉 Regarde quels clients achètent chez toi (Marché).';
  if (st.unlocked.market && full && want < st.you.prodRate * 0.75) return '👉 Ton stock dort : baisse ton prix dans le Marché.';
  if (st.unlocked.market && want > st.you.prodRate * 1.5 && st.stats.priceChanges > 0) return `👉 On t'en demande plus que tu n'en produis : monte ton prix, ou améliore ${bn.name}.`;
  return `👉 Économise pour améliorer ${bn.name} (${money(up.cost)}).`;
}

// --- Render -------------------------------------------------------------------

let segSeenT = 0;
function render() {
  const st = G.st;
  renderHud(hint());
  const mt = document.querySelector('.tab[data-tab="market"]');
  mt.classList.toggle('locked', !st.unlocked.market);
  mt.querySelector('.tab-label').textContent = st.unlocked.market ? '📈 Marché' : '🔒 Marché';
  mt.querySelector('.dot').classList.toggle('hidden', !(st.unlocked.market && !st.seen.market) && !(st.unlocked.segments && !st.seen.segments && G.tab !== 'market'));
  $('seg-card').classList.toggle('hidden', !st.unlocked.segments);
  $('seg-card').classList.toggle('pulse', !!st.unlocked.segments && !st.seen.segments);
  if (G.tab === 'market' && st.unlocked.segments && !st.seen.segments && (segSeenT += 0.2) > 4) st.seen.segments = true;
  if (G.tab === 'market') renderMarket();
  else renderFactory();
}

boot();
