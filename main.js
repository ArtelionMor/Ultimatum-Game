/* Market Ultimatum — main.js
 * Game object + event listeners + bootstrap.
 */
"use strict";

import { BASE_MARKETING, SPAWN_INTERVAL, FALL_TIME, S } from "./constants.js";
import { sprite, $, el, randInt } from "./helpers.js";
import { normalize } from "./config.js";

// ============================================================
// Game
// ============================================================
const Game = {
  cfg: null, state: S.Setup, round: 0, prepTimer: 0, waveActive: false,
  competitors: [], player: null, lastTime: 0, market: null,

  async start() {
    const raw = await fetch("config_export.json").then((r) => r.json());
    this.cfg = normalize(raw);
    // Production lookup keyed `resourceId_level`. New config schema: `outputs`
    // maps each resource id to a profile name (`profil`), and `outputsProfiles`
    // holds the per-level group weights + tier distribution shared by that profile.
    // Falls back to the old flat `outputs` shape if `outputsProfiles` is absent.
    this.cfg._outputs = {};
    if (raw.outputsProfiles) {
      const profileRows = {}; // `profil_level` -> [{ group, quantity, weight, tiers }]
      raw.outputsProfiles.forEach((o) => {
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
    $("#total-rounds").textContent = this.cfg.g.totalRounds;
    this.transitionTo(S.Setup);
    this.setupInventoryObserver();
    requestAnimationFrame((t) => this.loop(t));
  },

  // The inventory DOM is deliberately kept stale: stock mutations only flip
  // _invDirty. We flush to the DOM (chiffres + collapse des lignes vides) solely
  // when the section is on screen, so off-screen production never touches the DOM
  // and the reflow lands while the player is actually looking at the inventory.
  setupInventoryObserver() {
    this._invVisible = true; this._invDirty = false;
    const bar = $("#inventory-bar");
    if (!bar || !("IntersectionObserver" in window)) return; // no support → always flush
    this._invVisible = false;
    new IntersectionObserver((entries) => {
      this._invVisible = entries[0].isIntersecting;
      if (this._invVisible) this.maybeRefreshInventory();
    }, { root: $("#content"), threshold: 0 }).observe(bar);
  },
  maybeRefreshInventory() { if (this._invDirty && this._invVisible) this.refreshInventory(); },

  loop(t) {
    if (!this.lastTime) this.lastTime = t;
    let dt = (t - this.lastTime) / 1000; this.lastTime = t;
    if (dt > 0.2) dt = 0.2;
    if (this.state === S.Play) this.updatePlay(dt);
    requestAnimationFrame((t2) => this.loop(t2));
  },

  transitionTo(n) { this.exitState(this.state); this.state = n; this.enterState(n); },
  enterState(s) { ({ [S.Setup]: () => this.enterSetup(), [S.Play]: () => this.enterPlay(), [S.Tax]: () => this.enterTax(), [S.Results]: () => this.enterResults(), [S.GameOver]: () => this.enterGameOver() }[s] || (() => {}))(); },
  exitState(s) { void s; },

  // ---------- helpers ----------
  res(id) { return this.cfg.resources[id]; },
  tierInfo(id, tier) { return this.cfg.resources[id].tiers[tier]; },
  machineDef(id) { return this.cfg.machines.find((m) => m.id === id); },
  emptyStock() { const s = {}; this.cfg.resourceOrder.forEach((r) => { s[r] = {}; }); return s; },
  stockTotal(c) { let n = 0; for (const r in c.stock) for (const t in c.stock[r]) n += c.stock[r][t]; return n; },
  stockOf(c, resId) { let n = 0; const m = c.stock[resId] || {}; for (const t in m) n += m[t]; return n; },
  bestTier(c, resId) { const m = c.stock[resId] || {}; let best = 0; for (const t in m) if (m[t] > 0 && +t > best) best = +t; return best; },
  addStock(c, resId, tier, qty) { c.stock[resId][tier] = (c.stock[resId][tier] || 0) + qty; if (c === this.player) this._invDirty = true; },
  tierCount(c, resId, tier) { return (c.stock[resId] && c.stock[resId][tier]) || 0; },

  // ---------- Refining (convert table: N of tier n -> result of tier n+1) ----------
  convertRule(resId, tier) { const r = this.cfg.convert[resId]; return (r && r[tier]) || null; },
  canConvert(c, resId, tier) { const rule = this.convertRule(resId, tier); return !!rule && this.tierCount(c, resId, tier) >= rule.quantity; },
  doConvert(resId, tier) {
    const p = this.player, rule = this.convertRule(resId, tier);
    if (!rule || this.tierCount(p, resId, tier) < rule.quantity) return false;
    p.stock[resId][tier] -= rule.quantity;
    this.addStock(p, rule.resultRes, rule.resultTier, rule.resultQty);
    this.refreshInventory();
    return true;
  },

  // Build an <img> for a given resource tier, with a fallback chain so it works
  // whatever naming the tier art ends up using (and falls back to the base sprite
  // until per-tier art exists). Drop tier files in web/sprites/tiers/.
  // Per-tier sprite id from config (falls back to the resource's default sprite).
  tierSpriteId(resId, tier) { const t = this.cfg.resources[resId].tiers[tier]; return (t && t.spriteId) || this.res(resId).spriteId; },
  tierSrc(resId, tier) { return `sprites/${this.tierSpriteId(resId, tier)}.png`; },
  tierImg(resId, tier) {
    const candidates = [ this.tierSrc(resId, tier), `sprites/${this.res(resId).spriteId}.png` ]; // tier art, else default
    const img = new Image();
    let i = 0;
    img.onerror = () => { i++; if (i < candidates.length) img.src = candidates[i]; else img.onerror = null; };
    img.src = candidates[0];
    return img;
  },

  // Fly a freshly produced unit from its machine card into its inventory chip.
  flyToInventory(m, resId, tier) {
    const node = m._node, ref = this._invRefs && this._invRefs[resId];
    if (!node || !ref) return;
    const from = node.getBoundingClientRect(), to = ref.chip.getBoundingClientRect();
    const fly = this.tierImg(resId, tier); fly.className = "fly-res";
    document.body.appendChild(fly);
    const x0 = from.left + from.width / 2 - 14, y0 = from.top + 18;
    fly.style.left = x0 + "px"; fly.style.top = y0 + "px";
    const dx = (to.left + to.width / 2) - (x0 + 14), dy = (to.top + to.height / 2) - (y0 + 14);
    requestAnimationFrame(() => { fly.style.transform = `translate(${dx}px,${dy}px) scale(.55)`; fly.style.opacity = "0.15"; });
    setTimeout(() => fly.remove(), 520);
  },

  // Floating "luck" popup over a machine, styled per its output slot group (A..F).
  showSpawnPopup(m, resId, qty, tier, group) {
    const node = m._node; if (!node) return;
    const slot = (this.cfg.slots && this.cfg.slots[group]) || {};
    const r = node.getBoundingClientRect();
    const desc = slot.description ? slot.description + " " : "";
    const pop = el("div", "spawn-pop", `${desc}+${qty} Tier ${tier} ${this.res(resId).displayName}`);
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
    this.round = 0;
    this.player = {
      id: "player", name: "Toi", spriteId: "Worker", isPlayer: true, eliminated: false,
      money: g.startingMoney, stock: this.emptyStock(), storageCap: g.startingStorage,
      marketing: BASE_MARKETING, totalWorkers: g.startingWorkers, availableWorkers: g.startingWorkers,
      machines: [], buys: { increaseWorker: 0, increaseMarketting: 0, increaseStorage: 0 },
      salesThisRound: 0, selectedWorker: false,
    };
    this.cfg.machines.forEach((m) => { if (m.unlockAtRound <= 1) this.giveMachine(this.player, m.id); });

    // Pick numberOfCompetitors opponents at random from the pool (clamped to what's available).
    const pool = this.cfg.competitors.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const want = g.numberOfCompetitors;
    const count = (want == null) ? pool.length : Math.max(0, Math.min(want, pool.length));
    const bots = pool.slice(0, count).map((b) => ({
      id: b.id, name: b.displayName, spriteId: b.spriteId, isPlayer: false, eliminated: false,
      money: b.startingMoney, stock: this.emptyStock(), storageCap: g.startingStorage,
      marketing: BASE_MARKETING, def: b, behavior: b.behavior, upgradesBought: 0,
      buys: { increaseWorker: 0, increaseMarketting: 0, increaseStorage: 0 }, salesThisRound: 0,
    }));
    this.competitors = [this.player, ...bots];
    this._screenReady = false;
    this.transitionTo(S.Play);
  },

  giveMachine(p, id) { if (!p.machines.some((m) => m.id === id)) p.machines.push({ id, level: 1, workers: 0, elapsed: 0, producing: false }); },

  // ---------- Play (single screen: continuous production + customer waves) ----------
  enterPlay() {
    if (!this._screenReady) this.setupScreen();
    this.startPrep();
  },

  // One-time screen setup: both zones visible, worker bar shown.
  setupScreen() {
    this._screenReady = true;
    $("#factory-zone").classList.remove("hidden");
    $("#market-zone").classList.remove("hidden");
    $("#worker-bar").style.display = "flex";
    $("#customer-lane").innerHTML = "";
  },

  // Prep window before a wave: production runs, player prepares, top menu shows demand.
  startPrep() {
    this.round++;
    const g = this.cfg.g;
    this.waveActive = false;
    this.prepTimer = g.tycoonPhaseDuration;
    this._prepDuration = g.tycoonPhaseDuration;
    this.market = null;
    this.player.selectedWorker = false;

    // round income (scheduled) to every alive competitor
    const inc = this.cfg.roundIncome[this.round];
    if (inc) this.competitors.forEach((c) => { if (!c.eliminated) c.money += inc.coins; });

    // bots plan their whole round now; their stock is revealed gradually during prep
    this.competitors.forEach((c) => { if (!c.isPlayer && !c.eliminated) this.planBot(c); });

    // unlock machines, keep worker assignments, recompute the available pool
    this.cfg.machines.forEach((m) => { if (m.unlockAtRound === this.round) this.giveMachine(this.player, m.id); });
    let assigned = 0;
    this.player.machines.forEach((m) => { m.elapsed = 0; assigned += m.workers; });
    this.player.availableWorkers = Math.max(0, this.player.totalWorkers - assigned);

    $("#phase-banner").textContent = `Round ${this.round} — Revenu +${inc ? inc.coins : 0}$ · prépare-toi`;
    this.renderInventory(); this.renderShop(); this.renderMachines(); this.renderWorkers();
    this.renderSuppliers(); this.renderWavePreview(); this.refreshHud();
  },

  updatePlay(dt) {
    this.tickProduction(dt);
    // The inventory DOM is only written when the section is on screen (see the
    // IntersectionObserver in setupInventoryObserver). Off-screen production just
    // accumulates in the model + flips _invDirty, so it never shifts the layout
    // while the player watches the machines.
    this.maybeRefreshInventory();
    this._supTimer = (this._supTimer || 0) - dt;
    if (this._supTimer <= 0) { this.refreshSuppliers(); this.refreshAffordability(); this._supTimer = 0.2; }

    if (this.waveActive) {
      const m = this.market;
      m.spawnTimer -= dt;
      if (m.remaining > 0 && m.spawnTimer <= 0) { m.spawnTimer = SPAWN_INTERVAL / (this.cfg.g.customerRate || 1); m.remaining--; this.spawnCustomer(); }
      this._stackTimer = (this._stackTimer || 0) - dt;
      if (this._stackTimer <= 0) { this.restackCustomers(); this._stackTimer = 0.1; }
      if (m.remaining <= 0 && m.served >= m.total) this.endWave();
    } else {
      this.prepTimer -= dt;
      const progress = this._prepDuration ? Math.max(0, Math.min(1, 1 - this.prepTimer / this._prepDuration)) : 1;
      this.competitors.forEach((c) => { if (!c.isPlayer && !c.eliminated) this.releaseBotStock(c, progress); });
      this.updateWavePreviewTimer();
      if (this.prepTimer <= 0) this.startWave();
    }
    this.refreshHud();
  },

  // A wave arrives: bots stock up, customers start falling. Production keeps running.
  startWave() {
    this.waveActive = true;
    // flush any not-yet-revealed bot stock so they reach exactly the planned target
    this.competitors.forEach((c) => { if (!c.isPlayer && !c.eliminated) this.releaseBotStock(c, 1); c.salesThisRound = 0; });
    const m = this.cfg.market[this.round] || this.cfg.market[Object.keys(this.cfg.market).length];
    this.market = { def: m, remaining: m.customers, total: m.customers, served: 0, spawnTimer: 0, active: 0 };
    $("#customer-lane").innerHTML = "";
    $("#phase-banner").textContent = `Vague ${this.round} — les clients arrivent !`;
    this.renderSuppliers(); this.renderWavePreview(); this.refreshHud();
    const content = $("#content"); if (content) content.scrollTo({ top: 0, behavior: "smooth" });
  },

  // Wave fully served -> tax / elimination (overlays), then back to prep for the next one.
  endWave() {
    this.waveActive = false;
    this.transitionTo(S.Tax);
  },

  lvl(machine) { return this.machineDef(machine.id).levels[machine.level - 1]; },
  effTime(machine) { const L = this.lvl(machine); return Math.max(0.3, L.productionTime * (1 - L.workerSpeedBonus * machine.workers)); },
  hasInputs(p, def) { return def.inputs.every((i) => this.stockOf(p, i.type) >= i.quantity); },
  consumeInputs(p, def) { def.inputs.forEach((i) => { let need = i.quantity; const m = p.stock[i.type]; for (const t of Object.keys(m).sort((a, b) => a - b)) { while (need > 0 && m[t] > 0) { m[t]--; need--; } } }); if (p === this.player) this._invDirty = true; },

  tickProduction(dt) {
    const p = this.player;
    p.machines.forEach((m) => {
      const def = this.machineDef(m.id), L = this.lvl(m);
      const staffed = m.workers >= L.workersRequired;
      if (!staffed) { m.producing = false; m.elapsed = 0; this.setProgress(m, 0); return; }
      const converts = def.inputs.length > 0;
      // A converter needs its inputs to even run.
      if (converts && !this.hasInputs(p, def)) { m.producing = false; m.elapsed = 0; this.setProgress(m, 0); return; }
      // Storage full: only pure generators pause. Converters keep running — they
      // consume inputs (freeing space) before storing output, so they never deadlock.
      if (!converts && this.stockTotal(p) >= p.storageCap) { m.producing = false; this.setProgress(m, 1); return; }
      m.producing = true;
      m.elapsed += dt;
      const time = this.effTime(m);
      this.setProgress(m, Math.min(1, m.elapsed / time));
      if (m.elapsed >= time) {
        m.elapsed = 0;
        if (converts) { if (!this.hasInputs(p, def)) return; this.consumeInputs(p, def); }
        const out = this.pickOutput(def.outputs, m.level);
        const tier = this.rollTier(out.tiers);   // one tier for the whole spawn (matches the "+N Tier T" popup)
        let added = 0;
        for (let i = 0; i < out.quantity; i++) {
          if (this.stockTotal(p) >= p.storageCap) break;
          this.addStock(p, def.outputs, tier, 1);
          this.flyToInventory(m, def.outputs, tier);
          added++;
        }
        if (added > 0) this.showSpawnPopup(m, def.outputs, added, tier, out.group);
      }
    });
  },

  pickOutput(resId, level) {
    const list = this.cfg._outputs[resId + "_" + Math.min(level, 15)] || this.cfg._outputs[resId + "_1"];
    const total = list.reduce((s, o) => s + o.weight, 0);
    let r = Math.random() * total;
    for (const o of list) { r -= o.weight; if (r <= 0) return o; }
    return list[list.length - 1];
  },
  rollTier(tierPcts) {
    let r = Math.random() * 100;
    for (let i = 0; i < tierPcts.length; i++) { r -= tierPcts[i]; if (r <= 0) return i + 1; }
    return 1;
  },

  // ---------- Tycoon purchases ----------
  nextWorker() { return this.cfg.purchases.increaseWorker[this.player.buys.increaseWorker]; },
  buyWorker() { const n = this.nextWorker(); if (!n || this.player.totalWorkers >= this.cfg.g.maxWorkersTotal || this.player.money < n.price) return; this.player.money -= n.price; this.player.buys.increaseWorker++; this.player.totalWorkers += n.effect; this.player.availableWorkers += n.effect; this.renderShop(); this.renderWorkers(); this.refreshHud(); },
  nextMkt() { return this.cfg.purchases.increaseMarketting[this.player.buys.increaseMarketting]; },
  buyMkt() { const n = this.nextMkt(); if (!n || this.player.money < n.price) return; this.player.money -= n.price; this.player.buys.increaseMarketting++; this.player.marketing = n.effect; this.renderShop(); this.refreshHud(); },
  nextStorage() { return this.cfg.purchases.increaseStorage[this.player.buys.increaseStorage]; },
  buyStorage() { const n = this.nextStorage(); if (!n || this.player.money < n.price) return; this.player.money -= n.price; this.player.buys.increaseStorage++; this.player.storageCap += n.effect; this.renderShop(); this.renderInventory(); this.refreshHud(); },

  nextMachineLevel(m) { const lv = this.machineDef(m.id).levels[m.level]; return lv || null; }, // levels[m.level] is the (m.level+1)th
  upgradeMachine(m) { const nx = this.nextMachineLevel(m); if (!nx || this.player.money < nx.cost) return; this.player.money -= nx.cost; m.level++; this.refreshMachineCard(m); this.renderShop(); this.refreshHud(); },

  // ---------- Workers ----------
  selectWorker() { if (this.player.availableWorkers <= 0) return; this.player.selectedWorker = !this.player.selectedWorker; this.renderWorkers(); },
  assignWorker(m) { const L = this.lvl(m); if (m.workers >= L.maxWorkers || this.player.availableWorkers <= 0) return; m.workers++; this.player.availableWorkers--; this.player.selectedWorker = false; this.renderWorkers(); this.refreshMachineCard(m); },
  removeWorker(m) { if (m.workers <= 0) return; m.workers--; this.player.availableWorkers++; if (m.workers < this.lvl(m).workersRequired) { m.producing = false; m.elapsed = 0; this.setProgress(m, 0); } this.renderWorkers(); this.refreshMachineCard(m); },

  // ---------- Bots ----------
  // Reserve for the next upcoming tax, minus the guaranteed income the bot will still
  // collect before that tax is charged (round income + passive per-round gain, for every
  // round from the next one up to and including the tax round — that round's income lands
  // before its tax). Lets bots invest early instead of hoarding the full tax from round 1.
  taxReserve(b, round) {
    let taxRound = Infinity, cost = 0;
    for (const r in this.cfg.tax) { const rn = +r; if (rn >= round && rn < taxRound) { taxRound = rn; cost = this.cfg.tax[r]; } }
    if (!cost) return 0;
    const passive = b.def.increaseByRound + b.def.upgradeEffect * b.upgradesBought;
    let future = 0;
    for (let k = round + 1; k <= taxRound; k++) { const ri = this.cfg.roundIncome[k]; future += (ri ? ri.coins : 0) + passive; }
    return Math.max(0, cost - future);
  },

  simulateBot(b) {
    const inc = this.cfg.roundIncome[this.round];
    b.money += b.def.increaseByRound + b.def.upgradeEffect * b.upgradesBought;
    b.salesThisRound = 0;
    b.stock = this.emptyStock();
    const tier = inc ? inc.tier : 1;

    // Keep enough to survive the upcoming tax, net of income still to come before it.
    const reserve = this.taxReserve(b, this.round);

    // "Will I sell it?" — estimate how many units of each resource are worth making
    // this round, so the bot doesn't overproduce stock it can't move.
    const mk = this.cfg.market[this.round] || this.cfg.market[Object.keys(this.cfg.market).length];
    const order = this.cfg.resourceOrder;
    const totalW = order.reduce((s, r) => s + (mk.weights[r] || 0), 0) || 1;
    const numAlive = this.competitors.filter((c) => !c.eliminated).length || 1;
    const target = {};
    order.forEach((r) => { const demand = mk.customers * ((mk.weights[r] || 0) / totalW) * mk.avg; target[r] = Math.ceil(demand / numAlive * 1.3); });

    const actions = Object.keys(b.behavior).filter((k) => b.behavior[k] > 0);
    let guard = 600;
    while (guard-- > 0) {
      const pool = actions.filter((a) => this.botUseful(b, a, tier, reserve, target));
      if (!pool.length) break;
      const tot = pool.reduce((s, a) => s + b.behavior[a], 0);
      let r = Math.random() * tot; let pick = pool[0];
      for (const a of pool) { r -= b.behavior[a]; if (r <= 0) { pick = a; break; } }
      this.botDo(b, pick, tier);
    }
  },
  botUseful(b, a, tier, reserve, target) {
    if (a === "increaseWorker") { const n = this.cfg.purchases.increaseWorker[b.buys.increaseWorker]; return n && b.money - n.price >= reserve; }
    if (a === "increaseMarketting") { const n = this.cfg.purchases.increaseMarketting[b.buys.increaseMarketting]; return n && b.money - n.price >= reserve; }
    if (a === "increaseStorage") { const n = this.cfg.purchases.increaseStorage[b.buys.increaseStorage]; return n && b.money - n.price >= reserve; }
    // produce only above the tax reserve, with storage room, and not past the sellable target
    const ti = this.tierInfo(a, tier);
    return ti && b.money - ti.price >= reserve && this.stockTotal(b) < b.storageCap && this.stockOf(b, a) < target[a];
  },
  botDo(b, a, tier) {
    if (a === "increaseWorker") { const n = this.cfg.purchases.increaseWorker[b.buys.increaseWorker]; b.money -= n.price; b.buys.increaseWorker++; b.upgradesBought++; return; }
    if (a === "increaseMarketting") { const n = this.cfg.purchases.increaseMarketting[b.buys.increaseMarketting]; b.money -= n.price; b.buys.increaseMarketting++; b.marketing = n.effect; b.upgradesBought++; return; }
    if (a === "increaseStorage") { const n = this.cfg.purchases.increaseStorage[b.buys.increaseStorage]; b.money -= n.price; b.buys.increaseStorage++; b.storageCap += n.effect; b.upgradesBought++; return; }
    const ti = this.tierInfo(a, tier); b.money -= ti.price; this.addStock(b, a, tier, 1);
  },

  // Plan a bot's whole round (money/upgrades resolved now), then queue its target
  // stock to be revealed unit-by-unit over the prep so the counter fills gradually.
  planBot(b) {
    this.simulateBot(b);                    // produces the round's target into b.stock, spends money
    const queue = [];
    for (const rid in b.stock) for (const t in b.stock[rid]) for (let i = 0; i < b.stock[rid][t]; i++) queue.push({ resId: rid, tier: +t });
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; } // shuffle for a mixed reveal
    b._queue = queue; b._queueTotal = queue.length; b._released = 0;
    b.stock = this.emptyStock();            // start the round empty; reveal over time
  },
  // Reveal queued units up to `progress` (0..1) of the prep.
  releaseBotStock(b, progress) {
    if (!b._queue) return;
    const target = Math.min(b._queueTotal, Math.floor(progress * b._queueTotal));
    while (b._released < target) { const u = b._queue[b._released++]; this.addStock(b, u.resId, u.tier, 1); }
  },

  // ---------- Next-wave preview (top menu) ----------
  // The wave whose demand to advertise: during a wave, the next one; during prep, the
  // one about to arrive. Returns null when there is no further wave.
  previewWave() {
    const keys = Object.keys(this.cfg.market).map(Number);
    const last = keys.length ? Math.max(...keys) : 0;
    const pr = this.waveActive ? this.round + 1 : this.round;
    return pr > last ? null : pr;
  },
  renderWavePreview() {
    const wrap = $("#wave-preview"); if (!wrap) return;
    const pr = this.previewWave();
    if (pr == null) { wrap.innerHTML = `<div class="wp-head"><span class="wp-title">Dernière vague</span></div>`; return; }
    const mk = this.cfg.market[pr];
    const order = this.cfg.resourceOrder;
    const totalW = order.reduce((s, r) => s + (mk.weights[r] || 0), 0) || 1;
    const chips = order.filter((r) => (mk.weights[r] || 0) > 0)
      .sort((a, b) => (mk.weights[b] || 0) - (mk.weights[a] || 0))
      .map((r) => `<div class="wp-chip"><img src="${this.tierSrc(r, 1)}" title="${this.res(r).displayName}"><span>${Math.round((mk.weights[r] || 0) / totalW * 100)}%</span></div>`)
      .join("");
    wrap.innerHTML =
      `<div class="wp-head"><span class="wp-title">Vague ${pr}</span>` +
      `<span class="wp-meta">👥 ${mk.customers} · ~${mk.avg}/client</span>` +
      `<span id="wp-countdown" class="wp-countdown"></span></div>` +
      `<div class="wp-chips">${chips}</div>`;
    this.updateWavePreviewTimer();
  },
  updateWavePreviewTimer() {
    const c = $("#wp-countdown"); if (!c) return;
    c.textContent = this.waveActive ? "en cours" : "↓ " + Math.max(0, Math.ceil(this.prepTimer)) + "s";
    c.classList.toggle("imminent", !this.waveActive && this.prepTimer <= 5);
  },

  pickNeed() {
    const w = this.market.def.weights; const order = this.cfg.resourceOrder;
    const tot = order.reduce((s, r) => s + (w[r] || 0), 0);
    let r = Math.random() * tot; let res = order.find((x) => w[x] > 0) || order[0];
    for (const x of order) { if (!w[x]) continue; r -= w[x]; if (r <= 0) { res = x; break; } }
    const avg = this.market.def.avg; const qty = Math.max(1, [avg - 1, avg, avg + 1][randInt(0, 2)]);
    return { resId: res, qty };
  },

  attractiveness(c, resId) { return c.marketing + this.tierInfo(resId, this.bestTier(c, resId)).influence; },

  chooseShop(eligible, resId) {
    const min = this.cfg.g.minimalPercentage;
    const A = eligible.map((c) => this.attractiveness(c, resId));
    const sum = A.reduce((s, x) => s + x, 0);
    let p = A.map((x) => x / sum);
    // enforce floor then renormalize the non-floored proportionally
    const fixed = p.map((x) => x < min);
    const fixedSum = p.reduce((s, x, i) => s + (fixed[i] ? min : 0), 0);
    const freeSum = p.reduce((s, x, i) => s + (fixed[i] ? 0 : x), 0);
    p = p.map((x, i) => fixed[i] ? min : (freeSum > 0 ? x / freeSum * (1 - fixedSum) : (1 - fixedSum) / p.length));
    let r = Math.random(); for (let i = 0; i < eligible.length; i++) { r -= p[i]; if (r <= 0) return eligible[i]; }
    return eligible[eligible.length - 1];
  },

  spawnCustomer() {
    const need = this.pickNeed();
    const m = this.market; m.active++;
    const lane = $("#customer-lane");
    const cust = el("div", "customer");
    cust.style.left = randInt(12, 88) + "%";
    cust.innerHTML = `<div class="bubble"><span>${need.qty}×</span><img src="${this.tierSrc(need.resId, 1)}"></div><img class="cust-sprite" src="${sprite("Customer")}">`;
    const fall = FALL_TIME / (this.cfg.g.customerSpeed || 1); // customerSpeed: higher = faster
    cust.style.setProperty("--fall", fall + "s");
    lane.appendChild(cust);
    requestAnimationFrame(() => cust.classList.add("falling"));

    setTimeout(() => {
      const eligible = this.competitors.filter((c) => !c.eliminated && this.stockOf(c, need.resId) >= need.qty);
      if (eligible.length) {
        const winner = this.chooseShop(eligible, need.resId);
        const gain = this.sellTo(winner, need.resId, need.qty);
        if (winner._counter) {
          const cr = winner._counter.getBoundingClientRect(), lr = lane.getBoundingClientRect();
          cust.style.left = (cr.left - lr.left + cr.width / 2) + "px";
          cust.classList.add("toShop");
          this.flashStall(winner, gain);
        }
      } else {
        cust.classList.add("nobody"); // turns red
        const x = parseFloat(cust.style.left) || 50;
        cust.style.left = (x < 50 ? -25 : 125) + "%"; // slide off to the nearest edge
      }
      setTimeout(() => cust.remove(), 750);
      m.served++; m.active--;
      this.refreshSuppliers();
    }, fall * 1000);
  },

  // Depth-sort customers so the closest ones (lowest on screen) paint on top.
  // Two z bands keep every bubble above every sprite; within each band, closer = higher.
  restackCustomers() {
    const lane = $("#customer-lane");
    if (!lane) return;
    const custs = [...lane.querySelectorAll(".customer")];
    if (custs.length < 2) return;
    custs
      .map((c) => ({ c, y: c.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y) // farthest (higher up) first, closest (lower) last
      .forEach(({ c }, i) => {
        const sprite = c.querySelector(".cust-sprite");
        const bubble = c.querySelector(".bubble");
        if (sprite) sprite.style.zIndex = 1 + i;
        if (bubble) bubble.style.zIndex = 1000 + i;
      });
  },

  sellTo(c, resId, qty) {
    let gain = 0;
    const m = c.stock[resId];
    const tiers = Object.keys(m).map(Number).sort((a, b) => b - a); // highest tier first
    for (const t of tiers) { while (qty > 0 && m[t] > 0) { m[t]--; qty--; gain += this.tierInfo(resId, t).price; } }
    c.money += gain; c.salesThisRound += gain;
    if (c === this.player) this._invDirty = true;
    return gain;
  },

  // ---------- Tax ----------
  enterTax() {
    const cost = this.cfg.tax[this.round] || 0;
    if (cost > 0) this.competitors.forEach((c) => { if (!c.eliminated) c.money = Math.max(0, c.money - cost); });
    const p = this.player;
    $("#tax-before").textContent = p.money + (cost > 0 && !p.eliminated ? cost : 0);
    $("#tax-amount").textContent = "-" + cost;
    $("#tax-after").textContent = p.money;
    $("#tax-title").textContent = cost > 0 ? `Impôt — Round ${this.round}` : "Pas d'impôt ce round";
    $("#tax-overlay").classList.remove("hidden");
    setTimeout(() => { $("#tax-overlay").classList.add("hidden"); this.transitionTo(S.Results); }, cost > 0 ? 1900 : 800);
  },

  // ---------- Results (standings) ----------
  enterResults() {
    const ranked = this.competitors.sort((a, b) => b.money - a.money);
    this.renderResults(ranked, []);

    const end = this.round >= this.cfg.g.totalRounds;
    $("#results-continue").textContent = end ? "Voir le résultat" : "Round suivant";
    $("#results-continue").onclick = () => { $("#results-overlay").classList.add("hidden"); this.transitionTo(end ? S.GameOver : S.Play); };
  },

  enterGameOver() {
    const ranked = [...this.competitors].sort((a, b) => (a.eliminated !== b.eliminated ? (a.eliminated ? 1 : -1) : b.money - a.money));
    const won = !this.player.eliminated && ranked[0] === this.player;
    $("#gameover-title").textContent = won ? "Victoire !" : "Éliminé";
    $("#gameover-title").style.color = won ? "var(--ok)" : "var(--danger)";
    $("#final-score").textContent = this.player.money;
    $("#gameover-rank").textContent = won ? "Tu domines le marché 👑" : `${ranked.indexOf(this.player) + 1}ᵉ sur ${this.competitors.length}`;
    $("#gameover-overlay").classList.remove("hidden");
  },

  // ============================================================
  // Rendering
  // ============================================================
  refreshHud() {
    this.player; $("#money").textContent = this.player.money;
    $("#round").textContent = this.round;
    $("#phase-label").textContent = this.state === S.Play ? (this.waveActive ? "Vague" : "Prépa") : "";
    if (this.state === S.Play && this.waveActive) {
      $("#timer").textContent = "👥 " + (this.market ? this.market.remaining + this.market.active : 0);
      $("#hud-timer").classList.remove("urgent");
    } else if (this.state === S.Play) {
      const s = Math.max(0, Math.ceil(this.prepTimer)); $("#timer").textContent = s + "s";
      $("#hud-timer").classList.toggle("urgent", s <= 5);
    }
  },

  // Resources the player's current machines can produce (output resource IDs).
  producibleResources() {
    const set = new Set();
    this.player.machines.forEach((m) => { const def = this.machineDef(m.id); if (def) set.add(def.outputs); });
    return set;
  },

  // True if a machine staffed with enough workers to run outputs this resource.
  isStaffedFor(rid) {
    return this.player.machines.some((m) => {
      const def = this.machineDef(m.id);
      return def && def.outputs === rid && m.workers >= this.lvl(m).workersRequired;
    });
  },

  // --- inventory grid: resources (rows) × tiers (columns) ---
  renderInventory() {
    const bar = $("#inventory-bar"); bar.innerHTML = "";
    this._invCells = {}; this._invRow = {};
    const maxT = this.cfg.maxTier;
    bar.style.setProperty("--tiers", maxT);

    const top = el("div", "inv-top");
    const cap = el("span", "inv-cap", ""); cap.id = "inv-cap";
    top.append(el("span", "inv-top-label", "Inventaire"), cap);
    bar.appendChild(top);

    const head = el("div", "inv-grid-head");
    head.appendChild(el("div", "inv-hcorner", ""));
    for (let t = 1; t <= maxT; t++) head.appendChild(el("div", "inv-hcell", "T" + t));
    bar.appendChild(head);

    const scroll = el("div", "inv-scroll");
    const producible = this.producibleResources();
    this.cfg.resourceOrder.forEach((rid) => {
      if (!producible.has(rid)) return;
      const row = el("div", "inv-row");
      const rowHead = el("div", "inv-row-head");
      const icon = this.tierImg(rid, this.bestTier(this.player, rid) || 1); icon.className = "inv-row-icon"; icon.title = this.res(rid).displayName;
      rowHead.append(icon, el("span", "inv-refine", "🔁"));
      rowHead.classList.add("clickable"); rowHead.title = this.res(rid).displayName;
      rowHead.onclick = () => this.openResourceInfo(rid); // resource widget (refine lives inside it)
      row.appendChild(rowHead);
      this._invCells[rid] = {};
      for (let t = 1; t <= maxT; t++) {
        const cell = el("div", "inv-cell", "");
        row.appendChild(cell);
        this._invCells[rid][t] = { el: cell, last: -1 };
      }
      this._invRow[rid] = row;
      scroll.appendChild(row);
    });
    bar.appendChild(scroll);
    this.refreshInventory();
  },
  refreshInventory() {
    if (!this._invCells) return;
    const maxT = this.cfg.maxTier;
    this.cfg.resourceOrder.forEach((rid) => {
      if (!this._invCells[rid]) return;
      for (let t = 1; t <= maxT; t++) {
        const ref = this._invCells[rid][t]; const v = this.tierCount(this.player, rid, t);
        if (v !== ref.last) {
          ref.el.textContent = v > 0 ? v : "";
          ref.el.classList.toggle("has", v > 0);
          if (v > ref.last && ref.last >= 0) { ref.el.classList.remove("bump"); void ref.el.offsetWidth; ref.el.classList.add("bump"); }
          ref.last = v;
        }
      }
      if (this._invRow[rid]) {
        this._invRow[rid].classList.toggle("can-refine", this.anyConvert(rid));
        // Show a row when the player holds stock OR a staffed machine produces it (so assigning
        // workers reveals the row right away). Vacant rows collapse (display:none); the reflow is
        // confined to the capped-height .inv-scroll box, so the machine list below never bumps.
        const vacant = this.stockOf(this.player, rid) <= 0 && !this.isStaffedFor(rid);
        this._invRow[rid].classList.toggle("inv-row-vacant", vacant);
      }
    });
    const tot = this.stockTotal(this.player), cap = this.player.storageCap;
    const c = $("#inv-cap"); if (c) { c.textContent = `${tot}/${cap}`; c.classList.toggle("full", tot >= cap); }
    if (this._convertResId && !$("#convert-overlay").classList.contains("hidden")) this.updateConvertList();
    this._invDirty = false; // DOM now matches the model
  },

  // --- refining overlay (convert table) ---
  anyConvert(resId) { const r = this.cfg.convert[resId]; if (!r) return false; for (const t in r) if (this.canConvert(this.player, resId, +t)) return true; return false; },
  openConvert(resId) {
    this._convertResId = resId;
    $("#convert-title").textContent = `Raffiner — ${this.res(resId).displayName}`;
    this.renderConvertList();
    $("#convert-overlay").classList.remove("hidden");
  },
  closeConvert() { this._convertResId = null; $("#convert-overlay").classList.add("hidden"); },
  // Build the refine list once (stable button elements so clicks register).
  renderConvertList() {
    const resId = this._convertResId; if (!resId) return;
    const list = $("#convert-list"); list.innerHTML = "";
    const rules = this.cfg.convert[resId];
    this._cvRows = [];
    Object.keys(rules).map(Number).sort((a, b) => a - b).forEach((tier) => {
      const rule = rules[tier];
      const row = el("div", "convert-row");
      const from = el("div", "cv-side");
      from.append(this.tierImg(resId, tier), el("span", "cv-q", `${rule.quantity}× T${tier}`));
      const arrow = el("span", "cv-arrow", "→");
      const to = el("div", "cv-side");
      to.append(this.tierImg(rule.resultRes, rule.resultTier), el("span", "cv-q", `${rule.resultQty}× T${rule.resultTier}`));
      const haveEl = el("span", "cv-have", "");
      const btn = el("button", "cv-btn", "Raffiner");
      btn.onclick = () => { if (this.doConvert(resId, tier)) this.updateConvertList(); };
      row.append(from, arrow, to, haveEl, btn);
      list.appendChild(row);
      this._cvRows.push({ tier, rule, row, haveEl, btn });
    });
    this.updateConvertList();
  },
  // Lightweight per-frame refresh: update counts/disabled in place, never rebuild.
  updateConvertList() {
    if (!this._cvRows || !this._convertResId) return;
    const resId = this._convertResId;
    this._cvRows.forEach((r) => {
      const have = this.tierCount(this.player, resId, r.tier);
      const ok = have >= r.rule.quantity;
      r.haveEl.textContent = `tu as ${have}`;
      r.btn.disabled = !ok;
      r.row.classList.toggle("locked", !ok);
    });
  },

  // --- shop bar (worker / marketing / storage) ---
  renderShop() {
    const bar = $("#shop-bar"); bar.innerHTML = "";
    this._shopBtns = [];
    // disFn is stored so refreshAffordability() can re-evaluate disabled in place
    // (never rebuild the buttons — a rebuild mid-click would swallow the tap).
    const mk = (icon, label, val, disFn, fn) => {
      const b = el("button", "shop-btn");
      b.innerHTML = `<span class="si">${icon}</span><span>${label}</span><b>${val}</b>`;
      b.disabled = disFn(); b.onclick = fn; bar.appendChild(b);
      this._shopBtns.push({ b, disFn });
    };
    const w = this.nextWorker();
    mk(`<img src="${sprite("Worker")}">`, `Ouvrier ×${this.player.totalWorkers}`, w ? "$" + w.price : "MAX", () => !w || this.player.totalWorkers >= this.cfg.g.maxWorkersTotal || this.player.money < w.price, () => this.buyWorker());
    const mkt = this.nextMkt();
    mk("📣", `Mkt ${this.player.marketing.toFixed(1)}`, mkt ? "$" + mkt.price : "MAX", () => !mkt || this.player.money < mkt.price, () => this.buyMkt());
    const st = this.nextStorage();
    mk("📦", `Stock ${this.player.storageCap}`, st ? "$" + st.price : "MAX", () => !st || this.player.money < st.price, () => this.buyStorage());
  },
  // Re-evaluate buy/upgrade buttons' enabled state in place whenever money changes.
  refreshAffordability() {
    if (this._shopBtns) this._shopBtns.forEach(({ b, disFn }) => { b.disabled = disFn(); });
    this.player.machines.forEach((m) => {
      if (!m._refs || !m._refs.up) return;
      const nx = this.nextMachineLevel(m);
      m._refs.up.disabled = !nx || this.player.money < nx.cost;
    });
  },

  // --- machines ---
  renderMachines() { const list = $("#machine-list"); list.innerHTML = ""; this.player.machines.forEach((m) => { m._node = this.buildMachine(m); list.appendChild(m._node); }); },
  buildMachine(m) {
    const def = this.machineDef(m.id);
    const node = el("div", "machine");
    const icon = el("img", "machine-icon"); icon.src = sprite(def.spriteId);
    const name = el("div", "machine-name");
    const recipe = el("div", "machine-recipe", this.recipeHtml(def));
    const footer = el("div", "machine-footer");
    const slots = el("div", "worker-slots"); footer.appendChild(slots);
    const btns = el("div", "machine-buttons");
    const rm = el("button", "ghost", "−"), ad = el("button", null, "+"), up = el("button", "upgrade");
    btns.append(rm, ad, up); footer.appendChild(btns);
    const prog = el("div", "progress"); prog.appendChild(el("div"));
    node.append(icon, name, recipe, footer, prog);
    rm.onclick = (e) => { e.stopPropagation(); this.removeWorker(m); };
    ad.onclick = (e) => { e.stopPropagation(); this.assignWorker(m); };
    up.onclick = (e) => { e.stopPropagation(); this.upgradeMachine(m); };
    node.onclick = () => { if (this.player.selectedWorker) this.assignWorker(m); };
    m._refs = { name, slots, ad, rm, up }; this.updateMachine(m, node); return node;
  },
  recipeHtml(def) {
    const ic = (id) => `<img src="${this.tierSrc(id, 1)}" title="${this.res(id).displayName}">`;
    const out = ic(def.outputs);
    if (!def.inputs.length) return `<span class="arrow">→</span> ${out}`;
    return def.inputs.map((i) => `${i.quantity}×${ic(i.type)}`).join(" ") + ` <span class="arrow">→</span> ${out}`;
  },
  refreshMachineCard(m) { if (m._node) this.updateMachine(m, m._node); this.renderWorkers(); },
  updateMachine(m, node) {
    const def = this.machineDef(m.id), L = this.lvl(m), r = m._refs;
    r.name.innerHTML = `${def.displayName} <span class="lvl">Nv.${m.level}</span>`;
    r.slots.innerHTML = "";
    for (let i = 0; i < L.maxWorkers; i++) r.slots.appendChild(el("div", "slot" + (i < m.workers ? " filled" : (i < L.workersRequired ? " required" : ""))));
    r.ad.disabled = m.workers >= L.maxWorkers || this.player.availableWorkers <= 0;
    r.rm.disabled = m.workers <= 0;
    const nx = this.nextMachineLevel(m);
    if (nx) { r.up.innerHTML = `⬆ $${nx.cost}`; r.up.disabled = this.player.money < nx.cost; } else { r.up.innerHTML = "⬆ MAX"; r.up.disabled = true; }
    node.classList.toggle("producing", m.producing);
    node.classList.toggle("assignable", this.player.selectedWorker && m.workers < L.maxWorkers);
  },
  setProgress(m, ratio) { if (m._node) m._node.querySelector(".progress > div").style.width = (ratio * 100) + "%"; },

  // --- workers ---
  renderWorkers() {
    const wrap = $("#worker-icons"); wrap.innerHTML = "";
    for (let i = 0; i < this.player.availableWorkers; i++) { const w = el("div", "worker" + (this.player.selectedWorker && i === 0 ? " selected" : "")); w.innerHTML = `<img src="${sprite("Worker")}">`; w.onclick = () => this.selectWorker(); wrap.appendChild(w); }
    const hint = $("#worker-hint");
    hint.textContent = this.player.availableWorkers === 0 ? "Tous tes ouvriers sont assignés" : this.player.selectedWorker ? "Touche une machine (+)" : `${this.player.availableWorkers} ouvrier(s) dispo`;
    hint.classList.toggle("active", !!this.player.selectedWorker);
    this.player.machines.forEach((m) => { if (m._node) this.updateMachine(m, m._node); });
    this.renderShop();
  },

  // --- suppliers / counters (market) ---
  renderSuppliers() {
    const wrap = $("#suppliers"); wrap.innerHTML = "";
    const alive = this.competitors.filter((c) => !c.eliminated).sort((a, b) => b.money - a.money);
    alive.forEach((c) => {
      const s = el("div", "counter" + (c.isPlayer ? " me" : "")); c._counter = s;
      s.innerHTML = `<img class="counter-avatar" src="${sprite(c.spriteId)}"><div class="counter-name">${c.name}</div><div class="counter-money"><img src="${sprite("Coins")}"><span class="cmoney">${c.money}</span></div><div class="counter-mkt">📣${c.marketing.toFixed(1)}</div><div class="counter-inv"></div>`;
      c._moneyRef = s.querySelector(".cmoney");
      c._invRef = s.querySelector(".counter-inv");
      this.renderCounterInv(c);
      s.onclick = () => this.openCompetitor(c);
      wrap.appendChild(s);
    });
  },

  // --- competitor info widget ---
  openCompetitor(c) { this._infoC = c; this.renderCompetitorPanel(); $("#competitor-overlay").classList.remove("hidden"); },
  closeCompetitor() { this._infoC = null; $("#competitor-overlay").classList.add("hidden"); },

  // --- resource info widget (click an inventory resource) ---
  openResourceInfo(rid) { this._infoRes = rid; this.renderResourcePanel(); $("#resource-overlay").classList.remove("hidden"); },
  closeResourceInfo() { this._infoRes = null; $("#resource-overlay").classList.add("hidden"); },
  renderResourcePanel() {
    const rid = this._infoRes; if (!rid) return;
    const r = this.res(rid), maxT = this.cfg.maxTier;
    const body = $("#resource-body");
    const desc = r.description
      ? `<div class="res-desc">${r.description}</div>`
      : `<div class="res-desc muted">Pas encore de description — ajoute "description" à cette ressource dans le config.</div>`;
    body.innerHTML =
      `<div class="cp-head">
        <img class="cp-skin" src="${this.tierSrc(rid, this.bestTier(this.player, rid) || 1)}">
        <div class="cp-id">
          <div class="cp-name">${r.displayName}</div>
          <div class="cp-tags"><span class="cp-tag">#${rid}</span></div>
        </div>
      </div>
      ${desc}
      <div class="cp-section">Tiers</div>
      <div class="res-tiers"></div>
      <div id="res-actions"></div>`;
    const tiers = body.querySelector(".res-tiers");
    for (let t = 1; t <= maxT; t++) {
      const ti = this.cfg.resources[rid].tiers[t]; if (!ti) continue;
      const have = this.tierCount(this.player, rid, t);
      const row = el("div", "res-tier-row" + (have > 0 ? " owned" : ""));
      const img = this.tierImg(rid, t); img.className = "res-tier-img";
      row.append(
        img,
        el("span", "res-tier-name", `Tier ${t}`),
        el("span", "res-tier-price", `💰 ${ti.price}`),
        el("span", "res-tier-inf", `📣 ${ti.influence}`),
        el("span", "res-tier-have", `×${have}`)
      );
      tiers.appendChild(row);
    }
    if (this.cfg.convert[rid]) {
      const btn = el("button", "cv-btn", "🔁 Raffiner");
      btn.onclick = () => { this.closeResourceInfo(); this.openConvert(rid); };
      body.querySelector("#res-actions").appendChild(btn);
    }
  },
  botSpecialty(c) {
    if (!c.behavior) return "";
    let best = null, bw = -1;
    this.cfg.resourceOrder.forEach((r) => { const w = c.behavior[r] || 0; if (w > bw) { bw = w; best = r; } });
    return best && bw > 0 ? "Spécialité : " + this.res(best).displayName : "";
  },
  renderCompetitorPanel() {
    const c = this._infoC; if (!c) return;
    const body = $("#competitor-body");
    const tag = (c.def && c.def.tag) || c.id;
    const income = c.isPlayer ? null : (c.def.increaseByRound + c.def.upgradeEffect * c.upgradesBought);
    const spec = c.isPlayer ? "" : this.botSpecialty(c);
    body.innerHTML =
      `<div class="cp-head">
        <img class="cp-skin" src="${sprite(c.spriteId)}">
        <div class="cp-id">
          <div class="cp-name">${c.name}${c.eliminated ? ' <span class="cp-elim">éliminé</span>' : ""}</div>
          <div class="cp-tags"><span class="cp-tag">@${tag}</span>${spec ? `<span class="cp-spec">${spec}</span>` : ""}</div>
        </div>
      </div>
      <div class="cp-stats">
        <div class="cp-stat"><span>Argent</span><b>${c.money}</b></div>
        <div class="cp-stat"><span>Marketing</span><b>${c.marketing.toFixed(1)}</b></div>
        <div class="cp-stat"><span>Stockage</span><b>${this.stockTotal(c)}/${c.storageCap}</b></div>
        ${income != null ? `<div class="cp-stat"><span>Revenu/tour</span><b>+${income}</b></div>` : ""}
      </div>
      <div class="cp-section">Améliorations</div>
      <div class="cp-upg">
        <span>👷 Ouvriers : <b>${c.buys.increaseWorker}</b></span>
        <span>📣 Marketing : <b>${c.buys.increaseMarketting}</b></span>
        <span>📦 Stockage : <b>${c.buys.increaseStorage}</b></span>
        ${c.isPlayer ? "" : `<span>⭐ Total : <b>${c.upgradesBought}</b></span>`}
      </div>
      <div class="cp-section">Inventaire</div>
      <div class="cp-inv"></div>`;
    const inv = body.querySelector(".cp-inv");
    const maxT = this.cfg.maxTier; let any = false;
    this.cfg.resourceOrder.forEach((rid) => {
      if (this.stockOf(c, rid) <= 0) return; any = true;
      const row = el("div", "cp-inv-row");
      const ic = this.tierImg(rid, this.bestTier(c, rid) || 1); ic.className = "cp-inv-icon"; ic.title = this.res(rid).displayName;
      const tiers = el("div", "cp-inv-tiers");
      for (let t = 1; t <= maxT; t++) { const n = this.tierCount(c, rid, t); if (n > 0) tiers.appendChild(el("span", "cp-tier-chip", `T${t}·${n}`)); }
      row.append(ic, tiers); inv.appendChild(row);
    });
    if (!any) inv.appendChild(el("div", "cp-empty", "Inventaire vide"));
  },
  // Seller inventory on a counter. The player gets a compact per-resource total
  // (the full per-tier detail lives in the bottom inventory grid); bots show each
  // non-empty (resource, tier) stack, highest tier first.
  renderCounterInv(c) {
    const wrap = c._invRef; if (!wrap) return;
    wrap.innerHTML = "";
    if (c.isPlayer) {
      this.cfg.resourceOrder.forEach((rid) => {
        const n = this.stockOf(this.player, rid); if (n <= 0) return;
        const stack = el("div", "cinv-stack");
        stack.append(this.tierImg(rid, this.bestTier(this.player, rid) || 1), el("span", null, n));
        wrap.appendChild(stack);
      });
    } else {
      this.cfg.resourceOrder.forEach((rid) => {
        const m = c.stock[rid] || {};
        Object.keys(m).map(Number).sort((a, b) => b - a).forEach((t) => {
          if (m[t] <= 0) return;
          const stack = el("div", "cinv-stack");
          stack.append(this.tierImg(rid, t), el("span", null, m[t]));
          wrap.appendChild(stack);
        });
      });
    }
    if (!wrap.children.length) wrap.appendChild(el("span", "cinv-empty", "vide"));
  },
  // Update money + inventory in place (keeps the hit/money-pop animations alive).
  refreshSuppliers() {
    this.competitors.forEach((c) => {
      if (c.eliminated || !c._counter) return;
      if (c._moneyRef) c._moneyRef.textContent = c.money;
      this.renderCounterInv(c);
    });
    if (this._infoC && !$("#competitor-overlay").classList.contains("hidden")) this.renderCompetitorPanel();
  },
  flashStall(c, gain) {
    const s = c._counter; if (!s) return;
    s.classList.remove("hit"); void s.offsetWidth; s.classList.add("hit");
    if (gain) { const pop = el("div", "money-pop", "+" + gain); s.appendChild(pop); setTimeout(() => pop.remove(), 800); this.coinBurst(s, 6); }
  },
  // little coins springing out of a counter when it earns money
  coinBurst(s, n) {
    for (let i = 0; i < n; i++) {
      const coin = el("img", "coin-particle"); coin.src = sprite("Coins");
      coin.style.setProperty("--dx", Math.round(Math.random() * 80 - 40) + "px");
      coin.style.setProperty("--dy", Math.round(-32 - Math.random() * 40) + "px");
      coin.style.animationDelay = (Math.random() * 0.1).toFixed(2) + "s";
      s.appendChild(coin);
      setTimeout(() => coin.remove(), 850);
    }
  },

  renderResults(ranked, elimNow) {
    const list = $("#results-list"); list.innerHTML = "";
    ranked.forEach((c, i) => {
      const row = el("div", "result-row" + (c.isPlayer ? " me" : "") + (elimNow.includes(c) ? " eliminated" : ""));
      row.innerHTML = `<span class="rank">${i + 1}</span><img src="${sprite(c.spriteId)}"><span class="rname">${c.name}</span><span class="rsales">+${c.salesThisRound}</span><span class="rmoney"><img src="${sprite("Coins")}">${c.money}</span>` + (elimNow.includes(c) ? `<span class="rx">ÉLIMINÉ</span>` : "");
      list.appendChild(row);
    });
    $("#results-title").textContent = elimNow.length ? (elimNow.includes(this.player) ? "Tu es éliminé…" : `${elimNow.map((c) => c.name).join(", ")} éliminé`) : `Round ${this.round} — classement`;
    $("#results-overlay").classList.remove("hidden");
  },
};

$("#replay-btn").addEventListener("click", () => { $("#gameover-overlay").classList.add("hidden"); Game.transitionTo(S.Setup); });
$("#convert-close").addEventListener("click", () => Game.closeConvert());
$("#convert-overlay").addEventListener("click", (e) => { if (e.target.id === "convert-overlay") Game.closeConvert(); });
$("#competitor-close").addEventListener("click", () => Game.closeCompetitor());
$("#competitor-overlay").addEventListener("click", (e) => { if (e.target.id === "competitor-overlay") Game.closeCompetitor(); });
$("#resource-close").addEventListener("click", () => Game.closeResourceInfo());
$("#resource-overlay").addEventListener("click", (e) => { if (e.target.id === "resource-overlay") Game.closeResourceInfo(); });

// Inventory updates are driven by visibility (setupInventoryObserver) + the play
// loop's maybeRefreshInventory, so it never shifts the layout while off screen.

window.Game = Game; // expose for console debugging
Game.start();
