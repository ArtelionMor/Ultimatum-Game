// Top bar: player level + tasks (see tasks.js), money, and the
// "what can I do now?" hint.

import { money, fmt } from '../format.js';
import { retrigger } from './fx.js';
import { renderTasksHud, renderQuest } from './tasks.js';

const $ = id => document.getElementById(id);
let G, lastMoney = null;

export function initHud(game) { G = game; }

// `tip`: contextual advice (or null), shown under the featured quest.
export function renderHud(tip) {
  const { st } = G;
  renderTasksHud();

  const m = Math.floor(st.money);
  $('money').textContent = money(st.money);
  $('money').classList.toggle('neg', st.money < 0);
  if (lastMoney !== null && m > lastMoney + 1) retrigger($('money'), 'bump');
  lastMoney = m;

  const inc = G.incomePerMin();
  $('income').textContent = (inc >= 0 ? '+' : '') + fmt(inc) + ' $/min';
  $('income').classList.toggle('neg', inc < 0);

  renderQuest(tip);
}
