/* Market Ultimatum — main.js
 * Game object + event listeners + bootstrap.
 */
"use strict";

import { BASE_MARKETING, SPAWN_INTERVAL, SPAWN_BATCH_MAX, SPAWN_BATCH_GAP, FALL_TIME, S } from "./constants.js";
import { sprite, $, el, randInt } from "./helpers.js";
import { normalize, resolveLevel } from "./config.js";
import { Meta } from "./meta.js";
import { initMenu, showMenu, hideMenu, renderMenu, openCharacterPanel, gearBadges, renderDropList } from "./menu.js";
import { openBuildingPanel } from "./building.js";
import { openResource } from "./resource.js";
import { freeWorkers, addWorker } from "./game-workers.js";
import { nextMkt, buyMkt, nextStorage, buyStorage, nextMachineLevel, upgradeMachine } from "./game-shop.js";
import { botPlanRound, staffBot } from "./game-bots.js";
import { spawnCustomer, restackCustomers, retryWaiting } from "./game-customers.js";
import { tickProduction, effTime } from "./game-production.js";
import { renderMethods } from "./game-render.js";
import { cheatMethods } from "./game-cheats.js";
import { Tutorial } from "./tutorial.js";

// Player-facing names of feature_unlock ids (victory screen announcement).
const FEATURE_LABEL = {
  x2_button: "Vitesse ×2 débloquée !", x4_button: "Vitesse ×4 débloquée !",
  tier2: "Tier 2 débloqué !", tier3: "Tier 3 débloqué !", tier4: "Tier 4 débloqué !",
  tier5: "Tier 5 débloqué !", tier6: "Tier 6 débloqué !",
  upgrade_machine: "Amélioration des machines débloquée !",
  storage: "Stockage améliorable débloqué !",
  marketting: "Marketing débloqué !",
  merge: "Merge débloqué !",
  chest: "Coffres débloqués !",
  character: "Personnages débloqués !",
  gears: "Équipements débloqués !",
  end_of_round_summary: "Résumé de fin de round débloqué !",
};

