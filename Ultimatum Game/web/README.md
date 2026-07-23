# Market Ultimatum — le moteur de jeu

Doc d'entrée pour comprendre le jeu **sans avoir à lire les 20 fichiers**. Elle
couvre : ce qu'est le jeu, l'architecture, le pipeline de config, chaque système,
et les pièges. Pour l'outil de level design, voir
`../tools/level-designer/README.md`.

État : 2026-07-23.

---

## 1. Le jeu en une page

**Market Ultimatum** est un jeu web (format mobile, `#app` en `max-width: 480px`,
PWA via `sw.js`) de tycoon compétitif.

Tu tiens une échoppe. Tes **machines** fabriquent des **ressources**, tes
**ouvriers** les font tourner, et des **clients** tombent du haut de l'écran pour
acheter. Tu n'es pas seul : des **bots concurrents** jouent **exactement la même
économie** que toi (mêmes machines, mêmes ouvriers, mêmes tables de drop, même
horloge de production) — ils ne diffèrent que par leurs **décisions**.

**Condition de victoire** : finir dans le **top X** (`world_level.topX`) en
**revenus cumulés** (`revenue`) au bout des N vagues du niveau. Le revenu cumulé
ne redescend jamais : dépenser ne fait pas reculer au classement.

### La boucle

```
Menu ──launchLevel──► Setup ──► Play ──────────────────────────────► Results ──► GameOver
                    (crée le      ┌──────────────────────────┐        (entre       (fin du
                     joueur       │  PRÉPA  ──►  VAGUE       │◄──────  vagues)      niveau)
                     + les bots)  │  (rien   (production +   │
                                  │  produit)  clients)      │
                                  └──────────────────────────┘
```

- États : `S = { Menu, Setup, Play, Results, GameOver }` (`constants.js`),
  pilotés par `transitionTo` / `enterState` (`main.js`).
- La boucle temps réel est `Game.loop()` (rAF) → `updatePlay(dt)`. `dt` est
  **clampé à 0,2 s** puis multiplié par `timeScale` (boutons ×1/×2/×4).
- Un tutoriel `black_mask` **gèle la boucle** (`Tutorial.isBlocking()`) : le
  chrono de prépa ne coule pas derrière une modale.

---

## 2. Lancer & déboguer

- Config de lancement `ultimatum-web` (port 8792) → sert `Ultimatum Game/web/`.
  Ou `Launch Ultimatum Game.bat`.
- **Console de triche** : gated par le flag général `enableCheats`
  (`game-cheats.js`). Permet de sauter des vagues, compléter des niveaux,
  débloquer, etc.
- La méta est dans **localStorage** sous la clé `mu_meta_v2` (`meta.js`).
  `Meta.reset()` repart de zéro.
- ⚠️ **Piège de test** : dans un onglet en arrière-plan (`document.hidden`), le
  navigateur throttle `requestAnimationFrame`, les transitions CSS **et** les
  `setTimeout`. La boucle de jeu n'avance quasiment plus. Pour tester une
  mécanique, appelle `Game.updatePlay(dt)` à la main plutôt que d'attendre.

---

## 3. Architecture

Un **objet `Game` unique** (`main.js`) porte l'état et la config. Les gros
modules sont recollés dessus par `Object.assign` et utilisent `this` :

```js
Object.assign(Game, renderMethods, cheatMethods);
```

Les modules « logique pure » n'utilisent pas `this` : ils prennent `game` en
premier argument (`tickProduction(game, dt)`, `assignWorker(game, m, w)`…).

