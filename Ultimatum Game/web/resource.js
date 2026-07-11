/* Market Ultimatum — resource.js
 * The single resource detail widget, called from every context (inventory,
 * codex grid, recipe graph nodes, customer wants…). Shows what a resource is,
 * which machine produces it, its tiers & prices, and which customers want it.
 *
 * Reused everywhere, so context-specific extras are opt-in via `ctx`:
 *   { player }      -> show the ×count owned per tier (in-game inventory)
 *   { allowRefine } -> show the "Raffiner" action when the resource is refinable
 * No ctx = pure reference mode (codex / meta), where none of that applies.
 */
"use strict";

import { $, el, sprite, openOverlay } from "./helpers.js";
import { openBuildingPanel } from "./building.js";
import { openCodexCustomer } from "./codex.js";

let Game = null;
let current = null;   // focused resource id
let context = {};     // { player, allowRefine }

const res = (id) => Game.cfg.resources[id] || { displayName: id, spriteId: "", description: "", tiers: {} };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const producersOf = (rid) => Game.cfg.machines.filter((m) => m.outputs === rid);
const customersWanting = (rid) => (Game.cfg.customerOrder || []).filter((cid) => Game.cfg.customerDefs[cid].needs.includes(rid));

export function initResourcePanel(game) {
  Game = game;
  $("#resource-close").addEventListener("click", closeResource);
  $("#resource-overlay").addEventListener("click", (e) => { if (e.target.id === "resource-overlay") closeResource(); });
}

export function openResource(rid, ctx = {}) {
  if (!Game || !Game.cfg.resources[rid]) return;
  current = rid; context = ctx || {};
  renderResourcePanel();
  openOverlay("resource-overlay");
}
export function closeResource() { current = null; context = {}; $("#resource-overlay").classList.add("hidden"); }

function renderResourcePanel() {
  const rid = current; if (!rid) return;
  const r = res(rid), maxT = Game.cfg.maxTier;
  const body = $("#resource-body"); body.innerHTML = "";

  // --- head + description ---
  const headTier = context.player ? (Game.bestTier(context.player, rid) || 1) : 1;
  body.appendChild(el("div", "cp-head",
    `<img class="cp-skin" src="${Game.tierSrc(rid, headTier)}">
     <div class="cp-id">
       <div class="cp-name">${r.displayName}</div>
       <div class="cp-tags"><span class="cp-tag">#${rid}</span></div>
     </div>`));
  body.appendChild(el("div", "res-desc" + (r.description ? "" : " muted"),
    r.description || `Pas encore de description — ajoute "description" à cette ressource dans le config.`));

  // --- produced by (which machine outputs this resource) ---
  body.appendChild(el("div", "cp-section", "Produit par"));
  const producers = producersOf(rid);
  if (producers.length) {
    const wrap = el("div", "res-custs");
    producers.forEach((m) => {
      const b = el("button", "res-cust", `<img src="${sprite(m.spriteId)}"><span>${m.displayName}</span>`);
      b.onclick = () => openBuildingPanel(m.id);
      wrap.appendChild(b);
    });
    body.appendChild(wrap);
  } else {
    body.appendChild(el("div", "menu-muted", "Matière première — aucune machine ne la produit."));
  }

  // --- tiers (owned counts only when a player is in context) ---
  body.appendChild(el("div", "cp-section", "Tiers"));
  const tiers = el("div", "res-tiers");
  for (let t = 1; t <= maxT; t++) {
    const ti = Game.cfg.resources[rid].tiers[t]; if (!ti) continue;
    const have = context.player ? Game.tierCount(context.player, rid, t) : 0;
    const row = el("div", "res-tier-row" + (have > 0 ? " owned" : ""));
    const img = Game.tierImg(rid, t); img.className = "res-tier-img";
    row.append(
      img,
      el("span", "res-tier-name", `Tier ${t}`),
      el("span", "res-tier-price", `💰 ${ti.price}`),
      el("span", "res-tier-inf", `📣 ${ti.influence}`)
    );
    if (context.player) row.append(el("span", "res-tier-have", `×${have}`));
    tiers.appendChild(row);
  }
  body.appendChild(tiers);

  // --- customers who want this resource -> tap to open its codex page ---
  const wanting = customersWanting(rid);
  if (wanting.length) {
    body.appendChild(el("div", "cp-section", "Clients intéressés"));
    const cwrap = el("div", "res-custs");
    wanting.forEach((cid) => {
      const c = Game.cfg.customerDefs[cid];
      const b = el("button", "res-cust", `<img src="${sprite(c.spriteId)}"><span>${cap(cid)}</span>`);
      b.onclick = () => openCodexCustomer(cid);
      cwrap.appendChild(b);
    });
    body.appendChild(cwrap);
  }

  // --- refine action (in-game only) ---
  if (context.allowRefine && Game.cfg.convert[rid]) {
    const btn = el("button", "cv-btn", "🔁 Raffiner");
    btn.onclick = () => { closeResource(); Game.openConvert(rid); };
    body.appendChild(btn);
  }
}
