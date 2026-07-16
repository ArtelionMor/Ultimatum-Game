# Level Designer — brief de session

Outil de level design de Market Ultimatum. Il remplace les maquettes FigJam **et**
l'écriture à la main des onglets `market_config` / `competitors_behavior` de la
sheet : on assemble des niveaux à partir de blocs réutilisables, on vérifie
l'économie sur des graphiques, et l'outil génère les lignes exactes que le jeu lit.

## Lancement

- Double-clic sur `tools/level-designer/Level Designer.bat` (ou config de
  lancement `level-designer`, port 8790) → http://localhost:8790/tools/level-designer/
- Le serveur (`serve.py`) sert la **racine du repo** (l'outil lit
  `/web/config_export.json` et `/web/sprites/`) et envoie `Cache-Control:
  no-store` (un F5 suffit toujours). Ne pas remplacer par `python -m http.server`.
- Chrome/Edge requis pour la sauvegarde directe (File System Access).

## Le flux de création d'un niveau

1. **Palette (gauche) : créer des blocs.** Un bloc = un motif de N rounds :
   courbe de clients, courbe d'`avg`, et un mix de **rôles** abstraits
   (`focus:4, second:1` = 80/20). Courbes : `fixe`, `rampe` (from→to sur la
   durée du bloc), `liste` (valeurs cyclées, ex. `2,3,4,5,4,3,2`). Chaque bloc
   porte une **catégorie** libre (mono, duo, filler, complexity 2…) qui organise
   le menu d'ajout.
