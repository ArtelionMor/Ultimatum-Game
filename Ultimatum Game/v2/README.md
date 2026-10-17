# Market Ultimatum v2

Prototype mobile (portrait, 480 px max) : une usine de jus face à 3 usines rivales, jusqu'au monopole.
JS vanilla en modules ES, sans build ni dépendance.

```bash
python -m http.server 8795 --directory v2
```
Puis ouvrir http://localhost:8795 (`?debug` ouvre directement le panneau debug ; touche `d` ou 🐞 pour le basculer).

## La boucle
1. **Usine** : Cueillette → Pressage → Embouteillage → Entrepôt. La chaîne produit au rythme de son poste le plus lent (le *goulot*, en rouge). Chaque niveau donne +30 % de vitesse ; l'Embouteillage ajoute aussi de la **qualité**. L'entrepôt (stock max) sert aux heures de pointe.
2. **Marché** : tu fixes ton prix. Tu vois en direct ta marge, la demande pour toi par rapport à ta production, ta part prévue, les parts de chacun, qui achète chez toi par segment, et tes 3 rivaux.
3. Les ventes rapportent `prix − coût unitaire` ; tu réinvestis dans l'usine.
4. **Objectif** (toujours visible en haut) : tenir 60 % du marché pendant 60 s d'affilée → écran « Marché contrôlé », bouton Rejouer.

