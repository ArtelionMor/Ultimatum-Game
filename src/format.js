// Readable numbers: 950, 9.5K, 12K, 3.4M, 1.2B...
const UNITS = ['', 'K', 'M', 'B', 'T'];

export function fmt(n, smallDecimals = 0) {
  if (!isFinite(n)) return '∞';
  const neg = n < 0; n = Math.abs(n);
  let s;
  if (n < 1000) s = n.toFixed(n < 10 ? smallDecimals : 0);
  else {
    let i = 0;
    while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
    s = n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0);
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
    s += UNITS[i];
  }
  return (neg ? '-' : '') + s;
}

export const money = n => fmt(n, n < 100 && n % 1 ? 1 : 0) + ' $';
export const price = n => n.toFixed(n % 1 ? 1 : 0) + ' $';
export const pct = x => Math.round(x * 100) + ' %';
export const perMin = n => fmt(n) + '/min';
export const stars = q => '★' + q.toFixed(q % 1 ? 1 : 0);