| Fichier | Rôle |
| --- | --- |
| `main.js` | Objet `Game`, boot, boucle rAF, machine à états, boucle de round (prépa/vague), stock & tiers, raffinage/auto-merge |
| `config.js` | `normalize(raw)` : format export → format moteur. `resolveLevel(cfg, id)` : niveau → config effective |
| `constants.js` | Constantes de rythme + enum d'états |
| `helpers.js` | `$`, `el`, `sprite`, `randInt`, `openOverlay`, `chainOverscroll` (over-scroll iOS) |
| `game-production.js` | Production par frame, pour **tous** les concurrents. `effTime` (exporté) |
| `game-customers.js` | Apparition des clients, choix du shop, vente |
| `game-workers.js` | Ouvriers & équipes (`freeWorkers`, assign/unassign, bonus d'équipe) |
| `game-shop.js` | Achats tycoon (ouvrier/marketing/stockage) + upgrade de machine |
| `game-bots.js` | IA des concurrents : investir, puis staffer |
| `game-render.js` | **Tout** le rendu DOM du jeu (`renderMethods`) |
| `game-cheats.js` | Console de triche (`cheatMethods`) |
| `meta.js` | Méta-progression persistante (localStorage) : niveaux, coffres, personnages, gear, slots, triggers |
| `menu.js` | Menu principal : sélection de niveau, collection de personnages, coffres |
| `tutorial.js` | Overlay d'onboarding piloté par la sheet `feature_unlock` |
| `codex.js` / `resource.js` / `building.js` | Widgets de consultation (clients & ressources / fiche ressource / fiche bâtiment + graphe de recettes) |

---

## 4. Le pipeline de config

La **Google Sheet est la source de vérité**. Un script Apps Script
(`Export config to json` à la racine du repo) exporte **chaque onglet** en un
tableau d'objets, clés = en-têtes de colonnes. Ajouter une colonne suffit donc à
la rendre visible côté moteur — **aucun code d'export à toucher**.

```
Google Sheet ──Apps Script──► config_export.json ─┐
                                                  ├─► Object.assign ──► normalize() ──► Game.cfg
Level Designer ────────────► config_levels.json ──┘
```

- `main.js` charge **les deux** fichiers et fait `Object.assign(raw, rawLevels)` :
  `config_levels.json` **remplace** les sections qu'il porte
  (`market_config`, `competitors_behavior`, `competitors_buffs`, `unlock_config`).
  ⚠️ Il remplace la **section entière**, pas ligne à ligne.
- `normalize()` traduit tout en structures moteur ; `resolveLevel()` assemble la
  config effective d'un niveau (rounds, marché, unlocks, lineup de bots, topX,
  preparationTime, safeAssign).
- **Tolérance aux renommages** : l'exporteur renomme des onglets au fil du temps
  (`upgrades` → `upgrade_machines_profile`, `convert` → `convert_profile`…).
  `normalize()` lit le nouveau nom **avec repli** sur l'ancien. Garde ce réflexe.

### Principales sections

