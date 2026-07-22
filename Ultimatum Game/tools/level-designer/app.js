/* Level Designer — app.js
 * State, rendering and wiring.
 */

import {
  makeBlock, makeLevel, emptyDoc, compileLevel, econ, priceOf, curveAt,
  deriveBotWeightsPerWave, adaptationPerWave, toMarketConfigRows, toCompetitorRows,
  toCompetitorBuffRows, toUnlockRows, toConfigLevels, diagnoseColumns, BOT_BUFFS,
} from "./model.js";
import * as io from "./io.js";
import { makeBus } from "./sync.js";
import { makeHistory } from "./history.js";
import { lineChart, smallMultiples, barsH, groupedBars, fmt } from "./charts.js";

const $ = (s) => document.querySelector(s);
const st = { doc: emptyDoc(), cfg: null, raw: null, level: 0, tier: 1, dirty: false };

const resName = (id) => (st.cfg.resources[id] ? st.cfg.resources[id].displayName : id);
const machineName = (id) => { const m = st.cfg.machines.find((x) => x.id === id); return (m && m.displayName) || id; };
const resSprite = (id) => {
  const r = st.cfg.resources[id];
  if (!r) return "";
  const t = r.tiers[st.tier] || r.tiers[1] || Object.values(r.tiers)[0];
  return io.spriteUrl((t && t.spriteId) || r.spriteId);
};
const level = () => st.doc.levels[st.level];

function status(msg, kind = "") { const e = $("#status"); e.textContent = msg; e.className = kind; }

// Every edit path in the tool ends here, so this is where the change is banked
// for undo and broadcast to the other windows.
function mark() {
  hist.commit(st.doc, coalescing());
  st.dirty = !hist.isClean();
  status(st.dirty ? "Modifications non sauvegardées ●" : "Sauvegardé ✔", st.dirty ? "" : "ok");
  syncUndoButtons();
  bus.push(snapshot());
}

// ============================================================
// Undo / redo (see history.js)
// ============================================================
const hist = makeHistory();

// Typing a level id must be one undo step, not one per letter: fold consecutive
// edits made in the same field. Anything else (a select, a checkbox, a button,
// or moving to another field) starts a fresh step.
let lastField = null;
let lastEditAt = 0;
function coalescing() {
  const a = document.activeElement;
  const typed = a && a.matches("input[type=text], input[type=number], textarea");
  const same = typed && a === lastField && Date.now() - lastEditAt < 1500;
  lastField = typed ? a : null;
  lastEditAt = Date.now();
  return same;
}

function syncUndoButtons() {
  $("#undo").disabled = !hist.canUndo();
  $("#redo").disabled = !hist.canRedo();
}

// Undo/redo replace the whole doc, so they must not go back through mark() —
// that would bank the restored state as a new edit and make redo unreachable.
function applyHistory(doc, label) {
  st.doc = doc;
  st.level = Math.max(0, Math.min(st.level, st.doc.levels.length - 1));
  st.dirty = !hist.isClean();
  lastField = null; // never fold the next edit into a step we just walked off
  renderAll();
  status(st.dirty ? `${label} — modifications non sauvegardées ●` : `${label} — identique au fichier`, st.dirty ? "" : "ok");
  syncUndoButtons();
  bus.push(snapshot());
}

function doUndo() { const d = hist.undo(); d ? applyHistory(d, "Annulé ↶") : status("Rien à annuler"); }
function doRedo() { const d = hist.redo(); d ? applyHistory(d, "Rétabli ↷") : status("Rien à rétablir"); }

// Ctrl+Z is intercepted even inside a field. The native text undo would restore
// the visible characters without firing `input`, leaving the document holding
// the new value and the field showing the old one — silent desync. Our history
// redraws the field from the document, so the two can't disagree.
document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
});

// ============================================================
// Cross-tab sync (see sync.js)
// ============================================================
// The doc *and* the selected level are shared by every open tab: the Économie
// tab always describes the level being edited, whichever screen it's edited on.
// Only the valuation tier stays per-tab — it's a way of reading the same level,
// not a place in the document.
const snapshot = () => ({ doc: st.doc, level: st.level, dirty: st.dirty, handle: io.getHandle() });

const bus = makeBus({
  getState: snapshot,
  onState: (m) => { io.adoptHandle(m.handle); adopt(m); },
  // A save carries the doc it wrote, so this window lands exactly on the bytes
  // that reached the disk before clearing its own unsaved flag.
  onSaved: (m) => { io.adoptHandle(m.handle); adopt({ ...m, saved: true }); },
});

// Applying a remote doc rebuilds the DOM, which would eat the caret of anyone
// typing here. In practice only one screen is being edited at a time, so the
// passive tab just holds the update until its field loses focus.
let queued = null;
let flushTimer = 0;
const editing = () => {
  const a = document.activeElement;
  return a && (a.matches("input, select, textarea") || a.isContentEditable);
};

function flush() {
  if (!queued || editing()) return;
  clearInterval(flushTimer); flushTimer = 0;
  const q = queued; queued = null;
  adopt(q);
}

function adopt(m) {
  if (editing()) {
    queued = m;
    // A background window fires no focus events in Chrome, so focusout alone can
    // strand the update forever — poll as the safety net.
    if (!flushTimer) flushTimer = setInterval(flush, 250);
    return;
  }
  const wasId = level() && level().id;
  st.doc = m.doc;
  // A remote edit is new activity on the document, so it goes on this window's
  // undo stack too: Ctrl+Z here undoes the last thing that happened, wherever it
  // happened. Never coalesced — the sender already grouped its keystrokes.
  hist.commit(st.doc, false);
  if (m.saved) hist.markSaved();
  st.dirty = !hist.isClean();
  syncUndoButtons();
  // Follow the sender's selection. Falling back to the id (not the index) keeps
  // this tab on its level if the message predates a level being added or moved.
  const byId = st.doc.levels.findIndex((l) => l.id === wasId);
  const wanted = m.level != null ? m.level : byId >= 0 ? byId : st.level;
  st.level = Math.max(0, Math.min(wanted, st.doc.levels.length - 1));
  renderAll();
  if (m.saved) status("Sauvegardé ✔ (autre fenêtre)", "ok");
  else status(st.dirty ? "Modifications non sauvegardées ● (synchronisé)" : "Synchronisé avec l'autre fenêtre", st.dirty ? "" : "ok");
}

// focusout fires before the next focusin, so defer: tabbing between two fields
// must not count as "done editing" and redraw the form under the user.
document.addEventListener("focusout", () => setTimeout(flush, 0));

