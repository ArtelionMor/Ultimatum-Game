# Market Ultimatum v2

Prototype mobile (portrait, 480 px max) : tu construis une usine (citrons, jus, bouteilles, oranges, fraises, confiture…), tu montes de niveau en remplissant des tâches, et tu te bats sur 7 marchés contre des rivaux, jusqu'au monopole.
JS vanilla en modules ES, sans build ni dépendance.

```bash
python v2/tools/serve.py 8795 v2
```
Puis ouvrir http://localhost:8795.
- **Console de triche** : bouton 🐞 en haut à droite, touche `d`, ou `?debug` dans l'URL. Elle contient la vitesse ×1/×10/×50, la température, a/b par segment, +1K $ et Reset.
- `?nosave` : partie de test non sauvegardée.

## La boucle
1. **Usine** : une grille vue de dessus, plus grande que l'écran.
   - Tu achètes et poses des machines 2×2 : 🍋 Cueillette (crée des citrons), ⚙️ Pressage (citron → jus), 🍾 Embouteillage (jus → bouteille). Chaque machine a une entrée (triangle creux, de la couleur du produit qu'elle prend) et une sortie (triangle plein, de la couleur du produit qu'elle rend).
   - Tu les relies avec des tapis jusqu'à un **📤 Outcome**, qui envoie à la vente tout ce qui y entre, par tous les côtés.
   - Chaque machine s'améliore (+30 % de vitesse, niveau affiché dans une bulle), se tourne, se déplace gratuitement ou se revend (avec confirmation).
   - La 1re Cueillette et les tapis sont gratuits.
   - **Qualité ★1–★5 par fusion** : chaque produit a une machine d'**Amélioration** (Tri des citrons, Affinage du jus, Cuvée spéciale). Elle fusionne 3 objets de même ★ en 1 objet ★ supérieur ; un ★5 la traverse tel quel.
     - Chaîner deux Améliorations donne du ★3, etc. ; on sacrifie de la quantité pour de la qualité.
     - Les objets portent leur ★ (anneau : ★2 argent, ★3 or, ★4 violet, ★5 rose) et la gardent dans la chaîne (citron ★3 → jus ★3).
     - La qualité vendue = la moyenne des ★ du stock ; les ventes prennent chaque ★ au prorata.