| Section | Ce qu'elle porte |
| --- | --- |
| `general` | Réglages globaux → `cfg.g` (`startingMoney`, `startingWorkers`, `startingStorage`, `maxWorkersTotal`, `customerSpeed`, `customerRate`, `tycoonPhaseDuration`, `minimalPercentage`, `enableCheats`…) |
| `resources` / `ressources_tier` | Ressources et leurs tiers (prix, influence, sprite, couleur, chance de bonus de tier) |
| `machines` + `upgrade_machines_profile` + `inputs` | Machines, leurs niveaux (coût, `productionTime`, ouvriers requis/max, bonus de vitesse) et leurs recettes |
| `outputs` + `outputs_profiles` | Tables de drop : quel tier / quelle quantité / quel groupe (A..F) sort d'une machine à chaque niveau |
| `convert_profile` | Raffinage : N unités d'un tier → 1 du tier suivant |
| `purshases` *(sic)* | Paliers d'achat : ouvriers, marketing, stockage |
| `world_config` / `world_level` | Définition des niveaux (voir §9) |
| `market_config` | **Généré par l'outil** : par vague — nb de clients, quantité moyenne, poids par ressource, `customerBatch` |
| `competitors` / `competitors_behavior` / `competitors_buffs` | Identités des bots, puis (générés par l'outil) leurs poids par vague et leurs buffs |
| `characters` + profils | Personnages (les ouvriers du joueur), leurs machines de prédilection, leur courbe de progression |
| `gears` | Équipements : vitesse, proba 2×, valeur de fusion |
| `rewards` | Tables de butin (coffres, récompenses de niveau), tirage pondéré par groupe |
| `feature_unlock` + `triggers` / `triggers_group` | Déblocage progressif des fonctionnalités + tutoriels |
| `roundIncome` | Revenu automatique versé à **tout le monde** au début de certains rounds |

---

## 5. Modèle de données runtime

**Un « concurrent »** (le joueur et chaque bot ont la MÊME forme — c'est ce qui
permet à `tickProduction` de tourner pour tous) :

```js
{
  id, name, spriteId, spriteFolder, isPlayer,
  money, revenue,            // revenue = revenus cumulés (classement)
  salesThisRound, unitsThisRound,
  stock: { [resId]: { [tier]: count } },
  storageCap, marketing,
  workers: [ { uid, charId, machineId } ],
  machines: [ { id, level, crew: [worker], elapsed, producing, charged, _cycle, _inTiers } ],
  buys: { increaseWorker, increaseMarketting, increaseStorage },
  // bots seulement :
  def, behaviorByRound, buffs, upgradesBought,
}
```

- **Le stock est par (ressource, tier)** : `stockOf()` somme tous les tiers,
  `bestTier()` donne le meilleur tier détenu (il pilote l'attractivité).
- **L'ouvrier est l'entité canonique** : `w.machineId` dit s'il est assigné.
  `m.crew` est la liste miroir côté machine — les deux sont maintenus ensemble.
- `charId` non nul = c'est un **personnage** (bonus de vitesse/proba selon son
  niveau et son gear) ; sinon c'est un embauché anonyme.

---

## 6. Les systèmes

### 6.1 Production (`game-production.js`)

`tickProduction(game, dt)` tourne pour **chaque concurrent**, chaque frame. Les
helpers DOM abandonnent si la machine n'a pas de `_node` — seules les machines du
joueur sont rendues, donc les bots empruntent exactement le même code.

Un cycle :

1. **Sous-staffé** (`crew.length < workersRequired`) → **pause**, pas reset.
   `elapsed` est conservé, la barre reste figée sur `_cycle`.
2. **Convertisseur** → paie ses ingrédients **d'avance** (`charged`) : ils
   quittent le stock au **début** du cycle. Un cycle déjà payé va toujours au
   bout.
3. **Stock plein** → seuls les générateurs purs s'arrêtent ; les convertisseurs
   continuent (ils consomment avant de produire, donc jamais de blocage).
4. Fin de cycle → tirage du tier (`pickOutput` / `rollTier`), **bonus de qualité**
   (chaque ingrédient consommé retente +1 tier), plafonnage à
   `maxUnlockedTier()`, chance de **doubler** la sortie (proba 2× du gear).

**Vitesse** : les bonus s'additionnent en *vitesse*, pas en réduction de temps —
`temps = base / (1 + Σbonus)`. Linéaire, jamais zéro, pas d'explosion au cumul.

```js
effTime = max(0.3, productionTime / (1 + crewSpeedBonus + buffSpeed))
```

### 6.2 Boucle de round : prépa & vague (`main.js`)

**Pendant la prépa, PERSONNE ne produit** (joueur comme bots) :
`tickProduction` n'est appelé que si `waveActive`. La prépa est un temps mort où
l'on s'organise (achats, ouvriers, fusions). Les machines passent à
`producing = false` et réaffichent leur barre figée ; **le cycle en cours n'est
pas perdu** (`elapsed` conservé, reprise au lancement de la vague).

**Durée de la prépa** : `world_level.preparationTime` (par niveau), repli sur
`general.tycoonPhaseDuration`.

**Annonce de la demande** (`announceDemand`) : au début de chaque prépa, la
demande apparaît en gros **au centre** puis glisse jusqu'au bandeau
`#wave-preview`. Reste **3 s** (`HOLD`), vol 0,75 s, ressources en **grille
2 colonnes**. Purement cosmétique (`pointer-events: none`), auto-supprimée.

**Couverture de la demande** (`refreshWaveCoverage`, `.wp-cov` sur chaque chip du
bandeau **et** de l'annonce centrale) : le calcul mental « demande → machine →
ouvriers » fait par le jeu. ✓ machine staffée (ça produira, ou stock sans machine),
⚠ machine présente mais à l'arrêt (l'actionnable — il pulse), – pas positionné.
Rafraîchi sur le tick 0,2 s : réagit à chaque (dé)staff pendant la prépa.

**Bouton « ⏭ Lancer »** (`skipPrep`, dans le bandeau, seulement pendant la prépa) :
le joueur déclare qu'il a fini de se préparer. Il passe par **exactement le même
chemin** que le chrono qui tombe à 0 — verrou `safeAssign` compris : c'est un
raccourci de confort, pas une porte dérobée pour partir le banc plein. Grisé
(`.blocked`) quand le verrou refuserait le départ, mais il reste cliquable : le clic
allume alors l'alerte qui dit ce qui manque. Cette alerte-là (levée chrono **non**
écoulé) s'éteint d'elle-même dès que le banc est vidé — sans lancer la vague pour
autant, c'est au joueur de re-cliquer.