// ============================================================
// Boot
// ============================================================
(async function boot() {
  let missing = [];
  try {
    const loaded = await io.loadGameConfig();
    st.cfg = loaded.cfg; st.raw = loaded.raw; missing = loaded.missing || [];
  } catch (e) {
    status("Impossible de charger config_export.json — " + e.message, "err");
    // Without the config, every handler dereferences missing state: buttons
    // would "do nothing" with errors only in the console. Make the failure
    // unmissable and take the dead UI down with it.
    document.querySelector("main").innerHTML =
      `<div class="card"><h2 style="color:var(--critical)">L'outil n'a pas pu démarrer</h2>
       <p><b>config_export.json n'a pas pu être chargé :</b> ${e.message}</p>
       <p>Vérifie l'export (sections attendues par le jeu : resources, market_config,
       competitors, competitors_behavior, customers…), puis recharge cette page (F5).</p></div>`;
    return;
  }
  // Ask the other tabs first: one of them may hold unsaved edits, in which case
  // the copy on disk is stale and adopting it would fork the document.
  const peer = await bus.hello();
  io.adoptHandle(peer && peer.handle);
  const disk = (peer && peer.dirty && peer.doc) || (await io.loadDocFromServer());
  st.doc = disk || seedDoc();
  st.dirty = !!(peer && peer.dirty);
  if (!st.doc.levels.length) st.doc.levels.push(makeLevel("world_config_1", st.doc.biomes[0].id));
  // Open on the level the other screens are on, so a new window joins the work
  // in progress instead of dropping back to the first level.
  if (peer && peer.level != null) st.level = Math.max(0, Math.min(peer.level, st.doc.levels.length - 1));
  // History starts here: there is nothing to undo back past the loaded document.
  // Only a clean load counts as the saved point — adopting a peer's unsaved work
  // must keep the unsaved marker.
  hist.reset(st.doc);
  if (!st.dirty) hist.markSaved();
  syncUndoButtons();
  fillStatics();
  renderAll();
  if (st.dirty) return status("Modifications non sauvegardées ● (synchronisé avec l'autre fenêtre)");
  if (missing.length) {
    // The tool works without these sections, but the game's normalize() won't.
    status(`Sections absentes de config_export.json : ${missing.join(", ")} — le designer fonctionne, mais le JEU ne chargera probablement pas cette config.`, "err");
  } else {
    status(disk ? "Chargé depuis le disque" : "Nouveau document (exemple)", "ok");
  }
})();

// A first block + level so the tool is never a blank page on first run.
function seedDoc() {
  const d = emptyDoc();
  const b = makeBlock("blk_intro", "Intro mono-ressource");
  b.rounds = 3; b.roles = ["focus"];
  b.mix = [{ role: "focus", weight: { mode: "const", value: 3 } }];
  b.customers = { mode: "const", value: 20 };
  b.avg = { mode: "list", values: [2, 3, 4] };
  const b2 = makeBlock("blk_duo", "Duo 80/20");
  b2.rounds = 4;
  b2.avg = { mode: "ramp", from: 3, to: 5 };
  b2.mix = [{ role: "focus", weight: { mode: "const", value: 4 } }, { role: "second", weight: { mode: "const", value: 1 } }];
  d.blocks = [b, b2];
  d.levels = [makeLevel("world_config_1", d.biomes[0].id)];
  return d;
}

function fillStatics() {
  const ts = $("#tierSel"); ts.innerHTML = "";
  for (let t = 1; t <= st.cfg.maxTier; t++) ts.appendChild(new Option("Tier " + t, t));
  ts.value = st.tier;
  const bs = $("#botSel"); bs.innerHTML = "";
  st.cfg.competitors.forEach((c) => bs.appendChild(new Option(c.displayName || c.id, c.id)));
  buildBotPicker();
}

// ---------- Faux select "concurrent" (avec sprite) ----------
const botDef = (id) => st.cfg.competitors.find((c) => c.id === id) || null;
const botName = (c) => (c && (c.displayName || c.id)) || "";
// Sprite du concurrent. Même dossier et même repli que le jeu (main.js pose
// spriteFolder "Characters" sur chaque bot) : un PNG absent retombe sur l'icône
// ouvrier au lieu d'afficher une image cassée — les noms de sprites bougent.
function botSpriteImg(c) {
  const img = document.createElement("img");
  img.className = "pick-sprite"; img.alt = "";
  img.src = io.spriteUrl(c && c.spriteId, "Characters") || io.spriteUrl("Worker", "UI");
  img.onerror = () => { img.onerror = null; img.src = io.spriteUrl("Worker", "UI"); };
  return img;
}

function buildBotPicker() {
  const menu = $("#botPickMenu"); menu.innerHTML = "";
  st.cfg.competitors.forEach((c) => {
    const opt = document.createElement("div");
    opt.className = "pick-opt"; opt.role = "option"; opt.dataset.id = c.id;
    opt.append(botSpriteImg(c));
    opt.append(Object.assign(document.createElement("span"), { textContent: botName(c) }));
    opt.onclick = () => { $("#botSel").value = c.id; syncBotPick(); closeBotPick(); };
    menu.appendChild(opt);
  });
  syncBotPick();
}

// Le bouton reflète la valeur du <select> caché — seule source de vérité.
function syncBotPick() {
  const c = botDef($("#botSel").value);
  const btn = $("#botPickBtn"); btn.innerHTML = "";
  if (c) btn.append(botSpriteImg(c));
  btn.append(Object.assign(document.createElement("span"), { className: "pick-lab", textContent: c ? botName(c) : "—" }));
  btn.append(Object.assign(document.createElement("span"), { className: "pick-caret", textContent: "▾" }));
  $("#botPickMenu").querySelectorAll(".pick-opt").forEach((o) => o.classList.toggle("sel", !!c && o.dataset.id === c.id));
}

function openBotPick() {
  const menu = $("#botPickMenu");
  menu.hidden = false; $("#botPickBtn").setAttribute("aria-expanded", "true");
  menu.querySelector(".pick-opt.sel")?.scrollIntoView({ block: "nearest" });
}
function closeBotPick() { $("#botPickMenu").hidden = true; $("#botPickBtn").setAttribute("aria-expanded", "false"); }

function resOptions(sel, val) {
  sel.innerHTML = "";
  sel.appendChild(new Option("— non lié —", ""));
  st.cfg.resourceOrder.forEach((r) => sel.appendChild(new Option(resName(r), r)));
  sel.value = val || "";
}

// ============================================================
// Render
// ============================================================
function renderAll() { renderLevelSel(); renderBlocks(); renderLevels(); renderEcon(); renderBots(); renderExport(); }

function renderLevelSel() {
  const s = $("#levelSel"); s.innerHTML = "";
  const bioName = Object.fromEntries(st.doc.biomes.map((b) => [b.id, b.name]));
  st.doc.levels.forEach((l, i) => s.appendChild(new Option(`${bioName[l.biomeId] || "?"} · ${l.id}`, i)));
  s.value = st.level;
}

// ---------- Blocks palette ----------
// Which block cards are expanded. Kept out of the doc so it never reaches the
// saved JSON, but outside blockCard so a palette redraw doesn't collapse them.
const openBlocks = new Set();

function renderBlocks() {
  const host = $("#blocks"); host.innerHTML = "";
  st.doc.blocks.forEach((b) => host.appendChild(blockCard(b)));
  renderCatList();
}

const catOf = (b) => (b.category || "").trim() || "Sans catégorie";

function renderCatList() {
  const dl = $("#blk-cats"); dl.innerHTML = "";
  [...new Set(st.doc.blocks.map(catOf))].sort().forEach((c) => dl.appendChild(new Option(c)));
}

