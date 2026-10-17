// Top bar: the single goal (share bar + hold timer), money, and the
// "what can I do now?" hint.

import { shareOf } from '../sim.js';
import { money, pct, fmt } from '../format.js';
import { retrigger } from './fx.js';

const $ = id => document.getElementById(id);
let G, lastMoney = null, lastHint = '';

export function initHud(game) {
  G = game;
  const g = G.cfg.goal;
  $('goal-text').textContent = `Contrôle ${pct(g.share_target)} du marché pendant ${g.hold_s} s`;
  $('goal-mark').style.left = `calc(${g.share_target * 100}% - 1px)`;
}

export function renderHud(hint) {
  const { cfg, st } = G;
  const sh = shareOf(st).you;
  const g = cfg.goal;
  const holding = st.goal.hold > 0;
  $('goal-fill').style.width = (sh * 100).toFixed(1) + '%';
  $('goal-bar').classList.toggle('holding', holding);
  $('goal-share').textContent = `Ta part : ${pct(sh)} / ${pct(g.share_target)}`;
  const hold = $('goal-hold');
  hold.textContent = holding ? `⏱ Tiens bon : ${Math.floor(st.goal.hold)} / ${g.hold_s} s` : '';
  hold.classList.toggle('on', holding);

  const m = Math.floor(st.money);
  $('money').textContent = money(st.money);
  $('money').classList.toggle('neg', st.money < 0);
  if (lastMoney !== null && m > lastMoney) retrigger($('money'), 'bump');
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