**Verrou d'assignation** (`world_level.safeAssign` = TRUE) : la vague **refuse de
démarrer** tant qu'un ouvrier traîne sur le banc. Le chrono est gelé à 0, le banc
clignote rouge (`#worker-bar.assign-warn`), le décompte devient « ⚠ Assigne tes
ouvriers ». Re-testé chaque frame. **Garde anti-soft-lock** :
`assignGateBlocking()` ne bloque que s'il reste **au moins une place libre** —
un niveau avec plus d'ouvriers que de sièges ne peut pas figer le joueur.

### 6.3 Clients & vagues (`game-customers.js`)

**Délai avant le tout premier client** (`firstDemandDelay`) : le temps de
complétion du **pire bot** pour la ressource **la plus demandée**. Pour chaque
bot possédant la machine qui la produit, on prend son `effTime` et on garde **le
plus lent** — même le concurrent le plus lent a le temps d'en sortir une. Repli
sur le temps de base si aucun bot ne la produit.

**Les clients arrivent par paquets** : `1..N`. `N` =
`market_config.customerBatch` (par niveau, défaut 2), repli
`general.customerBatch` puis `SPAWN_BATCH_MAX`. Le paquet **s'égrène** :
`market.pending` retient les clients restants et en lâche un toutes les
`SPAWN_BATCH_GAP` (0.22 s de temps de jeu, donc suit x1/x2/x4). Sans ce décalage,
deux clients naissaient à la **même frame**, à la même hauteur — superposés s'ils
visaient le même comptoir. Le paquet suivant attend que `pending` soit vide.

**La loterie est VISIBLE** (lisibilité du pilier « voler des clients ») :

- **Badge de part de marché** (`.counter-share`, coin haut-droit de chaque stand) :
  part estimée du prochain client, calculée par `expectedShares` — les **vrais odds**
  de `chooseShop` (marketing + tier + stock), pondérés par la demande de la vague.
  Rafraîchi sur le tick 0,2 s. Rouge à 0 % **seulement si quelqu'un d'autre est en
  course** — en début de prépa personne n'a de stock, tout colorer serait du bruit.
- **Pastille de raison** (`lossInfo` / `.cust-flag`, sur le client qui descend) :
  pourquoi ce client n'est **pas pour toi**. 📦 rupture de stock au tirage,
  📣 battu au marketing, ⭐ battu au tier, 🎲 perdu au tirage malgré l'avantage
  (le plancher `minimalPercentage` existe). Pas de pastille si le joueur ne produit
  pas la ressource (pas son marché) ou si le client est pour lui. Figée au moment
  où le vainqueur est tiré — spawn **ou** rattrapage `retryWaiting`.
- **Ventilation des pertes** (`market.ruptureUnits` / `market.stolenUnits`, comptées
  au règlement) : sous le camembert de fin de round, « ×N perdus en rupture » /
  « ×N volés à l'attractivité » — chaque cause pointe son remède. Un client parti
  bredouille compte en rupture **si** le joueur produit la ressource.

