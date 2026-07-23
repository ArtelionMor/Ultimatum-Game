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
      // remaining = pas encore tirés, pending = paquet en cours d'égrenage, active = en train de tomber
      $("#timer").textContent = "👥 " + (this.market ? this.market.remaining + (this.market.pending || 0) + this.market.active : 0);
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

  // --- inventory: one tile per stored UNIT, background = its tier's color
  // (cfg.tierColors, sheet tab ressources_tier). "7/20" in the header is the
  // storage cap — the tile count IS the stock, no per-cell numbers anymore.
  renderInventory() {
    const bar = $("#inventory-bar"); bar.innerHTML = "";
    const top = el("div", "inv-top");
    const cap = el("span", "inv-cap", ""); cap.id = "inv-cap";
    // One Merge entry point for the whole inventory. It glows via
    // refreshInventory() whenever at least one merge is currently possible.
    const merge = el("button", "inv-merge-btn", "🔁 Merge"); merge.id = "inv-merge";
    merge.onclick = () => this.openMerge();
    if (!Meta.featureUnlocked("merge")) merge.classList.add("hidden");
    top.append(el("span", "inv-top-label", "Inventaire"), merge, cap);
    bar.appendChild(top);

    const scroll = el("div", "inv-scroll");
    chainOverscroll(scroll);  // at the list's top/bottom, keep the swipe scrolling the page
    this._invTiles = el("div", "inv-tiles");
    scroll.appendChild(this._invTiles);
    bar.appendChild(scroll);
    this._invSig = null;      // force the first tile build
    this.refreshInventory();
  },
  refreshInventory() {
    if (!this._invTiles) return;
    const p = this.player;
    // Rebuild only when the stock actually changed (the refresh runs every flush).
    const parts = [];
    this.cfg.resourceOrder.forEach((rid) => {
      const m = p.stock[rid] || {};
      Object.keys(m).map(Number).sort((a, b) => a - b).forEach((t) => { if (m[t] > 0) parts.push(rid + ":" + t + ":" + m[t]); });
    });
    const sig = parts.join("|");
    if (sig !== this._invSig) {
      this._invSig = sig;
      this._invTiles.innerHTML = "";
      this.cfg.resourceOrder.forEach((rid) => {
        const m = p.stock[rid] || {};
        Object.keys(m).map(Number).sort((a, b) => a - b).forEach((t) => {
          for (let i = 0; i < m[t]; i++) {
            const tile = el("div", "inv-unit");
            tile.dataset.tier = t;   // tutorial target [ressource_tierN]
            tile.style.background = this.tierColor(t);
            tile.title = `${this.res(rid).displayName} — Tier ${t}`;
            tile.appendChild(this.tierImg(rid, t));
            tile.onclick = () => openResource(rid, { player: p, allowRefine: true }); // resource widget (merge entry lives inside it)
            this._invTiles.appendChild(tile);
          }
        });
      });
      if (!this._invTiles.children.length) this._invTiles.appendChild(el("div", "inv-empty", "vide"));
    }
    const tot = this.stockTotal(p), cap = p.storageCap;
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
    // `tut` names the button for the tutorial overlay (feature_unlock targets).
    const mk = (icon, label, val, disFn, fn, tut) => {
      const b = el("button", "shop-btn");
      b.innerHTML = `<span class="si">${icon}</span><span>${label}</span><b>${val}</b>`;
      if (tut) b.dataset.tut = tut;
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
    mk(`<img src="${ico}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'">`, label, w ? "$" + w.price : "MAX", () => !w || this.player.workers.length >= this.cfg.g.maxWorkersTotal || this.player.money < w.price, () => buyWorker(this), "buy_a_worker");
    // locked features are hidden completely, not greyed (feature_unlock)
    if (Meta.featureUnlocked("marketting")) {
      const mkt = nextMkt(this);
      mk("📣", `Mkt ${this.player.marketing.toFixed(1)}`, mkt ? "$" + mkt.price : "MAX", () => !mkt || this.player.money < mkt.price, () => buyMkt(this), "marketting");
    }
    if (Meta.featureUnlocked("storage")) {
      const st = nextStorage(this);
      mk("📦", `Stock ${this.player.storageCap}`, st ? "$" + st.price : "MAX", () => !st || this.player.money < st.price, () => buyStorage(this), "storage");
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
    const timer = el("span", "machine-timer", ""); footer.appendChild(timer); // décompte de production (setProgress)
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
    m._refs = { name, slots, ad, rm, up, timer }; this.updateMachine(m, node); return node;
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
  // secs (optionnel) = temps restant avant le prochain spawn — affiché au centre
  // du footer de la carte ; vide quand la machine ne tourne pas.
  setProgress(m, ratio, secs) {
    if (!m._node) return;
    m._node.querySelector(".progress > div").style.width = (ratio * 100) + "%";
    const t = m._refs && m._refs.timer;
    if (t) {
      const txt = secs != null ? secs.toFixed(1) + "s" : "";
      if (t.textContent !== txt) t.textContent = txt;
    }
  },

  // --- workers (bar + chips + drag & drop) ---
  renderWorkers() {
    const wrap = $("#worker-icons"); wrap.innerHTML = "";
    freeWorkers(this.player).forEach((w) => wrap.appendChild(this.workerChip(w)));
    const hint = $("#worker-hint");
    hint.textContent = this.selectedWorker ? "Touche une machine (+)" : "";
    hint.classList.toggle("active", !!this.selectedWorker);
    this.updateBench(document.body.classList.contains("dragging-worker"));
    this.player.machines.forEach((m) => { if (m._node) this.updateMachine(m, m._node); });
    this.renderShop();
  },

  // Le banc (la « réserve » d'ouvriers) ne s'affiche que s'il y a quelqu'un à
  // assigner : tous les ouvriers postés, il ne restait qu'une barre vide qui mangeait
  // ~86 px de haut en permanence.
  // EXCEPTION pendant un drag : il doit rester la cible du geste « renvoyer l'ouvrier
  // au banc ». Il revient alors EN SURIMPRESSION (.as-drop, position: fixed) et non
  // dans le flux — sinon la mise en page se redistribuerait sous le doigt en plein
  // glissement, déplaçant les machines que le joueur vise.
  updateBench(dragging) {
    const bar = $("#worker-bar"); if (!bar || !this.player) return;
    const has = freeWorkers(this.player).length > 0;
    const asDrop = !has && !!dragging;
    bar.style.display = has || asDrop ? "flex" : "none";
    bar.classList.toggle("as-drop", asDrop);
    if (asDrop) { const h = $("#worker-hint"); h.textContent = "Relâche ici pour retirer l'ouvrier"; h.classList.add("active"); }
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
          this.updateBench(true);   // banc masqué (aucun libre) : il revient en surimpression comme cible de retrait
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
        this.updateBench(false);   // drop dans le vide : le banc de secours se retire aussi
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  },
  dropTargetAt(ev) {
    // Skip the tutorial layer: while a black_mask teaches the drag, its shields
    // sit on top of the board and elementFromPoint would only ever see them, so
    // every drop would silently do nothing.
    const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => !n.closest("#tut-layer"));
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
      // Deux étages bien distincts : le COMPTOIR (commandes réservées, en attente de
      // leur client) au-dessus, la RÉSERVE (le stock dormant) en dessous.
      s.innerHTML = `<img class="counter-avatar" src="${sprite(c.spriteId, c.spriteFolder)}"><div class="counter-name">${c.name}</div><div class="counter-money"><img src="${sprite("Coins", "UI")}"><span class="cmoney">${c.money}</span></div><div class="counter-mkt">📣${c.marketing.toFixed(1)}</div><div class="counter-desk"></div><div class="counter-inv"></div>`;
      c._moneyRef = s.querySelector(".cmoney");
      c._deskRef = s.querySelector(".counter-desk");
      c._invRef = s.querySelector(".counter-inv");
      chainOverscroll(c._invRef);  // at the stack's top/bottom, keep the swipe scrolling the page
      this.renderCounterInv(c);
      this.renderCounterDesk(c);   // repose les commandes en attente si le comptoir est reconstruit
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
      stack.dataset.res = rid;   // point de départ du vol réserve -> comptoir (reserveRect)
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
    if (!wrap.children.length) wrap.appendChild(el("span", "cinv-empty", "réserve vide")); // nomme l'étage du bas (cf. .counter-desk:empty)
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
  // --- comptoir : la marchandise réservée attend son client ---------------------
  // Cycle de vie d'une unité vendue :
  //   réserve (c.stock) --putOnCounter--> comptoir (c.counterItems) --takeFromCounter--> client
  // Le stock est décrémenté dès la réservation (game-customers.reserveSale), mais
  // l'objet reste À L'ÉCRAN sur le comptoir : on voit ce qui est déjà promis, et le
  // client repart visiblement avec. Avant, la marchandise s'évaporait à l'apparition.

  // Rectangle de départ du vol : la pile de la réserve pour cette ressource si elle
  // est encore affichée (la réserve n'est repeinte que toutes les 0,2 s), sinon la
  // zone réserve entière.
  reserveRect(c, resId) {
    const wrap = c._invRef; if (!wrap || !wrap.isConnected) return null;
    const stack = wrap.querySelector(`.cinv-stack[data-res="${resId}"]`);
    const r = (stack || wrap).getBoundingClientRect();
    return r.width ? r : null;
  },

  // Un objet qui glisse d'un point à l'autre (lerp CSS : translate interpolé par la
  // transition). `fade` = il se fond à l'arrivée (le client l'emporte).
  flyItem(resId, tier, from, to, ms, fade, done) {
    const fly = this.tierImg(resId, tier); fly.className = "fly-res fly-desk";
    document.body.appendChild(fly);
    const S = 26;
    const x0 = from.left + from.width / 2 - S / 2, y0 = from.top + from.height / 2 - S / 2;
    fly.style.left = x0 + "px"; fly.style.top = y0 + "px";
    fly.style.transitionDuration = ms + "ms";
    const dx = to.left + to.width / 2 - (x0 + S / 2), dy = to.top + to.height / 2 - (y0 + S / 2);
    requestAnimationFrame(() => {
      fly.style.transform = `translate(${dx}px,${dy}px) scale(${fade ? 1.15 : 1})`;
      if (fade) fly.style.opacity = "0";
    });
    setTimeout(() => { fly.remove(); if (done) done(); }, ms + 30);
  },

  // Pose les unités vendues sur le comptoir. Le chip est créé tout de suite (il donne
  // sa place EXACTE au vol) mais reste invisible tant que la marchandise n'est pas
  // arrivée : pas de doublon à l'écran pendant le trajet.
  putOnCounter(c, sale) {
    c.counterItems = c.counterItems || [];
    sale.items = sale.tiers.map((t) => ({ resId: sale.resId, tier: t }));
    if (!sale.items.length) return;
    c.counterItems.push(...sale.items);
    this.renderCounterDesk(c, sale.items);
  },

  // (Re)construit le comptoir : chaque item du modèle qui n'a pas (ou plus) de chip
  // à l'écran en reçoit un. `flying` = ceux qui doivent arriver en volant.
  renderCounterDesk(c, flying) {
    const desk = c._deskRef; if (!desk) return;
    const items = c.counterItems || [];
    desk.style.setProperty("--chip", items.length > 5 ? "15px" : items.length > 2 ? "19px" : "26px");
    items.forEach((it) => {
      if (it._chip && it._chip.isConnected) return;
      const chip = el("div", "desk-chip");
      chip.appendChild(this.tierImg(it.resId, it.tier));
      chip.onclick = (e) => { e.stopPropagation(); openResource(it.resId); }; // comme les piles de la réserve
      desk.appendChild(chip);
      it._chip = chip;
      if (!flying || !flying.includes(it)) return;
      const from = this.reserveRect(c, it.resId), to = chip.getBoundingClientRect();
      if (!from || !to.width) return;                      // comptoir hors écran : pose sèche
      chip.classList.add("landing");                       // caché le temps du trajet
      this.flyItem(it.resId, it.tier, from, to, 420, false, () => {
        chip.classList.remove("landing"); chip.classList.add("pop");
      });
    });
  },

  // Le client est arrivé : il emporte sa commande (vol comptoir -> client, fondu).
  takeFromCounter(c, sale, custEl) {
    const items = sale.items || []; sale.items = null;
    if (!items.length) return;
    c.counterItems = (c.counterItems || []).filter((it) => !items.includes(it));
    const target = custEl && custEl.querySelector(".cust-sprite");
    const to = target && target.isConnected ? target.getBoundingClientRect() : null;
    items.forEach((it) => {
      const chip = it._chip; it._chip = null;
      if (!chip || !chip.isConnected) return;
      const from = chip.getBoundingClientRect();
      const landing = chip.classList.contains("landing");  // pas encore arrivé : rien à faire voler
      chip.remove();
      if (to && from.width && !landing) this.flyItem(it.resId, it.tier, from, to, 340, true);
    });
    this.renderCounterDesk(c);   // ré-échelonne les chips restants
  },

  // Fin/début de vague : plus aucune commande en attente (les clients ont tous été
  // servis ou perdus). Évite qu'un chip fantôme survive à la reconstruction du marché.
  clearCounters() {
    this.competitors.forEach((c) => {
      (c.counterItems || []).forEach((it) => { if (it._chip) it._chip.remove(); it._chip = null; });
      c.counterItems = [];
      if (c._deskRef) c._deskRef.innerHTML = "";
    });
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
      if (mode === "money") b.dataset.tut = "results_money_toggle"; // end_of_round_summary red dot
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
    // Le classement (objectif + qui est devant) se montre TOUJOURS — savoir où on
    // en est fait partie du cœur du jeu. Ce que end_of_round_summary déverrouille,
    // c'est le détail marché (camembert ventes/argent).
    const full = Meta.featureUnlocked("end_of_round_summary");
    if (full) this.renderMarketPie(); else $("#results-market").innerHTML = "";
    const list = $("#results-list"); list.innerHTML = "";
    const topX = this.levelCfg.topX || 1;
    list.appendChild(el("div", "rk-goal", `🎯 Objectif : finir <b>top ${topX}</b> en revenus cumulés`));
    // Classement aux revenus cumulés — la seule valeur affichée est celle qui décide la victoire.
    ranked.forEach((c, i) => {
      const row = el("div", "result-row" + (c.isPlayer ? " me" : ""));
      row.innerHTML = `<span class="rank">${i + 1}</span><img src="${sprite(c.spriteId, c.spriteFolder)}"><span class="rname">${c.name}</span><span class="rmoney"><img src="${sprite("Coins", "UI")}">${c.revenue}</span>`;
      list.appendChild(row);
    });
    $("#results-title").textContent = full ? `Round ${this.round} — classement` : `Round ${this.round} terminé`;
    $("#results-overlay").classList.remove("hidden");
  },
};
