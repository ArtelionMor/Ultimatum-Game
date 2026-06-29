/* Market Ultimatum — v3. Competitive tiered tycoon.
 * Reads the user's config_export.json (their source of truth) and normalizes it.
 * Loop per round: Tycoon (produce tiered goods, capped by storage; buy machine
 * levels / workers / marketing / storage) -> Market (customers fall from the top
 * and pick a shop by attractiveness = marketing + tier influence) -> Tax -> Results.
 */
"use strict";

// ---- config knobs not in the export ----
const ELIM_AT_TAX_ROUNDS = true;   // eliminate the last competitor at each tax round
const BASE_MARKETING = 1.0;        // attractiveness baseline before any marketing purchase
const SPAWN_INTERVAL = 0.45;       // seconds between customers
const FALL_TIME = 2.6;             // seconds a customer takes to fall

const SPRITES = {
  Bois: "sprites/Bois.png", Vault: "sprites/Vault.png", Plank: "sprites/Plank.png",
  Sword: "sprites/Sword.png", Gear: "sprites/Gear.png", Engine: "sprites/Engine.png",
  Tree: "sprites/Tree.png", "Burning Wood": "sprites/Burning Wood.png",
  Worker: "sprites/Worker.png", Coins: "sprites/Coins.png", Customer: "sprites/Customer.png",
};
const sprite = (id) => SPRITES[id] || "";
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

const S = { Setup: "Setup", Tycoon: "Tycoon", Market: "Market", Tax: "Tax", Results: "Results", GameOver: "GameOver" };

// ============================================================
// Config normalization (export format -> engine format)
// ============================================================
function normalize(raw) {
  const g = {}; raw.general.forEach((x) => (g[x.id] = x.value));

  const resources = {}; const resourceOrder = [];
  raw.resources.forEach((r) => {
    if (!resources[r.id]) { resources[r.id] = { id: r.id, displayName: r.displayName.replace(/ tier.*$/i, ""), spriteId: r.spriteId, tiers: {} }; resourceOrder.push(r.id); }
    resources[r.id].tiers[r.tier] = { price: r.baseSellPrice, influence: r.influence };
  });
  const maxTier = Math.max(...raw.resources.map((r) => r.tier));

  const inputsByMachine = {};
  raw.inputs.forEach((i) => { (inputsByMachine[i.id] = inputsByMachine[i.id] || []).push({ type: i.type, quantity: i.quantity }); });

  const outputsByResLevel = {};
  raw.outputs.forEach((o) => {
    const k = o.id + "_" + o.level;
    (outputsByResLevel[k] = outputsByResLevel[k] || []).push({
      group: o.group, quantity: o.quantity, weight: o.weight,
      tiers: [o.tier1, o.tier2, o.tier3, o.tier4, o.tier5, o.tier6],
    });
  });

  const machines = raw.machines.map((m) => ({
    id: m.id, displayName: m.displayName, spriteId: m.spriteId, outputs: m.outputs,
    unlockAtRound: m.unlockAtRound,
    inputs: inputsByMachine[m.id] || [],
    levels: raw.upgrades.filter((u) => u.id === m.id).sort((a, b) => a.level - b.level)
      .map((u) => ({ level: u.level, cost: u.cost, workersRequired: u.workersRequired, maxWorkers: u.maxWorkers, workerSpeedBonus: u.workerSpeedBonus, productionTime: u.productionTime })),
  }));

  const purchases = { increaseWorker: [], increaseMarketting: [], increaseStorage: [] };
  raw.purshases.forEach((p) => { if (purchases[p.type]) purchases[p.type].push({ effect: p.effect, price: p.price }); });

  const market = {}; raw.market.forEach((m, i) => {
    market[i + 1] = { customers: m.customers, avg: m["average amount"], weights: { wood: m.weight_wood, iron: m.weight_iron, plank: m.weight_plank, sword: m.weight_sword } };
  });

  // convert: N units of (id, tier) -> result_quantity (default 1) of (result_ressource, result_tier)
  const convert = {};
  (raw.convert || []).forEach((c) => {
    (convert[c.id] = convert[c.id] || {})[c.tier] = { quantity: c.quantity, resultRes: c.result_ressource, resultTier: c.result_tier, resultQty: c.result_quantity || 1 };
  });

  // slots: rarity/luck styling for a produced output, keyed by its output `group` (A..F)
  const slots = {};
  (raw.slots || []).forEach((s) => { slots[s.id] = { description: s.description || "", color: s.color || "", font: s.font || 12 }; });

  const tax = {}; raw.tax.forEach((t) => (tax[t.round] = t.cost));
  const roundIncome = {}; raw.roundIncome.forEach((r) => (roundIncome[r.round] = { coins: r.coins, tier: r.ressource_tier }));

  const behavior = {};
  raw.competitors_behavior.forEach((b) => { (behavior[b.id] = behavior[b.id] || {})[b.ressources] = b.weights || 0; });
  const competitors = raw.competitors.map((c) => ({ ...c, behavior: behavior[c.id] || {} }));

  return { g, resources, resourceOrder, maxTier, machines, purchases, market, tax, roundIncome, competitors, convert, slots };
}