**Chaque client choisit son shop À L'APPARITION**, jamais au dernier moment :

1. Qui a le stock **maintenant** ? → `chooseShop` tire le vainqueur,
   pondéré par `attractiveness = marketing + influence(meilleur tier)`, avec un
   **plancher** `general.minimalPercentage` par concurrent (puis renormalisation).
2. `reserveSale` **réserve** aussitôt la marchandise (stock décrémenté) — un
   paquet ne peut donc pas survendre le même comptoir. Elle ne disparaît pas pour
   autant : `putOnCounter` la **pose sur le comptoir** (voir plus bas).
3. Le client descend **devant ce comptoir**, sur une colonne choisie par
   `freeLaneX()` : on balaie la largeur du comptoir et on garde le x le plus
   éloigné des clients encore **en haut de la lane** (< `LANE_BUSY` = 80 px), à
   égalité le plus proche du comptoir. Le jitter aléatoire ±18 px d'avant
   superposait régulièrement deux sprites de 46 px (`LANE_SLOT` = 52).
4. À l'arrivée, `settleSale` crédite argent + revenus + unités, et
   `takeFromCounter` fait **emporter** la marchandise par le client.

> **Conséquence assumée** : le stock d'un comptoir baisse dès qu'un client le
> vise, avant son arrivée. C'est le prix de la garantie « le client arrive devant
> le shop qu'il va vraiment visiter ».

### Le comptoir

Une unité vendue ne s'évapore plus à la réservation : elle **transite par le
comptoir**, visible, jusqu'à ce que le client vienne la prendre.

```
stock (c.stock)  --putOnCounter-->  comptoir (c.counterItems, .counter-desk)  --takeFromCounter-->  client
     ^ à la réservation (apparition du client)          ^ à l'arrivée du client
```

- Le stand n'affiche **que** le comptoir (planche de bois, `.counter-desk`) : ni
  liste de stock, ni intitulé. Le stock du joueur est dans le panneau
  **INVENTAIRE**, celui d'un bot dans sa **fiche** (tap sur le stand). Le stand
  reste ainsi à 139 px — le marché épinglé mange déjà 404 px de haut.
- Les deux trajets sont des **vols interpolés** (`flyItem` : `transform` animé par
  transition CSS) — vers le comptoir en 420 ms, vers le client en 340 ms avec
  fondu. Le chip destination est créé **avant** le vol et masqué (`.landing`) : il
  donne sa position exacte à l'atterrissage, et rien n'apparaît en double.
- Origine du vol (`reserveRect`) : le panneau **INVENTAIRE** quand c'est le joueur
  et qu'il est à l'écran — l'exact inverse de `flyToInventory` (l'unité produite y
  rentre, l'unité vendue en ressort) — sinon **sous le stand**, comme sortie de
  l'arrière-boutique.
- `c.counterItems` est le **modèle** (pas seulement du DOM) : `renderSuppliers`
  peut reconstruire les stands sans perdre les commandes en attente, et
  `clearCounters()` (début de prépa) garantit qu'aucun chip fantôme ne survit à une
  vague.

