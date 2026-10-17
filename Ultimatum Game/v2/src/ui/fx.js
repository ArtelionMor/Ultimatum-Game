// Feedback effects: floating numbers, bumps, flashes, toasts.

const $ = id => document.getElementById(id);

// Float a short text above `el` (or at its centre), relative to #app.
export function floatText(el, text, cls = '') {
  const fx = $('fx');
  if (!el || !fx || !el.offsetParent) return;
  const a = $('app').getBoundingClientRect(), r = el.getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'float ' + cls;
  d.textContent = text;
  d.style.left = (r.left - a.left + r.width / 2 + (Math.random() * 30 - 15)) + 'px';
  d.style.top = (r.top - a.top - 4) + 'px';
  fx.appendChild(d);
  setTimeout(() => d.remove(), 1150);
}

// Restart a CSS animation class.
export function retrigger(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const queue = [];
let showing = 0;
// One toast at a time on screen (max 2 stacked), each ~4s.
export function toast(text) {
  queue.push(text);
  pump();
}
function pump() {
  if (showing >= 2 || !queue.length) return;
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = queue.shift();
  $('toasts').appendChild(d);
  showing++;
  setTimeout(() => { d.remove(); showing--; pump(); }, 4000);
}