function blockCard(b) {
  const d = document.createElement("div"); d.className = "blk";
  const open = openBlocks.has(b.id);
  if (open) d.classList.add("open");
  const head = document.createElement("div"); head.className = "blk-head";
  const tog = document.createElement("button"); tog.className = "icon"; tog.textContent = open ? "▾" : "▸";
  tog.onclick = () => {
    const o = d.classList.toggle("open");
    if (o) openBlocks.add(b.id); else openBlocks.delete(b.id);
    tog.textContent = o ? "▾" : "▸";
  };
  const nm = document.createElement("input"); nm.type = "text"; nm.value = b.name;
  nm.oninput = () => { b.name = nm.value; mark(); renderLevels(); };
  const rn = document.createElement("input"); rn.type = "number"; rn.min = 1; rn.value = b.rounds; rn.title = "Durée du bloc en rounds";
  rn.style.width = "48px";
  rn.oninput = () => { b.rounds = Math.max(1, +rn.value || 1); mark(); syncPreview(); refresh(); };
  const rnLab = lab("rounds"); rnLab.title = rn.title;
  const del = document.createElement("button"); del.className = "icon"; del.textContent = "✕";
  del.onclick = () => {
    if (st.doc.levels.some((l) => l.instances.some((i) => i.blockId === b.id))
      && !confirm("Ce bloc est utilisé dans un niveau. Le supprimer ?")) return;
    st.doc.blocks = st.doc.blocks.filter((x) => x !== b);
    st.doc.levels.forEach((l) => (l.instances = l.instances.filter((i) => i.blockId !== b.id)));
    mark(); renderAll();
  };
  head.append(tog, nm, rnLab, rn, del);
  d.appendChild(head);

  const p = document.createElement("p"); p.className = "hint";
  // The preview lives outside the curve editors, so every edit has to push to it
  // explicitly — the card is never rebuilt while you type.
  const syncPreview = () => { p.textContent = "Aperçu : " + previewText(b); };
  const changed = () => { syncPreview(); refresh(); };

  const body = document.createElement("div"); body.className = "blk-body";
  const g = document.createElement("div"); g.className = "grid2";
  // Free grouping label used as step 1 of the block picker. The datalist offers
  // existing categories so the same one isn't retyped five slightly different ways.
  const cat = document.createElement("input"); cat.type = "text"; cat.setAttribute("list", "blk-cats");
  cat.value = b.category || ""; cat.placeholder = "mono, duo, filler, complexity 2…";
  cat.oninput = () => { b.category = cat.value; mark(); };
  cat.onchange = () => renderCatList();
  g.append(lab("Catégorie"), cat);
  g.append(lab("Clients"), curveEditor(b.customers, (c) => { b.customers = c; }, changed));
  g.append(lab("Quantité moy."), curveEditor(b.avg, (c) => { b.avg = c; }, changed));
  // Décochée (défaut) : chaque client demande exactement `avg`. Cochée : le
  // moteur retrouve son tirage {avg-1, avg, avg+1} → colonne qty_spread.
  const qs = document.createElement("input"); qs.type = "checkbox"; qs.checked = !!b.qtySpread;
  qs.onchange = () => { b.qtySpread = qs.checked; changed(); };
  g.append(lab("±1 aléatoire"), wrapLabel(qs, "quantité variable"));
  body.appendChild(g);

  const mix = document.createElement("div"); mix.className = "mix";
  const mh = document.createElement("div"); mh.className = "row";
  mh.innerHTML = "<b style='font-size:12px'>Mix (rôle → poids)</b>";
  const add = document.createElement("button"); add.className = "icon"; add.textContent = "+ rôle";
  // Adding/removing a row changes the card's shape, so it must redraw the palette
  // (refresh() deliberately skips it). Buttons can: they don't hold a caret.
  add.onclick = () => {
    b.mix.push({ role: nextRoleName(b), weight: { mode: "const", value: 1 } });
    syncRoles(b); mark(); renderBlocks(); refresh();
  };
  mh.appendChild(add); mix.appendChild(mh);

  b.mix.forEach((m) => {
    const r = document.createElement("div"); r.className = "mix-row";
    const role = document.createElement("input"); role.type = "text"; role.value = m.role;
    role.title = "Nom libre de l'emplacement — tu le lieras à une ressource dans le niveau";
    // Renaming on `change` (blur/Enter), not per keystroke: instances bind by role
    // name, so each intermediate spelling would orphan their binding.
    role.onchange = () => {
      const from = m.role; const to = role.value.trim();
      if (!to || to === from) { role.value = from; return; }
      if (b.mix.some((x) => x !== m && x.role === to)) { alert(`Le rôle "${to}" existe déjà dans ce bloc.`); role.value = from; return; }
      m.role = to; renameBinding(b.id, from, to);
      syncRoles(b); mark(); syncPreview(); refresh();
    };
    const rm = document.createElement("button"); rm.className = "icon"; rm.textContent = "✕";
    rm.onclick = () => {
      if (b.mix.length < 2) return alert("Un bloc a besoin d'au moins un rôle.");
      b.mix = b.mix.filter((x) => x !== m);
      syncRoles(b); mark(); renderBlocks(); refresh();
    };
    r.append(role, curveEditor(m.weight, (c) => { m.weight = c; }, changed), rm);
    mix.appendChild(r);
  });
  syncPreview();
  mix.appendChild(p);
  body.appendChild(mix);
  d.appendChild(body);
  return d;
}

function syncRoles(b) { b.roles = [...new Set(b.mix.map((m) => m.role))]; }
const nextRoleName = (b) => { let n = b.mix.length + 1; while (b.mix.some((m) => m.role === "role" + n)) n++; return "role" + n; };

// Instances bind resources by role name, so a rename has to carry the bindings
// with it or the demand silently vanishes from every level using this block.
function renameBinding(blockId, from, to) {
  st.doc.levels.forEach((l) => (l.instances || []).forEach((i) => {
    if (i.blockId !== blockId || !i.bind || !(from in i.bind)) return;
    i.bind[to] = i.bind[from]; delete i.bind[from];
  }));
}

function lab(t) { const s = document.createElement("label"); s.textContent = t; return s; }

// A curve is const / ramp / list — enough to express every shape in the sheet
// (flat customers, ramping avg, the 2-3-4-5-4-3-2 sawtooth via a cycled list).
function curveEditor(c, set, onChange = refresh) {
  const wrap = document.createElement("span"); wrap.className = "row";
  const mode = document.createElement("select");
  [["const", "fixe"], ["ramp", "rampe"], ["list", "liste"]].forEach(([v, t]) => mode.appendChild(new Option(t, v)));
  mode.value = c.mode || "const";
  const fields = document.createElement("span"); fields.className = "row";

  const build = () => {
    fields.innerHTML = "";
    if (c.mode === "ramp") {
      fields.append(numIn(c.from, (v) => (c.from = v), onChange), arrow(), numIn(c.to, (v) => (c.to = v), onChange));
    } else if (c.mode === "list") {
      const i = document.createElement("input"); i.type = "text"; i.className = "curve-list";
      i.value = (c.values || []).join(","); i.title = "Valeurs séparées par des virgules, répétées en boucle";
      i.oninput = () => { c.values = i.value.split(",").map((x) => +x.trim()).filter((x) => !isNaN(x)); mark(); onChange(); };
      fields.append(i);
    } else {
      fields.append(numIn(c.value, (v) => (c.value = v), onChange));
    }
  };
  mode.onchange = () => {
    const cur = c.mode === "list" ? (c.values || [1])[0] : c.mode === "ramp" ? c.from : c.value;
    Object.keys(c).forEach((k) => delete c[k]);
    c.mode = mode.value;
    if (c.mode === "const") c.value = cur || 0;
    if (c.mode === "ramp") { c.from = cur || 0; c.to = cur || 0; }
    if (c.mode === "list") c.values = [cur || 0];
    set(c); build(); mark(); onChange();
  };
  build();
  wrap.append(mode, fields);
  return wrap;
}
function numIn(v, set, onChange = refresh) {
  const i = document.createElement("input"); i.type = "number"; i.value = v ?? 0; i.style.width = "56px";
  i.oninput = () => { set(+i.value || 0); mark(); onChange(); };
  return i;
}
function arrow() { const s = document.createElement("span"); s.textContent = "→"; s.style.color = "var(--muted)"; return s; }

