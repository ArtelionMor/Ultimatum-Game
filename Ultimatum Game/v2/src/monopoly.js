// Monopoly "brand" bonus — pure. Any seller (player or rival) who holds at
// least `monopoly.share` of a market for `hold_s` seconds becomes the monopoly.
// While it lasts, its desirability bonus grows logarithmically with the time
// held:            M = ln(1 + D / grow_tau_s)
// Once lost, it decays as a power law whose exponent shrinks with the bonus
// reached, so a long monopoly is hard to break:
//                  M = M0 · (1 + t / decay_tau_s) ^ (−decay_k / M0)
// The bonus enters the customer score as c_s × M (see market.js).

export const createBrand = () => ({ hold: 0, active: false, D: 0, M: 0, M0: 0, lost: 0 });

// Returns 'start' | 'lost' | null.
export function stepBrand(mono, b, share, dt) {
  let ev = null;
  if (b.active) {
    if (share >= mono.share) {
      b.D += dt;
      b.M = Math.log(1 + b.D / mono.grow_tau_s);
    } else {
      b.active = false;
      b.M0 = b.M; b.lost = 0; b.hold = 0;
      ev = 'lost';
    }
  } else {
    b.hold = share >= mono.share ? b.hold + dt : 0;
    if (b.hold >= mono.hold_s) {
      b.active = true;
      // Resume from the bonus still left over, so the curve is continuous.
      b.D = mono.grow_tau_s * (Math.exp(b.M) - 1);
      ev = 'start';
    } else if (b.M0 > 0) {
      b.lost += dt;
      b.M = b.M0 * Math.pow(1 + b.lost / mono.decay_tau_s, -mono.decay_k / b.M0);
    }
  }
  return ev;
}