2. **Onglet Niveau : assembler.** Les niveaux sont empilés, groupés par
   **biomes** (clusters d'affichage : Meadow, Town… — jamais exportés). La carte
   fantôme « + » en bout de timeline ouvre un menu contextuel
   (catégorie → bloc, trié par usage réel). On lie alors chaque rôle à une vraie
   ressource — même bloc, liaisons différentes = variété gratuite. Overrides
   `clients`/`avg` par instance pour dévier du motif sans créer un bloc.
   Glisser-déposer pour réordonner ; ⧉ duplique ; la sélection (carte surlignée)
   pilote les trois autres onglets.
3. **Onglet Économie : vérifier.** Demande attendue par ressource (petits
   multiples), valeur du marché par round, **somme cumulée**, parts de marché,
   table des rounds. Formule = celle du moteur, pas une approximation :
   `clients × poids/Σpoids × avg` (cf. `pickNeed` dans web/game-customers.js).
4. **Onglet Concurrents : adapter les bots — par vague.** « Adapter au niveau »
   dérive les poids de la demande de **chaque round** : le bot se re-vise à
   chaque vague quand le marché pivote. Curseur spécialisation (0 = généraliste,
   1 = suit la demande de la vague, >1 = spécialiste), focus + boost. La carte
   montre l'**adaptation par vague** (courbe, similarité cosinus) et une
   mini-courbe de poids par ressource (« le bot se re-vise »). Les **achats
   d'upgrades** (increaseWorker/Marketting/Storage) sont une **courbe** sur les
   vagues (fixe/rampe/liste — ex. rampe descendante = investit tôt, récolte
   tard). Chaque bot porte des **buffs** — les personnages équipés,
   rationalisés : `speed` (vitesse prod %), `proba2x` (%), `marketing` (+plat).
5. **Onglet Export : sortir les données.** Lignes `market_config` (id = champ
   market_config du niveau, caché derrière ⚙ tant qu'il égale l'id du niveau) ;
   `competitors_behavior` **v2** : une ligne par (bot × vague), colonnes
   `config` (id du niveau), `id`, `round`, une colonne par ressource + les 3
   achats — le scope `config` élimine les collisions entre niveaux qui règlent
   le même bot ; `competitors_buffs` : une ligne par buff non nul (config, id,
   buff, value). Les diagnostics signalent toute colonne que le moteur lirait
   comme zéro (normalize lit les poids par id de ressource).

## Ce que la sheet ne porte plus (et ce qu'elle garde)

**Générés par l'outil — ne plus écrire à la main :**
- `market_config` : toutes les lignes des profils conçus ici.
- `competitors_behavior` : les poids des bots.

**Toujours dans la sheet (source de vérité) :** resources, machines/inputs,
upgrades, purshases, tax, unlock_config, **world_config / world_level** (qui
référencent les ids générés), competitors (identités), customers, rewards,
gears, characters, general, outputs…

✅ **Le jeu consomme le format v2** (migré 2026-07-16). `normalize()` indexe
`behaviorProfiles[config][bot][round]` + `buffProfiles[config][bot]` ;
`resolveLevel()` scope par **id de `world_level`** ; `simulateBot` lit les
poids de la vague courante (repli sur la vague précédente si la table est plus
courte que le niveau). Buffs : `speed` % → coût de production réduit
(`prix/(1+speed%)`), `proba2x` % → chance de doubler l'unité produite,
`marketing` → bonus plat d'attractivité (base 1.0 + buff). ⚠️ L'ancien format
global (`{id, ressources, weights}`) n'est **plus lu** : un bot sans lignes v2
pour un niveau ne fait rien — les niveaux existants doivent être re-exportés
depuis l'outil.

## Intégrer les niveaux dans le jeu (état 2026-07-16)

**Un seul geste : bouton « Export jeu » (onglet Export) → `config_levels.json`
→ le placer dans `web/`.** Le jeu charge `config_export.json` (sheet) **plus**
`config_levels.json` (outil : `market_config`, `competitors_behavior`,
`competitors_buffs` pour TOUS les niveaux du document) et fusionne au boot —
la sheet ne porte plus ces sections, un ré-export sheet ne peut donc plus
écraser les niveaux. Le fichier absent = jeu jouable mais niveaux sans marché.

Câblage des ids — **une seule colonne dans la sheet** :
- `world_config.marketConfig` = l'id du niveau dans l'outil (`Tutorial_1`…).
  Le moteur cherche les bots par id `world_level`, puis `marketConfig`, puis
  l'id `world_config` lui-même — marché + bots + buffs suivent donc la colonne
  qui porte l'id outil (tant que le champ ⚙ market_config du niveau garde sa
  valeur par défaut = l'id du niveau).
- Plus besoin de renseigner : `nbOfRounds` (déduit des rounds du marché) ni la
  colonne `competitors` (le lineup = les bots exportés par l'outil ; la colonne
  ne sert qu'aux niveaux non designés ici).
- « Copier les ids des niveaux » (onglet Export) copie un id par ligne, dans
  l'ordre d'affichage — collage direct dans une colonne de la sheet.
- `leveldesign.json` (bouton Sauvegarder) reste dans `tools/level-designer/`,
  jamais dans `web/`. Les boutons market/competitors par niveau restent pour
  inspection ponctuelle.

## Pont avec Claude

- Tout l'état vit dans `tools/level-designer/leveldesign.json` (bouton
  Sauvegarder). Pour passer la main : demander à Claude d'éditer ce fichier,
  puis « ↻ Depuis le disque » dans l'outil.
- « Copier le briefing pour Claude » (onglet Export) copie un résumé compact du
  niveau sélectionné.

## Pièges connus (2026-07)

- L'exporteur renomme des sections au fil du temps (`upgrades` →
  `upgrade_machines_profile`, `upgrade_profile` → `upgrade_character_profile`,
  `convert` → `convert_profile`). L'outil tolère l'absence des sections qu'il
  n'utilise pas et l'affiche en rouge ; **le jeu lit désormais les nouveaux noms
  avec repli sur les anciens** (corrigé 2026-07-16). `upgrade_machines_profile`
  est devenu une table de profils : la colonne `upgrades` de chaque machine
  référence son profil (`upgrade_profile_complexity_N`).
- Si « un bouton ne fait rien » : lire d'abord la barre de statut — un boot
  raté affiche désormais une bannière pleine page.
- `avg` = quantité moyenne par client (tirage `avg±1`, min 1) ; la colonne
  s'appelle `average amount` dans market_config.
