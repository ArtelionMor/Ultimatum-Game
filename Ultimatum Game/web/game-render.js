/* Market Ultimatum — game-render.js
 * All DOM rendering extracted from main.js. These stay methods on the Game
 * object (they use `this` for state + DOM, and are called as game.renderX()
 * from every module), reassembled via Object.assign(Game, renderMethods).
 */
"use strict";

import { $, el, sprite } from "./helpers.js";
import { S } from "./constants.js";
import { Meta } from "./meta.js";
import { openCharacterPanel, gearBadges } from "./menu.js";
import { openCodexCustomer, openCodexResource } from "./codex.js";
import { openBuildingPanel } from "./building.js";
import { nextTaxInfo } from "./game-tax.js";
import { freeWorkers, selectWorker, assignWorker, removeWorker, unassignWorker } from "./game-workers.js";
import { nextWorker, buyWorker, nextMkt, buyMkt, nextStorage, buyStorage, nextMachineLevel, upgradeMachine } from "./game-shop.js";

export const renderMethods = {
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
    this.refreshTaxChip();
  },

  // HUD chip: amount of the next tax (or ✅ once prepaid), pulsing red when imminent.
  refreshTaxChip() {
    const chip = $("#tax-chip"); if (!chip) return;
    const info = nextTaxInfo(this.levelCfg, this.round);
    if (!info) { chip.textContent = "🏛️ —"; $("#hud-tax").classList.remove("urgent"); return; }
    const prepaid = this.player.prepaidTaxRound === info.round;
    chip.textContent = prepaid ? "🏛️ ✅" : `🏛️ ${info.cost}$`;
    $("#hud-tax").classList.toggle("urgent", !prepaid && (info.round - this.round) <= 1);
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
      return def && def.outputs === rid && m.crew.length >= this.lvl(m).workersRequired;
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
    const w = nextWorker(this);
    mk(`<img src="${sprite("Worker")}">`, `Ouvrier ×${this.player.workers.length}`, w ? "$" + w.price : "MAX", () => !w || this.player.workers.length >= this.cfg.g.maxWorkersTotal || this.player.money < w.price, () => buyWorker(this));
    const mkt = nextMkt(this);
    mk("📣", `Mkt ${this.player.marketing.toFixed(1)}`, mkt ? "$" + mkt.price : "MAX", () => !mkt || this.player.money < mkt.price, () => buyMkt(this));
    const st = nextStorage(this);
    mk("📦", `Stock ${this.player.storageCap}`, st ? "$" + st.price : "MAX", () => !st || this.player.money < st.price, () => buyStorage(this));
  },
  // Re-evaluate buy/upgrade buttons' enabled state in place whenever money changes.
  refreshAffordability() {
    if (this._shopBtns) this._shopBtns.forEach(({ b, disFn }) => { b.disabled = disFn(); });
    this.player.machines.forEach((m) => {
      if (!m._refs || !m._refs.up) return;
      const nx = nextMachineLevel(this, m);
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
    rm.onclick = (e) => { e.stopPropagation(); removeWorker(this, m); };
    ad.onclick = (e) => { e.stopPropagation(); assignWorker(this, m); };
    up.onclick = (e) => { e.stopPropagation(); upgradeMachine(this, m); };
    node.onclick = () => { if (this.selectedWorker) assignWorker(this, m); };
    // tap the building sprite -> its detail widget (unless assigning a worker)
    icon.style.cursor = "pointer";
    icon.onclick = (e) => { if (this.selectedWorker) return; e.stopPropagation(); openBuildingPanel(m.id); };
    // tap an ingredient/output icon in the recipe -> its codex page
    recipe.addEventListener("click", (e) => { const img = e.target.closest("img[data-res]"); if (img) { e.stopPropagation(); openCodexResource(img.dataset.res); } });
    m._refs = { name, slots, ad, rm, up }; this.updateMachine(m, node); return node;
  },
  recipeHtml(def) {
    const ic = (id, cls = "") => `<img class="${cls}" data-res="${id}" src="${this.tierSrc(id, 1)}" title="${this.res(id).displayName}">`;
    const out = ic(def.outputs, "out");
    if (!def.inputs.length) return `<span class="arrow">→</span> ${out}`;
    return def.inputs.map((i) => `${i.quantity}×${ic(i.type)}`).join(" ") + ` <span class="arrow">→</span> ${out}`;
  },
  refreshMachineCard(m) { if (m._node) this.updateMachine(m, m._node); this.renderWorkers(); },
  updateMachine(m, node) {
    const def = this.machineDef(m.id), L = this.lvl(m), r = m._refs;
    r.name.innerHTML = `${def.displayName} <span class="lvl">Nv.${m.level}</span>`;
    r.slots.innerHTML = "";
    for (let i = 0; i < L.maxWorkers; i++) {
      if (i < m.crew.length) r.slots.appendChild(this.workerChip(m.crew[i]));
      else r.slots.appendChild(el("div", "slot" + (i < L.workersRequired ? " required" : "")));
    }
    r.ad.disabled = m.crew.length >= L.maxWorkers || freeWorkers(this.player).length <= 0;
    r.rm.disabled = m.crew.length <= 0;
    const nx = nextMachineLevel(this, m);
    if (nx) { r.up.innerHTML = `⬆ $${nx.cost}`; r.up.disabled = this.player.money < nx.cost; } else { r.up.innerHTML = "⬆ MAX"; r.up.disabled = true; }
    node.classList.toggle("producing", m.producing);
    node.classList.toggle("assignable", !!this.selectedWorker && m.crew.length < L.maxWorkers);
  },
  setProgress(m, ratio) { if (m._node) m._node.querySelector(".progress > div").style.width = (ratio * 100) + "%"; },

  // --- workers (bar + chips + drag & drop) ---
  renderWorkers() {
    const wrap = $("#worker-icons"); wrap.innerHTML = "";
    freeWorkers(this.player).forEach((w) => wrap.appendChild(this.workerChip(w)));
    const free = freeWorkers(this.player).length;
    const hint = $("#worker-hint");
    hint.textContent = free === 0 ? "Tous tes ouvriers sont assignés"
      : this.selectedWorker ? "Touche une machine (+)"
      : `${free} dispo — glisse-les sur les machines`;
    hint.classList.toggle("active", !!this.selectedWorker);
    this.player.machines.forEach((m) => { if (m._node) this.updateMachine(m, m._node); });
    this.renderShop();
  },

  // One worker chip: avatar + (for characters) name, gear badges and level ring.
  // Tap: character -> detail panel; generic free -> arm for tap-assign; generic
  // assigned -> back to the pool. Drag & drop works for every chip.
  workerChip(w) {
    const isChar = !!w.charId;
    const chip = el("div", "wchip" + (isChar ? " char" : "") + (this.selectedWorker === w ? " selected" : "") + (w.machineId ? " onmachine" : ""));
    chip.innerHTML =
      `<span class="wava"><img src="${sprite("Worker")}" draggable="false">` +
      (isChar ? `<span class="wgears">${gearBadges(w.charId)}</span>` : "") + `</span>` +
      (isChar ? `<span class="wname">${w.charId}<span class="wlvl">${Meta.charLevel(w.charId)}</span></span>` : "");
    this.makeDraggable(chip, w);
    return chip;
  },
  workerChipClick(w) {
    if (w.charId) { openCharacterPanel(w.charId); return; }
    if (w.machineId) { unassignWorker(this, w); return; }
    selectWorker(this, w);
  },

  // Pointer-based drag & drop (touch friendly): a ghost follows the finger; drop
  // on a machine assigns/moves the worker, drop on the worker bar recalls it.
  // A small move threshold keeps plain taps working as clicks.
  makeDraggable(chip, w) {
    chip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      let ghost = null, dragging = false;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
          dragging = true;
          ghost = chip.cloneNode(true); ghost.classList.add("drag-ghost");
          document.body.appendChild(ghost);
          chip.classList.add("drag-src");
          document.body.classList.add("dragging-worker");
        }
        if (dragging && ghost) {
          ghost.style.left = ev.clientX + "px"; ghost.style.top = ev.clientY + "px";
          this.highlightDropTarget(ev);
        }
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.classList.remove("dragging-worker");
        if (ghost) ghost.remove();
        chip.classList.remove("drag-src");
        this.clearDropHighlight();
        if (!dragging) { this.workerChipClick(w); return; }
        const target = this.dropTargetAt(ev);
        if (target === "bar") unassignWorker(this, w);
        else if (target) assignWorker(this, target, w);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  },
  dropTargetAt(ev) {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!under) return null;
    if (under.closest("#worker-bar")) return "bar";
    const node = under.closest(".machine");
    if (!node) return null;
    return this.player.machines.find((x) => x._node === node) || null;
  },
  highlightDropTarget(ev) {
    const t = this.dropTargetAt(ev);
    this.player.machines.forEach((m) => {
      if (!m._node) return;
      const ok = t === m && m.crew.length < this.lvl(m).maxWorkers;
      m._node.classList.toggle("drop-ok", ok);
    });
    $("#worker-bar").classList.toggle("drop-ok", t === "bar");
  },
  clearDropHighlight() {
    this.player.machines.forEach((m) => { if (m._node) m._node.classList.remove("drop-ok"); });
    $("#worker-bar").classList.remove("drop-ok");
  },

  // --- suppliers / counters (market) ---
  renderSuppliers() {
    const wrap = $("#suppliers"); wrap.innerHTML = "";
    const alive = this.competitors.filter((c) => !c.eliminated); // fixed order (joueur puis bots), indépendant de l'argent
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
    // customers who want this resource -> tap to open its codex page
    const actions = body.querySelector("#res-actions");
    const wanting = (this.cfg.customerOrder || []).filter((cid) => this.cfg.customerDefs[cid].needs.includes(rid));
    if (wanting.length) {
      actions.insertAdjacentElement("beforebegin", el("div", "cp-section", "Clients intéressés"));
      const cwrap = el("div", "res-custs");
      wanting.forEach((cid) => {
        const c = this.cfg.customerDefs[cid];
        const b = el("button", "res-cust");
        b.innerHTML = `<img src="${sprite(c.spriteId)}"><span>${cid.charAt(0).toUpperCase() + cid.slice(1)}</span>`;
        b.onclick = () => openCodexCustomer(cid);
        cwrap.appendChild(b);
      });
      actions.insertAdjacentElement("beforebegin", cwrap);
    }
    if (this.cfg.convert[rid]) {
      const btn = el("button", "cv-btn", "🔁 Raffiner");
      btn.onclick = () => { this.closeResourceInfo(); this.openConvert(rid); };
      actions.appendChild(btn);
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
      const ic = this.tierImg(rid, this.bestTier(c, rid) || 1); ic.className = "cp-inv-icon clickable"; ic.title = this.res(rid).displayName;
      ic.onclick = () => openCodexResource(rid);
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
    const stackFor = (rid, img, n) => {
      const stack = el("div", "cinv-stack");
      stack.append(img, el("span", null, n));
      stack.onclick = (e) => { e.stopPropagation(); openCodexResource(rid); };  // resource, not the seller
      return stack;
    };
    if (c.isPlayer) {
      this.cfg.resourceOrder.forEach((rid) => {
        const n = this.stockOf(this.player, rid); if (n <= 0) return;
        wrap.appendChild(stackFor(rid, this.tierImg(rid, this.bestTier(this.player, rid) || 1), n));
      });
    } else {
      this.cfg.resourceOrder.forEach((rid) => {
        const m = c.stock[rid] || {};
        Object.keys(m).map(Number).sort((a, b) => b - a).forEach((t) => {
          if (m[t] <= 0) return;
          wrap.appendChild(stackFor(rid, this.tierImg(rid, t), m[t]));
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