function previewText(b) {
  const n = Math.max(1, b.rounds | 0);
  return Array.from({ length: n }, (_, i) => {
    const mixTxt = b.mix.map((m) => `${m.role}:${curveAt(m.weight, i, n)}`).join(" ");
    return `[${curveAt(b.customers, i, n)}c ×${curveAt(b.avg, i, n)}${b.qtySpread ? "±1" : ""} ${mixTxt}]`;
  }).join(" ");
}

// ---------- Biomes & niveaux empilés ----------
// Collapsed biomes, session-only (default open, so it's a closed-set).
const closedBiomes = new Set();

function renderLevels() {
  const host = $("#biomes"); host.innerHTML = "";
  st.doc.biomes.forEach((bio) => host.appendChild(biomeCard(bio)));
}

function biomeCard(bio) {
  const card = document.createElement("div"); card.className = "card biome";
  const inBiome = st.doc.levels.map((l, i) => [l, i]).filter(([l]) => l.biomeId === bio.id);

  const head = document.createElement("div"); head.className = "row biome-head";
  const tog = document.createElement("button"); tog.className = "icon";
  tog.textContent = closedBiomes.has(bio.id) ? "▸" : "▾";
  tog.onclick = () => {
    if (closedBiomes.has(bio.id)) closedBiomes.delete(bio.id); else closedBiomes.add(bio.id);
    renderLevels();
  };
  const nm = document.createElement("input"); nm.type = "text"; nm.value = bio.name; nm.className = "biome-name";
  nm.oninput = () => { bio.name = nm.value; mark(); renderLevelSel(); };
  const count = document.createElement("span"); count.className = "hint";
  count.textContent = inBiome.length + " niveau" + (inBiome.length > 1 ? "x" : "");
  const addLvl = document.createElement("button"); addLvl.textContent = "+ Niveau";
  addLvl.onclick = () => {
    let n = st.doc.levels.length + 1;
    while (st.doc.levels.some((l) => l.id === "world_config_" + n)) n++;
    const lvl = makeLevel("world_config_" + n, bio.id);
    // keep doc.levels grouped: insert after the biome's last level
    const at = inBiome.length ? inBiome[inBiome.length - 1][1] + 1 : st.doc.levels.length;
    st.doc.levels.splice(at, 0, lvl);
    st.level = at; mark(); renderAll();
  };
  const del = document.createElement("button"); del.className = "icon"; del.textContent = "✕"; del.title = "Supprimer le biome";
  del.onclick = () => {
    if (inBiome.length) return alert("Ce biome contient des niveaux — déplace-les ou supprime-les d'abord.");
    st.doc.biomes = st.doc.biomes.filter((x) => x !== bio);
    mark(); renderLevels(); renderLevelSel();
  };
  head.append(tog, nm, count, spacer(), addLvl, del);
  card.appendChild(head);

  if (!closedBiomes.has(bio.id)) inBiome.forEach(([l, idx]) => card.appendChild(levelRow(l, idx)));
  return card;
}

function levelRow(l, idx) {
  const row = document.createElement("div"); row.className = "level-row" + (idx === st.level ? " sel" : "");
  row.dataset.idx = idx;
  row.onclick = () => selectLevel(idx);

  const head = document.createElement("div"); head.className = "level-head";
  // Un seul id par niveau : il nomme le world_config, le market_config ET le scope
  // des bots. Le champ market_config séparé a été supprimé — voir makeLevel().
  const idIn = document.createElement("input"); idIn.type = "text"; idIn.value = l.id; idIn.className = "level-id";
  idIn.title = "Id du niveau — nomme aussi son market_config et le scope de ses bots";
  idIn.oninput = () => { l.id = idIn.value; mark(); renderLevelSel(); renderExport(); };
  head.append(idIn);

  if (st.doc.biomes.length > 1) {
    const bio = document.createElement("select"); bio.title = "Déplacer vers un autre biome";
    st.doc.biomes.forEach((b) => bio.appendChild(new Option(b.name, b.id)));
    bio.value = l.biomeId;
    bio.onchange = () => { l.biomeId = bio.value; mark(); renderLevels(); renderLevelSel(); };
    head.appendChild(bio);
  }

  // Clients par paquet (max) : combien de clients peuvent arriver EN MÊME TEMPS.
  // Défaut 2. Émis dans chaque ligne market_config du niveau (colonne customerBatch).
  const batchWrap = document.createElement("label"); batchWrap.className = "level-batch";
  batchWrap.title = "Clients par paquet (max) — nombre max de clients qui arrivent en même temps";
  const batchIn = document.createElement("input"); batchIn.type = "number"; batchIn.min = "1"; batchIn.max = "20"; batchIn.step = "1";
  batchIn.value = l.customerBatch != null ? l.customerBatch : 2; batchIn.style.width = "42px";
  batchIn.onclick = (e) => e.stopPropagation();
  batchIn.oninput = () => { l.customerBatch = Math.max(1, Math.round(+batchIn.value || 2)); mark(); renderExport(); };
  batchWrap.append(document.createTextNode("👥"), batchIn);
  head.append(batchWrap);

  head.append(spacer());

  const stats = document.createElement("span"); stats.className = "level-stats";
  stats.dataset.levelStats = idx;
  head.appendChild(stats);

  const dup = document.createElement("button"); dup.className = "icon"; dup.textContent = "⧉"; dup.title = "Dupliquer le niveau";
  dup.onclick = (e) => {
    e.stopPropagation();
    const copy = JSON.parse(JSON.stringify(l));
    let n = 2; while (st.doc.levels.some((x) => x.id === l.id + "_" + n)) n++;
    copy.id = l.id + "_" + n;
    st.doc.levels.splice(idx + 1, 0, copy);
    st.level = idx + 1; mark(); renderAll();
  };
  const del = document.createElement("button"); del.className = "icon"; del.textContent = "✕"; del.title = "Supprimer le niveau";
  del.onclick = (e) => {
    e.stopPropagation();
    if (st.doc.levels.length < 2) return alert("Impossible de supprimer le dernier niveau.");
    if (!confirm(`Supprimer ${l.id} ?`)) return;
    st.doc.levels.splice(idx, 1);
    st.level = Math.max(0, Math.min(st.level, st.doc.levels.length - 1));
    mark(); renderAll();
  };
  head.append(dup, del);
  row.appendChild(head);
  row.appendChild(buildTimeline(l, idx));
  updateLevelStats(stats, l);
  return row;
}

