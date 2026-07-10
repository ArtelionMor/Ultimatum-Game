/* Market Ultimatum — codex.js
 * Customers & resources browser. Two tabs on top; opening from a specific
 * customer/resource jumps straight to its page, switching tabs shows a grid of
 * every entry (tap one to open it).
 *  - customer page: everything it wants to buy (tap a want -> resource page)
 *  - resource page: its tiers & prices (+ which customers want it)
 */
"use strict";

import { $, el, sprite } from "./helpers.js";

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
export function openCodexResource(resId) { tab = "resources"; selected = resId; show(); }
function show() { renderCodex(); $("#codex-overlay").classList.remove("hidden"); }
export function closeCodex() { $("#codex-overlay").classList.add("hidden"); }

const res = (id) => Game.cfg.resources[id] || { displayName: id, spriteId: "", description: "", tiers: {} };
const cust = (id) => Game.cfg.customerDefs[id];
const customersWanting = (resId) => Game.cfg.customerOrder.filter((cid) => cust(cid).needs.includes(resId));
const resIcon = (r) => (r.tiers && r.tiers[1] && r.tiers[1].spriteId) || r.spriteId;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderCodex() {
  $("#codex-tabs").querySelectorAll("button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = $("#codex-body"); body.innerHTML = "";
  if (tab === "customers") { if (selected) renderCustomer(body, selected); else renderCustomerGrid(body); }
  else { if (selected) renderResource(body, selected); else renderResourceGrid(body); }
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
    card.onclick = () => { selected = rid; renderCodex(); };
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
    row.onclick = () => openCodexResource(rid);
    body.appendChild(row);
  });
}

// ---------- Resource page ----------
function renderResource(body, rid) {
  const r = res(rid);
  body.appendChild(backLink("Toutes les ressources"));
  body.appendChild(el("div", "codex-head",
    `<img src="${sprite(resIcon(r))}"><div><div class="codex-name">${r.displayName}</div>` +
    (r.description ? `<div class="codex-desc">${r.description}</div>` : "") + `</div>`));

  body.appendChild(el("div", "cp-section", "Tiers & prix"));
  Object.keys(r.tiers || {}).map(Number).sort((a, b) => a - b).forEach((t) => {
    const tier = r.tiers[t];
    const row = el("div", "codex-row");
    row.innerHTML = `<img src="${sprite(tier.spriteId)}"><span>Tier ${t}</span>` +
      `<span class="price"><img src="${sprite("Coins")}">${tier.price}</span>`;
    body.appendChild(row);
  });

  const wanting = customersWanting(rid);
  if (wanting.length) {
    body.appendChild(el("div", "cp-section", "Clients intéressés"));
    wanting.forEach((cid) => {
      const c = cust(cid);
      const row = el("button", "codex-row");
      row.innerHTML = `<img src="${sprite(c.spriteId)}"><span>${cap(cid)}</span><span class="codex-go">›</span>`;
      row.onclick = () => openCodexCustomer(cid);
      body.appendChild(row);
    });
  }
}
