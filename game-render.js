/* Market Ultimatum — game-render.js
 * All DOM rendering extracted from main.js. These stay methods on the Game
 * object (they use `this` for state + DOM, and are called as game.renderX()
 * from every module), reassembled via Object.assign(Game, renderMethods).
 */
"use strict";

import { $, el, sprite, openOverlay, chainOverscroll } from "./helpers.js";
import { S } from "./constants.js";
import { Meta } from "./meta.js";
import { openCharacterPanel, gearBadges } from "./menu.js";
import { openBuildingPanel } from "./building.js";
import { openResource } from "./resource.js";
import { freeWorkers, selectWorker, assignWorker, removeWorker, unassignWorker } from "./game-workers.js";
import { nextWorker, buyWorker, nextMkt, buyMkt, nextStorage, buyStorage, nextMachineLevel, upgradeMachine } from "./game-shop.js";
import { botBehavior } from "./game-bots.js";

export const renderMethods = {
  refreshHud() {
    this.player; $("#money").textContent = this.player.money;
    if (this.state === S.Play && this.waveActive) {
      $("#timer").textContent = "👥 " + (this.market ? this.market.remaining + this.market.active : 0);
      $("#hud-timer").classList.remove("urgent");
    } else if (this.state === S.Play) {
      const s = Math.max(0, Math.ceil(this.prepTimer)); $("#timer").textContent = s + "s";
      $("#hud-timer").classList.toggle("urgent", s <= 5);
    }
    this.refreshRankChip();
  },

  // HUD chip: live rank on cumulative revenue; pulses red while below the topX
  // objective. Tap -> standings overlay (openRankInfo).
  refreshRankChip() {
    const chip = $("#rank-chip"); if (!chip || !this.player) return;
    const rank = this.playerRank(), topX = this.levelCfg.topX || 1;
    const medal = ["🥇", "🥈", "🥉"][rank - 1] || "🏆";
    chip.textContent = `${medal} ${rank}ᵉ`;
    $("#hud-rank").classList.toggle("urgent", rank > topX);
  },

  // --- standings overlay (tap the HUD rank chip) ---
  openRankInfo() {
    if (!this.player) return;
    this._rankOpen = true; this._rankTimer = 0.3;
    this.renderRankInfo();
    $("#rankinfo-overlay").classList.remove("hidden");
  },
  closeRankInfo() { this._rankOpen = false; $("#rankinfo-overlay").classList.add("hidden"); },
  renderRankInfo() {
    const body = $("#rankinfo-body"); if (!body || !this.player) return;
    const topX = this.levelCfg.topX || 1;
    body.innerHTML = `<div class="rk-goal">🎯 Objectif : finir <b>top ${topX}</b> en revenus cumulés (round ${this.round}/${this.levelCfg.totalRounds})</div>`;
    const list = el("div", "rk-list");
    this.rankedByRevenue().forEach((c, i) => {
      const row = el("div", "result-row" + (c.isPlayer ? " me" : ""));
      row.innerHTML = `<span class="rank">${i + 1}</span><img src="${sprite(c.spriteId, c.spriteFolder)}"><span class="rname">${c.name}</span><span class="rmoney"><img src="${sprite("Coins", "UI")}">${c.revenue}</span>`;
      list.appendChild(row);
    });
    body.appendChild(list);
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
    const maxT = this.maxUnlockedTier(); // locked tier columns simply don't exist yet
    bar.style.setProperty("--tiers", maxT);

    const top = el("div", "inv-top");
    const cap = el("span", "inv-cap", ""); cap.id = "inv-cap";
    // One Merge entry point for the whole inventory (the old per-row 🔁 badge was
    // absolutely positioned outside its row and clipped on mobile). It glows via
    // refreshInventory() whenever at least one merge is currently possible.
    const merge = el("button", "inv-merge-btn", "🔁 Merge"); merge.id = "inv-merge";
    merge.onclick = () => this.openMerge();
    if (!Meta.featureUnlocked("merge")) merge.classList.add("hidden");
    top.append(el("span", "inv-top-label", "Inventaire"), merge, cap);
    bar.appendChild(top);

    const head = el("div", "inv-grid-head");
    head.appendChild(el("div", "inv-hcorner", ""));
    for (let t = 1; t <= maxT; t++) head.appendChild(el("div", "inv-hcell", "T" + t));
    bar.appendChild(head);

    const scroll = el("div", "inv-scroll");
    chainOverscroll(scroll);  // at the list's top/bottom, keep the swipe scrolling the page
    const producible = this.producibleResources();
    this.cfg.resourceOrder.forEach((rid) => {
      if (!producible.has(rid)) return;
      const row = el("div", "inv-row");
      const rowHead = el("div", "inv-row-head");
      const icon = this.tierImg(rid, this.bestTier(this.player, rid) || 1); icon.className = "inv-row-icon"; icon.title = this.res(rid).displayName;
      rowHead.appendChild(icon);
      rowHead.classList.add("clickable"); rowHead.title = this.res(rid).displayName;
      rowHead.onclick = () => openResource(rid, { player: this.player, allowRefine: true }); // resource widget (merge entry lives inside it)
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
    const maxT = this.maxUnlockedTier();
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
        // Show a row when the player holds stock OR a staffed machine produces it (so assigning
        // workers reveals the row right away). Vacant rows collapse (display:none); the reflow is
        // confined to the capped-height .inv-scroll box, so the machine list below never bumps.
        const vacant = this.stockOf(this.player, rid) <= 0 && !this.isStaffedFor(rid);
        this._invRow[rid].classList.toggle("inv-row-vacant", vacant);
      }
    });
    const tot = this.stockTotal(this.player), cap = this.player.storageCap;
    const c = $("#inv-cap"); if (c) { c.textContent = `${tot}/${cap}`; c.classList.toggle("full", tot >= cap); }
    const mb = $("#inv-merge"); if (mb) mb.classList.toggle("glow", this.cfg.resourceOrder.some((rid) => this.anyConvert(rid)));
    const mo = $("#merge-overlay"); // ?.-style guard: a stale cached index.html must not break the inventory loop
    if (mo && !mo.classList.contains("hidden")) this.renderMergeList();
    this._invDirty = false; // DOM now matches the model
  },

  // --- merge sheet (slides from the bottom edge) ---
  anyConvert(resId) { const r = this.cfg.convert[resId]; if (!r) return false; for (const t in r) if (this.canConvert(this.player, resId, +t)) return true; return false; },
  openMerge() {
    $("#automerge-box").checked = !!this.autoMerge;
    this._mergeSig = null;
    this.renderMergeList();
    openOverlay("merge-overlay");
    // .hidden is display:none — the slide transition needs one painted frame at
    // translateY(100%) before .open lands, or the sheet just pops in place.
    requestAnimationFrame(() => requestAnimationFrame(() => $("#merge-overlay").classList.add("open")));
  },
  closeMerge() {
    const o = $("#merge-overlay");
    o.classList.remove("open");                              // slide out…
    setTimeout(() => o.classList.add("hidden"), 240);        // …then release the backdrop
  },
  // Only the merges the player can DO right now — an empty list means nothing to
  // merge, not a wall of locked rows. Rebuilt only when its content actually
  // changes (signature), so buttons stay stable under the live 0.2s refresh and
  // a tap can never land on a freshly rebuilt row.
  renderMergeList() {
    const rows = [];
    this.cfg.resourceOrder.forEach((rid) => {
      const rules = this.cfg.convert[rid]; if (!rules) return;
      Object.keys(rules).map(Number).sort((a, b) => a - b).forEach((tier) => {
        if (this.canConvert(this.player, rid, tier)) rows.push({ rid, tier, rule: rules[tier], have: this.tierCount(this.player, rid, tier) });
      });
    });
    const sig = rows.map((r) => `${r.rid}_${r.tier}_${r.have}`).join("|");
    if (sig === this._mergeSig) return;
    this._mergeSig = sig;
    const list = $("#merge-list"); list.innerHTML = "";
    if (!rows.length) { list.appendChild(el("div", "merge-empty", "Rien à merger pour l'instant")); return; }
    rows.forEach(({ rid, tier, rule, have }) => {
      const row = el("div", "convert-row");
      const from = el("div", "cv-side");
      const fromImg = this.tierImg(rid, tier); fromImg.classList.add("clickable");
      fromImg.onclick = () => openResource(rid, { player: this.player, allowRefine: true });
      from.append(fromImg, el("span", "cv-q", `${rule.quantity}× T${tier}`));
      const to = el("div", "cv-side");
      const toImg = this.tierImg(rule.resultRes, rule.resultTier); toImg.classList.add("clickable");
      toImg.onclick = () => openResource(rule.resultRes, { player: this.player, allowRefine: true });
      to.append(toImg, el("span", "cv-q", `${rule.resultQty}× T${rule.resultTier}`));
      const haveEl = el("span", "cv-have", `tu as ${have}`);
      const btn = el("button", "cv-btn", "Merge");
      btn.onclick = () => { if (this.doConvert(rid, tier)) this.renderMergeList(); };
      row.append(from, el("span", "cv-arrow", "→"), to, haveEl, btn);
      list.appendChild(row);
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
    // Preview WHO joins next (Meta.recruitOrder), with its gear; generic
    // Worker once every owned character is already on the payroll.
    const nxId = Meta.nextRecruit(this.player.workers.map((x) => x.charId).filter(Boolean));
    const nch = nxId && this.cfg.characters[nxId];
    const ico = nch && nch.spriteId ? sprite(nch.spriteId, "Characters") : sprite("Worker", "UI");
    const label = nch
      ? `${nch.displayName}<span class="sb-gears">${gearBadges(nxId) || ""}</span>`
      : `Ouvrier ×${this.player.workers.length}`;
    mk(`<img src="${ico}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'">`, label, w ? "$" + w.price : "MAX", () => !w || this.player.workers.length >= this.cfg.g.maxWorkersTotal || this.player.money < w.price, () => buyWorker(this));
    // locked features are hidden completely, not greyed (feature_unlock)
    if (Meta.featureUnlocked("marketting")) {
      const mkt = nextMkt(this);
      mk("📣", `Mkt ${this.player.marketing.toFixed(1)}`, mkt ? "$" + mkt.price : "MAX", () => !mkt || this.player.money < mkt.price, () => buyMkt(this));
    }
    if (Meta.featureUnlocked("storage")) {
      const st = nextStorage(this);
      mk("📦", `Stock ${this.player.storageCap}`, st ? "$" + st.price : "MAX", () => !st || this.player.money < st.price, () => buyStorage(this));
    }
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

  // --- game speed (HUD ×1/×2/×4 toggle, gated by feature_unlock) ---
  availableSpeeds() {
    const s = [1];
    if (Meta.featureUnlocked("x2_button")) s.push(2);
    if (Meta.featureUnlocked("x4_button")) s.push(4);
    return s;
  },
  refreshSpeedBtn() {
    const sel = $("#speed-sel"); if (!sel) return;
    const speeds = this.availableSpeeds();
    // locked speeds stay VISIBLE but greyed; the current one is highlighted
    sel.querySelectorAll("button[data-speed]").forEach((b) => {
      const v = +b.dataset.speed;
      const open = speeds.includes(v);
      b.classList.toggle("locked", !open);
      b.disabled = !open;
      b.classList.toggle("active", this.timeScale === v);
    });
  },
  setGameSpeed(v) {
    if (!this.availableSpeeds().includes(v)) return;   // still locked
    this.timeScale = v;
    this.refreshSpeedBtn();
  },

  // --- machines ---
  renderMachines() { const list = $("#machine-list"); list.innerHTML = ""; this.player.machines.forEach((m) => { m._node = this.buildMachine(m); list.appendChild(m._node); }); },
  buildMachine(m) {
    const def = this.machineDef(m.id);
    const node = el("div", "machine");
    const icon = el("img", "machine-icon"); icon.src = sprite(def.spriteId, "Machines");
    const name = el("div", "machine-name");
    const recipe = el("div", "machine-recipe", this.recipeHtml(def));
    const footer = el("div", "machine-footer");
    const slots = el("div", "worker-slots"); footer.appendChild(slots);
    const btns = el("div", "machine-buttons");
    const rm = el("button", "ghost", "−"), ad = el("button", null, "+"), up = el("button", "upgrade");
    if (!Meta.featureUnlocked("upgrade_machine")) up.classList.add("hidden");
    btns.append(rm, ad, up); footer.appendChild(btns);
    const prog = el("div", "progress"); prog.appendChild(el("div"));
    node.append(icon, name, recipe, footer, prog);
    rm.onclick = (e) => { e.stopPropagation(); removeWorker(this, m); };
    ad.onclick = (e) => { e.stopPropagation(); assignWorker(this, m); };
    up.onclick = (e) => { e.stopPropagation(); upgradeMachine(this, m); };
    node.onclick = () => { if (this.selectedWorker) assignWorker(this, m); };
    // tap the building sprite -> its detail widget (unless assigning a worker)
    icon.style.cursor = "pointer";
    icon.onclick = (e) => { if (this.selectedWorker) return; e.stopPropagation(); openBuildingPanel(m.id, { level: m.level }); };
    // tap an ingredient/output icon in the recipe -> its codex page
    recipe.addEventListener("click", (e) => { const img = e.target.closest("img[data-res]"); if (img) { e.stopPropagation(); openResource(img.dataset.res); } });
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
    const hint = $("#worker-hint");
    hint.textContent = this.selectedWorker ? "Touche une machine (+)" : "";
    hint.classList.toggle("active", !!this.selectedWorker);
    this.player.machines.forEach((m) => { if (m._node) this.updateMachine(m, m._node); });
    this.renderShop();
  },

  // One worker chip: avatar + (for characters) name, gear badges and level ring.
  // Tap: character -> detail panel; generic free -> arm for tap-assign; generic
  // assigned -> back to the pool. Drag & drop works for every chip.
  workerChip(w) {
    const isChar = !!w.charId;
    const ch = isChar ? this.cfg.characters[w.charId] : null;
    const src = ch && ch.spriteId ? sprite(ch.spriteId, "Characters") : sprite("Worker", "UI");
    const chip = el("div", "wchip" + (isChar ? " char" : "") + (this.selectedWorker === w ? " selected" : "") + (w.machineId ? " onmachine" : ""));
    // No name/level on the chip (they clipped on mobile): avatar + gear row,
    // details live in the character panel (tap).
    chip.innerHTML =
      `<span class="wava"><img src="${src}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'" draggable="false"></span>` +
      (isChar ? `<span class="wgears">${gearBadges(w.charId)}</span>` : "");
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
    // fixed order (joueur puis bots), indépendant de l'argent
    this.competitors.forEach((c) => {
      const s = el("div", "counter" + (c.isPlayer ? " me" : "")); c._counter = s;
      s.innerHTML = `<img class="counter-avatar" src="${sprite(c.spriteId, c.spriteFolder)}"><div class="counter-name">${c.name}</div><div class="counter-money"><img src="${sprite("Coins", "UI")}"><span class="cmoney">${c.money}</span></div><div class="counter-mkt">📣${c.marketing.toFixed(1)}</div><div class="counter-inv"></div>`;
      c._moneyRef = s.querySelector(".cmoney");
      c._invRef = s.querySelector(".counter-inv");
      chainOverscroll(c._invRef);  // at the stack's top/bottom, keep the swipe scrolling the page
      this.renderCounterInv(c);
      s.onclick = () => this.openCompetitor(c);
      wrap.appendChild(s);
    });
  },

  // --- competitor info widget ---
  openCompetitor(c) { this._infoC = c; this.renderCompetitorPanel(); openOverlay("competitor-overlay"); },
  closeCompetitor() { this._infoC = null; $("#competitor-overlay").classList.add("hidden"); },

  botSpecialty(c) {
    const w = botBehavior(c, this.round); // per-wave weights: the specialty can shift as the market pivots
    let best = null, bw = -1;
    this.cfg.resourceOrder.forEach((r) => { const x = w[r] || 0; if (x > bw) { bw = x; best = r; } });
    return best && bw > 0 ? "Spécialité : " + this.res(best).displayName : "";
  },
  renderCompetitorPanel() {
    const c = this._infoC; if (!c) return;
    const body = $("#competitor-body");
    const tag = (c.def && c.def.tag) || c.id;
    // Le bot tourne sur ton économie : ce qui le décrit, ce sont ses ouvriers et
    // ses machines staffées, comme toi. Voir game-bots.js.
    const crew = c.isPlayer ? null : c.workers.filter((w) => w.machineId).length + "/" + c.workers.length;
    const spec = c.isPlayer ? "" : this.botSpecialty(c);
    body.innerHTML =
      `<div class="cp-head">
        <img class="cp-skin" src="${sprite(c.spriteId, c.spriteFolder)}">
        <div class="cp-id">
          <div class="cp-name">${c.name}</div>
          <div class="cp-tags"><span class="cp-tag">@${tag}</span>${spec ? `<span class="cp-spec">${spec}</span>` : ""}</div>
        </div>
      </div>
      <div class="cp-stats">
        <div class="cp-stat"><span>Argent</span><b>${c.money}</b></div>
        <div class="cp-stat"><span>Marketing</span><b>${c.marketing.toFixed(1)}</b></div>
        <div class="cp-stat"><span>Stockage</span><b>${this.stockTotal(c)}/${c.storageCap}</b></div>
        ${crew != null ? `<div class="cp-stat"><span>Ouvriers postés</span><b>${crew}</b></div>` : ""}
      </div>
      <div class="cp-section">Améliorations</div>
      <div class="cp-upg">
        <span>👷 Ouvriers : <b>${c.buys.increaseWorker}</b></span>
        <span>📣 Marketing : <b>${c.buys.increaseMarketting}</b></span>
        <span>📦 Stockage : <b>${c.buys.increaseStorage}</b></span>
      </div>
      <div class="cp-section">Inventaire</div>
      <div class="cp-inv"></div>`;
    const inv = body.querySelector(".cp-inv");
    const maxT = this.cfg.maxTier; let any = false;
    this.cfg.resourceOrder.forEach((rid) => {
      if (this.stockOf(c, rid) <= 0) return; any = true;
      const row = el("div", "cp-inv-row");
      const ic = this.tierImg(rid, this.bestTier(c, rid) || 1); ic.className = "cp-inv-icon clickable"; ic.title = this.res(rid).displayName;
      ic.onclick = () => openResource(rid);
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
      stack.onclick = (e) => { e.stopPropagation(); openResource(rid); };  // resource, not the seller
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
      if (!c._counter) return;
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
      const coin = el("img", "coin-particle"); coin.src = sprite("Coins", "UI");
      coin.style.setProperty("--dx", Math.round(Math.random() * 80 - 40) + "px");
      coin.style.setProperty("--dy", Math.round(-32 - Math.random() * 40) + "px");
      coin.style.animationDelay = (Math.random() * 0.1).toFixed(2) + "s";
      s.appendChild(coin);
      setTimeout(() => coin.remove(), 850);
    }
  },

  // --- market-share donut (end-of-round results) ---
  // Colors are FIXED per competitor (lineup order), validated for CVD + contrast
  // against the dark panel (dataviz six-checks). "Perdu" is the unserved demand —
  // deliberately a neutral gray (it is nobody's share), relieved by the legend
  // label + hatched chip since it sits below 3:1 on this surface.
  renderMarketPie() {
    const wrap = $("#results-market"); if (!wrap) return;
    wrap.innerHTML = "";
    const mkt = this.market || {};
    const money = this._pieMode === "money"; // le booléen : volume (ventes) ou argent
    const val = (c) => (money ? c.salesThisRound : c.unitsThisRound) || 0;
    const lost = (money ? mkt.lostValue : mkt.lostUnits) || 0;

    const PIE_COLORS = ["#b8841f", "#279a86", "#8a6fe3", "#bf5f96"];
    const segs = [];
    this.competitors.forEach((c, i) => {
      const v = val(c);
      if (v > 0 || c.isPlayer) segs.push({ name: c.name, v, color: PIE_COLORS[i % PIE_COLORS.length] });
    });
    // Toujours listé, même à 0 : « Perdu ×0 » dit explicitement qu'aucun client
    // n'est reparti bredouille — l'absence de ligne ressemblait à un oubli.
    segs.push({ name: "Perdu", v: lost, color: "#6b7387", lost: true });
    const total = segs.reduce((s, x) => s + x.v, 0);

    // segmented toggle Ventes | Argent
    const seg = el("div", "pie-toggle");
    [["sales", "Ventes"], ["money", "Argent"]].forEach(([mode, label]) => {
      const b = el("button", "pie-mode" + ((this._pieMode === "money") === (mode === "money") ? " on" : ""), label);
      b.onclick = () => { this._pieMode = mode; this.renderMarketPie(); };
      seg.appendChild(b);
    });
    wrap.appendChild(seg);
    if (!total) { wrap.appendChild(el("div", "pie-empty", "Aucun client servi ce round")); return; }

    // donut: conic-gradient with a 2px-equivalent surface gap between slices
    const GAP = segs.length > 1 ? 0.8 : 0;
    let stops = [], acc = 0;
    segs.forEach((s) => {
      const pct = (s.v / total) * 100, span = Math.max(0, pct - GAP);
      stops.push(`${s.color} ${acc.toFixed(2)}% ${(acc + span).toFixed(2)}%`);
      if (GAP) stops.push(`var(--bg-panel) ${(acc + span).toFixed(2)}% ${(acc + pct).toFixed(2)}%`);
      acc += pct;
    });
    const box = el("div", "pie-box");
    const pie = el("div", "pie-donut");
    pie.style.background = `conic-gradient(${stops.join(",")})`;
    pie.appendChild(el("div", "pie-hole", money ? total + "$" : "×" + total));
    const legend = el("div", "pie-legend");
    segs.forEach((s) => {
      const row = el("div", "pie-leg-row");
      const chip = el("span", "pie-chip" + (s.lost ? " lost" : ""));
      if (!s.lost) chip.style.background = s.color;
      row.append(chip, el("span", "pie-leg-name", s.name),
        el("b", "pie-leg-val", money ? s.v + "$" : "×" + s.v),
        el("span", "pie-leg-pct", Math.round((s.v / total) * 100) + "%"));
      legend.appendChild(row);
    });
    box.append(pie, legend);
    wrap.appendChild(box);
  },

  renderResults(ranked) {
    // Before end_of_round_summary unlocks: a minimal screen — your own revenue,
    // no standings, no market pie.
    if (!Meta.featureUnlocked("end_of_round_summary")) {
      $("#results-market").innerHTML = "";
      const list = $("#results-list"); list.innerHTML = "";
      const me = this.player;
      const row = el("div", "result-row me");
      row.innerHTML = `<img src="${sprite(me.spriteId, me.spriteFolder)}"><span class="rname">${me.name}</span><span class="rmoney"><img src="${sprite("Coins", "UI")}">${me.revenue}</span>`;
      list.appendChild(row);
      $("#results-title").textContent = `Round ${this.round} terminé`;
      $("#results-overlay").classList.remove("hidden");
      return;
    }
    this.renderMarketPie();
    const list = $("#results-list"); list.innerHTML = "";
    // Classement aux revenus cumulés — la seule valeur affichée est celle qui décide la victoire.
    ranked.forEach((c, i) => {
      const row = el("div", "result-row" + (c.isPlayer ? " me" : ""));
      row.innerHTML = `<span class="rank">${i + 1}</span><img src="${sprite(c.spriteId, c.spriteFolder)}"><span class="rname">${c.name}</span><span class="rmoney"><img src="${sprite("Coins", "UI")}">${c.revenue}</span>`;
      list.appendChild(row);
    });
    $("#results-title").textContent = `Round ${this.round} — classement`;
    $("#results-overlay").classList.remove("hidden");
  },
};