function selectLevel(idx, scroll) {
  if (st.level !== idx) {
    st.level = idx;
    document.querySelectorAll(".level-row.sel").forEach((r) => r.classList.remove("sel"));
    document.querySelector(`.level-row[data-idx="${idx}"]`)?.classList.add("sel");
    $("#levelSel").value = idx;
    renderEcon(); renderBots(); renderExport();
    bus.push(snapshot()); // the other screens follow, so Économie can't drift off-level
  }
  if (scroll) document.querySelector(`.level-row[data-idx="${idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateLevelStats(span, l) {
  const e = econ(compileLevel(l, st.doc.blocks), st.cfg, st.tier);
  span.textContent = `${e.rounds} rounds · ${fmt(e.totalUnits)} unités · ${fmt(e.totalValue)} or`;
}

// Recompute every visible level's stats chip in place (no rebuild: this runs
// while an override field is being typed into).
function updateAllLevelStats() {
  document.querySelectorAll("[data-level-stats]").forEach((s) => {
    const l = st.doc.levels[+s.dataset.levelStats];
    if (l) updateLevelStats(s, l);
  });
}

function buildTimeline(l, levelIdx) {
  const host = document.createElement("div"); host.className = "timeline";
  let cursor = 0;

  l.instances.forEach((inst, idx) => {
    const b = st.doc.blocks.find((x) => x.id === inst.blockId);
    if (!b) return;
    const n = Math.max(1, b.rounds | 0);
    const first = cursor + 1; cursor += n;

    const d = document.createElement("div"); d.className = "inst"; d.draggable = true;
    const h = document.createElement("div"); h.className = "inst-head";
    h.innerHTML = `<span>${b.name}</span><span class="r">R${first}–${first + n - 1}</span>`;
    const x = document.createElement("button"); x.className = "icon"; x.textContent = "✕";
    x.onclick = () => { l.instances.splice(idx, 1); mark(); refresh(); };
    const dup = document.createElement("button"); dup.className = "icon"; dup.textContent = "⧉"; dup.title = "Dupliquer";
    dup.onclick = () => { l.instances.splice(idx + 1, 0, JSON.parse(JSON.stringify(inst))); mark(); refresh(); };
    h.append(dup, x);
    d.appendChild(h);

    b.roles.forEach((role) => {
      const r = document.createElement("div"); r.className = "bind";
      const s = document.createElement("span"); s.className = "role"; s.textContent = role;
      const sel = document.createElement("select");
      const bound = (inst.bind && inst.bind[role]) || (b.defaultBind && b.defaultBind[role]) || "";
      resOptions(sel, bound);
      // The bound resource's sprite, so a glance at the timeline reads like the
      // game. Kept in the layout even when unbound so cards don't shift width.
      const img = document.createElement("img");
      img.className = "bind-sprite"; img.alt = "";
      if (bound) img.src = resSprite(bound); else img.style.visibility = "hidden";
      sel.onchange = () => { inst.bind = inst.bind || {}; inst.bind[role] = sel.value; mark(); refresh(); };
      r.append(s, sel, img);
      d.appendChild(r);
    });

    const ov = document.createElement("div"); ov.className = "ov";
    ov.appendChild(lab("clients"));
    const oc = document.createElement("input"); oc.type = "number"; oc.placeholder = "auto";
    oc.value = inst.overrides?.customers ?? "";
    // Overrides change the economy but not the round numbering, so they must not
    // redraw the timeline — that would destroy the field being typed into.
    oc.oninput = () => { inst.overrides = inst.overrides || {}; if (oc.value === "") delete inst.overrides.customers; else inst.overrides.customers = +oc.value; mark(); refreshDerived(); };
    ov.append(oc, lab("avg"));
    const oa = document.createElement("input"); oa.type = "number"; oa.placeholder = "auto";
    oa.value = inst.overrides?.avg ?? "";
    oa.oninput = () => { inst.overrides = inst.overrides || {}; if (oa.value === "") delete inst.overrides.avg; else inst.overrides.avg = +oa.value; mark(); refreshDerived(); };
    ov.appendChild(oa);
    d.appendChild(ov);

    d.ondragstart = (e) => { e.dataTransfer.setData("text/plain", idx); d.classList.add("drag"); };
    d.ondragend = () => d.classList.remove("drag");
    d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = (e) => {
      e.preventDefault(); d.classList.remove("over");
      const from = +e.dataTransfer.getData("text/plain");
      if (from === idx) return;
      const [m] = l.instances.splice(from, 1);
      l.instances.splice(idx, 0, m);
      mark(); refresh();
    };
    host.appendChild(d);
  });

  host.appendChild(ghostCard(l, levelIdx));
  return host;
}

// The ghost "+" card at the end of every timeline: the one place to add a block
// to THAT line, so the target level is always the one under the cursor. It stays
// a fixed-size stub — the block list lives in a modal picker, so a hundred
// blocks cost the timeline nothing.
function ghostCard(l, levelIdx) {
  const d = document.createElement("div"); d.className = "inst ghost";
  const plus = document.createElement("button"); plus.className = "ghost-plus"; plus.textContent = "+";
  plus.title = "Ajouter un bloc à ce niveau";
  plus.onclick = () => openBlockMenu(l, levelIdx, plus);
  d.appendChild(plus);
  return d;
}

// Context-menu style picker anchored to the ghost "+": a compact category list,
// each category unfolding its blocks in a cascading submenu — the page behind
// stays fully visible. Both lists are ordered by real usage (instances across
// all levels), so the go-to patterns sit on top.
let ctxCleanup = null;
function closeCtx() { if (ctxCleanup) { ctxCleanup(); ctxCleanup = null; } }

function openBlockMenu(l, levelIdx, anchor) {
  closeCtx();
  const usage = {};
  st.doc.levels.forEach((lv) => (lv.instances || []).forEach((i) => (usage[i.blockId] = (usage[i.blockId] || 0) + 1)));
  const cats = {};
  st.doc.blocks.forEach((b) => (cats[catOf(b)] = cats[catOf(b)] || []).push(b));
  const catUse = (cn) => cats[cn].reduce((s, b) => s + (usage[b.id] || 0), 0);
  const catNames = Object.keys(cats).sort((a, b) => catUse(b) - catUse(a) || a.localeCompare(b));
  Object.values(cats).forEach((arr) => arr.sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0) || a.name.localeCompare(b.name)));

  const menuEl = () => { const m = document.createElement("div"); m.className = "ctx"; return m; };
  const item = (label, meta, hasSub) => {
    const it = document.createElement("button"); it.className = "ctx-item";
    const nm = document.createElement("span"); nm.textContent = label;
    const mt = document.createElement("span"); mt.className = "meta";
    mt.textContent = meta + (hasSub ? "  ▸" : "");
    it.append(nm, mt);
    return it;
  };
  // fixed-position, so the timeline's scroll clipping can't cut the menu off
  const place = (el, x, y) => {
    el.style.left = x + "px"; el.style.top = y + "px";
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = Math.max(8, innerWidth - r.width - 8) + "px";
    if (r.bottom > innerHeight - 8) el.style.top = Math.max(8, innerHeight - r.height - 8) + "px";
  };

  const root = menuEl();
  let sub = null;

  const addBlock = (b) => {
    st.level = levelIdx;
    l.instances.push({ blockId: b.id, bind: {}, overrides: {} });
    mark(); refresh();
    $("#levelSel").value = levelIdx;
    closeCtx();
  };
  const fillBlocks = (host, list) => {
    list.forEach((b) => {
      const it = item(b.name, b.rounds + " rd" + (usage[b.id] ? ` · ×${usage[b.id]}` : ""));
      it.onclick = () => addBlock(b);
      host.appendChild(it);
    });
  };

  if (!catNames.length) {
    const e = document.createElement("div"); e.className = "hint"; e.style.padding = "6px 10px";
    e.textContent = "Crée d'abord un bloc dans la palette.";
    root.appendChild(e);
  } else if (catNames.length === 1) {
    fillBlocks(root, cats[catNames[0]]); // one category = no cascade, straight to blocks
  } else {
    catNames.forEach((cn) => {
      const it = item(cn, String(cats[cn].length), true);
      const openSub = () => {
        if (sub) sub.remove();
        root.querySelectorAll(".ctx-item").forEach((x) => x.classList.remove("open"));
        it.classList.add("open");
        sub = menuEl();
        fillBlocks(sub, cats[cn]);
        document.body.appendChild(sub);
        const ir = it.getBoundingClientRect(); const rr = root.getBoundingClientRect();
        place(sub, rr.right + 2, ir.top);
        // if clamped back over the root, flip to its left side
        if (sub.getBoundingClientRect().left < rr.right - 4) place(sub, rr.left - sub.getBoundingClientRect().width - 2, ir.top);
      };
      it.onmouseenter = openSub;
      it.onclick = openSub; // touch / no-hover fallback
      root.appendChild(it);
    });
  }

  document.body.appendChild(root);
  const ar = anchor.getBoundingClientRect();
  place(root, ar.right + 6, ar.top);

  const onDown = (e) => { if (!root.contains(e.target) && !(sub && sub.contains(e.target))) closeCtx(); };
  const onKey = (e) => { if (e.key === "Escape") closeCtx(); };
  // scrolling the page under a fixed menu detaches it from its anchor — close;
  // scrolling inside the menus themselves is fine.
  const onScroll = (e) => { if (!root.contains(e.target) && !(sub && sub.contains(e.target))) closeCtx(); };
  document.addEventListener("mousedown", onDown);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeCtx);
  ctxCleanup = () => {
    root.remove(); if (sub) sub.remove();
    document.removeEventListener("mousedown", onDown);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", closeCtx);
  };
}
const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;

// ---------- Économie ----------
function renderEcon() {
  const rows = compileLevel(level(), st.doc.blocks);
  const e = econ(rows, st.cfg, st.tier);
  const labels = rows.map((r) => "R" + r.round);

  $("#econStats").innerHTML = stat("Rounds", e.rounds)
    + stat("Unités totales", fmt(e.totalUnits))
    + stat("Valeur totale", fmt(e.totalValue))
    + stat("Valeur / round (moy.)", e.rounds ? fmt(e.totalValue / e.rounds) : 0)
    + stat("Clients cumulés", fmt(rows.reduce((s, r) => s + r.customers, 0)));

  smallMultiples($("#smUnits"), {
    labels, unit: "unités", shareScale: $("#shareScale").checked,
    items: e.order.map((r) => ({ label: resName(r), sprite: resSprite(r), values: e.byRes[r].units, total: e.byRes[r].totalUnits })),
  });
  lineChart($("#chValue"), { values: e.perRound.map((p) => p.totalValue), labels, unit: "or" });
  lineChart($("#chCum"), { values: e.cumTotalValue, labels, unit: "or cumulé" });
  barsH($("#chShare"), {
    unit: "unités",
    items: e.order.map((r) => ({ label: resName(r), sprite: resSprite(r), value: e.byRes[r].totalUnits, pct: e.byRes[r].shareUnits }))
      .sort((a, b) => b.value - a.value),
  });
  renderRoundTable(e);
}

function renderRoundTable(e) {
  const cols = e.order;
  let h = "<table><thead><tr><th>Round</th><th>Bloc</th><th>Clients</th><th>Avg</th>"
    + cols.map((c) => `<th><img src="${resSprite(c)}" alt="">${resName(c)}</th>`).join("")
    + "<th>Unités</th><th>Valeur</th></tr></thead><tbody>";
  e.perRound.forEach((p) => {
    h += `<tr><td>R${p.round}</td><td>${p.blockName}</td><td>${p.customers}</td><td>${p.avg}</td>`
      + cols.map((c) => `<td title="poids ${p.weights[c] || 0}">${fmt(p.units[c])}</td>`).join("")
      + `<td>${fmt(p.totalUnits)}</td><td>${fmt(p.totalValue)}</td></tr>`;
  });
  $("#roundTable").innerHTML = h + "</tbody></table>";
}

// ---------- Concurrents ----------
function renderBots() {
  const host = $("#botList"); host.innerHTML = "";
  const l = level();
  const e = econ(compileLevel(l, st.doc.blocks), st.cfg, st.tier);
  (l.competitors || []).forEach((c, idx) => host.appendChild(botCard(c, idx, l, e)));
  if (!(l.competitors || []).length) {
    const d = document.createElement("div"); d.className = "card empty";
    d.textContent = "Aucun concurrent sur ce niveau.";
    host.appendChild(d);
  }
}

// A live control must never be re-created by its own event: rebuilding the card
// on every `input` tore the slider out of the DOM mid-drag (and stole focus from
// the number fields on every keystroke). So the controls are built once, and only
// the derived output — score, bars, weight values — is recomputed in place.
// Bot settings don't feed the market, so nothing outside this card needs a redraw
// except the export tab.
function botCard(c, idx, l, e) {
  // older docs stored a flat purchaseWeight and no buffs — upgrade in place
  if (typeof c.purchaseWeight === "number" && !c.purchase) { c.purchase = { mode: "const", value: c.purchaseWeight }; delete c.purchaseWeight; }
  c.purchase = c.purchase || { mode: "const", value: 5 };
  c.buffs = c.buffs || {};
  c.weights = c.weights || {};

  const card = document.createElement("div"); card.className = "card";

  const head = document.createElement("div"); head.className = "row";
  // Sprite + nom lisible devant l'id : une carte se reconnaît d'un coup d'œil,
  // et ça raccorde la carte à la vignette du sélecteur au-dessus.
  const d = botDef(c.id);
  head.append(botSpriteImg(d));
  head.append(Object.assign(document.createElement("h3"), { style: "margin:0", textContent: botName(d) || c.id }));
  if (d && d.displayName) head.append(Object.assign(document.createElement("span"), { className: "hint", textContent: c.id }));
  // Auto-merge : le bot plie son stock (3×Tn → Tn+1) comme le joueur. Coché par
  // défaut ; décoché, l'export émet autoMerge:0 et le moteur ne merge pas ce bot
  // — le knob "bot facile" des premiers niveaux.
  const am = document.createElement("input"); am.type = "checkbox"; am.checked = c.autoMerge !== false;
  am.onchange = () => { c.autoMerge = am.checked; mark(); renderExport(); };
  const rm = document.createElement("button"); rm.className = "icon"; rm.textContent = "✕";
  rm.onclick = () => { l.competitors.splice(idx, 1); mark(); renderBots(); renderExport(); };
  head.append(spacer(), wrapLabel(am, "Auto-merge"), rm);
  card.appendChild(head);

  const ctl = document.createElement("div"); ctl.className = "row"; ctl.style.margin = "8px 0";
  const auto = document.createElement("input"); auto.type = "checkbox"; auto.checked = !!c.auto;
  // Toggling auto changes which controls exist, so this one does rebuild the card.
  auto.onchange = () => { c.auto = auto.checked; mark(); renderBots(); renderExport(); };
  ctl.append(wrapLabel(auto, "Adapter au niveau"));

  if (c.auto) {
    ctl.append(lab("Spécialisation"));
    const sp = document.createElement("input"); sp.type = "range"; sp.min = 0; sp.max = 3; sp.step = .1;
    sp.value = c.specialization ?? 1; sp.style.width = "130px";
    const spv = document.createElement("span"); spv.className = "num"; spv.textContent = (+sp.value).toFixed(1);
    sp.oninput = () => { c.specialization = +sp.value; spv.textContent = (+sp.value).toFixed(1); mark(); update(); };
    ctl.append(sp, spv);

    ctl.append(lab("Focus"));
    const fs = document.createElement("select"); resOptions(fs, c.focus || "");
    fs.onchange = () => { c.focus = fs.value || null; mark(); update(); };
    ctl.append(fs);

    ctl.append(lab("Boost focus"));
    const fb = document.createElement("input"); fb.type = "number"; fb.step = .1; fb.min = 1; fb.value = c.focusBoost ?? 1;
    fb.oninput = () => { c.focusBoost = +fb.value || 1; mark(); update(); };
    ctl.append(fb);
  }
  card.appendChild(ctl);

  // Purchases are a curve over the level's waves (fixe/rampe/liste, like block
  // curves): an "invest early, harvest late" bot is a downward ramp.
  const buy = document.createElement("div"); buy.className = "row"; buy.style.margin = "8px 0";
  buy.append(lab("Achats d'upgrades (poids / vague)"));
  buy.appendChild(curveEditor(c.purchase, (v) => { c.purchase = v; }, () => update()));
  card.appendChild(buy);

  // Rationalized character loadout: flat buffs instead of simulated characters.
  const bf = document.createElement("div"); bf.className = "row"; bf.style.margin = "8px 0";
  bf.append(lab("Buffs (personnages équipés)"));
  BOT_BUFFS.forEach(([key, label]) => {
    const w = document.createElement("span"); w.className = "row"; w.style.gap = "4px";
    w.append(lab(label));
    const i = document.createElement("input"); i.type = "number"; i.min = 0; i.value = c.buffs[key] ?? 0;
    i.oninput = () => { c.buffs[key] = +i.value || 0; mark(); renderExport(); };
    w.append(i); bf.append(w);
  });
  card.appendChild(bf);

  const sc = document.createElement("div");
  const spark = document.createElement("div"); spark.className = "spark"; spark.style.marginTop = "10px";
  const cmp = document.createElement("div"); cmp.className = "sm-grid"; cmp.style.marginTop = "10px";
  card.append(sc, spark, cmp);

  // Manual mode: one constant weight per resource, applied to every wave.
  let fields = null;
  if (!c.auto) {
    const man = document.createElement("div"); man.style.marginTop = "10px";
    man.appendChild(Object.assign(document.createElement("h3"), { textContent: "Poids manuels (constants sur toutes les vagues)" }));
    const tbl = document.createElement("div"); tbl.className = "row";
    fields = {};
    e.order.forEach((k) => {
      const w = document.createElement("span"); w.className = "row"; w.style.gap = "4px";
      w.append(lab(resName(k)));
      const i = document.createElement("input"); i.type = "number"; i.min = 0;
      i.value = (c.weights && c.weights[k]) ?? 0;
      i.oninput = () => { c.weights[k] = +i.value || 0; mark(); update(); };
      fields[k] = i; w.append(i); tbl.append(w);
    });
    man.appendChild(tbl);
    card.appendChild(man);
  }

  function update() {
    const n = e.perRound.length;
    if (!e.order.length || !n) {
      sc.className = "warn";
      sc.textContent = "Aucune demande dans ce niveau — ajoute des blocs et lie leurs rôles pour mesurer l'adaptation.";
      spark.innerHTML = ""; cmp.innerHTML = "";
      renderExport();
      return;
    }
    const perWave = c.auto ? deriveBotWeightsPerWave(e, c) : e.perRound.map(() => ({ ...(c.weights || {}) }));
    const ad = adaptationPerWave(e, perWave);
    const valid = ad.filter((x) => x != null);
    const mean = valid.length ? valid.reduce((s, x) => s + x, 0) / valid.length : 0;
    const pct = (mean * 100).toFixed(0);
    sc.className = mean >= .9 ? "warn ok" : mean >= .7 ? "warn" : "warn crit";
    sc.innerHTML = mean >= .9
      ? `<b>Adaptation moyenne ${pct}%</b> — le bot vise ce que chaque vague demande.`
      : `<b>Adaptation moyenne ${pct}%</b> — sur certaines vagues, le bot produit ce que peu de clients réclament${mean < .7 ? " (il sera très faible)" : ""}.`;

    const labels = e.perRound.map((p) => "R" + p.round);
    lineChart(spark, { values: ad.map((x) => (x == null ? 0 : x * 100)), labels, unit: "% adaptation", height: 120 });

    // one mini-curve per resource: watch the bot re-aim wave by wave
    const items = e.order
      .map((r) => ({ label: resName(r), sprite: resSprite(r), values: perWave.map((w) => w[r] || 0), total: 0 }))
      .filter((it) => it.values.some((v) => v > 0));
    items.forEach((it) => (it.total = Math.max(...it.values)));
    smallMultiples(cmp, { labels, unit: "poids", shareScale: true, items });

    renderExport();
  }
  update();
  return card;
}
function spacer() { const s = document.createElement("span"); s.className = "sp"; s.style.flex = "1"; return s; }
function wrapLabel(input, text) {
  const l = document.createElement("label"); l.append(input, " " + text); return l;
}

// ---------- Export ----------
function renderExport() {
  const l = level();
  const mc = toMarketConfigRows(l, st.doc.blocks, st.cfg);
  const bots = toCompetitorRows(l, st.doc.blocks, st.cfg, st.tier);
  const buffs = toCompetitorBuffRows(l);
  const unlocks = toUnlockRows(l, st.doc.blocks, st.cfg);
  $("#mcCount").textContent = mc.length;
  $("#outMarket").textContent = JSON.stringify(mc, null, 1);
  $("#outBots").textContent = JSON.stringify(bots, null, 1);
  $("#outBuffs").textContent = JSON.stringify(buffs, null, 1);
  // "Machine (round N)" reads faster than raw rows when eyeballing the pacing.
  $("#unlockSummary").textContent = unlocks.length
    ? unlocks.map((u) => `${machineName(u.machine)} → vague ${u.unlock}`).join("  ·  ")
    : "Aucune machine requise (aucune ressource demandée sur ce niveau).";
  $("#outUnlock").textContent = JSON.stringify(unlocks, null, 1);

  // the sheet no longer carries market_config: diagnose the generated rows instead
  const d = diagnoseColumns(st.raw.market_config && st.raw.market_config.length ? st.raw.market_config : mc, st.cfg);
  let h = "";
  if (d.stale.length) {
    h += `<div class="warn crit"><b>Colonnes lues comme zéro par le moteur :</b> ${d.stale.join(", ")}.<br>
      <code>normalize()</code> lit chaque poids par <i>id de ressource</i> (<code>m[rid]</code>), donc une colonne
      nommée autrement est silencieusement ignorée — le jeu ne verra jamais cette demande.</div>`;
  }
  if (d.missing.length) {
    h += `<div class="warn"><b>Ressources sans colonne dans market_config :</b> ${d.missing.map(resName).join(", ")}.
      Leur demande est nulle partout tant que la colonne n'existe pas.</div>`;
  }
  if (!h) h = `<div class="warn" style="border-left-color:var(--good)">Colonnes market_config alignées avec les ids de ressources.</div>`;
  $("#diag").innerHTML = h;
}

