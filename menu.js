/* Market Ultimatum — menu.js
 * Main menu: level select, character collection (upgrade + gear), chest opening.
 * Also owns the character detail panel used in-game (tap a worker).
 */
"use strict";

import { $, el, sprite, openOverlay } from "./helpers.js";
import { SLOT_EMOJI, RARITY_LABEL, RARITIES } from "./constants.js";
import { Meta } from "./meta.js";
import { initBuildingPanel, openBuildingPanel } from "./building.js";
import { initCodex } from "./codex.js";
import { initResourcePanel } from "./resource.js";

let Game = null;
let tab = "levels";

const SLOT_LABEL = { hat: "Chapeau", suit: "Costume", shoes: "Chaussures" };
const CHEST_LABEL = {
  common_chest: "Coffre commun", rare_chest: "Coffre rare",
  epic_chest: "Coffre épique", legendary_chest: "Coffre légendaire",
};

// Rarity keyword inside a config id ("epic_chest" -> "epic"); "common" fallback.
const rarityOf = (id) => (id.split("_").find((p) => RARITY_LABEL[p]) || "common");
// Human name for a gear piece at a given slot + rarity, optionally owned by a hero.
const gearName = (slot, rarity, owner) => `${SLOT_LABEL[slot] || slot} ${(RARITY_LABEL[rarity] || rarity).toLowerCase()}${owner ? " de " + owner : ""}`;
// Same, from an instance (always carries its owner).
const gearInstName = (inst) => gearName(inst.slot, inst.rarity, inst.owner);

export function initMenu(game) {
  Game = game;
  initBuildingPanel(game);
  initCodex(game);
  initResourcePanel(game);
  $("#menu-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { tab = b.dataset.tab; renderMenu(); }
  });
  $("#character-close").addEventListener("click", closeCharacterPanel);
  $("#character-overlay").addEventListener("click", (e) => { if (e.target.id === "character-overlay") closeCharacterPanel(); });
  $("#slot-close").addEventListener("click", closeSlotPicker);
  $("#slot-overlay").addEventListener("click", (e) => { if (e.target.id === "slot-overlay") closeSlotPicker(); });
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
  chip(`<img src="${sprite("Coins", "UI")}">`, s.coins, "Pièces");
  chip("💎", s.gems, "Gemmes");
  // Character shards are nominative now — shown on each character, not here.
}

