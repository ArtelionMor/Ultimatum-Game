/* Market Ultimatum — menu.js
 * Main menu: level select, character collection (upgrade + gear), chest opening.
 * Also owns the character detail panel used in-game (tap a worker).
 */
"use strict";

import { $, el, sprite } from "./helpers.js";
import { SLOT_EMOJI, RARITY_LABEL } from "./constants.js";
import { Meta } from "./meta.js";

let Game = null;
let tab = "levels";

const SLOT_LABEL = { hat: "Chapeau", suit: "Costume", shoes: "Chaussures" };
const CHEST_LABEL = {
  common_chest: "Coffre commun", rare_chest: "Coffre rare",
  epic_chest: "Coffre épique", legendary_chest: "Coffre légendaire",
};
const SHARD_LABEL = {
  common_shard: "Éclats communs", rare_shard: "Éclats rares",
  epic_shard: "Éclats épiques", legendary_shard: "Éclats légendaires",
};

const rarityOf = (id) => (id.split("_").find((p) => RARITY_LABEL[p]) || "common");
const gearLabel = (gearId) => `${SLOT_LABEL[Meta.gearDef(gearId).slot] || gearId} ${RARITY_LABEL[Meta.gearDef(gearId).rarity].toLowerCase()}`;

export function initMenu(game) {
  Game = game;
  $("#menu-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { tab = b.dataset.tab; renderMenu(); }
  });
  $("#character-close").addEventListener("click", closeCharacterPanel);
  $("#character-overlay").addEventListener("click", (e) => { if (e.target.id === "character-overlay") closeCharacterPanel(); });
  $("#chest-close").addEventListener("click", () => { $("#chest-overlay").classList.add("hidden"); renderMenu(); });
}

export function showMenu() {
  $("#menu-screen").classList.remove("hidden");
  renderMenu();
}
export function hideMenu() { $("#menu-screen").classList.add("hidden"); }