// A compact, self-contained brief so Claude can take over without guessing.
function claudeBrief() {
  const l = level();
  const e = econ(compileLevel(l, st.doc.blocks), st.cfg, st.tier);
  return [
    `Niveau "${l.id}" — ${e.rounds} rounds.`,
    `Fichier: tools/level-designer/leveldesign.json`,
    `Ressources actives: ${e.order.map((r) => `${resName(r)} ${(e.byRes[r].shareUnits * 100).toFixed(1)}%`).join(", ")}`,
    `Unités totales ${fmt(e.totalUnits)} · valeur totale ${fmt(e.totalValue)} (tier ${st.tier}).`,
    `Séquence: ${l.instances.map((i) => { const b = st.doc.blocks.find((x) => x.id === i.blockId); return `${b ? b.name : "?"}(${Object.entries(i.bind || {}).map(([k, v]) => k + "=" + (v || "∅")).join(",")})`; }).join(" → ")}`,
    `Concurrents: ${(l.competitors || []).map((c) => {
      const pw = c.auto ? deriveBotWeightsPerWave(e, c) : e.perRound.map(() => c.weights || {});
      const ad = adaptationPerWave(e, pw).filter((x) => x != null);
      const m = ad.length ? (ad.reduce((s, x) => s + x, 0) / ad.length) * 100 : 0;
      return `${c.id} adaptation/vague ${m.toFixed(0)}%`;
    }).join(", ") || "aucun"}`,
  ].join("\n");
}

