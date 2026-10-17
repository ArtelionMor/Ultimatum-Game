# Market Ultimatum v2

Prototype mobile (portrait, 480 px max) : tu construis une usine de citrons → jus → bouteilles et tu te bats sur 3 marchés contre des rivaux, jusqu'au monopole.
JS vanilla en modules ES, sans build ni dépendance.

```bash
python -m http.server 8795 --directory v2
```
Puis ouvrir http://localhost:8795.
- **Console de triche** : bouton 🐞 en haut à droite, touche `d`, ou `?debug` dans l'URL. Elle contient la vitesse ×1/×10/×50, la température, a/b par segment, +1K $ et Reset.
- `?nosave` : partie de test non sauvegardée.

## La boucle
1. **Usine** : une grille vue de dessus, plus grande que l'écran.
   - Tu achètes et poses des machines 2×2 : 🍋 Cueillette (crée des citrons), ⚙️ Pressage (citron → jus), 🍾 Embouteillage (jus → bouteille). Chaque machine a une entrée (flèche orange) et une sortie (flèche verte).
   - Tu les relies avec des tapis jusqu'à un **📤 Outcome**, qui envoie à la vente tout ce qui y entre, par tous les côtés.
   - Chaque machine s'améliore (+30 % de vitesse), se tourne, se déplace gratuitement ou se revend (avec confirmation).
   - La 1re Cueillette et les tapis sont gratuits.
   - La qualité d'une ressource = le niveau moyen des machines qui la produisent.