**Client parti à vide** (personne n'a la ressource à son apparition) : il n'est
**pas condamné pour autant**. Il descend sur une **ligne au hasard** mais reste
inscrit dans `market.waiting`, et `retryWaiting()` (~10×/s, même tick que
`restackCustomers`) retente sa réservation à chaque passage. Dès qu'un comptoir peut
le servir — ta machine vient de sortir la pièce — la marchandise part sur ce
comptoir et le client **glisse vers cette ligne** (transition CSS `left` .55 s). Il
ne se cogne plus contre un stand vide alors que la commande existe en stock.

La fenêtre se ferme à l'arrivée : le settle pose `order.arrived`, et `retryWaiting`
ne sert plus une commande dont le client est déjà passé (sinon le stock partait sans
que personne ne paie). `order` est **mutable** exprès — c'est le seul lien entre le
tir initial, une réservation tardive et le règlement en bas.

Toujours rien à l'arrivée : il **rate sa cible sur place** (rouge + fondu), sans
glisser hors écran. Compté en part de marché perdue (`lostUnits` / `lostValue`,
valorisé au prix T1). Le rattrapage vaut pour **tout le monde**, bots compris : un
concurrent qui produit pendant la chute peut rafler le client de la même façon.

### 6.4 Ressources, tiers, raffinage

- `maxUnlockedTier()` : plus haut tier débloqué (`feature_unlock` `tier2`..`tier6`).
  **S'applique aussi aux bots** — même économie, mêmes handicaps.
- **Raffinage / merge** : N unités d'un tier → 1 du tier suivant
  (`convertRule` / `doConvert`). `autoMergeTick()` (opt-in) replie tout ce qui
  est faisable, **tier le plus bas d'abord**, pour que les T2 frais cascadent en
  T3+ dans la même passe. Les bots ont le même auto-merge
  (`mergeBotStock`), désactivable par bot via le buff `autoMerge = 0`.
- **L'inventaire DOM est volontairement tenu périmé** : les mutations de stock ne
  font que lever `_invDirty`. On ne réécrit le DOM que si la section est à
  l'écran (`IntersectionObserver`), pour que la production hors-écran ne
  provoque aucun reflow.

### 6.5 Ouvriers & personnages

- Les **personnages possédés ET assignés à un slot** entrent en jeu en premier
  (`Meta.nextRecruit`, ordre : rareté, puis pièces de gear portées, puis qualité
  du gear, puis niveau) ; les embauches suivantes sont anonymes.
- Un personnage n'apporte son bonus de vitesse que sur **ses** machines
  (`character.machines`) ; le **gear** apporte vitesse + proba 2× partout.
- Un bot n'a pas de vrais personnages : sa panoplie est **rationalisée en buffs
  plats** (`speed`, `proba2x`, `marketing`) appliqués par-dessus son équipe.
- Le **banc** (`#worker-bar`) vit dans la barre du bas, **toujours visible** :
  cible permanente du geste « renvoyer l'ouvrier » (`dropTargetAt` → `"bar"`),
  plus de mode escamoté ni de surimpression pendant le drag (voir §7). Le geste
  principal pour déplacer un ouvrier est **tap → tap** (chip puis machine **ou
  pastille**) ; le drag reste possible, pastilles comprises pour les machines
  hors écran.

### 6.6 Bots (`game-bots.js`)

Un bot ne reçoit **aucune allocation** et **aucune unité gratuite** : chaque
unité, il l'a produite ; chaque pièce, il l'a vendue. Il ne diffère que par ses
décisions, prises **une fois par round** (`botPlanRound`) :

1. **Investir** (`botInvest`) : tire au sort pondéré parmi tout ce qu'il peut
   s'offrir (les 3 achats + les upgrades de machines de sa chaîne), en boucle
   jusqu'à ne plus rien pouvoir.
2. **Staffer** (`staffBot`, rejoué aussi ~1×/s pendant le round) : il calcule la
   **chaîne voulue** (la machine dont la sortie se vend + récursivement ses
   fournisseurs, poids décroissant en remontant), classe par **déficit de stock**
   plutôt que par poids brut, remplit d'abord le **minimum** de chaque machine
   (sous `workersRequired` une machine ne produit *rien*), puis empile le reste.

Son point faible est là : mal staffer gâche le round, exactement comme le joueur
qui lit mal la demande.

### 6.7 Méta-progression (`meta.js`)

Persistée en localStorage (`mu_meta_v2`).

- **Niveaux** : un niveau est débloqué quand tous les précédents sont complétés.
  Le **dernier** `world_level` est l'**endless** : toujours rejouable, sa
  récompense retombe à chaque victoire (les autres sont one-shot).
- **Monnaies & butin** : coins, gems, coffres. `grantReward` tire **un pick
  pondéré par groupe** (A..E) ; une ligne sans contenu = « rien ».
- **Personnages** : shards **nominatifs** (chaque personnage a son propre stock)
  pour débloquer (niveau 1) puis monter en niveau.
- **Gear** : des **instances** `{ uid, owner, slot, rarity, progress }`. La
  **fusion** consomme des pièces orphelines du même personnage et du même slot ;
  leur `fuzeValue` remplit la barre et fait monter la rareté (common → rare →
  epic → legendary), avec cascade et report du reste.
- **Slots de personnages** : une race (`typeSlot`) ne tient **qu'un seul slot**
  sur tout le plateau.

### 6.8 Déblocages & tutoriel

`feature_unlock` gate quasiment toute l'UI (marketing, stockage, upgrade,
merge, coffres, personnages, gear, vitesses ×2/×4, tiers 2..6…).