// ============================================================
// Events
// ============================================================
// refresh() redraws the timeline too, so only call it when the structure changed
// (blocks added/removed/reordered). While a field is being edited, use
// refreshDerived(): it updates everything the edit affects except the timeline
// the field lives in.
function refresh() { renderLevels(); renderEcon(); renderBots(); renderExport(); }
function refreshDerived() { updateAllLevelStats(); renderEcon(); renderBots(); renderExport(); }

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
  };
});

$("#levelSel").onchange = (e) => selectLevel(+e.target.value, true);
$("#addBiome").onclick = () => {
  let n = st.doc.biomes.length + 1;
  while (st.doc.biomes.some((b) => b.id === "biome_" + n)) n++;
  st.doc.biomes.push({ id: "biome_" + n, name: "Nouveau biome" });
  mark(); renderLevels(); renderLevelSel();
};
$("#addBlock").onclick = () => {
  const id = "blk_" + Date.now().toString(36);
  st.doc.blocks.push(makeBlock(id, "Nouveau bloc")); mark(); renderBlocks(); renderLevels();
};
$("#addBot").onclick = () => {
  const id = $("#botSel").value; if (!id) return;
  const l = level(); l.competitors = l.competitors || [];
  if (l.competitors.some((c) => c.id === id)) return status("Ce concurrent est déjà sur le niveau", "err");
  l.competitors.push({ id, auto: true, specialization: 1, focusBoost: 1, purchase: { mode: "const", value: 5 }, buffs: {}, weights: {} });
  mark(); renderBots();
};
$("#tierSel").onchange = (e) => { st.tier = +e.target.value; refresh(); };
$("#shareScale").onchange = renderEcon;

