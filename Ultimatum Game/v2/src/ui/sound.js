// Tiny sound player (Kenney UI pack). Browsers only allow audio after a user
// gesture, which is always the case here: sounds answer taps.

const files = { buy: 'click-a', tick: 'tap-a', tab: 'switch-a' };
const cache = {};
let muted = false;

export function play(name, volume = 0.4) {
  if (muted || !files[name]) return;
  try {
    const base = cache[name] || (cache[name] = new Audio(`assets/kenney/sounds/${files[name]}.ogg`));
    const a = base.cloneNode();
    a.volume = volume;
    a.play().catch(() => {});
  } catch { /* no audio support */ }
}

export function setMuted(m) { muted = m; }