// ============================================================
// Game
// ============================================================
const Game = {
  cfg: null, state: S.Setup, round: 0, phaseTimer: 0,
  competitors: [], player: null, lastTime: 0, market: null,

  async start() {
    const raw = await fetch("config_export.json").then((r) => r.json());
    this.cfg = normalize(raw);
    // outputs lookup keyed resource_level for production rolls
    this.cfg._outputs = {};
    raw.outputs.forEach((o) => { const k = o.id + "_" + o.level; (this.cfg._outputs[k] = this.cfg._outputs[k] || []).push({ group: o.group, quantity: o.quantity, weight: o.weight, tiers: [o.tier1, o.tier2, o.tier3, o.tier4, o.tier5, o.tier6] }); });
    $("#total-rounds").textContent = this.cfg.g.totalRounds;
    this.transitionTo(S.Setup);
    requestAnimationFrame((t) => this.loop(t));
  },

  loop(t) {
    if (!this.lastTime) this.lastTime = t;
    let dt = (t - this.lastTime) / 1000; this.lastTime = t;
    if (dt > 0.2) dt = 0.2;
    if (this.state === S.Tycoon) this.updateTycoon(dt);
    else if (this.state === S.Market) this.updateMarket(dt);
    requestAnimationFrame((t2) => this.loop(t2));
  },

  transitionTo(n) { this.exitState(this.state); this.state = n; this.enterState(n); },
  enterState(s) { ({ [S.Setup]: () => this.enterSetup(), [S.Tycoon]: () => this.enterTycoon(), [S.Market]: () => this.enterMarket(), [S.Tax]: () => this.enterTax(), [S.Results]: () => this.enterResults(), [S.GameOver]: () => this.enterGameOver() }[s] || (() => {}))(); },
  exitState(s) { if (s === S.Tycoon) this.exitTycoon(); },

  // ---------- helpers ----------
  res(id) { return this.cfg.resources[id]; },
  tierInfo(id, tier) { return this.cfg.resources[id].tiers[tier]; },
  machineDef(id) { return this.cfg.machines.find((m) => m.id === id); },
  emptyStock() { const s = {}; this.cfg.resourceOrder.forEach((r) => { s[r] = {}; }); return s; },
  stockTotal(c) { let n = 0; for (const r in c.stock) for (const t in c.stock[r]) n += c.stock[r][t]; return n; },
  stockOf(c, resId) { let n = 0; const m = c.stock[resId] || {}; for (const t in m) n += m[t]; return n; },
  bestTier(c, resId) { const m = c.stock[resId] || {}; let best = 0; for (const t in m) if (m[t] > 0 && +t > best) best = +t; return best; },
  addStock(c, resId, tier, qty) { c.stock[resId][tier] = (c.stock[resId][tier] || 0) + qty; },
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
  tierImg(resId, tier) {
    const base = this.res(resId).spriteId;
    const candidates = [
      `sprites/tiers/${resId}_t${tier}.png`,   // e.g. sprites/tiers/wood_t3.png  (recommended)
      `sprites/tiers/${base} T${tier}.png`,    // e.g. sprites/tiers/Bois T3.png
      `sprites/${base} T${tier}.png`,          // e.g. sprites/Bois T3.png
      `sprites/${base}.png`,                   // base sprite (no per-tier art yet)
    ];
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

    const bots = this.cfg.competitors.map((b) => ({
      id: b.id, name: b.displayName, spriteId: b.spriteId, isPlayer: false, eliminated: false,
      money: b.startingMoney, stock: this.emptyStock(), storageCap: g.startingStorage,
      marketing: BASE_MARKETING, def: b, behavior: b.behavior, upgradesBought: 0,
      buys: { increaseWorker: 0, increaseMarketting: 0, increaseStorage: 0 }, salesThisRound: 0,
    }));
    this.competitors = [this.player, ...bots];
    this.transitionTo(S.Tycoon);
  },

  giveMachine(p, id) { if (!p.machines.some((m) => m.id === id)) p.machines.push({ id, level: 1, workers: 0, elapsed: 0, producing: false }); },

  // ---------- Tycoon ----------
  enterTycoon() {
    this.round++;
    const g = this.cfg.g;
    this.phaseTimer = g.tycoonPhaseDuration;
    this.player.selectedWorker = false;

    // round income (scheduled) to every alive competitor
    const inc = this.cfg.roundIncome[this.round];
    if (inc) this.competitors.forEach((c) => { if (!c.eliminated) c.money += inc.coins; });

    // unlock machines
    this.cfg.machines.forEach((m) => { if (m.unlockAtRound === this.round) this.giveMachine(this.player, m.id); });
    // keep last round's worker assignments; only recompute the available pool
    let assigned = 0;
    this.player.machines.forEach((m) => { m.producing = false; m.elapsed = 0; assigned += m.workers; });
    this.player.availableWorkers = Math.max(0, this.player.totalWorkers - assigned);

    $("#market-zone").classList.add("hidden");
    $("#factory-zone").classList.remove("hidden");
    $("#worker-bar").style.display = "flex";
    $("#phase-banner").textContent = `Round ${this.round} — Revenu +${inc ? inc.coins : 0}$ · stock max ${this.player.storageCap}`;

    this.renderInventory(); this.renderShop(); this.renderMachines(); this.renderWorkers(); this.refreshHud();
  },

  updateTycoon(dt) {
    this.phaseTimer -= dt;
    this.tickProduction(dt);
    this.refreshInventory(); this.refreshHud();
    if (this.phaseTimer <= 0) this.transitionTo(S.Market);
  },

  exitTycoon() { this.player.machines.forEach((m) => { m.producing = false; m.elapsed = 0; }); },

  lvl(machine) { return this.machineDef(machine.id).levels[machine.level - 1]; },
  effTime(machine) { const L = this.lvl(machine); return Math.max(0.3, L.productionTime * (1 - L.workerSpeedBonus * machine.workers)); },
  hasInputs(p, def) { return def.inputs.every((i) => this.stockOf(p, i.type) >= i.quantity); },
  consumeInputs(p, def) { def.inputs.forEach((i) => { let need = i.quantity; const m = p.stock[i.type]; for (const t of Object.keys(m).sort((a, b) => a - b)) { while (need > 0 && m[t] > 0) { m[t]--; need--; } } }); },

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
  // cost of the next upcoming tax (this round or later) — bots keep this as a reserve
  nextTaxCost(round) { let best = 0, near = Infinity; for (const r in this.cfg.tax) { const rn = +r; if (rn >= round && rn < near) { near = rn; best = this.cfg.tax[r]; } } return best; },

  simulateBot(b) {
    const inc = this.cfg.roundIncome[this.round];
    b.money += b.def.increaseByRound + b.def.upgradeEffect * b.upgradesBought;
    b.salesThisRound = 0;
    b.stock = this.emptyStock();
    const tier = inc ? inc.tier : 1;

    // Keep enough to survive the upcoming tax.
    const reserve = this.nextTaxCost(this.round);

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

  // ---------- Market ----------
  enterMarket() {
    this.competitors.forEach((c) => { if (!c.isPlayer && !c.eliminated) this.simulateBot(c); c.salesThisRound = 0; });
    const m = this.cfg.market[this.round] || this.cfg.market[Object.keys(this.cfg.market).length];
    this.market = { def: m, remaining: m.customers, total: m.customers, served: 0, spawnTimer: 0, active: 0 };

    this.closeConvert();
    $("#factory-zone").classList.add("hidden");
    $("#market-zone").classList.remove("hidden");
    $("#worker-bar").style.display = "none";
    $("#phase-banner").textContent = "Les clients arrivent — capte-les !";
    $("#customer-lane").innerHTML = "";
    this.renderSuppliers();
    this.refreshHud();
  },

  updateMarket(dt) {
    const m = this.market;
    m.spawnTimer -= dt;
    if (m.remaining > 0 && m.spawnTimer <= 0) { m.spawnTimer = SPAWN_INTERVAL / (this.cfg.g.customerRate || 1); m.remaining--; this.spawnCustomer(); }
    this.refreshHud();
    if (m.remaining <= 0 && m.served >= m.total) this.transitionTo(S.Tax);
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
    cust.innerHTML = `<div class="bubble"><span>${need.qty}×</span><img src="${sprite(this.res(need.resId).spriteId)}"></div><img class="cust-sprite" src="${sprite("Customer")}">`;
    const fall = FALL_TIME / (this.cfg.g.customerSpeed || 1); // customerSpeed: higher = faster
    cust.style.setProperty("--fall", fall + "s");
    lane.appendChild(cust);
    requestAnimationFrame(() => cust.classList.add("falling"));

    setTimeout(() => {
      const eligible = this.competitors.filter((c) => !c.eliminated && this.stockOf(c, need.resId) > 0);
      if (eligible.length) {
        const winner = this.chooseShop(eligible, need.resId);
        const gain = this.sellTo(winner, need.resId, need.qty);
        if (winner._counter) {
          const cr = winner._counter.getBoundingClientRect(), lr = lane.getBoundingClientRect();
          cust.style.left = (cr.left - lr.left + cr.width / 2) + "px";
          cust.classList.add("toShop");
          this.flashStall(winner, gain);
        }
      } else { cust.classList.add("nobody"); setTimeout(() => cust.classList.add("done"), 200); }
      setTimeout(() => cust.remove(), 750);
      m.served++; m.active--;
      this.refreshSuppliers();
    }, fall * 1000);
  },

  sellTo(c, resId, qty) {
    let gain = 0;
    const m = c.stock[resId];
    const tiers = Object.keys(m).map(Number).sort((a, b) => b - a); // highest tier first
    for (const t of tiers) { while (qty > 0 && m[t] > 0) { m[t]--; qty--; gain += this.tierInfo(resId, t).price; } }
    c.money += gain; c.salesThisRound += gain;
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

  // ---------- Results / elimination ----------
  enterResults() {
    const alive = this.competitors.filter((c) => !c.eliminated).sort((a, b) => b.money - a.money);
    const isTaxRound = !!this.cfg.tax[this.round];
    let elimNow = [];
    if (ELIM_AT_TAX_ROUNDS && isTaxRound && alive.length > 2) { elimNow = alive.slice(-1); elimNow.forEach((c) => (c.eliminated = true)); }
    this.renderResults(alive, elimNow);

    const stillAlive = this.competitors.filter((c) => !c.eliminated);
    const end = this.player.eliminated || stillAlive.length <= 1 || this.round >= this.cfg.g.totalRounds;
    $("#results-continue").textContent = end ? "Voir le résultat" : "Round suivant";
    $("#results-continue").onclick = () => { $("#results-overlay").classList.add("hidden"); this.transitionTo(end ? S.GameOver : S.Tycoon); };
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
    $("#phase-label").textContent = ({ [S.Tycoon]: "Production", [S.Market]: "Marché" })[this.state] || "";
    if (this.state === S.Tycoon) { const s = Math.max(0, Math.ceil(this.phaseTimer)); $("#timer").textContent = s + "s"; $("#hud-timer").classList.toggle("urgent", s <= 10); }
    else if (this.state === S.Market) { $("#timer").textContent = "👥 " + (this.market ? this.market.remaining : 0); $("#hud-timer").classList.remove("urgent"); }
  },

  // --- inventory (tiered) ---
  renderInventory() {
    const bar = $("#inventory-bar"); bar.innerHTML = ""; this._invRefs = {};
    this.cfg.resourceOrder.forEach((rid) => {
      const r = this.res(rid);
      const chip = el("div", "inv-chip");
      chip.title = `${r.displayName} — raffiner`;
      const img = this.tierImg(rid, this.bestTier(this.player, rid) || 1);
      const count = el("span", "inv-count", "0"), tier = el("span", "inv-tier", "");
      const refine = el("span", "inv-refine", "🔁");
      chip.append(img, count, tier, refine);
      if (this.cfg.convert[rid]) chip.onclick = () => this.openConvert(rid);
      bar.appendChild(chip);
      this._invRefs[rid] = { count, tier, chip, img, refine, last: -1, lastTier: -1 };
    });
    const cap = el("div", "inv-cap"); cap.id = "inv-cap"; bar.appendChild(cap);
    this.refreshInventory();
  },
  refreshInventory() {
    if (!this._invRefs) return;
    this.cfg.resourceOrder.forEach((rid) => {
      const ref = this._invRefs[rid]; const v = this.stockOf(this.player, rid);
      const bt = this.bestTier(this.player, rid);
      if (v !== ref.last) {
        ref.count.textContent = v; ref.chip.classList.toggle("empty", v === 0);
        ref.tier.textContent = bt ? "T" + bt : "";
        if (v > ref.last && ref.last >= 0) { ref.chip.classList.remove("bump"); void ref.chip.offsetWidth; ref.chip.classList.add("bump"); }
        ref.last = v;
      }
      const dispTier = bt || 1;
      if (dispTier !== ref.lastTier) {
        const ni = this.tierImg(rid, dispTier); ni.title = this.res(rid).displayName; ni.className = ref.img.className;
        ref.chip.replaceChild(ni, ref.img); ref.img = ni; ref.lastTier = dispTier;
      }
      ref.chip.classList.toggle("can-refine", this.anyConvert(rid));
    });
    const tot = this.stockTotal(this.player), cap = this.player.storageCap;
    const c = $("#inv-cap"); if (c) { c.textContent = `${tot}/${cap}`; c.classList.toggle("full", tot >= cap); }
    if (this._convertResId && !$("#convert-overlay").classList.contains("hidden")) this.renderConvertList();
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
  renderConvertList() {
    const resId = this._convertResId; if (!resId) return;
    const list = $("#convert-list"); list.innerHTML = "";
    const rules = this.cfg.convert[resId];
    Object.keys(rules).map(Number).sort((a, b) => a - b).forEach((tier) => {
      const rule = rules[tier];
      const have = this.tierCount(this.player, resId, tier);
      const ok = have >= rule.quantity;
      const row = el("div", "convert-row" + (ok ? "" : " locked"));
      const from = el("div", "cv-side");
      from.append(this.tierImg(resId, tier), el("span", "cv-q", `${rule.quantity}× T${tier}`));
      const arrow = el("span", "cv-arrow", "→");
      const to = el("div", "cv-side");
      to.append(this.tierImg(rule.resultRes, rule.resultTier), el("span", "cv-q", `${rule.resultQty}× T${rule.resultTier}`));
      const have$ = el("span", "cv-have", `tu as ${have}`);
      const btn = el("button", "cv-btn", "Raffiner"); btn.disabled = !ok;
      btn.onclick = () => { if (this.doConvert(resId, tier)) { this.renderConvertList(); } };
      row.append(from, arrow, to, have$, btn);
      list.appendChild(row);
    });
  },

  // --- shop bar (worker / marketing / storage) ---
  renderShop() {
    const bar = $("#shop-bar"); bar.innerHTML = "";
    const mk = (icon, label, val, dis, fn) => { const b = el("button", "shop-btn"); b.innerHTML = `<span class="si">${icon}</span><span>${label}</span><b>${val}</b>`; b.disabled = dis; b.onclick = fn; bar.appendChild(b); };
    const w = this.nextWorker();
    mk(`<img src="${sprite("Worker")}">`, `Ouvrier ×${this.player.totalWorkers}`, w ? "$" + w.price : "MAX", !w || this.player.totalWorkers >= this.cfg.g.maxWorkersTotal || this.player.money < (w ? w.price : 1e9), () => this.buyWorker());
    const mkt = this.nextMkt();
    mk("📣", `Mkt ${this.player.marketing.toFixed(1)}`, mkt ? "$" + mkt.price : "MAX", !mkt || this.player.money < (mkt ? mkt.price : 1e9), () => this.buyMkt());
    const st = this.nextStorage();
    mk("📦", `Stock ${this.player.storageCap}`, st ? "$" + st.price : "MAX", !st || this.player.money < (st ? st.price : 1e9), () => this.buyStorage());
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
    const ic = (id) => `<img src="${sprite(this.res(id).spriteId)}" title="${this.res(id).displayName}">`;
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
      wrap.appendChild(s);
    });
  },
  // Each non-empty (resource, tier) stack the seller holds, highest tier first.
  renderCounterInv(c) {
    const wrap = c._invRef; if (!wrap) return;
    wrap.innerHTML = "";
    this.cfg.resourceOrder.forEach((rid) => {
      const m = c.stock[rid] || {};
      Object.keys(m).map(Number).sort((a, b) => b - a).forEach((t) => {
        if (m[t] <= 0) return;
        const stack = el("div", "cinv-stack");
        stack.append(this.tierImg(rid, t), el("span", null, m[t]));
        wrap.appendChild(stack);
      });
    });
    if (!wrap.children.length) wrap.appendChild(el("span", "cinv-empty", "vide"));
  },
  // Update money + inventory in place (keeps the hit/money-pop animations alive).
  refreshSuppliers() {
    this.competitors.forEach((c) => {
      if (c.eliminated || !c._counter) return;
      if (c._moneyRef) c._moneyRef.textContent = c.money;
      this.renderCounterInv(c);
    });
  },
  flashStall(c, gain) {
    const s = c._counter; if (!s) return;
    s.classList.remove("hit"); void s.offsetWidth; s.classList.add("hit");
    if (gain) { const pop = el("div", "money-pop", "+" + gain); s.appendChild(pop); setTimeout(() => pop.remove(), 800); }
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

Game.start();
