/* Market Ultimatum — game-render.js
 * All DOM rendering extracted from main.js. These stay methods on the Game
 * object (they use `this` for state + DOM, and are called as game.renderX()
 * from every module), reassembled via Object.assign(Game, renderMethods).
 */
"use strict";

import { $, el, sprite, openOverlay } from "./helpers.js";
import { S } from "./constants.js";
import { Meta } from "./meta.js";
import { openCharacterPanel, gearBadges } from "./menu.js";
import { openBuildingPanel } from "./building.js";
import { openResource } from "./resource.js";
import { nextMkt, buyMkt, nextStorage, buyStorage, nextMachineLevel, upgradeMachine } from "./game-shop.js";
import { botBehavior } from "./game-bots.js";
import { expectedShares, captureCustomer } from "./game-customers.js";

// Couleur FIXE par concurrent (ordre du lineup) — la même partout : camembert de
// fin de round, rabatteurs dans la rue. C'est elle qui permet de lire « ce
// bonhomme travaille pour Woof Inc » au milieu de la mêlée.
export const COMP_COLORS = ["#f4b942", "#279a86", "#8a6fe3", "#bf5f96"];

// Rythme des rabatteurs (tickHawkers). Les délais de trajet découlent de la
// vitesse (px/s), donc un grand écran = trajets plus longs, cohérent. Volontairement
// LENTS : la course vers le client doit être une vraie course contre sa chute vers
// le comptoir — c'est là qu'est l'enjeu (intercepter à temps, ou pas).
const HAWK_SPEED = 38;          // balade
const HAWK_RUN_SPEED = 75;      // course vers un client à livrer (la tension : ~la moitié d'avant)
const HAWK_HOME_SPEED = 70;     // retour à la base

