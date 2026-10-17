// Top bar: the goal (take a monopoly: share bar of the best market + hold
// timer), money, and the "what can I do now?" hint.

import { shareOf, monopolistOf } from '../sim.js';
import { money, pct, fmt } from '../format.js';
import { retrigger } from './fx.js';
import { openMarkets } from './market-view.js';

const $ = id => document.getElementById(id);
let G, lastMoney = null, lastHint = '';

export function initHud(game) {
  G = game;
  const mono = G.cfg.monopoly;
  $('goal-mark').style.left = `calc(${mono.share * 100}% - 1px)`;
}

export function renderHud(hint) {
  const { cfg, st } = G;
  const mono = cfg.monopoly;
  const open = openMarkets(cfg, st);
  const mine = open.filter(r => monopolistOf(st, r.id) === 'you');
  // The market closest to a monopoly (or the one being held).
  let best = null, bestSh = 0;
  for (const r of open) {
    const sh = shareOf(st, r.id).you;
    if (!best || sh > bestSh) { best = r; bestSh = sh; }
  }
  const holding = best && st.mk[best.id].brands.you.hold > 0 && !st.mk[best.id].brands.you.active;
  if (mine.length) {
    $('goal-text').textContent = `👑 Monopole : ${mine.map(r => r.icon + ' ' + r.name).join(', ')}`;
  } else $('goal-text').textContent = `Prends un monopole : ${pct(mono.share)} d'un marché pendant ${mono.hold_s} s`;
  $('goal-fill').style.width = (bestSh * 100).toFixed(1) + '%';
  $('goal-bar').classList.toggle('holding', !!holding || mine.length > 0);
  $('goal-share').textContent = best ? `Meilleure part : ${best.icon} ${pct(bestSh)} / ${pct(mono.share)}` : 'Vends ta première production';
  const hold = $('goal-hold');
  hold.textContent = holding ? `⏱ ${Math.floor(st.mk[best.id].brands.you.hold)} / ${mono.hold_s} s` : '';
  hold.classList.toggle('on', !!holding);

  const m = Math.floor(st.money);
  $('money').textContent = money(st.money);
  $('money').classList.toggle('neg', st.money < 0);
  if (lastMoney !== null && m > lastMoney + 1) retrigger($('money'), 'bump');
  lastMoney = m;

  const inc = G.incomePerMin();
  $('income').textContent = (inc >= 0 ? '+' : '') + fmt(inc) + ' $/min';
  $('income').classList.toggle('neg', inc < 0);

  if (hint !== lastHint) {
    $('hint').textContent = hint;
    retrigger($('hint'), 'flash');
    lastHint = hint;
  }
}
