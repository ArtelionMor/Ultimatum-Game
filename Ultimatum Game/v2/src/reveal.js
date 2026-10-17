// Progressive reveal: each novelty unlocks on a simple condition, one at a
// time (at least reveal.min_gap_s of game time apart), with a toast.
// Pure: reads/writes st.unlocked and st.lastReveal only.

export const REVEALS = [
  { id: 'press',    when: st => (st.stats.built.harvest || 0) >= 1,
    toast: '⚙️ Nouveau : le Pressage transforme les citrons en jus.' },
  { id: 'bottle',   when: st => (st.stats.built.press || 0) >= 1,
    toast: '🍾 Nouveau : l’Embouteillage met le jus en bouteille. Sa qualité monte avec son niveau.' },
  { id: 'market',   when: st => st.stats.sold >= 1,
    toast: '📈 Premier client ! L’onglet Marché est ouvert.' },
  { id: 'upgrades', when: st => st.seen.market && st.stats.sold >= 5,
    toast: '🔧 Touche une machine (outil ✋) pour l’améliorer.' },
  { id: 'stock',    when: (st, cfg) => st.stats.stockFullSeen || st.t >= cfg.reveal.stock_hint_after_s,
    toast: '📦 Ton entrepôt est petit : agrandis-le pour vendre aux heures de pointe.' },
  { id: 'segments', when: st => st.seen.market && st.stats.priceChanges >= 1,
    toast: '👥 Nouveau sur le Marché : fais glisser les cartes pour voir chaque type de client.' },
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