// ---------- Levels tab (trophy road) ----------
// A vertical winding path: each level is a node on a central rail, cards
// alternate left/right, and the rail is "filled" up to the current level.
function renderLevels(body) {
  const road = el("div", "trophy-road");
  const next = Meta.nextLevel();
  let currentRow = null;
  Game.cfg.worldLevels.forEach((lvl, i) => {
    const endless = Meta.isEndless(lvl.id);
    const done = Meta.isCompleted(lvl.id);
    const unlocked = Meta.isUnlocked(lvl.id);
    const playable = unlocked && (endless || !done);
    const current = !!next && next.id === lvl.id;
    const reached = done || current;           // rail is filled up to here
    const side = i % 2 === 0 ? "right" : "left";

    const row = el("div", "tr-row side-" + side +
      (reached ? " reached" : "") + (current ? " current" : "") +
      (endless ? " endless" : "") + (!unlocked ? " locked" : ""));

    // central rail + node
    const rail = el("div", "tr-rail");
    const node = el("div", "tr-node");
    node.innerHTML = endless ? "∞" : `${i + 1}`;
    const badge = el("div", "tr-node-badge",
      !unlocked ? "🔒" : (done && !endless) ? "✔" : current ? "▶" : "");
    node.appendChild(badge);
    rail.appendChild(node);

    // level card
    const card = el("div", "tr-card");
    const eff = safeResolve(lvl.id);
    const meta = eff ? `${eff.totalRounds} vagues · ${eff.bots.length} concurrent${eff.bots.length > 1 ? "s" : ""}` : "";
    const name = endless ? "∞ Endless" : `Niveau ${i + 1}`;
    card.innerHTML =
      `<div class="tr-name">${name}</div>` +
      `<div class="tr-meta">${meta}</div>` +
      `<div class="tr-rewards">${rewardChips(lvl.reward)}</div>`;
    if (playable) {
      const btn = el("button", "tr-play", endless ? "Jouer ∞" : "Jouer");
      btn.onclick = () => Game.launchLevel(lvl.id);
      card.appendChild(btn);
    } else if (done && !endless) {
      card.appendChild(el("div", "tr-status done", "✅ Terminé"));
    }
    // locked levels: the 🔒 badge on the node already conveys the state

    row.appendChild(rail);
    row.appendChild(card);
    road.appendChild(row);
    if (current) currentRow = row;
  });
  body.appendChild(road);
  // When there are more levels than fit, park the view on the current level.
  if (currentRow) requestAnimationFrame(() => currentRow.scrollIntoView({ block: "center" }));
}
function safeResolve(levelId) { try { return Game.resolveLevel(levelId); } catch (e) { return null; } }
// Reward table -> row of icon chips (guaranteed content rows, merged by content).
function rewardChips(rewardId) {
  const table = Game.cfg.rewards[rewardId];
  if (!table) return "";
  const merged = {};
  Object.values(table).forEach((rows) => {
    rows.forEach((r) => { if (r.content) merged[r.content] = (merged[r.content] || 0) + r.amount; });
  });
  const chips = Object.keys(merged).map((content) =>
    `<span class="tr-chip ${chipRarity(content)}" title="${dropLabel(content)}">${chipIcon(content)}<b>×${merged[content]}</b></span>`);
  return chips.join("");
}
function chipRarity(content) {
  if (content.endsWith("_chest") || content.endsWith("_shard") || content.endsWith("_gear")) return rarityOf(content);
  return "";
}
function chipIcon(content) {
  if (content === "coins") return `<img src="${sprite("Coins", "UI")}">`;
  if (content === "gems") return `<span class="chip-ico">💎</span>`;
  if (content.endsWith("_shard")) return `<span class="chip-ico shard ${rarityOf(content)}">🔷</span>`;
  if (content.endsWith("_chest")) return `<span class="chip-ico">🎁</span>`;
  if (content.endsWith("_gear")) return `<span class="chip-ico">${SLOT_EMOJI[content.split("_")[0]] || "🎽"}</span>`;
  return `<span class="chip-ico">🎁</span>`;
}
function dropLabel(content) {
  if (content === "coins") return "pièces";
  if (content === "gems") return "gemmes";
  return CHEST_LABEL[content] || SHARD_LABEL[content] || content.replace(/_/g, " ");
}

// ---------- Characters tab: resource slots ----------
// One slot per resource (cfg.characterSlots). An empty slot is a ghost "+";
// tapping it opens the two-step attribution widget (race, then character).
// A filled slot shows its character — tap for the detail panel (gear), ✕ to free it.
const charRarity = (ch) => (ch.profile || "").split("_")[0] || "common";
const rarityIdx = (ch) => Math.max(0, RARITIES.indexOf(charRarity(ch)));
const charAvatar = (ch, cls = "char-avatar") =>
  `<img class="${cls}" src="${ch.spriteId ? sprite(ch.spriteId, "Characters") : sprite("Worker", "UI")}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'" draggable="false">`;
const slotResIcon = (slot) =>
  Game.cfg.resources[slot.resource] ? `<img class="slot-res" src="${Game.tierSrc(slot.resource, 1)}">` : "";