Deux durées de vie à ne **pas** mélanger (`meta.js`) :

- Les **records de run** (stock, vagues) sont remis à zéro à chaque niveau —
  sinon « atteindre 3 balles » serait déjà vrai en entrant et le tutoriel merge
  se déclencherait à la porte.
- `unlocked` est la moitié **permanente** : une fois qu'un trigger a été
  satisfait, la fonctionnalité reste ouverte pour toujours.

Le tutoriel (`tutorial.js`) lit la même table : `black_mask` (masque troué,
**gèle le jeu** jusqu'à l'action) ou `red_dot` (pastille non bloquante). Une
chaîne de cibles est parcourue un clic à la fois, la progression est persistée.

Layout une-page : une cible peut vivre dans une **sheet fermée** (Boutique,
Stock). Un `black_mask` **ouvre lui-même** la sheet qui contient sa cible
(`ensureSheet`) — le tutoriel amène le joueur à l'endroit qu'il enseigne ; un
`red_dot` attend que le joueur l'ouvre. Le geste `drag_n_drop_a_worker` vise
désormais chip → **pastille** de la machine de destination : dans le carrousel,
deux cartes ne sont jamais entières à l'écran en même temps, chip + pastille si.

---

## 7. Mise en page — écran unique

**Plus aucun scroll vertical.** L'ancien layout empilait tout dans une colonne
scrollable ; le marché épinglé et l'usine se battaient pour la hauteur, ce qui
avait engendré trois systèmes de compensation (marché condensé au scroll avec
hystérésis, inventaire à `IntersectionObserver`, banc escamotable avec mode
surimpression pendant le drag). Les trois sont **supprimés**. L'écran est une
colonne flex fixe :

```
#hud → #wave-preview → #market-zone (flex, toujours plein) →
#machine-dots + #machine-list (carrousel) → #bottom-bar (banc + Boutique + Stock)
```

- **Marché toujours visible** : `#market-zone` absorbe la hauteur flexible ; la
  lane est bornée (`min-height: 120px; max-height: var(--lane-h)`).
- **Machines en carrousel horizontal aimanté** (`#machine-list`,
  `scroll-snap-type: x mandatory`, cartes à 84 % — la voisine dépasse du bord).
  Les pseudo-éléments `::before/::after` (8 %) permettent à la première/dernière
  carte de se snapper au centre.
- **Pastilles d'état** (`#machine-dots`, `renderMachineDots` /
  `refreshMachineDots`) : la vue d'ensemble que le carrousel fait perdre. Une par
  machine — verte = produit, **rouge pulsante = à l'arrêt faute d'ouvriers**,
  or = assignable (un ouvrier est sélectionné). Tap = le carrousel s'y aimante,
  ou y **assigne** l'ouvrier sélectionné. C'est aussi une **cible de drop**
  (`dropTargetAt`) : on peut glisser un ouvrier vers une machine hors écran.
- **Barre du bas permanente** (`#bottom-bar`) : le banc (`#worker-bar`, scroll
  horizontal interne) + les boutons **Boutique** et **Stock**.
- **Boutique** (`#boutique-overlay`, sheet) : les achats tycoon (`#shop-bar` y a
  déménagé avec son id — les cibles tutoriel pointent toujours dessus). Le bouton
  porte une pastille `.glow` quand un achat est abordable (`refreshAffordability`).
  L'upgrade de machine reste sur la carte machine (contextuel).
