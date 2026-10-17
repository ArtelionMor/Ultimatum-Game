// Boot, game loop, tabs. The simulation lives in sim.js (pure); this file only
// wires it to the DOM.

import { newGame, step, derive, SAVE_VERSION, productOf } from './sim.js';
import { unitCost } from './factory.js';
import { initHud, renderHud } from './ui/hud.js';
import { initMarket, renderMarket, flashRival } from './ui/market-view.js';
import { initFactory, renderFactory, saleCoin } from './ui/factory-view.js';
import { toast, floatText } from './ui/fx.js';
import { money } from './format.js';

const $ = id => document.getElementById(id);
const DT = 0.1;              // fixed simulation step (s)

const G = {
  cfg: null, st: null, speed: 1, tab: 'factory',
  onAction: () => {},
  incomePerMin: () => G.st.shares.flow.you * 60 * (G.st.you.price - unitCost(productOf(G.cfg), G.st.you.quality)),
};
window.G = G; // handy from the console

async function boot() {
  G.cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  G.st = newGame(G.cfg);
  derive(G.cfg, G.st);
  initHud(G);
  initMarket(G);
  initFactory(G);
  G.st.unlocked.upgrades = G.st.unlocked.stock = true;
  initTabs();
  startLoop();
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
}

function showTab(tab) {
  G.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + tab));
  render();
}

// --- Loop: fixed-step sim on a timer (keeps running in background tabs),
// rendering on animation frames.
let acc = 0, last = 0, saleAcc = 0, saleT = 0;
function startLoop() {
  last = performance.now();
  setInterval(tick, 50);
  setInterval(render, 200);
}

function tick() {
  const now = performance.now();
  acc += Math.min(2, (now - last) / 1000) * G.speed;
  last = now;
  while (acc >= DT) {
    acc -= DT;
    for (const e of step(G.cfg, G.st, DT)) handle(e);
  }
  saleT += 0.05;
  if (saleT >= 0.7 && saleAcc > 0.5) {
    floatText($('money'), '+' + money(saleAcc));
    saleAcc = 0; saleT = 0;
  }
}

function handle(e) {
  if (e.type === 'sale') { saleAcc += e.gain; saleCoin(); }
  else if (e.type === 'rivalPrice') flashRival(e.id);
}

function render() {
  renderHud('👉 Fixe ton prix');
  if (G.tab === 'market') renderMarket();
  else renderFactory();
}

boot();