2. **Marché** : un onglet par ressource livrée (🍋 Citron, 🧃 Jus, 🍾 Bouteille, 🍊 Orange, 🥤 Jus d'orange, 🍓 Fraise, 🍯 Confiture), chacun avec ses 3 rivaux. Tu règles ton prix ; des cartes camembert montrent les parts (tout le marché, puis chaque type de client).
3. Les ventes rapportent `prix − coût unitaire`. Pas de revenu passif ; comme la 1re Cueillette et les tapis sont gratuits, on peut toujours relancer une ligne.
4. **Niveau et tâches** (façon Chainsaw Juice King) : chaque niveau a 3 ou 4 tâches (construire, vendre, livrer un ★, monter une machine, atteindre une part de marché, gagner X $, agrandir le stock, prendre un monopole).
   - Une tâche remplie se **valide** dans le panneau 📋 (petite récompense).
   - Toutes validées → **Niveau suivant**, qui donne une récompense et **débloque** de nouvelles machines et produits.
   - Le bouton « Aller » d'une tâche emmène là où elle se fait.
5. **Recettes et enchères** (niveau 3+) :
   - chaque machine suit une recette : par ex. Pressage de base 2 🍋 → 1 🧃, Confiturerie 3 🍓 → 1 🍯, fusion 3 → 1 ★+1 ;
   - les **ventes aux enchères sont un événement** : environ toutes les 9 min (`event_every_s` + durée), quelques recettes alternatives (moins d'ingrédients, plus de sorties, plus rapide, Cueillette ★2) sont mises en vente pendant 2 min. Entre deux, l'onglet affiche un compte à rebours ;
   - tu enchéris (ta mise est bloquée, et rendue si tu es dépassé) ; les rivaux enchérissent jusqu'à un maximum secret (ceux du marché de la recette presque toujours, ceux des autres marchés parfois). Un rival dépassé par un autre rival s'obstine : il répond vite et monte un peu son maximum. Un rival qui gagne **se renforce** ;
   - **📜 Recettes** (bouton en haut, tiroir latéral) : tes recettes (appliquer à toutes tes machines, remettre la base, **mettre aux enchères**) et celles des rivaux (leur faire une offre) ;
   - **offres de rachat** : une notification reste en bas de l'écran jusqu'à ta réponse (Vendre / Refuser). Un rival refusé revient plus tard, plus offrant. Les rivaux se rachètent aussi des recettes entre eux ;
   - un **point rouge** signale une recette inutilisée, une seule fois (il s'éteint dès que tu as ouvert le tiroir) ;
   - deux quêtes l'introduisent : « Obtiens une recette alternative » (niv. 4) et « Fais tourner une machine avec une recette alternative » (niv. 6).
6. **Monopole** (pas d'écran de victoire) : tenir 80 % d'un marché pendant 20 s donne le monopole. Il apporte un effet visuel et un **bonus d'attrait** qui fidélise les clients. Les rivaux peuvent aussi prendre un monopole.

## Écrans
- **Haut** : ⭐ niveau, barre des tâches du niveau (bouton 📋, qui pulse quand une tâche est à valider), argent et revenu/min, et une ligne « 👉 » qui dit quoi faire maintenant (sinon : la prochaine tâche).
- **Usine** :
  - Barre d'outils : un bouton par produit (🍋 · 🧃 · 🍾), qui ouvre un menu **Production / Amélioration** ; puis 📤 Outcome et ⇉ Tapis. Toucher le produit de l'outil actif le repose. Dessous : les stocks par ressource et le bouton Agrandir.
  - **Poser** : avec un outil machine, appuie là où tu la veux, glisse vers où doit sortir la production (grosse flèche), lâche. Poser (ou déplacer) une machine sur des tapis les casse (croix orange en aperçu).
  - **Tapis** : glisse le doigt pour tracer ; toucher un tapis existant le tourne.
  - **Déplacer** : appuie sur une machine et fais-la glisser (elle garde son sens).
  - **Éditer** : touche une machine. Le reste de l'usine se grise et un widget au-dessus propose ⬆ Améliorer et Vendre (avec « Êtes-vous sûr ? »). En mode édition :
    - appuyer ailleurs (+ glisser) la déplace à cet endroit avec un nouveau sens ;
    - appuyer sur elle et glisser la tourne ;
    - la toucher à nouveau ou ✕ ferme.
  - **⬚ Sélection** (outil de la barre) : trace un rectangle au doigt pour sélectionner machines et tapis ; glisse ensuite dans la sélection pour déplacer tout le bloc (les tapis gênants sont cassés, les autres machines bloquent), ou vends-la depuis le widget.
  - **🧱 Agrandir** (à côté des stocks) : +4 colonnes et +4 lignes (à droite et en bas), prix qui double à chaque fois (`grid.expand_*`, max `grid.max_cols`).
  - **Pan** : glisser sur le sol vide sans outil, deux doigts avec n'importe quel outil, clic droit/molette sur PC.
  - Icônes : 💤 = attend sa matière, ⛔ = sortie bloquée (pas de tapis, ou stock plein).
- **Marché** (débloqué à la 1re vente) : onglets de ressources (👑 = ton monopole, ⚠️ = celui d'un rival), bandeau monopole, prix (± / curseur), marge, qualité, cartes camembert (prix et ★ qualité de chaque vendeur).
  - Prix de 0,1 $ à 999 $ sur tous les marchés. Curseur logarithmique : 0,1 → 100 $ sur les 90 premiers %, 100 → 999 $ sur les 10 derniers (`price_slider`). Pas des ± : 0,1 sous 10 $, 0,5 jusqu'à 100 $, puis 1 $.
- **E encadré** à côté de tes recettes : plein = équipée sur au moins une machine, pointillé = pas équipée.
- **🔀 Splitter** (outil à côté des tapis, 50 $ puis +1 % par splitter, `grid.splitter_*`) : posé sur un tapis il garde sa direction (ou glisse pour la choisir). Entrée par l'arrière, 2 sorties : forme ↑+←, ↑+→ ou ←+→ (vu dans le sens du tapis) ; schéma 50/50, 30/70, 70/30 ou « Principal d'abord » (le second ne reçoit que si le principal est bloqué). Flèche verte = principal, bleue = second. Si une sortie est bloquée, tout part par l'autre.
- **Menu ⇉ Tapis** : Tapis (gratuit), 🔀 Splitter, ➕ Croisement (gauche↔droite et haut↔bas passent sans se mélanger), 🚇 Tunnel (glisse de l'entrée à la sortie, jusqu'à `grid.tunnel_max_gap` = 4 cases entre les deux ; passe sous tapis et machines, se vend par paire). Prix 50 $ puis +1 % par pièce (`grid.crossing_*`, `grid.tunnel_*`).
- **Cartes de recettes** : un seul chiffre comparé à la recette de base : ⚡ ×N vitesse pour les récoltes, ♻️ ×N sorties par matière pour les transformations (⚡ si seul le rythme change) et le verdict de rang.
- **Recette équipée = choix durable** : la dernière recette choisie pour un type de machine (⇄, « Appliquer à mes… » ou « Remettre la base ») est aussi celle des machines construites ensuite (`auc.equip`). Si la recette est vendue, ce type repasse en recette de base.
- **Enchères** (niveau 3) : sous-onglets 🔨 Enchères (vente en cours, ou compte à rebours) et ✉️ Offres (reçues et envoyées).
- **En haut** : 📜 Recettes (tiroir) et 📊 Statistiques : courbes de tes ventes ($/min) par produit sur les dernières minutes, et part de chaque produit dans tes revenus.
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
3 rivaux par marché, avec la même logique de stock et de vente (production abstraite).

**Ils se calent sur ton niveau** :
- leur cible au niveau L est `production = prod_per_min × (1 + prod_per_level)^(L−1)` (idem pour le stock) et `qualité = quality + quality_per_level × (L−1)`, plafonnée à `quality_max` ;
- ils s'en approchent doucement (constante `ai.level_tau_s`, 60 s) ;
- ils ne prennent donc jamais d'avance tant que tu ne montes pas de niveau.

Toutes les `price_interval_s` :
- `undercut` : 5 % sous ton prix, jamais au-dessus de son prix de départ.
- `premium` : baisse si son stock dort, monte s'il est vide (±30 % de son prix de départ).
- `follow` : copie le prix du leader de parts, à ±5 %.

Plancher : `coût unitaire × (1 + price_floor_margin)`, arrondi au pas de prix du marché.

## Outils
- `node tools/check-market.js [--market bottle] [--minutes 5]` : pour chaque marché, 10 min simulées à prix fixes (0,6 / 1 / 1,6 × réf) × 3 qualités, avec les parts par segment.
  - Résultat actuel : sur les 3 marchés, le prix le plus rentable dépend du segment (pas de stratégie dominante), et chaque segment a un rival favori différent.
- `node tools/bot-run.js` : un bot pose la Cueillette gratuite, puis construit jusqu'à 4 lignes de bouteilles et vise le monopole Bouteille. Il n'utilise pas encore l'Amélioration, donc il reste à ★1 et n'obtient plus de monopole : **équilibrage à refaire avec le niveau joueur (étape 2)**.

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
| `grid.cols` / `rows` / `outcome_x` / `_y` | taille de départ de l'usine et position du 1er Outcome |
| `grid.expand_step` / `expand_cost` / `expand_cost_mult` / `max_cols` | achat de place : cases ajoutées, prix, hausse, taille max |
| `grid.belt_cost` / `belt_speed` | prix d'un tapis (0 = gratuit), cases/s (débit max ≈ 60 × vitesse /min) |
| `player.start_money` / `stock_*` | démarrage, stock |
| `machines[].first_free` | le 1er exemplaire est gratuit (Cueillette) |
| `machines[].kind` / `group` / `merge_n` / `max_tier` | `make` = production, `refine` = Amélioration (fusion `merge_n` → ★+1, jusqu'à `max_tier`) ; `group` = produit du menu |
| `reveal.refine_after_sold` | ventes avant de débloquer l'Amélioration |
| `rivals[]` (`market`, `behavior`, prix, qualité, production, `prod_per_level`, `quality_per_level`) | rivaux de chaque marché et leur progression par niveau du joueur |
| `ai.price_interval_s` / `level_tau_s` | nervosité des rivaux, vitesse à laquelle ils rejoignent leur cible |
| `recipes[]` (`machine`, `base`, `rarity`, `inputs`, `outputs`, `rate_mult`, `out_tier`, `value`) | recettes de base et alternatives ; `value` sert de prix de référence aux enchères et aux offres |
| `rarities[]` (`color`, `ai_max`) | couleur des cartes et jusqu'où les rivaux peuvent monter (× valeur) |
| `price_slider` (`knee_price`, `knee_pos`, `steps[]`) | curseur de prix logarithmique et pas des ± selon la tranche de prix |
| `auction.*` | ouverture (niveau), événements (`event_every_s`, `event_lots`, `first_event_s`, `duration_s`), mise de départ, surenchère, intérêt des rivaux (`ai_interest`, `ai_interest_other`, `ai_max_mult`, `ai_other_max`), obstination (`ai_pride`, `ai_pride_cap`, `ai_counter_s`), revente, offres reçues (`offer_every_s`, `retry_s`, `retry_raise`), échanges entre rivaux (`rival_trade_every_s`, `rival_trade_chance`), bonus d'un rival par recette possédée |
| `levels[]` (`level`, `unlock`, `reward`) | ce que chaque niveau débloque (ids de machines séparés par des espaces) et rapporte |
| `tasks[]` (`level`, `type`, `param`, `target`, `reward`) | tâches de chaque niveau ; types : `build`, `sell`, `tier`, `upgrade`, `share`, `earn`, `stock`, `monopoly`, `own_recipe`, `use_recipe` |
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
src/progress.js        niveau joueur, tâches, déblocages (pur)
src/auction.js         événements d'enchères, offres, ventes de recettes, échanges entre rivaux (pur)
src/reveal.js          révélation progressive des éléments d'interface
src/main.js            boucle, onglets, indices, effets de monopole, sauvegarde
src/ui/*.js            hud, tâches, usine (canvas + pan), marché, enchères + tiroir recettes + notification d'offre, statistiques, debug, effets, sons
tools/                 check-market.js, bot-run.js
assets/kenney/         sous-ensemble des packs Kenney (CC0, voir License.txt)
```

## Décisions à valider
- **Flux continu** plutôt que tirage client par client : la part = l'espérance du tirage softmax, lisse et reproductible.
- **Refus par vendeur** : un segment refuse chaque vendeur sous son seuil.
- **Prix de 0,1 à 999 $ partout, vente à perte permise** (la marge passe en rouge). L'ancien plancher au coût unitaire a été retiré.
- **Pas de victoire** : le monopole est un état (effet visuel + bonus), qu'on peut perdre ; le jeu continue.
- Le monopole exige d'abord **80 % pendant 20 s** ; la croissance de son bonus démarre à ce moment-là.
- Reprendre un monopole pendant que l'ancien bonus décroît repart du bonus restant (courbe continue).
- **Mêmes 3 types de clients** sur chaque marché (volumes différents) ; rivaux différents par marché.
- **Un seul niveau de stock** pour toutes les ressources (chaque ressource a son propre stock, de même capacité).
- **Qualité = moyenne des ★ du stock** ; le niveau d'une machine ne donne que de la vitesse.
- **Coût unitaire d'un ★n** = formule `unit_cost_base + unit_cost_per_quality × (n − 1)`, pas ×3 : sinon la fusion n'est jamais rentable. Le vrai prix de la qualité, c'est la quantité sacrifiée.
- **Ventes au prorata des ★** (pas de choix « vendre seulement les ★4 » pour l'instant).
- Machines 2×2, entrée et sortie sur la même file ; une machine peut livrer directement dans la suivante si elles sont collées et alignées.
- 1 objet par case de tapis ; les tapis peuvent fusionner ; l'Outcome accepte par tous les côtés.
- Le dernier Outcome ne peut pas être vendu ; déplacer est gratuit ; revente = 50 % (machine + améliorations).
- Les réglages du panneau debug ne sont pas sauvegardés et ne modifient pas `config.json`.
- **Tâches cumulatives** : « Vends 25 jus » compte toutes les ventes depuis le début, pas seulement celles du niveau.
- Les **anciennes sauvegardes** sont placées au plus haut niveau dont elles utilisent déjà une machine ; les tâches des niveaux précédents sont considérées faites.
- **Équilibrage (17/10)** : rivaux +5 % de production par niveau (au lieu de +15 %), température 0,4 ; le seuil de monopole reste à 80 %.
- Une sauvegarde **impossible à charger** est mise de côté (`mu_v2_save_backup` dans le localStorage) au lieu d'être écrasée.
- Le bot de `bot-run` ignore les niveaux (il reste niveau 1, donc ses rivaux aussi) et les enchères.
- **Recette d'une machine à plusieurs entrées** : elle prend les N premiers objets de son tampon ; le produit garde le ★ le plus bas des ingrédients.
- Changer de recette vide le tampon de la machine (les ingrédients en attente sont perdus).
- Les rivaux n'ont pas d'argent modélisé : ils enchérissent jusqu'à leur maximum secret.
- Une recette vendue à un rival remet tes machines qui l'utilisaient en recette de base.
- Les recettes alternatives ne sont mises en vente que pour des machines que tu as déjà débloquées.
- Textes non polis : une passe de localisation est prévue.