- **Stock** (`#stock-overlay`, sheet) : l'inventaire (`#inventory-bar`, id
  conservé, bouton Merge compris). Le bouton affiche la jauge `7/20` en
  permanence (`refreshStockBtn`, tick 0.2 s). `_invVisible` signifie désormais
  « la sheet Stock est ouverte » — même contrat qu'avant pour le flush différé
  (`maybeRefreshInventory`) et les vols : une unité produite vole **vers le
  bouton Stock** quand la sheet est fermée (`flyToInventory`), une unité vendue
  en **repart** (`reserveRect`).
- Les overlays partagent un z-index ; `openOverlay()` incrémente un compteur pour
  que le dernier ouvert passe au-dessus (une fiche ouverte depuis une autre fiche
  revient bien sur la précédente à la fermeture). Les sheets (merge, boutique,
  stock) partagent le patron `.sheet` : une frame peinte à `translateY(100%)`
  avant `.open`, sinon pas de glissade.

---

## 8. Constantes de rythme (`constants.js`)

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `SPAWN_INTERVAL` | 0.45 s | Délai entre deux **paquets** de clients |
| `SPAWN_BATCH_MAX` | 2 | Repli du nb max de clients par paquet |
| `SPAWN_BATCH_GAP` | 0.22 s | Décalage entre deux clients **du même paquet** |
| `FALL_TIME` | 2.6 s | Durée de chute d'un client (divisée par `customerSpeed`) |
| `BASE_MARKETING` | 1.0 | Attractivité de base avant tout achat |

---

## 9. Colonnes `world_level`

| Colonne | Effet | Si absente |
| --- | --- | --- |
| `config` | Le `world_config` (et, par repli, le scope marché/bots) | — |
| `reward` | Table de butin à la victoire | pas de butin |
| `topX` | Rang à atteindre en revenus cumulés pour gagner | 1 |
| `preparationTime` | Durée de la prépa du niveau (s) | `general.tycoonPhaseDuration` |
| `safeAssign` | TRUE = vague bloquée tant qu'un ouvrier est libre | FALSE |

`safeAssign` accepte le booléen d'une case à cocher **ou** la chaîne `"TRUE"` —
l'exporteur rend l'un ou l'autre selon le type de la cellule.

---

## 10. Pièges connus

**Une colonne absente ne bloque pas — elle désactive silencieusement.** C'est le
piège numéro un de ce projet, et il a déjà coûté un bug majeur :

> Les bots lisaient `b.startingMoney`, colonne **disparue** de la sheet
> `competitors` → `money = undefined` → **NaN**. Or toutes les vérifs d'achat
> comparent `b.money - prix < reserve` : avec NaN, `NaN < 0` vaut **`false`**,
> donc **aucun achat n'était filtré**. Les bots achetaient en boucle à chaque
> round (« argent infini », affiché « 💰 NaN »). Corrigé par un repli sur
> `g.startingMoney`.

Toute comparaison numérique sur une valeur venant de la sheet doit tolérer
l'absence de la colonne. Préfère `Number.isFinite(x) ? x : defaut`.

Autres :

- **`config_levels.json` doit être ré-exporté** depuis l'outil après tout ajout
  de colonne générée (ex. `customerBatch`), sinon le moteur retombe sur son
  défaut. Rien ne casse, mais le réglage est ignoré.
- **Un niveau n'a qu'UN id**, qui nomme son `market_config` *et* le scope de ses
  bots. Les faire diverger a déjà produit des niveaux à **0 round**, en silence.
- Un bot **sans lignes `competitors_behavior` v2** pour un niveau ne fait
  strictement **rien** — l'ancien format global n'est plus lu.
- `avg` (quantité par client) est **exact** par défaut : `avg = 1` veut dire 1.
  Le tirage `{avg-1, avg, avg+1}` ne revient que si `qty_spread` est coché.