## Écrans
- **Haut** : objectif + barre de part (repère à 60 %) + chrono de tenue, argent et revenu/min, et une ligne « 👉 » qui dit quoi faire maintenant.
- **Usine** : tapis vu de dessus (canvas), entrepôt, une carte par poste. Au départ, seul le bouton du goulot existe.
- **Marché** (débloqué à la 1re vente) : prix (curseur, ±, appui long), conseil demande/production, parts de marché, segments (débloqués après le 1er changement de prix), rivaux.
- Les nouveautés arrivent une par une (au moins 5 s d'écart) avec une pastille qui pulse et un toast.

## Formule de demande (`src/market.js`)
Pour un client du segment *s* et un vendeur *v* :

```
score(s, v) = b_s × qualité_v − a_s × (prix_v / prix_de_référence)
```
- Un vendeur est **refusé** par le segment si `score < refuse_below_s`, ou s'il n'a pas de stock.
- Les autres se partagent les clients selon `softmax(score / température)`.
- Personne d'acceptable → le client repart sans acheter.
- La demande arrive en flux continu (`demand_per_min`) modulé par des heures de pointe (sinus). Un vendeur à court de stock sert chaque segment au prorata ; ses clients non servis rechoisissent parmi les autres.
- La part de marché = moyenne glissante (constante `share_smoothing_s`) des ventes de chacun.

## Rivaux (`src/ai.js`)
Même stock / production / vente que le joueur. Toutes les `price_interval_s` :
- **Casseur de prix** (`undercut`) : 5 % sous ton prix, jamais au-dessus de son prix de départ.
- **Premium** (`premium`) : baisse de 3 % si son stock dort (> 80 %), monte s'il est vide (< 20 %), dans ±30 % de son prix de départ.
- **Suiveur** (`follow`) : copie le prix du leader de parts, à ±5 %.

Plancher pour tous : `coût unitaire × (1 + price_floor_margin)`. Toutes les `upgrade_interval_s`, chacun gagne `prod_growth` de production et `quality_step` de qualité (jusqu'à `quality_max`).

## Outils
- `node tools/check-market.js` : 10 min simulées à prix fixes (bas 6 $, moyen 10 $, haut 16 $) × 3 qualités, parts par segment, et verdicts.
- `node tools/bot-run.js` : une partie complète jouée par un bot glouton, pour régler le rythme (≈ 8 min pour un bot parfait).

**Résultat actuel de check-market** : à qualité égale, le prix le plus bas gagne presque toujours la part *brute* (c'est mathématique : le score baisse avec le prix). Mais ce n'est pas une stratégie dominante : le prix **le plus rentable** dépend du segment (q2.5 : Économes 7 $, Standards 8,5 $, Premium 16,5 $), le prix ne peut pas descendre sous le coût unitaire, et le Casseur te suit. Chaque segment a un favori naturel : Économes → Casseur, Standards → Suiveur, Premium → Premium.
Réglages faits pour y arriver : qualité du Suiveur 2 → 2,5 (il était à égalité avec le Premium chez les Standards), mix de demande 300/200/100 → 250/220/130, température 0,6 → 0,5, coût de la qualité 1 → 0,5 $/★, et progression des rivaux ralentie (sinon le monopole était impossible).

## Paramètres de `config.json` à toucher pour le fun
| Clé | Effet |
|---|---|
| `segments[].a` / `.b` | sensibilité au prix / à la qualité de chaque segment |
| `segments[].refuse_below` | seuil « prix injuste » : plus haut = segment plus exigeant |
| `segments[].demand_per_min` | taille de chaque segment |
| `market.temperature` | bas = le meilleur rafle tout ; haut = parts plus partagées |
| `market.demand_wave_amp` / `_period_s` | force et durée des heures de pointe (utilité du stock) |
| `market.share_smoothing_s` | réactivité de la barre de part |
| `stations[].base_rate` / `rate_mult` / `base_cost` / `cost_mult` | rythme de progression de l'usine |
| `stations[].quality_per_level` | qualité gagnée par niveau (seul l'Embouteillage en donne) |
| `product[].unit_cost_base` / `unit_cost_per_quality` | marge et coût de la qualité |
| `player.start_money`, `stock_*` | démarrage et entrepôt |
| `competitors[]` | prix de départ, qualité, production, croissance, comportement |
| `ai.price_interval_s` / `upgrade_interval_s` | nervosité et vitesse de progression des rivaux |
| `goal.share_target` / `hold_s` | difficulté de l'objectif |
| `reveal.min_gap_s` / `stock_hint_after_s` | rythme de la révélation progressive |

Les tables sont plates (une ligne = un objet) pour passer facilement à Google Sheets. Changer `meta.version` invalide les sauvegardes.

## Architecture
```
config.json            tout l'équilibrage
src/market.js          modèle de demande pur (Node + navigateur)
src/factory.js         maths des postes, stock, qualité, coût unitaire
src/ai.js              comportement des rivaux
src/sim.js             état + tick pur (événements), actions du joueur
src/reveal.js          révélation progressive
src/main.js            boucle, onglets, indices, victoire, sauvegarde
src/ui/*.js            hud, usine (canvas), marché, debug, effets, sons
tools/                 check-market.js, bot-run.js
assets/kenney/         sous-ensemble des packs Kenney (CC0, voir License.txt)
```
Plusieurs produits plus tard : `product` est une table et `stations[].product` relie un poste à son produit ; aujourd'hui seul `product[0]` est joué.

## Décisions à valider
- **Flux continu** plutôt que tirage aléatoire client par client : la part de marché est l'espérance du tirage softmax, donc lisse et reproductible.
- **Refus par vendeur** : un segment refuse chaque vendeur sous son seuil (pas seulement quand le meilleur est sous le seuil). Ça couvre la règle demandée et rend « les Économes te fuient » littéral.
- **Prix plancher = coût unitaire** (pas de revente à perte) : sinon le dumping gagnait le monopole sans réfléchir.
- **Chrono de tenue remis à zéro** dès que la part repasse sous l'objectif.
- **Coût payé à la vente** (marge = prix − coût), pas à la production.
- **Débit de la chaîne = poste le plus lent**, pas de stocks intermédiaires.
- **Heures de pointe** (demande ±50 % sur 40 s) ajoutées pour que l'entrepôt serve à quelque chose.
- **Le Casseur ne réagit qu'à toi**, pas aux autres rivaux (sinon guerre des prix en spirale entre IA).
- Demande totale **fixe** dans le temps ; seuls les rivaux progressent.
- Produit : du jus (🍋 → ⚙️ → 🍾), placeholders emoji pour l'usine.
- Les réglages du panneau debug ne sont pas sauvegardés et ne modifient pas `config.json`.
- Textes non polis : une passe de localisation est prévue.
