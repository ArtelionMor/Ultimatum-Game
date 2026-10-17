// Progressive reveal: each novelty unlocks on a simple condition, one at a
// time (at least reveal.min_gap_s of game time apart), with a toast.
// Pure: reads/writes st.unlocked and st.lastReveal only.

const sold = st => Object.values(st.stats.sold).reduce((x, y) => x + y, 0);
const delivered = st => Object.values(st.stats.delivered).reduce((x, y) => x + y, 0);

export const REVEALS = [
  // On delivery, not on sale: a price nobody accepts must still be fixable.
  { id: 'market',   when: st => delivered(st) >= 1,
    toast: '📈 Ta 1re production est arrivée : l’onglet Marché est ouvert, fixe ton prix.' },
  { id: 'press',    when: st => st.stats.sold.fruit >= 5,
    toast: '⚙️ Nouveau : le Pressage fait du jus, qui se vend plus cher que le citron.' },
  { id: 'bottle',   when: st => (st.stats.built.press || 0) >= 1,
    toast: '🍾 Nouveau : l’Embouteillage met le jus en bouteille, le produit le plus cher.' },
  { id: 'upgrades', when: st => st.seen.market && sold(st) >= 10,
    toast: '🔧 Touche une machine pour l’améliorer ou la vendre ; fais-la glisser pour la déplacer.' },
  { id: 'stock',    when: (st, cfg) => st.stats.stockFullSeen || st.t >= cfg.reveal.stock_hint_after_s,
    toast: '📦 Ton stock est petit : agrandis-le pour vendre aux heures de pointe.' },
  { id: 'segments', when: st => st.seen.market && st.stats.priceChanges >= 1,
    toast: '👥 Nouveau sur le Marché : fais glisser les cartes pour voir chaque type de client.' },
  { id: 'outcome',  when: st => (st.stats.built.bottle || 0) >= 1,
    toast: '📤 Tu peux construire d’autres Outcomes pour raccourcir tes tapis.' },
];

export function checkReveal(cfg, st) {
  if (st.t - st.lastReveal < cfg.reveal.min_gap_s) return null;
  for (const r of REVEALS) {
    if (st.unlocked[r.id] || !r.when(st, cfg)) continue;
    st.unlocked[r.id] = true;
    st.lastReveal = st.t;
    return r;
  }
  return null;
}
