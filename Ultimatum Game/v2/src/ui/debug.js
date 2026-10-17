// Debug panel (🐞 or ?debug): sim speed, live a/b/temperature, +money, reset.
// Edits change the in-memory config only (not saved, not written to config.json).

const $ = id => document.getElementById(id);

export function initDebug(G) {
  const panel = $('debug');
  const toggle = () => panel.classList.toggle('hidden');
  $('debug-toggle').addEventListener('click', toggle);
  $('debug-close').addEventListener('click', toggle);
  addEventListener('keydown', e => { if (e.key === 'd' && e.target.tagName !== 'INPUT') toggle(); });
  if (new URLSearchParams(location.search).has('debug')) panel.classList.remove('hidden');

  const speedBtns = [...$('speed-btns').querySelectorAll('button')];
  const paintSpeed = () => speedBtns.forEach(b => b.classList.toggle('active', Number(b.dataset.speed) === G.speed));
  speedBtns.forEach(b => b.addEventListener('click', () => { G.speed = Number(b.dataset.speed); paintSpeed(); }));
  paintSpeed();

  const temp = $('dbg-temp');
  temp.value = G.cfg.market.temperature;
  temp.addEventListener('change', () => { const v = Number(temp.value); if (v > 0) G.cfg.market.temperature = v; });

  $('dbg-segments').innerHTML = G.cfg.segments.map(sg => `<div class="row"><span style="white-space:nowrap">${sg.icon} ${sg.name}</span>
    <span>a <input type="number" step="0.1" data-seg="${sg.id}" data-k="a" value="${sg.a}">
    b <input type="number" step="0.1" data-seg="${sg.id}" data-k="b" value="${sg.b}"></span></div>`).join('');
  $('dbg-segments').querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
    const sg = G.cfg.segments.find(s => s.id === inp.dataset.seg);
    const v = Number(inp.value);
    if (isFinite(v)) sg[inp.dataset.k] = v;
  }));

  $('dbg-money').addEventListener('click', () => { G.st.money += 1000; });
  $('dbg-reset').addEventListener('click', () => { if (confirm('Effacer la partie et recommencer ?')) G.reset(); });
}