2. **Marché** : un onglet par ressource livrée (🍋 Citron, 🧃 Jus, 🍾 Bouteille), chacun avec ses 3 rivaux. Tu règles ton prix ; des cartes camembert montrent les parts (tout le marché, puis chaque type de client).
3. Les ventes rapportent `prix − coût unitaire`. Pas de revenu passif ; comme la 1re Cueillette et les tapis sont gratuits, on peut toujours relancer une ligne.
4. **Monopole** (pas d'écran de victoire) : tenir 80 % d'un marché pendant 20 s donne le monopole. Il apporte un effet visuel et un **bonus d'attrait** qui fidélise les clients. Les rivaux peuvent aussi prendre un monopole.

## Écrans
- **Haut** : l'objectif « Prends un monopole », la barre de ton meilleur marché (repère à 80 %) avec le chrono, l'argent et le revenu/min, et une ligne « 👉 » qui dit quoi faire maintenant.
- **Usine** :
  - Barre d'outils : 🍋 · ⚙️ · 🍾 · 📤 · ⇉ Tapis. Toucher l'outil actif le repose. Dessous : les stocks par ressource et le bouton Agrandir.
  - **Poser** : avec un outil machine, appuie là où tu la veux, glisse vers où doit sortir la production (grosse flèche verte), lâche.
  - **Tapis** : glisse le doigt pour tracer ; toucher un tapis existant le tourne.
  - **Déplacer** : appuie sur une machine et fais-la glisser (elle garde son sens).
  - **Éditer** : touche une machine. Le reste de l'usine se grise et un widget au-dessus propose ⬆ Améliorer et Vendre (avec « Êtes-vous sûr ? »). En mode édition :
    - appuyer ailleurs (+ glisser) la déplace à cet endroit avec un nouveau sens ;
    - appuyer sur elle et glisser la tourne ;
    - la toucher à nouveau ou ✕ ferme.
  - **Pan** : glisser sur le sol vide sans outil, deux doigts avec n'importe quel outil, clic droit/molette sur PC.
  - Icônes : 💤 = attend sa matière, ⛔ = sortie bloquée (pas de tapis, ou stock plein).
- **Marché** (débloqué à la 1re vente) : onglets de ressources (👑 = ton monopole, ⚠️ = celui d'un rival), bandeau monopole, prix (± / curseur), marge, qualité, cartes camembert.
- Les nouveautés arrivent une par une, avec une pastille et un toast : Marché → Pressage → Embouteillage → améliorations → stock → cartes segments → Outcomes supplémentaires.

## Formule de demande (`src/market.js`, `src/monopoly.js`)
Pour un client du segment *s* et un vendeur *v*, sur un marché de prix de référence *réf* :

```
score(s, v) = b_s × qualité_v − a_s × (prix_v / réf) + c_s × M_v
```
- Un vendeur est **refusé** par le segment si `score < refuse_below_s`, ou s'il n'a pas de stock.
- Les autres se partagent les clients selon `softmax(score / température)`. Personne d'acceptable → le client repart sans acheter.
- La demande est un flux continu (`demand_per_min`), modulé par des heures de pointe (sinus).
- **Bonus de monopole M** :
  - Pendant le monopole : `M = ln(1 + D / grow_tau_s)`, où D est la durée du monopole.
  - Après la perte : `M = M0 × (1 + t / decay_tau_s)^(−decay_k / M0)`. Un monopole long (M0 grand) s'effrite lentement, donc il est dur à casser.
  - Ordres de grandeur avec la config actuelle :

    | Durée du monopole | M0 | M une minute après la perte |
    |---|---|---|
    | 1 min | 1,1 | 0,17 |
    | 5 min | 2,4 | 1,0 |
    | 15 min | 3,4 | 1,9 |

## Rivaux (`src/ai.js`)
3 rivaux par marché, avec la même logique de stock et de vente (production abstraite). Toutes les `price_interval_s` :
- `undercut` : 5 % sous ton prix, jamais au-dessus de son prix de départ.
- `premium` : baisse si son stock dort, monte s'il est vide (±30 % de son prix de départ).
- `follow` : copie le prix du leader de parts, à ±5 %.

Plancher : `coût unitaire × (1 + price_floor_margin)`, arrondi au pas de prix du marché. Toutes les `upgrade_interval_s`, chaque rival gagne de la production et de la qualité.

## Outils
- `node tools/check-market.js [--market bottle] [--minutes 5]` : pour chaque marché, 10 min simulées à prix fixes (0,6 / 1 / 1,6 × réf) × 3 qualités, avec les parts par segment.
  - Résultat actuel : sur les 3 marchés, le prix le plus rentable dépend du segment (pas de stratégie dominante), et chaque segment a un rival favori différent.
- `node tools/bot-run.js` : un bot construit jusqu'à 4 lignes de bouteilles et vise le monopole Bouteille. Il l'obtient à ≈ 16 min. **Premier calage, à affiner.**

## Paramètres de `config.json` à toucher pour le fun
| Clé | Effet |
|---|---|
| `markets[]` | prix de référence, prix de départ, pas de prix, coût unitaire de chaque ressource |
| `segments[]` (`market`, `a`, `b`, `c`, `refuse_below`, `demand_per_min`) | clients de chaque marché : sensibilité au prix, à la qualité, au monopole ; seuil de refus ; volume |
| `monopoly.share` / `hold_s` | ce qu'il faut tenir pour un monopole |
| `monopoly.grow_tau_s` / `decay_tau_s` / `decay_k` | vitesse de croissance et de décroissance du bonus |
| `market.temperature` | bas = le meilleur rafle tout ; haut = parts plus partagées |
| `market.demand_wave_amp` / `_period_s` | heures de pointe (utilité du stock) |
| `machines[]` | prix (et hausse par exemplaire), vitesse, améliorations, qualité par niveau ; `outcome` = point de vente |
| `grid.cols` / `rows` / `outcome_x` / `_y` | taille de l'usine et position du 1er Outcome |
| `grid.belt_cost` / `belt_speed` | prix d'un tapis (0 = gratuit), cases/s (débit max ≈ 60 × vitesse /min) |
| `player.start_money` / `stock_*` | démarrage, stock |
| `machines[].first_free` | le 1er exemplaire est gratuit (Cueillette) |
| `rivals[]` (`market`, `behavior`, prix, qualité, production, croissance) | rivaux de chaque marché |
| `ai.price_interval_s` / `upgrade_interval_s` | nervosité et progression des rivaux |
| `reveal.*` | rythme de la révélation progressive |

Les tables sont plates (une ligne = un objet) pour passer facilement à Google Sheets. Changer `meta.version` invalide les sauvegardes.

## Architecture
```
config.json            tout l'équilibrage
src/market.js          modèle de demande pur, par marché
src/monopoly.js        bonus de monopole (pur)
src/grid.js            grille : machines 2×2, Outcome, tapis, objets en transit (pur)
src/factory.js         stock, coût unitaire, production abstraite des rivaux
src/ai.js              comportement des rivaux
src/sim.js             état + tick pur : grille → stocks → 3 marchés ; actions du joueur
src/reveal.js          révélation progressive
src/main.js            boucle, onglets, indices, effets de monopole, sauvegarde
src/ui/*.js            hud, usine (canvas + pan), marché, debug, effets, sons
tools/                 check-market.js, bot-run.js
assets/kenney/         sous-ensemble des packs Kenney (CC0, voir License.txt)
```

## Décisions à valider
- **Flux continu** plutôt que tirage client par client : la part = l'espérance du tirage softmax, lisse et reproductible.
- **Refus par vendeur** : un segment refuse chaque vendeur sous son seuil.
- **Prix plancher = coût unitaire** (pas de revente à perte).
- **Pas de victoire** : le monopole est un état (effet visuel + bonus), qu'on peut perdre ; le jeu continue.
- Le monopole exige d'abord **80 % pendant 20 s** ; la croissance de son bonus démarre à ce moment-là.
- Reprendre un monopole pendant que l'ancien bonus décroît repart du bonus restant (courbe continue).
- **Mêmes 3 types de clients** sur chaque marché (volumes différents) ; rivaux différents par marché.
- **Un seul niveau de stock** pour toutes les ressources (chaque ressource a son propre stock, de même capacité).
- **Qualité = niveau moyen des machines** qui produisent la ressource.
- Machines 2×2, entrée et sortie sur la même file ; une machine peut livrer directement dans la suivante si elles sont collées et alignées.
- 1 objet par case de tapis ; les tapis peuvent fusionner ; l'Outcome accepte par tous les côtés.
- Le dernier Outcome ne peut pas être vendu ; déplacer est gratuit ; revente = 50 % (machine + améliorations).
- Les réglages du panneau debug ne sont pas sauvegardés et ne modifient pas `config.json`.
- Textes non polis : une passe de localisation est prévue.
