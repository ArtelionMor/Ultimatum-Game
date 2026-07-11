/* Market Ultimatum — codex.js
 * Customers & resources browser. Two tabs on top; the customers tab has its own
 * pages, the resources tab is a grid that hands off to the shared resource
 * widget (resource.js). Opening from a specific customer jumps to its page.
 *  - customer page: everything it wants to buy (tap a want -> resource widget)
 *  - resource: opens openResource() overlay, same as everywhere else
 */
"use strict";

import { $, el, sprite, openOverlay } from "./helpers.js";
import { openResource } from "./resource.js";

let Game = null;
let tab = "customers";   // "customers" | "resources"
let selected = null;     // id inside the current tab; null = grid view

export function initCodex(game) {
  Game = game;
  $("#codex-close").addEventListener("click", closeCodex);
  $("#codex-overlay").addEventListener("click", (e) => { if (e.target.id === "codex-overlay") closeCodex(); });
  $("#codex-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { tab = b.dataset.tab; selected = null; renderCodex(); }   // tab switch -> grid
  });
}

export function openCodexCustomer(custId) { tab = "customers"; selected = custId; show(); }
function show() { renderCodex(); openOverlay("codex-overlay"); }
export function closeCodex() { $("#codex-overlay").classList.add("hidden"); }

const res = (id) => Game.cfg.resources[id] || { displayName: id, spriteId: "", description: "", tiers: {} };
const cust = (id) => Game.cfg.customerDefs[id];
const resIcon = (r) => (r.tiers && r.tiers[1] && r.tiers[1].spriteId) || r.spriteId;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderCodex() {
  $("#codex-tabs").querySelectorAll("button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = $("#codex-body"); body.innerHTML = "";
  if (tab === "customers") { if (selected) renderCustomer(body, selected); else renderCustomerGrid(body); }
  else renderResourceGrid(body);   // resources open in the shared resource widget (overlay)
}

function backLink(label) {
  const b = el("button", "codex-back", "← " + label);
  b.onclick = () => { selected = null; renderCodex(); };
  return b;
}

// ---------- Grids ----------
function renderCustomerGrid(body) {
  const grid = el("div", "codex-grid");
  Game.cfg.customerOrder.forEach((cid) => {
    const c = cust(cid);
    const card = el("button", "codex-card");
    card.innerHTML = `<img src="${sprite(c.spriteId)}"><span>${cap(cid)}</span>`;
    card.onclick = () => { selected = cid; renderCodex(); };
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

function renderResourceGrid(body) {
  const grid = el("div", "codex-grid");
  Game.cfg.resourceOrder.forEach((rid) => {
    const r = res(rid);
    const card = el("button", "codex-card");
    card.innerHTML = `<img src="${sprite(resIcon(r))}"><span>${r.displayName}</span>`;
    card.onclick = () => openResource(rid);
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

// ---------- Customer page ----------
function renderCustomer(body, cid) {
  const c = cust(cid); if (!c) { selected = null; renderCodex(); return; }
  body.appendChild(backLink("Tous les clients"));
  body.appendChild(el("div", "codex-head",
    `<img src="${sprite(c.spriteId)}"><div class="codex-name">${cap(cid)}</div>`));
  body.appendChild(el("div", "cp-section", "Veut acheter"));
  if (!c.needs.length) body.appendChild(el("div", "menu-muted", "Ne demande rien pour l'instant."));
  c.needs.forEach((rid) => {
    const r = res(rid);
    const row = el("button", "codex-row");
    row.innerHTML = `<img src="${sprite(resIcon(r))}"><span>${r.displayName}</span><span class="codex-go">›</span>`;
    row.onclick = () => openResource(rid);
    body.appendChild(row);
  });
}