// Faux select : le clic sur le bouton bascule, tout clic ailleurs referme, Échap
// aussi. Les flèches ↑/↓ déplacent la sélection sans ouvrir, comme un vrai select.
$("#botPickBtn").onclick = () => { $("#botPickMenu").hidden ? openBotPick() : closeBotPick(); };
document.addEventListener("click", (e) => { if (!e.target.closest("#botPick")) closeBotPick(); });
$("#botPick").addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closeBotPick();
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const ids = st.cfg.competitors.map((c) => c.id);
  const i = ids.indexOf($("#botSel").value);
  const next = ids[Math.min(ids.length - 1, Math.max(0, (i < 0 ? 0 : i) + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next) { $("#botSel").value = next; syncBotPick(); }
});

// Loading a different document from disk starts a new history: undoing back into
// the document you just replaced would silently resurrect it.
function loaded(msg) {
  hist.reset(st.doc);
  hist.markSaved();
  syncUndoButtons();
  renderAll();
  status(msg, "ok");
  bus.push(snapshot());
}

$("#undo").onclick = doUndo;
$("#redo").onclick = doRedo;

$("#open").onclick = async () => {
  try {
    const doc = io.canUseFS() ? (await io.pickDocFile("open"), await io.readHandle()) : await io.pickLocalFile();
    if (!doc) return;
    st.doc = doc; st.level = 0; st.dirty = false;
    loaded("Chargé");
  } catch (e) { if (e.name !== "AbortError") status(e.message, "err"); }
};
$("#save").onclick = async () => {
  try {
    if (io.canUseFS()) {
      if (!io.hasHandle()) await io.pickDocFile("save");
      await io.writeHandle(st.doc);
    } else {
      io.download("leveldesign.json", JSON.stringify(st.doc, null, 2));
    }
    // The history keeps the saved point, so undoing back to it clears the
    // unsaved marker instead of leaving a phantom "●".
    hist.markSaved();
    st.dirty = false; status("Sauvegardé ✔", "ok");
    // Clears the dirty flag everywhere, and hands the freshly picked file handle
    // to tabs that don't have one yet.
    bus.saved(io.getHandle());
  } catch (e) { if (e.name !== "AbortError") status(e.message, "err"); }
};
$("#reload").onclick = async () => {
  if (st.dirty && !confirm("Tu as des modifications non sauvegardées. Recharger depuis le disque ?")) return;
  const doc = (io.hasHandle() ? await io.readHandle() : null) || await io.loadDocFromServer();
  if (!doc) return status("Aucun leveldesign.json trouvé sur le disque", "err");
  st.doc = doc; st.level = Math.min(st.level, doc.levels.length - 1); st.dirty = false;
  loaded("Rechargé depuis le disque");
};
$("#dlGame").onclick = () => {
  const f = toConfigLevels(st.doc, st.cfg, st.tier);
  io.download("config_levels.json", JSON.stringify(f, null, 1));
  status(`config_levels.json — ${st.doc.levels.length} niveaux, ${f.market_config.length} lignes market, ${f.unlock_config.length} unlock → à placer dans web/`, "ok");
};
$("#dlDoc").onclick = () => io.download("leveldesign.json", JSON.stringify(st.doc, null, 2));
$("#dlMarket").onclick = () => io.download("market_config.json", JSON.stringify(toMarketConfigRows(level(), st.doc.blocks, st.cfg), null, 2));
$("#dlBots").onclick = () => io.download("competitors.json", JSON.stringify({
  competitors_behavior: toCompetitorRows(level(), st.doc.blocks, st.cfg, st.tier),
  competitors_buffs: toCompetitorBuffRows(level()),
}, null, 2));
// One id per line, in display order (biome by biome) — pastes straight into a
// sheet column (world_config / world_level ids).
$("#copyLevelIds").onclick = async () => {
  const ids = st.doc.biomes.flatMap((b) => st.doc.levels.filter((l) => l.biomeId === b.id)).map((l) => l.id);
  await navigator.clipboard.writeText(ids.join("\n"));
  status(`${ids.length} ids copiés — colle-les dans la colonne id de la sheet`, "ok");
};
$("#copyClaude").onclick = async () => {
  await navigator.clipboard.writeText(claudeBrief());
  status("Briefing copié — colle-le à Claude", "ok");
};
window.addEventListener("beforeunload", (e) => { if (st.dirty) e.preventDefault(); });