export const renderMethods = {
  compColor(c) { const i = this.competitors.indexOf(c); return COMP_COLORS[(i < 0 ? 0 : i) % COMP_COLORS.length]; },
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
  // Bande compacte, toujours à l'écran dans la barre du bas : [ INVENTAIRE / 📦x/y ]
  // à gauche, tuiles qui défilent LATÉRALEMENT au centre, bouton Merge à droite.
  renderInventory() {
    const bar = $("#inventory-bar"); bar.innerHTML = "";
    const head = el("div", "inv-top");
    const cap = el("span", "inv-cap", ""); cap.id = "inv-cap";
    head.append(el("span", "inv-top-label", "Inventaire"), cap);
    bar.appendChild(head);

    const scroll = el("div", "inv-scroll");
    this._invTiles = el("div", "inv-tiles");
    scroll.appendChild(this._invTiles);
    bar.appendChild(scroll);

    // One Merge entry point for the whole inventory. It glows via
    // refreshInventory() whenever at least one merge is currently possible.
    const merge = el("button", "inv-merge-btn", "🔁"); merge.id = "inv-merge";
    merge.title = "Merge : combiner des ressources";
    merge.onclick = () => this.openMerge();
    if (!Meta.featureUnlocked("merge")) merge.classList.add("hidden");
    bar.appendChild(merge);

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
    this.refreshStockBtn();
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
    // Plus d'achat d'ouvriers (rework rabatteur : les équipes sont fixes) — la
    // boutique ne vend plus que du marketing et du stockage.
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
    // La boutique est derrière un bouton : sans cette pastille, l'argent dort et
    // rien à l'écran ne rappelle qu'un achat est possible.
    const bb = $("#boutique-btn");
    if (bb && this._shopBtns) bb.classList.toggle("glow", this._shopBtns.some(({ disFn }) => !disFn()));
  },

  // --- bottom sheets : Boutique (achats) & Stock (inventaire) ---
  // Même patron que la sheet de merge : .hidden est display:none, il faut une
  // frame peinte à translateY(100%) avant .open pour que la glissade joue.
  _openSheet(id) {
    openOverlay(id);
    requestAnimationFrame(() => requestAnimationFrame(() => $("#" + id).classList.add("open")));
  },
  _closeSheet(id) {
    const o = $("#" + id);
    o.classList.remove("open");
    setTimeout(() => o.classList.add("hidden"), 240);
  },
  openBoutique() { this.renderShop(); this.refreshAffordability(); this._openSheet("boutique-overlay"); },
  closeBoutique() { this._closeSheet("boutique-overlay"); },
  // L'inventaire est désormais une bande TOUJOURS à l'écran (barre du bas) : plus de
  // sheet Stock. _invVisible reste vrai pendant toute la partie (posé dans enterPlay)
  // pour que la boucle 0.2 s écrive les tuiles en direct (maybeRefreshInventory).
  refreshStockBtn() {},   // conservé (appelé par refreshInventory / la boucle) — le
                          // compteur vit maintenant dans la bande (#inv-cap).

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

  // --- machines : carrousel horizontal + pastilles d'état ---
  renderMachines() {
    const list = $("#machine-list"); list.innerHTML = "";
    this.player.machines.forEach((m) => { m._node = this.buildMachine(m); list.appendChild(m._node); });
    this.renderMachineDots();
    // La pastille active suit le doigt : recalculée au scroll (léger — quelques
    // classes), pas seulement sur le tick 0.2 s.
    if (!list._snapWired) { list._snapWired = true; list.addEventListener("scroll", () => this.refreshMachineDots(), { passive: true }); }
  },
  // Une pastille par machine : la vue d'ensemble que le carrousel fait perdre.
  // Couleur = état (verte produit, rouge à l'arrêt faute d'ouvriers) ; tap = le
  // carrousel s'aimante dessus — ou, un ouvrier étant sélectionné, l'y assigne
  // directement (la pastille est une cible au même titre que la carte).
  renderMachineDots() {
    const wrap = $("#machine-dots"); if (!wrap) return;
    wrap.innerHTML = "";
    this._mdots = this.player.machines.map((m, i) => {
      const d = el("button", "mdot");
      d.dataset.mi = i;
      d.title = this.machineDef(m.id).displayName;
      d.onclick = () => { if (m._node) m._node.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }); };
      wrap.appendChild(d);
      return d;
    });
    this.refreshMachineDots();
  },
  refreshMachineDots() {
    if (!this._mdots || !this.player || this._mdots.length !== this.player.machines.length) return;
    const list = $("#machine-list");
    let active = 0;
    if (list) {
      const mid = list.scrollLeft + list.clientWidth / 2;
      let best = Infinity;
      this.player.machines.forEach((m, i) => {
        if (!m._node) return;
        const c = m._node.offsetLeft + m._node.offsetWidth / 2;
        const dist = Math.abs(c - mid);
        if (dist < best) { best = dist; active = i; }
      });
    }
    this.player.machines.forEach((m, i) => {
      const d = this._mdots[i];
      d.classList.toggle("active", i === active);
      d.classList.toggle("producing", !!m.producing);
      d.classList.toggle("selling", this.machineSells(m));
    });
    // Focus visuel : la machine active du carrousel définit LA ressource dont on
    // parle — les clients qui veulent autre chose s'estompent dans la rue. La
    // carte (icône + % de part) et la rue racontent alors le même produit.
    const am = this.player.machines[active];
    const focusRes = am ? this.machineDef(am.id).outputs : null;
    if (focusRes !== this._focusRes) {
      this._focusRes = focusRes;
      document.querySelectorAll("#customer-lane .customer").forEach((n) => n.classList.toggle("dim", !!focusRes && n.dataset.res !== focusRes));
    }
  },
  // Les clients apparus APRÈS le dernier changement de focus prennent leur état en
  // naissant (appelé de spawnCustomer via refreshSuppliers ? non : tick 0.2 s).
  refreshCustomerDim() {
    if (this._focusRes == null) return;
    document.querySelectorAll("#customer-lane .customer:not(.toShop):not(.done)").forEach((n) => n.classList.toggle("dim", n.dataset.res !== this._focusRes));
  },
  buildMachine(m) {
    const def = this.machineDef(m.id);
    const node = el("div", "machine");
    const icon = el("img", "machine-icon"); icon.src = sprite(def.spriteId, "Machines");
    const name = el("div", "machine-name");
    const recipe = el("div", "machine-recipe", this.recipeHtml(def));
    const footer = el("div", "machine-footer");
    // LE verbe du joueur : la posture de CHAQUE ouvrier. Plus de switch global —
    // chaque ouvrier porte SON propre sélecteur Produit / Rabatteur (updateMachine).
    const slots = el("div", "worker-slots"); footer.appendChild(slots);
    // Ligne du bas : décompte de production (setProgress) + upgrade de la machine.
    const bottom = el("div", "machine-footer-bottom");
    const timer = el("span", "machine-timer", "");
    const btns = el("div", "machine-buttons");
    const up = el("button", "upgrade");
    if (!Meta.featureUnlocked("upgrade_machine")) up.classList.add("hidden");
    btns.append(up);
    bottom.append(timer, btns); footer.appendChild(bottom);
    const prog = el("div", "progress"); prog.appendChild(el("div"));
    node.append(icon, name, recipe, footer, prog);
    up.onclick = (e) => { e.stopPropagation(); upgradeMachine(this, m); };
    // tap the building sprite -> its detail widget
    icon.style.cursor = "pointer";
    icon.onclick = (e) => { e.stopPropagation(); openBuildingPanel(m.id, { level: m.level }); };
    // tap an ingredient/output icon in the recipe -> its codex page
    recipe.addEventListener("click", (e) => { const img = e.target.closest("img[data-res]"); if (img) { e.stopPropagation(); openResource(img.dataset.res); } });
    m._refs = { name, slots, up, timer };
    this.updateMachine(m, node); return node;
  },

  // Sélecteur PAR OUVRIER (w.role) : le dosage appartient au joueur — 2/2, 3/1,
  // 0/4… Chaque ouvrier a son segment Produit / Rabatteur (updateMachine). Plus de
  // switch global : on dose ouvrier par ouvrier. Le trajet fait foi (tickHawkers) :
  // passer en "sell" fait SORTIR l'ouvrier ; repasser en "prod" le fait RENTRER À
  // PIED — il ne recompte dans la production qu'une fois à la base (prodCrew).
  setWorkerRole(m, w, role) {
    if (w.role === role) return;
    w.role = role;
    this.refreshMachineCard(m);
    this.refreshMachineDots();
  },
  machineSells(m) { return m.crew.some((w) => w.role === "sell"); },
  recipeHtml(def) {
    const ic = (id, cls = "") => `<img class="${cls}" data-res="${id}" src="${this.tierSrc(id, 1)}" title="${this.res(id).displayName}">`;
    const out = ic(def.outputs, "out");
    if (!def.inputs.length) return `<span class="arrow">→</span> ${out}`;
    return def.inputs.map((i) => `${i.quantity}×${ic(i.type)}`).join(" ") + ` <span class="arrow">→</span> ${out}`;
  },
  refreshMachineCard(m) { if (m._node) this.updateMachine(m, m._node); this.renderWorkers(); },
  updateMachine(m, node) {
    const def = this.machineDef(m.id), r = m._refs;
    r.name.innerHTML = `${def.displayName} <span class="lvl">Nv.${m.level}</span>`;
    // Chaque ouvrier = une ligne [avatar][ ⚙ Produit | 📣 Rabatteur ]. Le segment
    // actif est mis en avant ; un tap sur l'autre change le poste de CET ouvrier.
    // Bordure dorée sur l'avatar quand il est rabatteur.
    r.slots.innerHTML = "";
    m.crew.forEach((w) => {
      const row = el("div", "worker-row");
      const chip = this.workerChip(w);
      chip.classList.toggle("sell", w.role === "sell");
      const seg = el("div", "wrole-seg");
      const prodB = el("button", "wrole-btn" + (w.role !== "sell" ? " on" : ""), `⚙<span>Produit</span>`);
      prodB.title = "Produit : l'ouvrier fabrique à la machine";
      const sellB = el("button", "wrole-btn sell" + (w.role === "sell" ? " on" : ""), `📣<span>Rabatteur</span>`);
      sellB.title = "Rabatteur : l'ouvrier sort capter les clients dans la rue";
      prodB.onclick = (e) => { e.stopPropagation(); this.setWorkerRole(m, w, "prod"); };
      sellB.onclick = (e) => { e.stopPropagation(); this.setWorkerRole(m, w, "sell"); };
      seg.append(prodB, sellB);
      row.append(chip, seg);
      r.slots.appendChild(row);
    });
    const sells = m.crew.filter((w) => w.role === "sell").length;
    const nx = nextMachineLevel(this, m);
    if (nx) { r.up.innerHTML = `⬆ $${nx.cost}`; r.up.disabled = this.player.money < nx.cost; } else { r.up.innerHTML = "⬆ MAX"; r.up.disabled = true; }
    node.classList.toggle("producing", m.producing);
    node.classList.toggle("selling", sells > 0);
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

  // --- workers ---
  // Rework « rabatteur » : les équipes sont FIXES (fillCrew), il n'y a plus de
  // banc ni d'assignation. renderWorkers ne fait plus que rafraîchir les cartes.
  renderWorkers() {
    this.player.machines.forEach((m) => { if (m._node) this.updateMachine(m, m._node); });
    this.refreshMachineDots();
    this.renderShop();
  },

  // One worker chip: avatar + (for characters) gear badges. Le clic appartient à
  // l'appelant — sur une carte machine, la chip est l'interrupteur prod/rabatteur
  // (updateMachine) ; la fiche des personnages vit dans le menu collection.
  workerChip(w) {
    const isChar = !!w.charId;
    const ch = isChar ? this.cfg.characters[w.charId] : null;
    const src = ch && ch.spriteId ? sprite(ch.spriteId, "Characters") : sprite("Worker", "UI");
    const chip = el("div", "wchip" + (isChar ? " char" : ""));
    chip.innerHTML =
      `<span class="wava"><img src="${src}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'" draggable="false"></span>` +
      (isChar ? `<span class="wgears">${gearBadges(w.charId)}</span>` : "") +
      `<span class="wrole"></span>`;
    return chip;
  },

  // (Le drag & drop d'ouvriers est mort avec la gestion d'équipes : les crews sont
  // fixes, le seul geste machine est le switch Prod/Rabatteur.)

  // --- suppliers / counters (market) ---
  renderSuppliers() {
    const wrap = $("#suppliers"); wrap.innerHTML = "";
    // fixed order (joueur puis bots), indépendant de l'argent
    this.competitors.forEach((c) => {
      const s = el("div", "counter" + (c.isPlayer ? " me" : "")); c._counter = s;
      // Le stand ne montre QUE le comptoir : les commandes réservées en attente de leur
      // client. La réserve (le stock dormant) n'est plus listée ici — celle du joueur est
      // dans le panneau INVENTAIRE, celle d'un bot dans sa fiche (tap sur le stand).
      // .counter-share : la loterie chooseShop rendue visible — part estimée du
      // prochain client (odds réels : marketing + tier + stock, voir expectedShares).
      // C'est LA jauge du pilier « voler des clients » : elle bouge à chaque achat
      // de marketing, montée de tier ou rupture de stock, chez toi comme chez eux.
      s.innerHTML = `<img class="counter-avatar" src="${sprite(c.spriteId, c.spriteFolder)}"><div class="counter-name">${c.name}</div><div class="counter-money"><img src="${sprite("Coins", "UI")}"><span class="cmoney">${c.money}</span></div><div class="counter-mkt">📣${c.marketing.toFixed(1)}</div><div class="counter-share" title="Part estimée du prochain client (marketing + qualité, si le stock suit)">–</div><div class="counter-desk"></div>`;
      c._moneyRef = s.querySelector(".cmoney");
      c._shareRef = s.querySelector(".counter-share");
      c._deskRef = s.querySelector(".counter-desk");
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
  // Update money in place (keeps the hit/money-pop animations alive). Le stand n'affiche
  // plus le stock : le comptoir se met à jour tout seul, à la pose et au retrait.
  refreshSuppliers() {
    // Les parts sont recalculées sur le même tick 0.2 s que l'argent : le badge
    // réagit « en direct » à un achat de marketing, un merge ou une rupture.
    const es = expectedShares(this);
    // Le rouge signale « hors course PENDANT que d'autres vendent ». En début de
    // prépa tout le monde est à 0 (rien n'a encore été produit) : tout colorer en
    // rouge serait du bruit, pas une alerte.
    const anyStock = !!es && [...es.shares.values()].some((v) => v > 0);
    this.competitors.forEach((c) => {
      if (!c._counter) return;
      if (c._moneyRef) c._moneyRef.textContent = c.money;
      // Stand illuminé (couleur du concurrent) tant que ses rabatteurs sont dehors.
      const hawking = c.machines.some((m) => (m._hawkers || []).some((h) => h.state === "hunt" || h.state === "chase"));
      c._counter.classList.toggle("hawking", hawking);
      if (hawking) c._counter.style.setProperty("--hc", this.compColor(c));
      if (c._shareRef) {
        const sh = es ? Math.round((es.shares.get(c) || 0) * 100) : null;
        c._shareRef.textContent = sh == null ? "–" : sh + "%";
        c._shareRef.classList.toggle("zero", sh === 0 && anyStock);
      }
    });
    if (this._infoC && !$("#competitor-overlay").classList.contains("hidden")) this.renderCompetitorPanel();
  },
  // --- comptoir : la marchandise réservée attend son client ---------------------
  // Cycle de vie d'une unité vendue :
  //   réserve (c.stock) --putOnCounter--> comptoir (c.counterItems) --takeFromCounter--> client
  // Le stock est décrémenté dès la réservation (game-customers.reserveSale), mais
  // l'objet reste À L'ÉCRAN sur le comptoir : on voit ce qui est déjà promis, et le
  // client repart visiblement avec. Avant, la marchandise s'évaporait à l'apparition.

  // Rectangle de départ du vol. Le stand ne liste plus son stock, il faut donc un
  // point d'origine crédible :
  //  - joueur -> la bande INVENTAIRE (toujours à l'écran). C'est l'exact inverse de
  //    flyToInventory (l'unité produite y rentre, l'unité vendue en ressort).
  //  - bot (n'expose rien) -> de SOUS le stand, comme sorti de l'arrière-boutique.
  reserveRect(c) {
    if (c === this.player) {
      if (this._invTiles && this._invTiles.isConnected) {
        const r = this._invTiles.getBoundingClientRect();
        if (r.width) return r;
      }
      const ib = $("#inventory-bar");
      if (ib) { const r = ib.getBoundingClientRect(); if (r.width) return r; }
    }
    const s = c._counter; if (!s || !s.isConnected) return null;
    const r = s.getBoundingClientRect();
    return r.width ? { left: r.left + r.width / 2 - 13, top: r.bottom + 8, width: 26, height: 26 } : null;
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
      const from = this.reserveRect(c), to = chip.getBoundingClientRect();
      if (!from || !to.width) return;                      // comptoir hors écran : pose sèche
      chip.classList.add("landing");                       // caché le temps du trajet
      this.flyItem(it.resId, it.tier, from, to, 420, false, () => {
        chip.classList.remove("landing"); chip.classList.add("pop");
      });
    });
  },

  // Le client est arrivé jusqu'au comptoir : il emporte sa commande (la marchandise
  // vole du comptoir vers lui, en fondu). Les clients CAPTURÉS en route par un
  // rabatteur ne passent jamais par ici — ils sont servis sur place (captureCustomer).
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

  // --- rabatteurs : des ouvriers PHYSIQUES qui RABATTENT les clients ------------
  // Un ouvrier en "sell" sort dans la rue prendre de quoi servir un client qui veut
  // SA ressource (icône + quantité sur la tête) et court le lui livrer AVANT qu'il
  // n'atteigne un comptoir. Deux usages, offensif ET défensif :
  //   - VOL : un client qui allait chez un CONCURRENT est servi sur place → il
  //     repart sans jamais y arriver (captureCustomer rembourse le concurrent et
  //     crédite le patron du rabatteur). D'où la préférence pour les lignes adverses.
  //   - SÉCURISATION : un client qui venait déjà chez soi est servi tout de suite,
  //     hors de portée des rabatteurs adverses.
  // Cycle : recharge (base) → hunt (cherche une cible, rôde côté adverse) → chase
  // (fonce dessus, colis en main) → returning (rentre) → recharge. Le TRAJET fait
  // foi : repasser en "prod" fait rentrer l'ouvrier à pied avant qu'il ne
  // reproduise (prodCrew gate dans game-production) — pas d'exploit de switch.
  hawkerBaseX(c, laneRect) {
    const s = c._counter;
    if (!s || !s.isConnected) return laneRect.width / 2;
    const r = s.getBoundingClientRect();
    return Math.max(14, Math.min(laneRect.width - 14, r.left - laneRect.left + r.width / 2));
  },
  tickHawkers(dt) {
    const lane = $("#customer-lane"); if (!lane || !this.competitors) return;
    const laneRect = lane.getBoundingClientRect(); if (!laneRect.height) return;
    const recharge = Number.isFinite(this.cfg.g.hawkerRecharge) ? this.cfg.g.hawkerRecharge : 1.5;
    this.competitors.forEach((c) => c.machines.forEach((m) => {
      m._hawkers = m._hawkers || [];
      // Interrupteur PAR OUVRIER : seuls les rôles "sell" sortent — le reste de
      // l'équipe continue de produire à côté (dosage 2/2, 3/1…).
      m.crew.forEach((w) => {
        if (w.role !== "sell" || w._hawk) return;
        // Départs étalés : toute l'équipe ne surgit pas à la même frame.
        w._hawk = { w, c, m, state: "recharge", timer: 0.2 + Math.random() * 0.9, target: null };
        m._hawkers.push(w._hawk);
      });
      m._hawkers = m._hawkers.filter((h) => !this.tickHawker(h, dt, lane, laneRect, h.w.role === "sell", recharge));
    }));
    // Balayage défensif : un sprite .hawker que plus aucune entrée vivante ne
    // possède (vague qui a vidé la lane, entrée retirée entre-temps) est enlevé.
    lane.querySelectorAll(".hawker").forEach((n) => { if (!n._hawk || n._hawk.el !== n) n.remove(); });
  },
  // Un pas de simulation pour UN rabatteur. Renvoie true quand il a terminé
  // (rentré + son ouvrier repassé en prod) : son entrée est retirée, w._hawk aussi.
  tickHawker(h, dt, lane, laneRect, selling, recharge) {
    const baseX = this.hawkerBaseX(h.c, laneRect), baseY = laneRect.height - 8;
    const spdCfg = Number(this.cfg.g.hawkerSpeed); // multiplicateur global (general.hawkerSpeed) — 0.5 = deux fois plus lent
    const spd = Number.isFinite(spdCfg) && spdCfg > 0 ? spdCfg : 1;
    // La vague a reconstruit la lane (innerHTML = "") : l'élément est orphelin —
    // le bonhomme « est rentré entre les vagues », il repart proprement de la base.
    if (h.el && !h.el.isConnected) { h.el = null; h.state = "recharge"; h.timer = recharge * Math.random(); this.dropHawkTarget(h); this.hawkerReturnCarried(h); }
    if (h.state === "recharge") {
      if (!selling) { this.hawkerReturnCarried(h); h.w._hawk = null; return true; }   // rappelé : il rend son paquet
      h.timer -= dt;
      if (h.timer <= 0) {
        h.el = el("div", "hawker");
        h.el._hawk = h;   // lien de propriété, pour le balayage anti-fantômes
        h.el.style.setProperty("--hc", this.compColor(h.c));
        const src = h.w.charId && this.cfg.characters[h.w.charId] && this.cfg.characters[h.w.charId].spriteId
          ? sprite(this.cfg.characters[h.w.charId].spriteId, "Characters") : sprite("Worker", "UI");
        h.el.innerHTML = `<img class="hw" src="${src}">`;
        lane.appendChild(h.el);
        h.x = baseX; h.y = baseY;
        h.state = "hunt";   // il apparaît À LA BOUTIQUE ; le chargement se fait là (hunt, ci-dessous)
      }
      return false;
    }
    // Ouvrier rappelé en production : il lâche sa cible et rentre à pied.
    if (!selling && h.state !== "returning") { this.dropHawkTarget(h); h.state = "returning"; }

    if (h.state === "hunt") {
      // RÈGLE : on ne prend une ressource QU'À LA BOUTIQUE (jamais par magie en pleine
      // map). Poches vides -> il rentre/attend à la base et ne se charge QUE là, quand
      // le stock le permet (produit une commande visible, sinon 1 unité par défaut).
      if (this.carriedCount(h) === 0) {
        const atBase = Math.hypot(h.x - baseX, h.y - baseY) < 6;
        if (atBase) { const want = this.hawkerDesiredLoad(h, lane); if (want > 0) this.hawkerSetLoad(h, want); }
        if (this.carriedCount(h) === 0) {                    // toujours rien à vendre : il attend à la boutique
          h.tx = baseX; h.ty = baseY;
          this.hawkerStep(h, dt, HAWK_SPEED * spd);
          return false;
        }
      }
      if (!h.target || !this.hawkTargetValid(h)) this.acquireHawkTarget(h, lane, laneRect);
      if (h.target) h.state = "chase";                        // cible verrouillée : à la charge
      else if (this.hawkerStep(h, dt, HAWK_SPEED * spd)) this.hawkerRoam(h, laneRect, baseX); // rôde avec son paquet
    }
    if (h.state === "chase") {
      if (!this.hawkTargetValid(h)) { this.dropHawkTarget(h); h.state = "hunt"; this.hawkerRoam(h, laneRect, baseX); }
      else {
        const t = h.target.getBoundingClientRect();
        h.tx = t.left - laneRect.left + t.width / 2;
        h.ty = t.top - laneRect.top + t.height * 0.6;
        if (this.hawkerStep(h, dt, HAWK_RUN_SPEED * spd)) {
          const defense = h.target._order && h.target._order.winner === h.c;
          if (defense) {
            // Défense : livre la marchandise du COMPTOIR (garde son paquet de réserve).
            if (captureCustomer(this, h.c, h.target, null)) { this.finishCapture(h); h.carriedSale = null; this.updateHawkerCarry(h); }
          } else {
            // Vol/conversion : DÉPOSE sa part dans l'escrow (complète si l'alliance a réuni la commande).
            this.depositToOrder(h);
          }
          this.dropHawkTarget(h);
          h.state = "returning";
        }
      }
    }
    if (h.state === "returning") {
      h.tx = baseX; h.ty = baseY;
      if (this.hawkerStep(h, dt, HAWK_HOME_SPEED * spd)) {
        if (h.el) { h.el.remove(); h.el = null; }
        if (!selling) { this.hawkerReturnCarried(h); h.w._hawk = null; return true; }  // rentré pour de bon : rend son paquet
        h.state = "recharge"; h.timer = recharge;         // souffle un coup avant de ressortir (garde son paquet)
      }
    }
    return false;
  },
  // Combien charger À LA BOUTIQUE : de quoi couvrir la PLUS GROSSE commande visible de
  // sa ressource (vol/conversion), sinon 1 unité par défaut — le tout borné par la
  // réserve. 0 = rien en stock, il attend.
  hawkerDesiredLoad(h, lane) {
    const resId = this.machineDef(h.m.id).outputs;
    const avail = this.stockOf(h.c, resId);
    if (avail <= 0) return 0;
    let want = 1;
    lane.querySelectorAll(".customer").forEach((cust) => {
      const o = cust._order, need = cust._need;
      if (!o || !need || need.resId !== resId || o.done || o.arrived) return;
      if (o.winner === h.c) return;   // ses propres clients = défense (comptoir), pas besoin de charger
      if (cust.classList.contains("toShop") || cust.classList.contains("done") || cust.classList.contains("nobody")) return;
      if (need.qty > want) want = need.qty;
    });
    return Math.min(avail, want);
  },
  // Rôde en attendant une cible : de préférence vers les LIGNES ADVERSES (là où
  // tombent les clients qu'on peut voler), sinon autour de son propre stand.
  hawkerRoam(h, laneRect, baseX) {
    let cx = baseX;
    const foes = this.competitors.filter((c) => c !== h.c && c._counter && c._counter.isConnected);
    if (foes.length) {
      const r = foes[Math.floor(Math.random() * foes.length)]._counter.getBoundingClientRect();
      cx = r.left - laneRect.left + r.width / 2;
    }
    h.tx = Math.max(14, Math.min(laneRect.width - 14, cx + (Math.random() * 120 - 60)));
    h.ty = laneRect.height * (0.35 + Math.random() * 0.5);
  },
  // La cible d'un rabatteur tient-elle encore la route ? (client toujours en chute,
  // commande pas encore soldée, et — pour un vol — le patron a de quoi le servir.)
  hawkTargetValid(h) {
    const t = h.target;
    if (!t || !t.isConnected) return false;
    if (t.classList.contains("toShop") || t.classList.contains("done") || t.classList.contains("nobody")) return false;
    const o = t._order, need = t._need;
    if (!o || !need || o.done || o.arrived) return false;
    // Vol/conversion : il doit encore porter au moins 1 unité à déposer (il n'apporte
    // que SA part de la commande — les autres unités viennent des alliés).
    if (o.winner !== h.c && this.carriedCount(h) < 1) return false;
    return true;
  },
  // Choisit la meilleure proie : sa ressource, client encore en chute. Priorité :
  // VOLER un adverse (2) > convertir un client sans preneur (1) > SÉCURISER le sien
  // (0) ; à égalité, le plus proche. ALLIANCE : sur un vol/conversion, plusieurs
  // rabatteurs se relaient — chacun rejoint tant que la commande n'est pas ENTIÈREMENT
  // réservée (o.reserved) et qu'il porte au moins 1 unité. La défense reste solo.
  acquireHawkTarget(h, lane, laneRect) {
    const resId = this.machineDef(h.m.id).outputs;
    let best = null, bestScore = -Infinity;
    lane.querySelectorAll(".customer").forEach((cust) => {
      const o = cust._order, need = cust._need;
      if (!o || !need || need.resId !== resId || o.done || o.arrived) return;
      if (cust.classList.contains("toShop") || cust.classList.contains("done") || cust.classList.contains("nobody")) return;
      let cls;
      if (o.winner === h.c) {
        // DÉFENSE : un seul rabatteur (marchandise du comptoir).
        const claim = cust._claim;
        if (claim && claim !== h && claim.el && (claim.state === "chase" || claim.state === "hunt")) return;
        cls = 0;
      } else {
        // VOL / CONVERSION : il rejoint l'alliance s'il porte de quoi contribuer et
        // qu'il reste de la place dans la commande. Une commande n'est disputée que par
        // UN concurrent à la fois (l'escrow ne mélange pas les réserves).
        if (this.carriedCount(h) < 1) return;
        if (o.allyOwner && o.allyOwner !== h.c) return;
        if ((o.reserved || 0) >= need.qty) return;   // déjà couverte par les collègues
        cls = o.winner ? 2 : 1;
      }
      const r = cust.getBoundingClientRect();
      const cx = r.left - laneRect.left + r.width / 2, cy = r.top - laneRect.top + r.height / 2;
      const score = cls * 100000 - Math.hypot(cx - h.x, cy - h.y); // classe d'abord, puis le plus proche
      if (score > bestScore) { bestScore = score; best = cust; }
    });
    if (best) this.setHawkTarget(h, best);
    else h.target = null;
  },
  setHawkTarget(h, cust) {
    this.dropHawkTarget(h);
    h.target = cust;
    const o = cust._order, need = cust._need;
    if (o && o.winner === h.c && o.sale && o.sale.items && o.sale.items.length) {
      // DÉFENSE (le client est DÉJÀ à lui) : marchandise sur SON comptoir. Il la RAMASSE
      // pour l'apporter plus tôt et GARDE son paquet de réserve. Un seul rabatteur.
      cust._claim = h;
      this.hawkerPickup(h.c, o.sale);
      h.carriedSale = o.sale;
    } else if (o && need) {
      // VOL / CONVERSION (ALLIANCE) : il RÉSERVE sa part de la commande (ce qu'il porte,
      // borné par ce qu'il reste à couvrir). Il déposera cette part en arrivant.
      const room = need.qty - (o.reserved || 0);
      const give = Math.min(this.carriedCount(h), Math.max(0, room));
      if (give <= 0) { h.target = null; return; }
      o.reserved = (o.reserved || 0) + give;
      o.allyOwner = h.c;                 // ce concurrent mène l'assaut sur cette commande
      h.pledge = give;
    }
    this.updateHawkerCarry(h);
  },
  dropHawkTarget(h) {
    const cust = h.target;
    if (cust) {
      if (cust._claim === h) cust._claim = null;                       // défense
      // Part réservée mais PAS encore déposée : on la libère pour d'autres alliés.
      if (h.pledge && cust._order) {
        const oo = cust._order;
        oo.reserved = Math.max(0, (oo.reserved || 0) - h.pledge);
        if (oo.reserved === 0 && (!oo.escrow || !oo.escrow.tiers.length)) oo.allyOwner = null; // assaut abandonné : libre
      }
    }
    h.pledge = 0;
    h.target = null;
    if (h.carriedSale) { this.hawkerRestore(h.c, h.carriedSale); h.carriedSale = null; }
    this.updateHawkerCarry(h);
  },
  // ALLIANCE : le rabatteur arrive et DÉPOSE sa part (h.pledge) dans l'escrow de la
  // commande — ses unités quittent sa poche et attendent les alliés. Quand l'escrow
  // atteint la commande, on solde (captureCustomer avec l'escrow comme paquet) et le
  // client est servi ; le vol du concurrent ne se fait donc QU'À la complétion.
  depositToOrder(h) {
    const cust = h.target, o = cust && cust._order, need = cust && cust._need;
    if (!o || !need || o.done || o.arrived) return;
    const give = Math.min(this.carriedCount(h), h.pledge || 0);
    if (give <= 0) return;
    const resId = h.carried.resId;
    const tiers = h.carried.tiers.splice(0, give);
    const gain = tiers.reduce((s, t) => s + this.tierInfo(resId, t).price, 0);
    h.carried.gain -= gain; if (!h.carried.tiers.length) h.carried = null;
    h.pledge = 0;                                    // livré : reste compté dans o.reserved (devenu escrow)
    o.escrow = o.escrow || { resId, tiers: [], gain: 0, owner: h.c };
    o.escrow.tiers.push(...tiers); o.escrow.gain += gain; o.escrow.owner = h.c;
    this.updateHawkerCarry(h);
    // Rafraîchit la bulle du client : ce qu'il reste à réunir.
    const left = need.qty - o.escrow.tiers.length;
    const bub = cust.querySelector(".bubble span"); if (bub && left > 0) bub.textContent = left + "×";
    if (o.escrow.tiers.length >= need.qty) {
      // Commande réunie : on solde via captureCustomer (l'escrow EST le paquet livré).
      const bundle = { resId: o.escrow.resId, tiers: o.escrow.tiers, gain: o.escrow.gain };
      if (captureCustomer(this, o.escrow.owner, cust, bundle)) {
        // captureCustomer a consommé need.qty ; un éventuel surplus retourne à la réserve.
        if (bundle.tiers.length) { const m = o.escrow.owner.stock[o.escrow.resId] = o.escrow.owner.stock[o.escrow.resId] || {}; bundle.tiers.forEach((t) => (m[t] = (m[t] || 0) + 1)); if (o.escrow.owner === this.player) this._invDirty = true; }
        o.escrow = null;
        this.finishCapture(h);
      }
    }
  },
  // Nombre d'unités actuellement en poche (paquet sorti de la réserve).
  carriedCount(h) { return h.carried ? h.carried.tiers.length : 0; },
  // Modèle "réel" : ajuste le paquet en poche à EXACTEMENT `n` unités du produit de sa
  // machine — pioche le complément dans la réserve (meilleur tier d'abord) ou y remet
  // le surplus. Le stock bouge tout de suite (visible dans l'inventaire). Renvoie le
  // nombre réellement en main (< n si la réserve s'épuise). n=0 = tout reposer.
  hawkerSetLoad(h, n) {
    const resId = this.machineDef(h.m.id).outputs;
    const m = h.c.stock[resId] = h.c.stock[resId] || {};
    h.carried = h.carried || { resId, tiers: [], gain: 0 };
    while (h.carried.tiers.length > n) {                       // rend le surplus
      const t = h.carried.tiers.pop(); m[t] = (m[t] || 0) + 1; h.carried.gain -= this.tierInfo(resId, t).price;
    }
    while (h.carried.tiers.length < n) {                       // complète depuis la réserve
      const t = Object.keys(m).map(Number).filter((x) => m[x] > 0).sort((a, b) => b - a)[0];
      if (t == null) break;
      m[t]--; h.carried.tiers.push(t); h.carried.gain += this.tierInfo(resId, t).price;
    }
    if (h.c === this.player) this._invDirty = true;
    const cnt = h.carried.tiers.length;
    if (!cnt) h.carried = null;
    this.updateHawkerCarry(h);
    return cnt;
  },
  // Il rentre bredouille (rappelé en prod, vague finie) ou bascule en défense : tout le
  // paquet RETOURNE à la réserve. Rien n'est perdu.
  hawkerReturnCarried(h) { this.hawkerSetLoad(h, 0); },
  // La poche à l'écran = ce que le rabatteur tient PHYSIQUEMENT : la marchandise du
  // comptoir (défense, carriedSale) sinon l'unité sortie de la réserve (carried), sinon rien.
  updateHawkerCarry(h) {
    if (!h.el) return;
    const old = h.el.querySelector(".hw-carry"); if (old) old.remove();
    let resId, tier, qty = 1;
    if (h.carriedSale && h.carriedSale.tiers && h.carriedSale.tiers.length) {
      resId = h.carriedSale.resId; tier = h.carriedSale.tiers[0]; qty = h.carriedSale.units || h.carriedSale.tiers.length;
    } else if (h.carried && h.carried.tiers.length) {
      resId = h.carried.resId; tier = h.carried.tiers[0]; qty = h.carried.tiers.length;
    } else return;
    const carry = el("div", "hw-carry");
    carry.appendChild(this.tierImg(resId, tier));
    if (qty > 1) carry.appendChild(el("span", "hw-qty", "×" + qty));
    h.el.appendChild(carry);
  },
  // Défense : sort la marchandise réservée du comptoir vers la main du rabatteur.
  // Le MODÈLE (sale.items) est gardé — seuls les chips à l'écran partent — pour
  // pouvoir la reposer si le rabatteur ne livre pas.
  hawkerPickup(c, sale) {
    if (!sale || !sale.items) return;
    c.counterItems = (c.counterItems || []).filter((it) => !sale.items.includes(it));
    sale.items.forEach((it) => { if (it._chip) { it._chip.remove(); it._chip = null; } });
    this.renderCounterDesk(c);
  },
  // Repose sur le comptoir une marchandise ramassée mais jamais livrée (rabatteur
  // rappelé en prod, lane reconstruite…). No-op si la vente a déjà été soldée.
  hawkerRestore(c, sale) {
    if (!sale || !sale.items || !sale.items.length) return;
    c.counterItems = c.counterItems || [];
    sale.items.forEach((it) => { if (!c.counterItems.includes(it)) c.counterItems.push(it); });
    this.renderCounterDesk(c);   // recrée les chips manquants (pas d'animation de vol)
  },
  // Livraison réussie : le colis quitte les mains du rabatteur et le client, servi
  // sur place, s'efface (flashStall a déjà crédité le patron dans captureCustomer).
  finishCapture(h) {
    const cust = h.target;
    if (h.el) { const carry = h.el.querySelector(".hw-carry"); if (carry) carry.remove(); }
    if (cust && cust.isConnected) { cust.classList.add("captured"); setTimeout(() => cust.remove(), 500); }
    this.refreshSuppliers();
  },
  // Avance vers (tx,ty) à `speed` px/s. true = arrivé.
  hawkerStep(h, dt, speed) {
    const dx = h.tx - h.x, dy = h.ty - h.y;
    const d = Math.hypot(dx, dy), step = speed * dt;
    if (d <= step || d === 0) { h.x = h.tx; h.y = h.ty; }
    else { h.x += dx / d * step; h.y += dy / d * step; }
    if (h.el) {
      h.el.style.left = h.x + "px"; h.el.style.top = h.y + "px";
      h.el.classList.toggle("flip", dx < 0);
    }
    return h.x === h.tx && h.y === h.ty;
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

    const segs = [];
    this.competitors.forEach((c) => {
      const v = val(c);
      if (v > 0 || c.isPlayer) segs.push({ name: c.name, v, color: this.compColor(c) });
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
    // Ventilation des pertes du JOUEUR : le camembert dit combien, ces deux lignes
    // disent COMMENT — et donc quoi corriger. Comptées au règlement de chaque client
    // (game-customers) : rupture = pas de stock au tirage ; volé = battu au tirage
    // alors que le stock y était.
    const ru = mkt.ruptureUnits || 0, st = mkt.stolenUnits || 0;
    if (ru || st) {
      const note = el("div", "pie-note");
      if (ru) note.appendChild(el("span", "pn-item", `📦 ×${ru} perdus en rupture de stock — produis / stocke plus`));
      if (st) note.appendChild(el("span", "pn-item", `📣 ×${st} volés à l'attractivité — marketing ou meilleur tier`));
      wrap.appendChild(note);
    }
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