function renderCharacters(body) {
  const grid = el("div", "slot-grid");
  Game.cfg.characterSlots.forEach((slot) => {
    const charId = Meta.slotChar(slot.id);
    const ch = charId && Game.cfg.characters[charId];
    const card = el("div", "slot-card" + (ch ? " filled " + charRarity(ch) : " empty"));
    if (ch) {
      card.innerHTML = slotResIcon(slot) + charAvatar(ch) +
        `<div class="char-name">${ch.displayName}</div>` +
        `<div class="char-lvl">Nv. ${Meta.charLevel(charId)}</div>` +
        `<div class="char-gears">${gearBadges(charId)}</div>` +
        `<button class="slot-remove">✕</button>`;
      card.querySelector(".slot-remove").onclick = (e) => { e.stopPropagation(); Meta.unassignSlot(slot.id); renderMenu(); };
      card.onclick = () => openCharacterPanel(charId);
    } else {
      card.innerHTML = slotResIcon(slot) + `<div class="slot-plus">+</div>`;
      card.onclick = () => openSlotPicker(slot.id);
    }
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

// ---------- Slot attribution widget ----------
// Step 1: pick a race among the slot's containments that isn't already holding
// a slot (each race serves at most once), shown via its lowest-rarity character.
// Step 2: pick the character — owned first (rarity desc), then locked greyed
// (rarity asc; tap opens the detail panel to see the unlock cost).
let pickerSlotId = null, pickerRace = null;

function openSlotPicker(slotId) { pickerSlotId = slotId; pickerRace = null; renderSlotPicker(); openOverlay("slot-overlay"); }
function closeSlotPicker() { pickerSlotId = null; pickerRace = null; $("#slot-overlay").classList.add("hidden"); }

function renderSlotPicker() {
  const slot = Game.cfg.characterSlots.find((s) => s.id === pickerSlotId); if (!slot) return;
  const body = $("#slot-body"); body.innerHTML = "";
  const head = el("div", "sp-head");
  head.innerHTML = (pickerRace ? `<button id="sp-back" class="ghost">←</button>` : "") + slotResIcon(slot) + `<b>${pickerRace || "Choisis une race"}</b>`;
  body.appendChild(head);
  if (pickerRace) { const b = head.querySelector("#sp-back"); if (b) b.onclick = () => { pickerRace = null; renderSlotPicker(); }; }
  const grid = el("div", "sp-grid");
  body.appendChild(grid);

  const byRace = (race) => Game.cfg.characterOrder.map((id) => Game.cfg.characters[id]).filter((c) => c.typeSlot === race);

  if (!pickerRace) {
    const used = Meta.assignedRaces(slot.id);
    slot.containments.forEach((race) => {
      const chars = byRace(race);
      if (!chars.length) return;
      const rep = chars.reduce((a, b) => (rarityIdx(b) < rarityIdx(a) ? b : a));
      const taken = used.includes(race);
      const card = el("div", "sp-card" + (taken ? " off" : ""));
      card.innerHTML = charAvatar(rep) + `<div class="char-name">${race}</div>` + (taken ? `<div class="char-lvl">déjà en poste</div>` : "");
      if (!taken) card.onclick = () => { pickerRace = race; renderSlotPicker(); };
      grid.appendChild(card);
    });
  } else {
    const chars = byRace(pickerRace);
    const owned = chars.filter((c) => Meta.isOwned(c.id)).sort((a, b) => rarityIdx(b) - rarityIdx(a));
    const locked = chars.filter((c) => !Meta.isOwned(c.id)).sort((a, b) => rarityIdx(a) - rarityIdx(b));
    owned.concat(locked).forEach((c) => {
      const has = Meta.isOwned(c.id);
      const card = el("div", "sp-card " + charRarity(c) + (has ? "" : " off"));
      card.innerHTML = charAvatar(c) +
        `<div class="char-name">${c.displayName}</div>` +
        `<div class="char-lvl">${has ? "Nv. " + Meta.charLevel(c.id) : "🔒"}</div>`;
      card.onclick = () => {
        if (has) {
          if (Meta.assignSlot(pickerSlotId, c.id)) { closeSlotPicker(); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); }
        } else openCharacterPanel(c.id); // detail panel: unlock cost, shards
      };
      grid.appendChild(card);
    });
  }
}

// Small colored slot emojis showing what a character is wearing.
export function gearBadges(charId) {
  const eq = Meta.state.equipment[charId] || {};
  return ["hat", "suit", "shoes"].map((slot) => {
    const inst = eq[slot] && Meta.gearInst(eq[slot]);
    return inst ? `<span class="gear-badge ${inst.rarity}" title="${gearInstName(inst)}">${SLOT_EMOJI[slot]}</span>` : "";
  }).join("");
}

// ---------- Character detail panel (menu + in-game) ----------
let panelChar = null;
export function openCharacterPanel(charId) {
  panelChar = charId;
  renderCharacterPanel();
  openOverlay("character-overlay");
}
export function closeCharacterPanel() { panelChar = null; $("#character-overlay").classList.add("hidden"); }

function renderCharacterPanel() {
  const id = panelChar; if (!id) return;
  const body = $("#character-body");
  const ch = Game.cfg.characters[id];
  const owned = Meta.isOwned(id);
  const lvl = Meta.charLevel(id);
  const speed = Meta.charSpeed(id); // progress% × multiplier at the current level

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

  // the machines this character boosts — tap a building to inspect it
  const aff = ch.machines.map((mid) => {
    const m = Game.cfg.machines.find((x) => x.id === mid);
    return `<div class="cd-aff" data-mid="${mid}"><img src="${m ? sprite(m.spriteId, "Machines") : ""}"><span>${m ? m.displayName : mid}</span><b>+${Math.round(speed * 100)}%</b></div>`;
  }).join("");
  const p2 = Meta.proba2x(id);

  // gear slots (equipped instances)
  const eq = Meta.state.equipment[id] || {};
  const slots = ["hat", "suit", "shoes"].map((slot) => {
    const inst = eq[slot] && Meta.gearInst(eq[slot]);
    const def = inst && Meta.gearDef(inst);
    return `<div class="cd-slot ${inst ? inst.rarity : "empty"}" data-slot="${slot}">
      <span class="cd-slot-ico">${SLOT_EMOJI[slot]}</span>
      <span class="cd-slot-name">${inst ? gearInstName(inst) : SLOT_LABEL[slot] + " — vide"}</span>
      ${inst ? `<span class="cd-slot-fx">⚡${Math.round(def.speed * 100)}% 🎲${Math.round(def.proba2x * 100)}%</span>` : ""}
    </div>`;
  }).join("");

  // upgrade (paid in the character's own shards)
  const cost = Meta.upgradeCost(id);
  let upg = "";
  if (cost) {
    const have = Meta.charShards(id);
    const ok = have >= cost.amount;
    upg = `<div class="cd-upgrade">
      <span>${owned ? `Passer Nv. ${cost.level}` : "Débloquer"} : <b class="${ok ? "ok" : "danger"}">${cost.amount} 🔷</b> <span class="menu-muted">(tu as ${have})</span></span>
      <button id="cd-upgrade-btn"${ok ? "" : " disabled"}>${owned ? "Améliorer ⬆" : "Débloquer 🔓"}</button>
    </div>`;
  } else if (owned) {
    upg = `<div class="cd-upgrade"><span class="menu-muted">Niveau maximum atteint ✨</span></div>`;
  }

  body.innerHTML =
    `<div class="cp-head">
      <img class="cp-skin" src="${ch.spriteId ? sprite(ch.spriteId, "Characters") : sprite("Worker", "UI")}" onerror="this.onerror=null;this.src='${sprite("Worker", "UI")}'">
      <div class="cp-id">
        <div class="cp-name">${ch.displayName} ${owned ? `<span class="lvl">Nv.${lvl}</span>` : '<span class="cp-elim">verrouillé</span>'}</div>
        <div class="cp-tags"><span class="cp-tag">${(ch.profile || "").replace("_character", "")}</span>${ch.typeSlot ? `<span class="cp-tag">${ch.typeSlot}</span>` : ""}</div>
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
  if (owned) body.querySelectorAll(".cd-slot").forEach((n) => { n.onclick = () => showGearEditor(id, n.dataset.slot); });
  body.querySelectorAll(".cd-aff[data-mid]").forEach((n) => { n.onclick = () => openBuildingPanel(n.dataset.mid); });
}

// Per-slot gear editor shown inside a character panel.
//  - empty slot  -> pick one of the hero's orphan gears to equip
//  - filled slot -> upgrade (fuse) the equipped gear with the hero's other
//    orphan gears as fuel, or remove it.
let editorFuel = new Set();   // fuel uids selected in the upgrade view
function showGearEditor(charId, slot) { editorFuel = new Set(); renderGearEditor(charId, slot); }

function renderGearEditor(charId, slot) {
  const wrap = $("#cd-gearpick"); wrap.innerHTML = "";
  const box = el("div", "gearpick");
  const eq = Meta.state.equipment[charId] || {};
  const equipped = eq[slot] && Meta.gearInst(eq[slot]);
  const done = () => { renderCharacterPanel(); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); };

  if (!equipped) {
    // --- equip view: hero's orphan gears for this slot ---
    box.appendChild(el("div", "menu-section", `${SLOT_LABEL[slot]} — équiper`));
    const orphans = Meta.orphanGears(charId, slot);
    orphans.forEach((inst) => {
      const def = Meta.gearDef(inst);
      const it = el("button", `gp-item ${inst.rarity}`,
        `${SLOT_EMOJI[slot]} ${gearInstName(inst)} — ⚡${Math.round(def.speed * 100)}% 🎲${Math.round(def.proba2x * 100)}%`);
      it.onclick = () => { Meta.equip(charId, inst.uid); renderCharacterPanel(); showGearEditor(charId, slot); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); };
      box.appendChild(it);
    });
    if (!orphans.length) box.appendChild(el("div", "menu-muted", "Aucun équipement libre de ce type — ouvre des coffres !"));
  } else {
    // --- upgrade view: fuse the equipped gear ---
    box.appendChild(el("div", "menu-section", gearInstName(equipped)));
    if (Meta.canUpgradeGear(equipped)) {
      const threshold = Meta.gearThreshold(equipped);
      const pending = [...editorFuel].reduce((s, u) => { const f = Meta.gearInst(u); return s + (f ? Meta.gearFuel(f) : 0); }, 0);
      const total = equipped.progress + pending;
      const next = RARITIES[RARITIES.indexOf(equipped.rarity) + 1];
      const curPct = threshold > 0 ? Math.min(100, (equipped.progress / threshold) * 100) : 0;
      const addPct = threshold > 0 ? Math.min(100 - curPct, (pending / threshold) * 100) : 0;
      const panel = el("div", "cd-fuse");
      panel.innerHTML =
        `<div class="fuse-base-name">Améliorer → <span class="fuse-arrow">${RARITY_LABEL[next]}</span></div>
         <div class="fuse-bar"><span class="fuse-bar-cur" style="width:${curPct}%"></span><span class="fuse-bar-add" style="width:${addPct}%"></span></div>
         <div class="fuse-bar-label">${total} / ${threshold}${total >= threshold ? " ✅" : ""}</div>`;
      box.appendChild(panel);

      const fuel = Meta.orphanGears(charId);   // any of the hero's free gears
      if (fuel.length) {
        box.appendChild(el("div", "menu-muted", "Carburant (équipements libres) :"));
        const grid = el("div", "fuse-grid");
        fuel.forEach((inst) => {
          const tile = el("div", `fuse-tile ${inst.rarity}` + (editorFuel.has(inst.uid) ? " fuel" : ""));
          tile.innerHTML =
            `<span class="ft-ico">${SLOT_EMOJI[inst.slot]}</span>` +
            `<span class="ft-name">${gearInstName(inst)}</span>` +
            `<span class="ft-fuel">🔥${Meta.gearFuel(inst)}</span>`;
          tile.onclick = () => { if (editorFuel.has(inst.uid)) editorFuel.delete(inst.uid); else editorFuel.add(inst.uid); renderGearEditor(charId, slot); };
          grid.appendChild(tile);
        });
        box.appendChild(grid);
      } else {
        box.appendChild(el("div", "menu-muted", "Aucun équipement libre à fusionner."));
      }
      const go = el("button", "fuse-go", pending > 0 ? `Fusionner (+${pending})` : "Choisis du carburant");
      go.disabled = pending <= 0;
      go.onclick = () => { if (Meta.fuse(equipped.uid, [...editorFuel])) { renderCharacterPanel(); showGearEditor(charId, slot); renderMenu(); if (Game.onMetaChanged) Game.onMetaChanged(); } };
      box.appendChild(go);
    } else {
      box.appendChild(el("div", "menu-muted", "Rareté maximale atteinte ✨"));
    }
    const off = el("button", "gp-item remove", `Retirer`);
    off.onclick = () => { Meta.unequip(charId, slot); done(); };
    box.appendChild(off);
  }
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
  if (d.type === "gear") return d.rarity;
  if (d.type === "chest") return rarityOf(d.id);
  return "";
}
function dropHtml(d) {
  if (d.type === "coins") return `<img src="${sprite("Coins", "UI")}"><span>+${d.amount} pièces</span>`;
  if (d.type === "gems") return `<span class="drop-ico">💎</span><span>+${d.amount} gemmes</span>`;
  if (d.type === "shard") return `<span class="drop-ico">🔷</span><span>+${d.amount} éclats ${d.charId}</span>`;
  if (d.type === "chest") return `<span class="drop-ico">🎁</span><span>+${d.amount} ${CHEST_LABEL[d.id] || d.id}</span>`;
  if (d.type === "gear") return `<span class="drop-ico">${SLOT_EMOJI[d.slot]}</span><span>+${d.amount} ${gearName(d.slot, d.rarity, d.owner)}</span>`;
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