export function renderMenu() {
  if ($("#menu-screen").classList.contains("hidden")) return;
  renderCurrencies();
  $("#menu-tabs").querySelectorAll("button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = $("#menu-body"); body.innerHTML = "";
  if (tab === "levels") renderLevels(body);
  else if (tab === "characters") renderCharacters(body);
  else renderChests(body);
}

function renderCurrencies() {
  const s = Meta.state;
  const wrap = $("#menu-currencies"); wrap.innerHTML = "";
  const chip = (icon, val, title) => { const c = el("div", "cur-chip"); c.title = title; c.innerHTML = `${icon}<b>${val}</b>`; wrap.appendChild(c); };
  chip(`<img src="${sprite("Coins")}">`, s.coins, "Pièces");
  chip("💎", s.gems, "Gemmes");
  Object.keys(SHARD_LABEL).forEach((id) => { const n = s.shards[id] || 0; if (n > 0) chip(`<span class="shard ${rarityOf(id)}">🔷</span>`, n, SHARD_LABEL[id]); });
}

// ---------- Levels tab ----------
function renderLevels(body) {
  const list = el("div", "level-list");
  const next = Meta.nextLevel();
  Game.cfg.worldLevels.forEach((lvl, i) => {
    const endless = Meta.isEndless(lvl.id);
    const done = Meta.isCompleted(lvl.id);
    const unlocked = Meta.isUnlocked(lvl.id);
    const playable = unlocked && (endless || !done);
    const card = el("div", "level-card" + (endless ? " endless" : "") + (done ? " done" : "") + (!unlocked ? " locked" : "") + (next && next.id === lvl.id ? " next" : ""));
    const name = endless ? "∞ Endless" : `Niveau ${i + 1}`;
    const eff = safeResolve(lvl.id);
    const meta = eff ? `${eff.totalRounds} vagues · ${eff.bots.length} concurrent${eff.bots.length > 1 ? "s" : ""}` : "";
    card.innerHTML =
      `<div class="lv-name">${name}</div>` +
      `<div class="lv-meta">${meta}</div>` +
      `<div class="lv-reward">${rewardSummary(lvl.reward)}</div>` +
      `<div class="lv-state">${!unlocked ? "🔒" : done && !endless ? "✅ Terminé" : ""}</div>`;
    if (playable) {
      const btn = el("button", "lv-play", endless ? "Jouer ∞" : "Jouer");
      btn.onclick = () => Game.launchLevel(lvl.id);
      card.appendChild(btn);
    }
    list.appendChild(card);
  });
  body.appendChild(list);
}
function safeResolve(levelId) { try { return Game.resolveLevel(levelId); } catch (e) { return null; } }
// Human summary of a reward table (used on level cards): guaranteed lines only.
function rewardSummary(rewardId) {
  const table = Game.cfg.rewards[rewardId];
  if (!table) return "";
  const parts = [];
  Object.values(table).forEach((rows) => {
    rows.forEach((r) => { if (r.content) parts.push(`${r.amount}× ${dropLabel(r.content)}`); });
  });
  return parts.length ? "🎁 " + parts.join(", ") : "";
}
function dropLabel(content) {
  if (content === "coins") return "pièces";
  if (content === "gems") return "gemmes";
  return CHEST_LABEL[content] || SHARD_LABEL[content] || content.replace(/_/g, " ");
}

// ---------- Characters tab ----------
function renderCharacters(body) {
  const grid = el("div", "char-grid");
  Game.cfg.characterOrder.forEach((id) => {
    const owned = Meta.isOwned(id);
    const lvl = Meta.charLevel(id);
    const ch = Game.cfg.characters[id];
    const card = el("div", "char-card" + (owned ? "" : " locked"));
    const machine = Game.cfg.machines.find((m) => m.id === ch.mainMachine);
    card.innerHTML =
      `<img class="char-avatar" src="${sprite("Worker")}">` +
      `<div class="char-name">${id}</div>` +
      `<div class="char-lvl">${owned ? "Nv. " + lvl : "🔒 Verrouillé"}</div>` +
      `<div class="char-spec">${machine ? `<img src="${sprite(machine.spriteId)}" title="${machine.displayName}">` : ""}</div>` +
      `<div class="char-gears">${gearBadges(id)}</div>`;
    card.onclick = () => openCharacterPanel(id);
    grid.appendChild(card);
  });
  body.appendChild(grid);
  // gear stock summary under the grid
  const inv = el("div", "gear-inventory");
  inv.appendChild(el("div", "menu-section", "Équipement possédé"));
  const rows = el("div", "gear-rows");
  let any = false;
  Object.keys(Game.cfg.gears).forEach((gid) => {
    const n = Meta.state.gearsOwned[gid] || 0;
    if (n <= 0) return; any = true;
    const g = Meta.gearDef(gid);
    const free = Meta.freeCount(gid);
    const row = el("div", `gear-row ${g.rarity}`);
    row.innerHTML = `<span class="gear-ico">${SLOT_EMOJI[g.slot] || "🎽"}</span><span class="gear-name">${gearLabel(gid)}</span>` +
      `<span class="gear-fx">⚡${Math.round(g.speed * 100)}% · 🎲${Math.round(g.proba2x * 100)}%</span>` +
      `<span class="gear-count">×${n}${free < n ? ` (${free} libre${free > 1 ? "s" : ""})` : ""}</span>`;
    rows.appendChild(row);
  });
  if (!any) rows.appendChild(el("div", "menu-muted", "Aucun équipement — ouvre des coffres !"));
  inv.appendChild(rows);
  body.appendChild(inv);
}

// Small colored slot emojis showing what a character is wearing.
export function gearBadges(charId) {
  const eq = Meta.state.equipment[charId] || {};
  return ["hat", "suit", "shoes"].map((slot) => {
    const gid = eq[slot];
    return gid ? `<span class="gear-badge ${Meta.gearDef(gid).rarity}" title="${gearLabel(gid)}">${SLOT_EMOJI[slot]}</span>` : "";
  }).join("");
}

// ---------- Character detail panel (menu + in-game) ----------
let panelChar = null;
export function openCharacterPanel(charId) {
  panelChar = charId;
  renderCharacterPanel();
  $("#character-overlay").classList.remove("hidden");
}
export function closeCharacterPanel() { panelChar = null; $("#character-overlay").classList.add("hidden"); }

function renderCharacterPanel() {
  const id = panelChar; if (!id) return;
  const body = $("#character-body");
  const ch = Game.cfg.characters[id];
  const owned = Meta.isOwned(id);
  const lvl = Meta.charLevel(id);
  const data = owned ? ch.levels[lvl] : ch.levels[1];

  // what is this character doing right now? (only meaningful during a run)
  let activity = "";
  if (Game.player && Game.state === "Play") {
    const w = (Game.player.workers || []).find((x) => x.charId === id);
    if (w && w.machineId) {
      const m = Game.machineDef(w.machineId);
      activity = `<div class="cd-activity">🔧 Travaille : <b>${m ? m.displayName : w.machineId}</b> (+${Math.round(Meta.speedBonus(id, w.machineId) * 100)}% vitesse ici)</div>`;
    } else if (w) {
      activity = `<div class="cd-activity">😴 Disponible (non assigné)</div>`;
    }
  }

  // affinity lines at current (or first) level
  const aff = Object.keys(data.speeds).map((mid) => {
    const m = Game.cfg.machines.find((x) => x.id === mid);
    return `<div class="cd-aff"><img src="${m ? sprite(m.spriteId) : ""}"><span>${m ? m.displayName : mid}</span><b>+${Math.round(data.speeds[mid] * 100)}%</b></div>`;
  }).join("");
  const p2 = Meta.proba2x(id);

  // gear slots
  const eq = Meta.state.equipment[id] || {};
  const slots = ["hat", "suit", "shoes"].map((slot) => {
    const gid = eq[slot];
    const g = gid && Meta.gearDef(gid);
    return `<div class="cd-slot ${g ? g.rarity : "empty"}" data-slot="${slot}">
      <span class="cd-slot-ico">${SLOT_EMOJI[slot]}</span>
      <span class="cd-slot-name">${g ? gearLabel(gid) : SLOT_LABEL[slot] + " — vide"}</span>
      ${g ? `<span class="cd-slot-fx">⚡${Math.round(g.speed * 100)}% 🎲${Math.round(g.proba2x * 100)}%</span>` : ""}
    </div>`;
  }).join("");

  // upgrade
  const cost = Meta.upgradeCost(id);
  let upg = "";
  if (cost) {
    const have = Meta.state.shards[cost.content] || 0;
    const ok = have >= cost.amount;
    upg = `<div class="cd-upgrade">
      <span>${owned ? `Passer Nv. ${cost.level}` : "Débloquer"} : <b class="${ok ? "ok" : "danger"}">${cost.amount}× ${SHARD_LABEL[cost.content] || cost.content}</b> <span class="menu-muted">(tu as ${have})</span></span>
      <button id="cd-upgrade-btn"${ok ? "" : " disabled"}>${owned ? "Améliorer ⬆" : "Débloquer 🔓"}</button>
    </div>`;
  } else if (owned) {
    upg = `<div class="cd-upgrade"><span class="menu-muted">Niveau maximum atteint ✨</span></div>`;
  }

  body.innerHTML =
    `<div class="cp-head">
      <img class="cp-skin" src="${sprite("Worker")}">
      <div class="cp-id">
        <div class="cp-name">${id} ${owned ? `<span class="lvl">Nv.${lvl}</span>` : '<span class="cp-elim">verrouillé</span>'}</div>
        <div class="cp-tags"><span class="cp-tag">${ch.profile.replace("_character", "")}</span></div>
      </div>
    </div>
    ${activity}
    <div class="cp-section">Affinités machines${owned ? "" : " (au Nv.1)"}</div>
    <div class="cd-affs">${aff || '<span class="menu-muted">Aucune</span>'}</div>
    <div class="cd-proba">🎲 Production ×2 : <b>${Math.round(p2 * 100)}%</b></div>
    <div class="cp-section">Équipement</div>
    <div class="cd-slots">${slots}</div>
    <div id="cd-gearpick"></div>
    ${upg}`;

  const btn = body.querySelector("#cd-upgrade-btn");
  if (btn) btn.onclick = () => { if (Meta.upgradeCharacter(id)) { renderCharacterPanel(); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); } };
  if (owned) body.querySelectorAll(".cd-slot").forEach((n) => { n.onclick = () => showGearPicker(id, n.dataset.slot); });
}