// ============================================================
// Game
// ============================================================
const Game = {
  cfg: null, state: S.Menu, round: 0, prepTimer: 0, waveActive: false,
  competitors: [], player: null, lastTime: 0, market: null, timeScale: 1,
  levelCfg: null, // effective config of the level being played (resolveLevel)

  async start() {
    // Two sources: the sheet export, plus the level designer's output
    // (market_config + competitors_behavior + competitors_buffs). The sheet no
    // longer carries those sections, so a sheet re-export can't erase the levels.
    const [raw, rawLevels] = await Promise.all([
      fetch("config_export.json").then((r) => r.json()),
      fetch("config_levels.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    Object.assign(raw, rawLevels);
    this.cfg = normalize(raw);
    // Production lookup keyed `resourceId_level`. New config schema: `outputs`
    // maps each resource id to a profile name (`profil`), and `outputsProfiles`
    // holds the per-level group weights + tier distribution shared by that profile.
    // Falls back to the old flat `outputs` shape if `outputsProfiles` is absent.
    this.cfg._outputs = {};
    const outputsProfiles = raw.outputsProfiles || raw.outputs_profiles; // exporter emits snake_case
    if (outputsProfiles) {
      const profileRows = {}; // `profil_level` -> [{ group, quantity, weight, tiers }]
      outputsProfiles.forEach((o) => {
        const k = o.id + "_" + o.level;
        (profileRows[k] = profileRows[k] || []).push({
          group: o.group, quantity: o.quantity, weight: o.weight,
          tiers: [o.tier1, o.tier2, o.tier3, o.tier4, o.tier5, o.tier6].map((t) => t ?? 0),
        });
      });
      raw.outputs.forEach((o) => {
        for (let lvl = 1; lvl <= 15; lvl++) {
          const rows = profileRows[o.profil + "_" + lvl];
          if (rows) this.cfg._outputs[o.id + "_" + lvl] = rows;
        }
      });
    } else {
      raw.outputs.forEach((o) => { const k = o.id + "_" + o.level; (this.cfg._outputs[k] = this.cfg._outputs[k] || []).push({ group: o.group, quantity: o.quantity, weight: o.weight, tiers: [o.tier1, o.tier2, o.tier3, o.tier4, o.tier5, o.tier6] }); });
    }
    Meta.init(this.cfg);
    initMenu(this);
    Tutorial.init(this);
    this.applyCheatMode();
    this.transitionTo(S.Menu);
    this._invVisible = false; this._invDirty = false;   // la sheet Stock démarre fermée
    requestAnimationFrame((t) => this.loop(t));
  },

  // ---------- Menu / level flow ----------
  resolveLevel(levelId) { return resolveLevel(this.cfg, levelId); },
  enterMenu() { $("#app").classList.add("hidden"); showMenu(); },
  launchLevel(levelId) {
    this.levelCfg = this.resolveLevel(levelId);
    // enter_level_[number]: same progression point as reach_level_(N-1), but
    // observed here, with the in-game UI on screen — that is where the tutorials
    // pointing at in-game buttons need to fire.
    Meta.noteEnterLevel(this.cfg.worldLevels.findIndex((l) => l.id === levelId) + 1);
    hideMenu();
    $("#app").classList.remove("hidden");
    this.transitionTo(S.Setup);
  },
  // Abandon or finish -> back to the menu (game loop idles in S.Menu).
  toMenu() {
    ["#results-overlay", "#gameover-overlay", "#quit-overlay", "#rankinfo-overlay", "#boutique-overlay", "#stock-overlay", "#merge-overlay"].forEach((id) => { const o = $(id); if (o) { o.classList.add("hidden"); o.classList.remove("open"); } });
    this._invVisible = false;   // sheet Stock refermée avec le reste
    this.waveActive = false; this.market = null;
    const lane = $("#customer-lane"); if (lane) lane.innerHTML = "";
    this.transitionTo(S.Menu);
  },
  // Called by the menu when meta state changes (gear equipped, character upgraded)
  // so an ongoing run picks the new bonuses up immediately.
  onMetaChanged() { if (this.state === S.Play) { this.renderWorkers(); } },

  // The inventory DOM is deliberately kept stale: stock mutations only flip
  // _invDirty, and the flush only happens while the Stock sheet is open
  // (_invVisible, posé par openStock/closeStock). L'IntersectionObserver de
  // l'ancien layout scrollable n'a plus d'objet : la sheet EST la visibilité.
  maybeRefreshInventory() { if (this._invDirty && this._invVisible) this.refreshInventory(); },

  loop(t) {
    if (!this.lastTime) this.lastTime = t;
    let dt = (t - this.lastTime) / 1000; this.lastTime = t;
    if (dt > 0.2) dt = 0.2;
    dt *= (this.timeScale || 1); // time acceleration (HUD speed button / cheat console)
    // A black_mask freezes the run: the prep countdown must not drain behind a
    // modal the player can only dismiss by performing the action.
    if (this.state === S.Play && !Tutorial.isBlocking()) this.updatePlay(dt);
    requestAnimationFrame((t2) => this.loop(t2));
  },

  transitionTo(n) { this.exitState(this.state); this.state = n; this.enterState(n); },
  enterState(s) { ({ [S.Menu]: () => this.enterMenu(), [S.Setup]: () => this.enterSetup(), [S.Play]: () => this.enterPlay(), [S.Results]: () => this.enterResults(), [S.GameOver]: () => this.enterGameOver() }[s] || (() => {}))(); },
  exitState(s) { void s; },

  // ---------- helpers ----------
  // Per-level lookups: market row (falls back to the last defined round), tax
  // cost of a round, and the round a machine unlocks (null = not in this level).
  marketFor(round) {
    const m = this.levelCfg.market;
    if (m[round]) return m[round];
    const keys = Object.keys(m).map(Number);
    return m[Math.max(...keys)];
  },
  machineUnlockRound(id) { const u = this.levelCfg.unlocks; return u[id] != null ? u[id] : null; },
  // Classement live aux revenus cumulés (le camembert et le HUD s'en servent).
  rankedByRevenue() { return [...this.competitors].sort((a, b) => b.revenue - a.revenue); },
  playerRank() { return 1 + this.competitors.filter((c) => c.revenue > this.player.revenue).length; },
  res(id) { return this.cfg.resources[id]; },
  tierInfo(id, tier) { return this.cfg.resources[id].tiers[tier]; },
  tierColor(tier) { return this.cfg.tierColors[tier] || "#EFEFEF"; }, // fond des tuiles d'inventaire (tab ressources_tier)
  machineDef(id) { return this.cfg.machines.find((m) => m.id === id); },
  // First customer whose needs include this resource (codex navigation helper).
  customerForResource(resId) { return (this.cfg.customerOrder || []).find((cid) => this.cfg.customerDefs[cid].needs.includes(resId)) || null; },
  emptyStock() { const s = {}; this.cfg.resourceOrder.forEach((r) => { s[r] = {}; }); return s; },
  stockTotal(c) { let n = 0; for (const r in c.stock) for (const t in c.stock[r]) n += c.stock[r][t]; return n; },
  stockOf(c, resId) { let n = 0; const m = c.stock[resId] || {}; for (const t in m) n += m[t]; return n; },
  bestTier(c, resId) { const m = c.stock[resId] || {}; let best = 0; for (const t in m) if (m[t] > 0 && +t > best) best = +t; return best; },
  addStock(c, resId, tier, qty) { c.stock[resId][tier] = (c.stock[resId][tier] || 0) + qty; if (c === this.player) this._invDirty = true; },
  tierCount(c, resId, tier) { return (c.stock[resId] && c.stock[resId][tier]) || 0; },
  // Highest tier the player has unlocked (feature_unlock rows tier2..tier6).
  // Applies to BOTS TOO: they play the player's economy, locks included.
  maxUnlockedTier() {
    let t = 1;
    while (t < this.cfg.maxTier && Meta.featureUnlocked("tier" + (t + 1))) t++;
    return t;
  },

  // ---------- Refining (convert table: N of tier n -> result of tier n+1) ----------
  convertRule(resId, tier) { const r = this.cfg.convert[resId]; return (r && r[tier]) || null; },
  canConvert(c, resId, tier) {
    if (!Meta.featureUnlocked("merge")) return false;
    const rule = this.convertRule(resId, tier);
    return !!rule && rule.resultTier <= this.maxUnlockedTier() && this.tierCount(c, resId, tier) >= rule.quantity;
  },
  doConvert(resId, tier) {
    const p = this.player, rule = this.convertRule(resId, tier);
    if (!this.canConvert(p, resId, tier)) return false;
    p.stock[resId][tier] -= rule.quantity;
    this.addStock(p, rule.resultRes, rule.resultTier, rule.resultQty);
    this.refreshInventory();
    return true;
  },
  // Auto-merge (opt-in, tickbox in the merge sheet): fold every doable merge,
  // lowest tier first so fresh T2s can cascade into T3+ in the same pass.
  autoMergeTick() {
    if (!this.autoMerge || !this.player) return; // pas de partie en cours (menu) → rien à replier
    let guard = 200;
    this.cfg.resourceOrder.forEach((rid) => {
      const rules = this.cfg.convert[rid]; if (!rules) return;
      Object.keys(rules).map(Number).sort((a, b) => a - b).forEach((t) => {
        while (guard-- > 0 && this.canConvert(this.player, rid, t)) this.doConvert(rid, t);
      });
    });
  },

  // Build an <img> for a given resource tier, with a fallback chain so it works
  // whatever naming the tier art ends up using (and falls back to the base sprite
  // until per-tier art exists). Drop tier files in web/sprites/tiers/.
  // Per-tier sprite id from config (falls back to the resource's default sprite).
  tierSpriteId(resId, tier) { const t = this.cfg.resources[resId].tiers[tier]; return (t && t.spriteId) || this.res(resId).spriteId; },
  tierSrc(resId, tier) { return `sprites/Ressources/${this.tierSpriteId(resId, tier)}.png`; },
  tierImg(resId, tier) {
    const candidates = [ this.tierSrc(resId, tier), `sprites/Ressources/${this.res(resId).spriteId}.png` ]; // tier art, else default
    const img = new Image();
    let i = 0;
    img.onerror = () => { i++; if (i < candidates.length) img.src = candidates[i]; else img.onerror = null; };
    img.src = candidates[0];
    return img;
  },

  // Fly a freshly produced unit from its machine card into the inventory —
  // les tuiles si la sheet Stock est ouverte, sinon le BOUTON Stock (la réserve
  // visible du layout une-page ; l'exact inverse de reserveRect côté vente).
  flyToInventory(m, resId, tier) {
    const node = m._node; if (!node) return;
    const box = (this._invTiles && this._invTiles.isConnected && this._invVisible) ? this._invTiles : $("#stock-btn");
    if (!box || !box.isConnected) return;
    const from = node.getBoundingClientRect(), to = box.getBoundingClientRect();
    if (!to.width) return;
    const fly = this.tierImg(resId, tier); fly.className = "fly-res";
    document.body.appendChild(fly);
    const x0 = from.left + from.width / 2 - 14, y0 = from.top + 18;
    fly.style.left = x0 + "px"; fly.style.top = y0 + "px";
    const dx = (to.left + to.width / 2) - (x0 + 14), dy = (to.top + to.height / 2) - (y0 + 14);
    requestAnimationFrame(() => { fly.style.transform = `translate(${dx}px,${dy}px) scale(.55)`; fly.style.opacity = "0.15"; });
    setTimeout(() => fly.remove(), 520);
  },

  // Floating "luck" popup over a machine, styled per its output slot group (A..F).
  // `bonusTiers` = the ingredient tiers that won their +1 quality roll this cycle
  // (game-production.rollIngredientBonus); each gets its own credit line under the drop.
  showSpawnPopup(m, resId, qty, tier, group, bonusTiers) {
    const node = m._node; if (!node) return;
    const slot = (this.cfg.slots && this.cfg.slots[group]) || {};
    const r = node.getBoundingClientRect();
    const desc = slot.description ? slot.description + " " : "";
    const bonus = (bonusTiers || []).map((t) => `<br><span class="spawn-bonus">bonus for good ingredient: Tier ${t}</span>`).join("");
    const pop = el("div", "spawn-pop", `${desc}+${qty} Tier ${tier} ${this.res(resId).displayName}${bonus}`);
    if (slot.color) pop.style.color = slot.color;
    pop.style.fontSize = (slot.font || 12) + "px";
    pop.style.left = (r.left + r.width / 2) + "px";
    pop.style.top = (r.top + 14) + "px";
    document.body.appendChild(pop);
    setTimeout(() => pop.remove(), 1150);
  },

  // ---------- Setup ----------
  enterSetup() {
    const g = this.cfg.g;
    // The run starts with an empty inventory, so the stock/wave trigger records
    // start over too: a condition like "hold 3 tennis balls" has to be met in
    // THIS run, not inherited from the last one.
    Meta.startRun();
    this.round = 0;
    this.selectedWorker = null;
    this.timeScale = 1;           // each run starts at normal speed
    this.refreshSpeedBtn();
    const pav = Meta.profileSprite();
    this.player = {
      id: "player", name: "Toi", spriteId: pav.spriteId, spriteFolder: pav.folder, isPlayer: true,
      money: g.startingMoney, stock: this.emptyStock(), storageCap: g.startingStorage,
      marketing: BASE_MARKETING, workers: [],
      machines: [], buys: { increaseWorker: 0, increaseMarketting: 0, increaseStorage: 0 },
      salesThisRound: 0, revenue: 0,
    };
    // Plus d'ouvriers de départ à poser : chaque machine arrive équipée (fillCrew).
    this.cfg.machines.forEach((m) => { const r = this.machineUnlockRound(m.id); if (r != null && r <= 1) this.giveMachine(this.player, m.id); });

    // The level defines the exact bot lineup.
    const bots = this.levelCfg.bots.map((b) => ({
      id: b.id, name: b.displayName, spriteId: b.spriteId, spriteFolder: "Characters", isPlayer: false,
      // Même argent de départ que le joueur (les bots jouent TON économie). Sans repli,
      // une colonne startingMoney absente laissait money=undefined → NaN, et NaN déjoue
      // TOUTES les vérifs d'achat (NaN < reserve = false) : le bot achetait à l'infini.
      money: Number.isFinite(b.startingMoney) ? b.startingMoney : g.startingMoney, stock: this.emptyStock(), storageCap: g.startingStorage,
      marketing: BASE_MARKETING + (b.buffs.marketing || 0), def: b, behaviorByRound: b.behaviorByRound, buffs: b.buffs, upgradesBought: 0,
      workers: [], machines: [],
      buys: { increaseWorker: 0, increaseMarketting: 0, increaseStorage: 0 }, salesThisRound: 0, revenue: 0,
    }));
    // Les bots jouent TON économie : mêmes machines débloquées (équipées d'office),
    // même horloge de production (game-production.js tickProduction).
    bots.forEach((b) => {
      this.cfg.machines.forEach((m) => { const r = this.machineUnlockRound(m.id); if (r != null && r <= 1) this.giveMachine(b, m.id); });
    });
    this.competitors = [this.player, ...bots];
    this._screenReady = false;
    this.transitionTo(S.Play);
  },

  // Rework « rabatteur » : plus de gestion d'ouvriers. Une machine ARRIVE avec son
  // équipe au complet (maxWorkers de son niveau) et ne la partage plus. Le verbe du
  // joueur n'est plus « déplacer des bonshommes » mais « choisir la posture de
  // chaque machine » : mode "prod" (fabrique) ou "sell" (rabatteur — l'équipe crie
  // sur le pas de la porte : attractivité boostée sur SA ressource, zéro production).
  giveMachine(p, id) {
    if (p.machines.some((m) => m.id === id)) return;
    const m = { id, level: 1, crew: [], elapsed: 0, producing: false, mode: "prod" };
    p.machines.push(m);
    this.fillCrew(p, m);
  },
  // Complète l'équipe d'une machine à maxWorkers (appelé à la création ET après
  // chaque upgrade, joueur comme bot). Passe par addWorker : les PERSONNAGES du
  // joueur embarquent toujours en premier (bonus de vitesse/proba conservés).
  fillCrew(p, m) {
    const L = this.lvl(m);
    while (m.crew.length < L.maxWorkers) {
      addWorker(this, p);
      const w = p.workers[p.workers.length - 1];
      w.machineId = m.id; m.crew.push(w);
    }
  },

  // ---------- Play (single screen: continuous production + customer waves) ----------
  enterPlay() {
    if (!this._screenReady) this.setupScreen();
    this.startPrep();
  },

  // One-time screen setup. L'écran une-page n'a plus de scroll vertical : la
  // mécanique de condensation du marché (hystérésis, padding compensé) est morte
  // avec lui — le marché est toujours en pleine taille.
  setupScreen() {
    this._screenReady = true;
    $("#factory-zone").classList.remove("hidden");
    $("#market-zone").classList.remove("hidden");
    $("#customer-lane").innerHTML = "";
  },

  // Prep window before a wave: production runs, player prepares, top menu shows demand.
  startPrep() {
    this.round++;
    Meta.noteWave(this.round);   // reach_wave_[number]
    const g = this.cfg.g;
    this.waveActive = false;
    // Prep window is per-level (world_level.preparationTime); the global
    // tycoonPhaseDuration is only the fallback for levels that leave it blank.
    this.prepTimer = this.levelCfg.preparationTime != null ? this.levelCfg.preparationTime : g.tycoonPhaseDuration;
    this.market = null;
    this.selectedWorker = null;

    // Pendant la prépa, PERSONNE ne produit (joueur comme bots) : la production
    // ne tourne que pendant la vague (voir updatePlay). On gèle donc chaque machine
    // à l'arrêt ; son cycle en cours reprend là où il s'était figé au lancement.
    this.competitors.forEach((c) => c.machines.forEach((m) => { m.producing = false; }));
    this.setAssignWarning(false); // repart d'un banc « propre » (safeAssign)

    // round income (scheduled) to every competitor — counts as earned revenue
    const inc = this.cfg.roundIncome[this.round];
    if (inc) this.competitors.forEach((c) => { c.money += inc.coins; c.revenue += inc.coins; });

    // unlock machines (per-level schedule) pour tout le monde, keep worker assignments.
    // Avant le plan des bots : une machine débloquée ce round doit pouvoir être staffée.
    this.competitors.forEach((c) => {
      this.cfg.machines.forEach((m) => { if (this.machineUnlockRound(m.id) === this.round) this.giveMachine(c, m.id); });
    });

    // Les bots décident leur round ici : acheter, puis staffer. Ils ne fabriquent
    // rien eux-mêmes — leurs machines tournent dans tickProduction comme les tiennes.
    this.competitors.forEach((c) => { if (!c.isPlayer) botPlanRound(this, c); });

    this.clearCounters();   // vague finie : plus une seule commande en attente sur les comptoirs
    this.renderInventory(); this.renderShop(); this.renderMachines(); this.renderWorkers();
    this.renderSuppliers(); this.renderWavePreview(); this.refreshHud();
    // Freshly rebuilt machine cards start empty : on ré-affiche la barre figée du
    // cycle en pause (0 si aucun cycle n'a encore tourné), sans compte à rebours.
    this.player.machines.forEach((m) => this.setProgress(m, m._cycle ? Math.min(1, m.elapsed / m._cycle) : 0));
    // La demande de la vague apparaît en gros au centre puis glisse vers le bandeau.
    this.announceDemand();
  },

  // Prep opener: the incoming wave's demand pops in the middle of the screen as
  // floating text, then slides up to its slot in the top banner (#wave-preview).
  // Purely cosmetic (pointer-events:none) — the real banner is already rendered
  // underneath, so the float just merges into it and self-removes.
  announceDemand() {
    const pr = this.previewWave();
    if (pr == null) return;                    // last wave: nothing incoming to announce
    const banner = $("#wave-preview");
    const chips = banner && banner.querySelector(".wp-chips");
    if (!chips) return;
    document.querySelectorAll(".demand-float").forEach((n) => n.remove()); // drop any leftover
    const float = el("div", "demand-float");
    float.innerHTML = `<div class="df-title">Vague ${pr}</div><div class="wp-chips">${chips.innerHTML}</div>`;
    document.body.appendChild(float);
    // getBoundingClientRect force un reflow : l'état initial (opacity:0) est « commité »,
    // donc passer à 1 juste après déclenche bien la transition — sans dépendre du rAF.
    const target = banner.getBoundingClientRect(), fr = float.getBoundingClientRect();
    const dx = (target.left + target.width / 2) - (fr.left + fr.width / 2);
    const dy = (target.top + target.height / 2) - (fr.top + fr.height / 2);
    const HOLD = 3000, FLY = 0.75;                               // reste ≥ 3 s à l'écran avant de filer
    float.style.opacity = "1";                                   // fade in, centered (CSS)
    setTimeout(() => {                                            // hold, then fly to the banner
      float.style.transition = `transform ${FLY}s cubic-bezier(.4,0,.2,1), opacity ${FLY}s ease`;
      float.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.62)`;
      float.style.opacity = "0";
    }, HOLD);
    const done = () => float.remove();
    float.addEventListener("transitionend", (e) => { if (e.propertyName === "transform") done(); }, { once: true });
    setTimeout(done, HOLD + FLY * 1000 + 400); // safety net if transitionend never fires
  },

  updatePlay(dt) {
    // Production ne tourne QUE pendant la vague : la phase de prépa est un temps
    // mort où l'on s'organise (achats, ouvriers, fusions) sans rien fabriquer.
    if (this.waveActive) tickProduction(this, dt);
    // The inventory DOM is only written when the section is on screen (see the
    // IntersectionObserver in setupInventoryObserver). Off-screen production just
    // accumulates in the model + flips _invDirty, so it never shifts the layout
    // while the player watches the machines.
    this.maybeRefreshInventory();
    // Les rabatteurs se déplacent à CHAQUE frame (ce sont des agents physiques,
    // leur trajet gate la reprise de production — voir game-render.tickHawkers).
    this.tickHawkers(dt);
    this._supTimer = (this._supTimer || 0) - dt;
    if (this._supTimer <= 0) { this.refreshSuppliers(); this.refreshAffordability(); this.refreshWaveCoverage(); this.refreshMachineDots(); this.refreshMachineShares(); this.refreshCustomerDim(); this.refreshStockBtn(); this._supTimer = 0.2; }
    // Les bots redéploient leurs ouvriers en cours de round, comme tu le fais à la main :
    // une chaîne de conversion ne coule que si on passe l'ouvrier au convertisseur dès que
    // son stock d'intrants est prêt, puis qu'on le rend au fournisseur quand il est à sec.
    this._botStaffTimer = (this._botStaffTimer || 0) - dt;
    if (this._botStaffTimer <= 0) {
      this.competitors.forEach((c) => { if (!c.isPlayer) staffBot(this, c); });
      this._botStaffTimer = 1;
    }
    this._amTimer = (this._amTimer || 0) - dt;
    if (this._amTimer <= 0) { this.autoMergeTick(); this._amTimer = 0.5; }
    // Live-refresh the standings screen while it is open (revenues move in real time).
    if (this._rankOpen) { this._rankTimer -= dt; if (this._rankTimer <= 0) { this.renderRankInfo(); this._rankTimer = 0.3; } }

    if (this.waveActive) {
      const m = this.market;
      m.spawnTimer -= dt;
      // Les clients arrivent par PAQUETS (1..N d'un coup), plus un par un. Le tout
      // premier paquet n'apparaît qu'après le délai posé dans startWave (= temps de
      // prépa de la ressource la plus demandée), le temps de produire un peu.
      if (m.remaining > 0 && m.pending <= 0 && m.spawnTimer <= 0) {
        const batchMax = (m.def && m.def.customerBatch) || this.cfg.g.customerBatch || SPAWN_BATCH_MAX; // par niveau (level designer), défaut 2
        const batch = Math.min(m.remaining, randInt(1, batchMax));
        m.remaining -= batch; m.pending = batch; m.batchTimer = 0;
        m.spawnTimer = SPAWN_INTERVAL / (this.cfg.g.customerRate || 1);
      }
      // Le paquet s'ÉGRÈNE (SPAWN_BATCH_GAP entre deux clients) au lieu de tomber
      // d'un bloc : deux clients nés à la même frame partaient de la même hauteur et,
      // s'ils visaient le même comptoir, descendaient superposés. Le décalage passe
      // par le timer du jeu (donc suit x1/x2/x4), pas par un setTimeout.
      if (m.pending > 0) {
        m.batchTimer -= dt;
        if (m.batchTimer <= 0) { spawnCustomer(this); m.pending--; m.batchTimer = SPAWN_BATCH_GAP; }
      }
      this._stackTimer = (this._stackTimer || 0) - dt;
      // Même tick que le tri en profondeur : on retente de servir les clients partis
      // à vide (leur commande a pu sortir d'une machine entre-temps).
      if (this._stackTimer <= 0) { restackCustomers(); retryWaiting(this); this._stackTimer = 0.1; }
      if (m.remaining <= 0 && m.served >= m.total) this.endWave();
    } else {
      this.prepTimer -= dt;
      // safeAssign : quand le chrono tombe à 0, la vague ne part QUE si le banc est
      // vide. Sinon on gèle le chrono à 0, on fait clignoter le banc en rouge et on
      // attend que le joueur assigne ses ouvriers (re-testé à chaque frame).
      if (this.prepTimer <= 0) {
        this.prepTimer = 0;
        if (this.assignGateBlocking()) this.setAssignWarning(true);
        else { this.setAssignWarning(false); this.startWave(); }
      } else if (this._assignWarn && !this.assignGateBlocking()) {
        // Alerte levée par un « ⏭ Lancer » refusé, chrono encore en cours : elle
        // s'éteint dès que le banc est vidé. Sans ça, rien ne la re-testait avant 0 et
        // le banc restait rouge alors que le joueur avait déjà corrigé. On ne lance
        // PAS la vague pour autant : c'est au joueur de re-cliquer.
        this.setAssignWarning(false);
      }
      this.updateWavePreviewTimer();
    }
    this.refreshHud();
  },

  // safeAssign gate: block the wave while an idle worker sits on the bench — but
  // only while there is actually an open machine slot to move it to, so a level
  // with more workers than seats can never soft-lock the player in prep.
  assignGateBlocking() {
    if (!this.levelCfg || !this.levelCfg.safeAssign) return false;
    if (freeWorkers(this.player).length === 0) return false;
    const openSlots = this.player.machines.reduce((s, m) => s + Math.max(0, this.lvl(m).maxWorkers - m.crew.length), 0);
    return openSlots > 0;
  },
  setAssignWarning(on) {
    if (this._assignWarn === on) return;
    this._assignWarn = on;
    const bar = $("#worker-bar"); if (bar) bar.classList.toggle("assign-warn", on);
  },

  // A wave arrives: bots stock up, customers start falling. Production keeps running.
  startWave() {
    this.waveActive = true;
    this.setAssignWarning(false); // le banc a été vidé : on éteint l'alerte rouge
    this.competitors.forEach((c) => { c.salesThisRound = 0; c.unitsThisRound = 0; });
    const m = this.marketFor(this.round);
    // Le premier client attend le temps de PRODUIRE la ressource la plus demandée :
    // spawnTimer démarre à ce délai (au lieu de 0), le reste des paquets suit à l'interval.
    // stolenUnits / ruptureUnits : les pertes du JOUEUR ventilées par cause (volé au
    // tirage vs rupture de stock) — comptées dans game-customers, lues par le bilan.
    this.market = { def: m, remaining: m.customers, total: m.customers, served: 0, spawnTimer: this.firstDemandDelay(m), pending: 0, batchTimer: 0, waiting: [], active: 0, lostUnits: 0, lostValue: 0, stolenUnits: 0, ruptureUnits: 0 };
    $("#customer-lane").innerHTML = "";
    this.renderSuppliers(); this.renderWavePreview(); this.refreshHud();
  },

  // Délai avant le tout premier client de la vague. On prend le temps de complétion
  // du PIRE bot pour la ressource la plus demandée : pour chaque bot qui possède la
  // machine qui la produit, son temps effectif (niveau + équipe + buffs), et on garde
  // le plus lent. Ainsi même le concurrent le plus lent a le temps d'en sortir une
  // avant que la file ne démarre. Repli sur le temps de base si aucun bot ne la produit.
  firstDemandDelay(mk) {
    const w = mk.weights || {};
    const resId = this.cfg.resourceOrder
      .filter((r) => (w[r] || 0) > 0)
      .sort((a, b) => (w[b] || 0) - (w[a] || 0))[0];
    if (!resId) return 0;
    let worst = 0;
    this.competitors.forEach((c) => {
      if (c.isPlayer) return; // le PIRE bot, pas le joueur
      const machine = c.machines.find((m) => { const d = this.machineDef(m.id); return d && d.outputs === resId; });
      if (machine) worst = Math.max(worst, effTime(this, c, machine));
    });
    if (worst === 0) { // aucun bot ne produit cette ressource : temps de base de la machine
      const producer = this.cfg.machines.find((mm) => mm.outputs === resId);
      const lvl0 = producer && producer.levels && producer.levels[0];
      worst = (lvl0 && lvl0.productionTime) || 0;
    }
    return worst;
  },

  // Wave fully served -> standings, then back to prep for the next one.
  endWave() {
    this.waveActive = false;
    this.transitionTo(S.Results);
  },

  lvl(machine) { return this.machineDef(machine.id).levels[machine.level - 1]; },

  // ---------- Wave banner (top menu) ----------
  // Toujours la vague du round COURANT : pendant la prep c'est celle qui arrive,
  // pendant la vague c'est celle qu'on sert. Afficher la suivante en pleine vague
  // embrouillait (le bandeau disait "Vague 4" pendant la vague 3). Les deux états
  // se distinguent par la couleur — voir .wp-incoming / .wp-current dans style.css.
  previewWave() {
    return this.round > this.levelCfg.totalRounds ? null : this.round;
  },
  renderWavePreview() {
    const wrap = $("#wave-preview"); if (!wrap) return;
    const pr = this.previewWave();
    wrap.classList.toggle("wp-current", !!this.waveActive);
    wrap.classList.toggle("wp-incoming", !this.waveActive);
    if (pr == null) { wrap.innerHTML = `<div class="wp-head"><span class="wp-title">Dernière vague</span></div>`; return; }
    const mk = this.marketFor(pr);
    const order = this.cfg.resourceOrder;
    const totalW = order.reduce((s, r) => s + (mk.weights[r] || 0), 0) || 1;
    const chips = order.filter((r) => (mk.weights[r] || 0) > 0)
      .sort((a, b) => (mk.weights[b] || 0) - (mk.weights[a] || 0))
      .map((r) => `<div class="wp-chip" data-res="${r}"><img src="${this.tierSrc(r, 1)}" title="${this.res(r).displayName}"><span>${Math.round((mk.weights[r] || 0) / totalW * 100)}%</span><span class="wp-cov" data-covres="${r}"></span></div>`)
      .join("");
    wrap.innerHTML =
      `<div class="wp-head"><span class="wp-title">Vague ${pr}</span>` +
      `<span class="wp-state">${this.waveActive ? "en cours" : "à venir"}</span>` +
      `<span id="wp-countdown" class="wp-countdown"></span>` +
      // Le bouton n'existe QUE pendant la prépa : pas de « lancer » à cliquer sur une
      // vague déjà partie. Le bandeau est reconstruit à chaque bascule de phase.
      (this.waveActive ? "" : `<button id="wp-skip" class="wp-skip" title="Lancer la vague sans attendre la fin de la préparation">⏭ Lancer</button>`) +
      `</div><div class="wp-chips">${chips}</div>`;
    this.refreshWaveCoverage();
    this.updateWavePreviewTimer();
  },

  // ✓ / ⚠ / — sur chaque ressource demandée : « est-ce que MA production est prête ? »
  // Le calcul mental que la prépa exigeait (demande → machine → ouvriers), fait par
  // le jeu : ✓ machine staffée (ça produira), ⚠ machine présente mais à l'arrêt,
  // — pas positionné dessus (pas ton marché, pas une erreur). Rafraîchi sur le tick
  // 0.2 s : réagit à chaque (dé)staff pendant la prépa. Le sélecteur couvre aussi la
  // copie des chips dans l'annonce centrale (.demand-float).
  refreshWaveCoverage() {
    if (!this.player) return;
    document.querySelectorAll("#wave-preview .wp-cov, .demand-float .wp-cov").forEach((n) => {
      const rid = n.dataset.covres;
      const producers = this.player.machines.filter((x) => { const d = this.machineDef(x.id); return d && d.outputs === rid; });
      // Rework rabatteur : l'équipe est toujours au complet — ce qui arrête une
      // machine, c'est son MODE. ⚠ = tout ce qui produit cette ressource est en
      // mode Rabatteur, rien n'en sortira.
      const producing = producers.some((x) => x.mode !== "sell");
      const hasStock = this.stockOf(this.player, rid) > 0;
      let cls, txt, tip;
      if (producing) { cls = "ok"; txt = "✓"; tip = "Ta machine produit cette ressource"; }
      else if (producers.length) { cls = "warn"; txt = "⚠"; tip = "Ta machine est en mode Rabatteur : rien ne produira"; }
      else if (hasStock) { cls = "ok"; txt = "✓"; tip = "Tu as du stock (mais aucune machine pour en refaire)"; }
      else { cls = "off"; txt = "–"; tip = "Tu n'es pas positionné sur cette ressource"; }
      n.className = "wp-cov " + cls; n.textContent = txt; n.title = tip;
    });
  },
  updateWavePreviewTimer() {
    const c = $("#wp-countdown"); if (!c) return;
    // Le bouton se grise quand safeAssign bloque : il reste cliquable (le clic rappelle
    // pourquoi ça ne part pas), mais il annonce d'avance qu'il ne partira pas.
    const skip = $("#wp-skip"); if (skip) skip.classList.toggle("blocked", !!this._assignWarn || this.assignGateBlocking());
    // safeAssign bloque le départ : on remplace le décompte par une consigne rouge.
    if (this._assignWarn) { c.textContent = "⚠ Assigne tes ouvriers"; c.classList.add("imminent"); return; }
    c.textContent = this.waveActive ? "" : "↓ " + Math.max(0, Math.ceil(this.prepTimer)) + "s"; // l'état est dans .wp-state
    c.classList.toggle("imminent", !this.waveActive && this.prepTimer <= 5);
  },

  // « Skip preparation time » : le joueur déclare qu'il a fini de se préparer. Passe
  // par EXACTEMENT le même chemin que le chrono qui tombe à 0 (verrou safeAssign
  // compris) — un raccourci de confort, pas une porte dérobée pour partir le banc plein.
  skipPrep() {
    if (this.state !== S.Play || this.waveActive || this.previewWave() == null) return;
    if (this.assignGateBlocking()) { this.setAssignWarning(true); this.updateWavePreviewTimer(); return; }
    this.prepTimer = 0;
    this.setAssignWarning(false);
    this.startWave();
  },

  // ---------- Results (standings) ----------
  enterResults() {
    this.renderResults(this.rankedByRevenue());
    const end = this.round >= this.levelCfg.totalRounds;
    $("#results-continue").textContent = end ? "Voir le résultat" : "Round suivant";
    $("#results-continue").onclick = () => { $("#results-overlay").classList.add("hidden"); this.transitionTo(end ? S.GameOver : S.Play); };
  },

  enterGameOver() {
    // Victoire au topX (world_level) : finir dans les X premiers en revenus cumulés.
    const rank = this.playerRank(), topX = this.levelCfg.topX || 1;
    const won = rank <= topX;
    $("#gameover-title").textContent = won ? "Victoire !" : "Défaite";
    $("#gameover-title").style.color = won ? "var(--ok)" : "var(--danger)";
    $("#final-score").textContent = this.player.revenue;
    $("#gameover-rank").textContent = won
      ? (rank === 1 ? "Tu domines le marché 👑" : `${rank}ᵉ sur ${this.competitors.length} — objectif top ${topX} atteint 👑`)
      : `${rank}ᵉ sur ${this.competitors.length} — il fallait finir top ${topX}`;

    // Victory rewards (once per one-shot level, every time in endless).
    const rewards = $("#gameover-rewards"); rewards.innerHTML = "";
    if (won && this.levelCfg) {
      const firstClear = !Meta.isEndless(this.levelCfg.id) && !Meta.isCompleted(this.levelCfg.id);
      const drops = Meta.completeLevel(this.levelCfg.id);
      if (drops.length) {
        rewards.appendChild(el("div", "cp-section", "Récompenses"));
        const list = el("div", "go-drops");
        renderDropList(list, drops);
        rewards.appendChild(list);
      }
      // Feature unlocks presented like rewards ("finish level N -> feature").
      if (firstClear) {
        const feats = Meta.featuresUnlockedBy(this.levelCfg.id);
        if (feats.length) {
          rewards.appendChild(el("div", "cp-section", "Débloqué"));
          const list = el("div", "go-drops");
          feats.forEach((f) => {
            const node = el("div", "drop-item legendary");
            node.innerHTML = `<span class="drop-ico">🚀</span><span>${FEATURE_LABEL[f] || f}</span>`;
            list.appendChild(node);
          });
          rewards.appendChild(list);
        }
      }
    }
    // Replay only when the level is still playable (lost one-shot, or endless).
    const replayable = this.levelCfg && (Meta.isEndless(this.levelCfg.id) || !Meta.isCompleted(this.levelCfg.id));
    $("#replay-btn").style.display = replayable ? "" : "none";
    $("#gameover-overlay").classList.remove("hidden");
  },
};

// DOM rendering + cheat console live in their own modules; mix them back onto Game.
Object.assign(Game, renderMethods, cheatMethods);

$("#replay-btn").addEventListener("click", () => { $("#gameover-overlay").classList.add("hidden"); Game.transitionTo(S.Setup); });
$("#speed-sel").addEventListener("click", (e) => { const b = e.target.closest("button[data-speed]"); if (b) Game.setGameSpeed(+b.dataset.speed); });
$("#gameover-menu-btn")?.addEventListener("click", () => Game.toMenu());
// Home button: confirm before abandoning a running level.
$("#hud-home")?.addEventListener("click", () => {
  if (Game.state === S.Play || Game.state === S.Results) $("#quit-overlay").classList.remove("hidden");
  else Game.toMenu();
});
$("#quit-confirm")?.addEventListener("click", () => Game.toMenu());
$("#quit-cancel")?.addEventListener("click", () => $("#quit-overlay").classList.add("hidden"));
$("#merge-overlay")?.addEventListener("click", (e) => { if (e.target.id === "merge-overlay") Game.closeMerge(); });
// Sheets Boutique & Stock : ouvertes par la barre du bas, fermées au tap sur le fond.
$("#boutique-btn")?.addEventListener("click", () => Game.openBoutique());
$("#stock-btn")?.addEventListener("click", () => Game.openStock());
$("#boutique-overlay")?.addEventListener("click", (e) => { if (e.target.id === "boutique-overlay") Game.closeBoutique(); });
$("#stock-overlay")?.addEventListener("click", (e) => { if (e.target.id === "stock-overlay") Game.closeStock(); });
// L'auto-merge est un RÉGLAGE, pas un état de partie : il survit à la fermeture
// de l'app (même modèle que la meta, clé localStorage à part).
try { Game.autoMerge = localStorage.getItem("mu_automerge") === "1"; } catch (e) { /* storage bloqué → off */ }
$("#automerge-box")?.addEventListener("change", (e) => {
  Game.autoMerge = e.target.checked;
  try { localStorage.setItem("mu_automerge", e.target.checked ? "1" : "0"); } catch (e2) { /* ignore */ }
  Game.autoMergeTick();
});
$("#competitor-close").addEventListener("click", () => Game.closeCompetitor());
$("#competitor-overlay").addEventListener("click", (e) => { if (e.target.id === "competitor-overlay") Game.closeCompetitor(); });
// Délégation : le bandeau est reconstruit à chaque phase, un listener posé sur le
// bouton lui-même mourrait avec lui.
$("#wave-preview")?.addEventListener("click", (e) => {
  if (e.target.closest("#wp-skip")) { Game.skipPrep(); return; }
  const chip = e.target.closest(".wp-chip[data-res]"); if (chip) openResource(chip.dataset.res);
});
// Guarded with ?.: if a stale/cached index.html lacks these nodes, the bootstrap must
// not throw here — otherwise Game.start() below never runs and the game hangs.
$("#hud-rank")?.addEventListener("click", () => Game.openRankInfo());
$("#rankinfo-close")?.addEventListener("click", () => Game.closeRankInfo());
$("#rankinfo-overlay")?.addEventListener("click", (e) => { if (e.target.id === "rankinfo-overlay") Game.closeRankInfo(); });

// ---------- Cheat console ----------
$("#cheat-toggle")?.addEventListener("click", () => { if (Game.cheatsEnabled()) $("#cheat-overlay").classList.toggle("hidden"); });
$("#cheat-close")?.addEventListener("click", () => $("#cheat-overlay").classList.add("hidden"));
$("#cheat-overlay")?.addEventListener("click", (e) => { if (e.target.id === "cheat-overlay") $("#cheat-overlay").classList.add("hidden"); });
$("#cheat-speeds")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-speed]"); if (b) Game.setTimeScale(+b.dataset.speed); });
$("#cheat-money-add")?.addEventListener("click", () => Game.cheatAddMoney(parseInt($("#cheat-money").value, 10)));
$("#cheat-wave-go")?.addEventListener("click", () => Game.cheatGoToWave(parseInt($("#cheat-wave").value, 10)));
// Debug: current run
$("#cheat-win")?.addEventListener("click", () => Game.cheatWinLevel());
$("#cheat-lose")?.addEventListener("click", () => Game.cheatLoseLevel());
// Debug: meta currencies / shards / chests
const cheatAmount = () => parseInt($("#cheat-meta-amount")?.value, 10) || 0;
document.querySelectorAll("#cheat-overlay button[data-cur]").forEach((b) => b.addEventListener("click", () => Game.cheatAddCurrency(b.dataset.cur, cheatAmount())));
$("#cheat-shards")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-shard]"); if (b) Game.cheatAddShards(b.dataset.shard, cheatAmount()); });
$("#cheat-chests")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-chest]"); if (b) Game.cheatAddChest(b.dataset.chest, 1); });
// Debug: meta progression
$("#cheat-unlock-chars")?.addEventListener("click", () => Game.cheatUnlockChars());
$("#cheat-levelup-chars")?.addEventListener("click", () => Game.cheatLevelUpChars());
$("#cheat-complete-level")?.addEventListener("click", () => Game.cheatCompleteNextLevel());
$("#cheat-unlock-levels")?.addEventListener("click", () => Game.cheatUnlockAllLevels());
$("#cheat-reset")?.addEventListener("click", () => { if (confirm("Effacer toute la progression méta ?")) Game.cheatResetSave(); });

// Inventory updates are driven by visibility (setupInventoryObserver) + the play
// loop's maybeRefreshInventory, so it never shifts the layout while off screen.

window.Game = Game; // expose for console debugging
window.Meta = Meta; // idem: Meta.state, Meta.openChest("common_chest"), Meta.reset()…
window.Tutorial = Tutorial; // idem: Tutorial.pending(), Tutorial.evaluate()
Game.start();