// List owned gears for one slot; tap to equip (or remove the current one).
function showGearPicker(charId, slot) {
  const wrap = $("#cd-gearpick"); wrap.innerHTML = "";
  const box = el("div", "gearpick");
  box.appendChild(el("div", "menu-section", `${SLOT_LABEL[slot]} — choisir`));
  const eq = Meta.state.equipment[charId] || {};
  if (eq[slot]) {
    const off = el("button", "gp-item remove", `Retirer ${gearLabel(eq[slot])}`);
    off.onclick = () => { Meta.unequip(charId, slot); renderCharacterPanel(); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); };
    box.appendChild(off);
  }
  let any = false;
  Object.keys(Game.cfg.gears).forEach((gid) => {
    const g = Meta.gearDef(gid);
    if (g.slot !== slot) return;
    const free = Meta.freeCount(gid);
    if (free <= 0 && eq[slot] !== gid) return;
    any = true;
    const it = el("button", `gp-item ${g.rarity}` + (eq[slot] === gid ? " current" : ""),
      `${SLOT_EMOJI[slot]} ${gearLabel(gid)} — ⚡${Math.round(g.speed * 100)}% 🎲${Math.round(g.proba2x * 100)}% <span class="gear-count">×${free} libre${free > 1 ? "s" : ""}</span>`);
    it.onclick = () => { if (eq[slot] !== gid) Meta.equip(charId, gid); renderCharacterPanel(); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); };
    box.appendChild(it);
  });
  if (!any && !eq[slot]) box.appendChild(el("div", "menu-muted", "Aucun équipement de ce type — ouvre des coffres !"));
  wrap.appendChild(box);
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Chests tab ----------
function renderChests(body) {
  const list = el("div", "chest-list");
  let any = false;
  Object.keys(CHEST_LABEL).forEach((cid) => {
    const n = Meta.state.chests[cid] || 0;
    const rarity = rarityOf(cid);
    const card = el("div", `chest-card ${rarity}` + (n <= 0 ? " empty" : ""));
    card.innerHTML = `<div class="chest-ico">🎁</div><div class="chest-name">${CHEST_LABEL[cid]}</div><div class="chest-count">×${n}</div>`;
    if (n > 0) {
      any = true;
      const btn = el("button", "chest-open", "Ouvrir");
      btn.onclick = () => openChestUI(cid);
      card.appendChild(btn);
    }
    list.appendChild(card);
  });
  body.appendChild(list);
  if (!any) body.appendChild(el("div", "menu-muted center", "Aucun coffre — termine des niveaux pour en gagner !"));
}

// Chest opening: shake the chest, then reveal each drop with a stagger.
export function openChestUI(chestId) {
  const drops = Meta.openChest(chestId);
  if (!drops) return;
  const rarity = rarityOf(chestId);
  $("#chest-title").textContent = CHEST_LABEL[chestId] || chestId;
  const anim = $("#chest-anim");
  anim.innerHTML = `<div class="chest-big ${rarity}">🎁</div>`;
  const dr = $("#chest-drops"); dr.innerHTML = "";
  $("#chest-close").classList.add("hidden");
  $("#chest-overlay").classList.remove("hidden");
  setTimeout(() => {
    anim.querySelector(".chest-big").classList.add("open");
    drops.forEach((d, i) => {
      setTimeout(() => {
        const node = el("div", "drop-item " + dropRarity(d));
        node.innerHTML = dropHtml(d);
        dr.appendChild(node);
        if (i === drops.length - 1) $("#chest-close").classList.remove("hidden");
      }, 350 + i * 280);
    });
    if (!drops.length) { dr.appendChild(el("div", "menu-muted", "Rien cette fois…")); $("#chest-close").classList.remove("hidden"); }
  }, 600);
}
function dropRarity(d) {
  if (d.type === "gear" || d.type === "shard" || d.type === "chest") return rarityOf(d.id);
  return "";
}
function dropHtml(d) {
  if (d.type === "coins") return `<img src="${sprite("Coins")}"><span>+${d.amount} pièces</span>`;
  if (d.type === "gems") return `<span class="drop-ico">💎</span><span>+${d.amount} gemmes</span>`;
  if (d.type === "shard") return `<span class="drop-ico shard ${rarityOf(d.id)}">🔷</span><span>+${d.amount} ${SHARD_LABEL[d.id] || d.id}</span>`;
  if (d.type === "chest") return `<span class="drop-ico">🎁</span><span>+${d.amount} ${CHEST_LABEL[d.id] || d.id}</span>`;
  if (d.type === "gear") { const g = Meta.gearDef(d.id); return `<span class="drop-ico">${SLOT_EMOJI[g.slot]}</span><span>+${d.amount} ${gearLabel(d.id)}</span>`; }
  return "";
}

// Reward drops shown on the game-over screen (same visual language as chests).
export function renderDropList(container, drops) {
  container.innerHTML = "";
  drops.forEach((d) => {
    const node = el("div", "drop-item " + dropRarity(d));
    node.innerHTML = dropHtml(d);
    container.appendChild(node);
  });
}
