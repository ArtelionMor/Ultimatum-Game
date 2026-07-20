/* Market Ultimatum — building.js
 * Building detail widget: tap a building anywhere (character affinities, recipe
 * graph nodes…) to see what it is, what it produces, which customers that
 * attracts, and a pan/zoomable recipe graph of everything it's involved in.
 *
 * Graph readability rules:
 *  - only relevant nodes: the building's ingredient chain (upstream), every
 *    recipe it feeds (downstream), and the OTHER ingredients those recipes
 *    need (context, dimmed) — so each recipe always shows all its underlyings.
 *  - color code: gold = this building, teal = its ingredients, pink = recipes
 *    using it, grey = context ingredients.
 *  - tap any node to refocus the widget on that building.
 */
"use strict";

import { $, el, sprite, openOverlay } from "./helpers.js";
import { openCodexCustomer } from "./codex.js";
import { openResource } from "./resource.js";

let Game = null;
let current = null;   // focused machine id
let showUses = true;  // graph scope: true = recipes using this building too, false = only its ingredient chain
let fixedLevel = null; // drop-rate level fixed by context (in-game machine level); null = meta -> level dropdown
let dropLevel = 1;     // level currently shown in the drop-rate section (dropdown value in meta)

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 150, NODE_H = 56, COL_GAP = 205, ROW_GAP = 78;

export function initBuildingPanel(game) {
  Game = game;
  $("#building-close").addEventListener("click", closeBuildingPanel);
  $("#building-overlay").addEventListener("click", (e) => { if (e.target.id === "building-overlay") closeBuildingPanel(); });
}

// ctx.level (in-game machine level) fixes the drop-rate section to that level and
// hides the level dropdown; without it (meta) the dropdown lets you preview any level.
export function openBuildingPanel(machineId, ctx = {}) {
  if (!Game || !Game.cfg.machines.some((m) => m.id === machineId)) return;
  current = machineId;
  fixedLevel = ctx.level != null ? ctx.level : null;
  dropLevel = fixedLevel != null ? fixedLevel : 1;
  renderBuildingPanel();
  openOverlay("building-overlay");
}
export function closeBuildingPanel() { current = null; $("#building-overlay").classList.add("hidden"); }

const machineDef = (id) => Game.cfg.machines.find((m) => m.id === id);
const res = (id) => Game.cfg.resources[id] || { displayName: id, spriteId: "", description: "" };

// All customers attracted by a product. Shaped as a list so several customers
// per product (and shared customers across products) keep working later.
function customersFor(resId) {
  return Game.cfg.customerOrder
    .filter((cid) => Game.cfg.customerDefs[cid].needs.includes(resId))
    .map((cid) => Game.cfg.customerDefs[cid]);
}
// A machine's products, as a list (single `outputs` today, may grow).
const productsOf = (m) => (m.outputs ? [m.outputs] : []);

// ---------- Drop rate (tier distribution of the dominant "A" group) ----------
// Colors per tier for the drop-rate bars (T1 -> T6). Data-driven elsewhere: only
// these presentation colors are hard-coded; every percentage comes from config.
const TIER_COLORS = ["#7ed957", "#57b6d9", "#9b7bf1", "#e07be0", "#f0932b", "#e05b5b"];
// Levels a resource actually defines in _outputs, sorted ascending.
const levelsFor = (rid) => {
  const out = Game.cfg._outputs || {};
  return Object.keys(out).map((k) => (k.startsWith(rid + "_") ? +k.slice(rid.length + 1) : NaN))
    .filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
};
// Group-A tier percentages [t1..t6] for a resource at a level (falls back to L1).
const dropTiers = (rid, level) => {
  const out = Game.cfg._outputs || {};
  const rows = out[rid + "_" + level] || out[rid + "_1"] || [];
  const a = rows.find((r) => r.group === "A") || rows[0];
  return a ? a.tiers : null;
};

// ---------- Recipe graph data ----------
// Nodes are machine ids, plus "res:<id>" pseudo-nodes for raw ingredients that
// no machine produces. Edge src->dst means "src's output is an ingredient of dst".
function buildGraphIndex() {
  const prodBy = {};                    // resId -> machine ids producing it
  Game.cfg.machines.forEach((m) => { if (m.outputs) (prodBy[m.outputs] = prodBy[m.outputs] || []).push(m.id); });
  const parents = {}, children = {};    // nodeId -> [{node, qty}] / [nodeId]
  const P = (id) => (parents[id] = parents[id] || []);
  const C = (id) => (children[id] = children[id] || []);
  Game.cfg.machines.forEach((m) => {
    m.inputs.forEach((inp) => {
      const prods = prodBy[inp.type] || [];
      if (prods.length) prods.forEach((p) => { P(m.id).push({ node: p, qty: inp.quantity }); C(p).push(m.id); });
      else { const rn = "res:" + inp.type; P(m.id).push({ node: rn, qty: inp.quantity }); C(rn).push(m.id); }
    });
  });
  return { parents, children };
}

function collect(startIds, adj) {       // BFS over an adjacency map
  const seen = new Set();
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift();
    (adj[id] || []).forEach((e) => {
      const n = typeof e === "string" ? e : e.node;
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    });
  }
  return seen;
}

// Relevant subgraph around a focus machine + relation of each node.
// includeUses=false limits the graph to the ingredient chain up to the focus.
function relevantGraph(focusId, includeUses) {
  const { parents, children } = buildGraphIndex();
  const up = collect([focusId], parents);                       // ingredient chain
  const down = includeUses ? collect([focusId], children) : new Set();  // recipes using it
  const ctx = new Set();                                        // other ingredients of those recipes
  collect([...down], parents).forEach((n) => { if (n !== focusId && !up.has(n) && !down.has(n)) ctx.add(n); });
  const rel = new Map([[focusId, "focus"]]);
  up.forEach((n) => rel.set(n, "up"));
  down.forEach((n) => rel.set(n, "down"));
  ctx.forEach((n) => rel.set(n, "ctx"));
  // edges inside the relevant set
  const edges = [];
  rel.forEach((_, id) => {
    (parents[id] || []).forEach((p) => { if (rel.has(p.node)) edges.push({ from: p.node, to: id, qty: p.qty }); });
  });
  return { rel, edges };
}

// Layered layout: column = longest path from a source, rows centered per column.
function layout(rel, edges) {
  const parentsOf = {};
  edges.forEach((e) => { (parentsOf[e.to] = parentsOf[e.to] || []).push(e.from); });
  const depth = {};
  const depthOf = (id, trail = new Set()) => {
    if (depth[id] != null) return depth[id];
    if (trail.has(id)) return 0;                      // cycle guard
    trail.add(id);
    const ps = parentsOf[id] || [];
    depth[id] = ps.length ? 1 + Math.max(...ps.map((p) => depthOf(p, trail))) : 0;
    return depth[id];
  };
  const cols = {};
  [...rel.keys()].forEach((id) => { const d = depthOf(id); (cols[d] = cols[d] || []).push(id); });
  const pos = {};
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((d) => {
    // order rows by average parent row to limit edge crossings
    const order = cols[d].map((id) => {
      const ps = (parentsOf[id] || []).map((p) => (pos[p] ? pos[p].row : 0));
      return { id, key: ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : 0 };
    }).sort((a, b) => a.key - b.key);
    order.forEach((o, i) => { pos[o.id] = { row: i, x: d * COL_GAP, y: i * ROW_GAP - ((order.length - 1) * ROW_GAP) / 2 }; });
  });
  return pos;
}

// ---------- Widget ----------
function renderBuildingPanel() {
  const m = machineDef(current); if (!m) return;
  const body = $("#building-body");
  const products = productsOf(m);
  const desc = products.map((r) => res(r).description).find((d) => d) || "";

  // products + attracted customers (a row per product; supports several later)
  // — tap the product or a customer to open its codex page
  const prodRows = products.map((rid) => {
    const r = res(rid);
    const cust = customersFor(rid);
    const custHtml = cust.length
      ? cust.map((c) => `<img class="bp-cust" data-cust="${c.id}" src="${sprite(c.spriteId, "Characters")}" title="Client attiré">`).join("")
      : `<span class="menu-muted">aucun client direct</span>`;
    return `<div class="bp-prod"><button class="bp-res" data-res="${rid}"><img src="${sprite(r.spriteId, "Ressources")}"><span class="bp-prod-name">${r.displayName}</span></button><span class="bp-attract">→</span>${custHtml}</div>`;
  }).join("") || `<div class="menu-muted">Ne produit rien directement.</div>`;

  body.innerHTML =
    `<div class="bp-head">
      <img class="bp-sprite" src="${sprite(m.spriteId, "Machines")}">
      <div><div class="bp-name">${m.displayName}</div>
      ${desc ? `<div class="bp-desc">${desc}</div>` : ""}</div>
    </div>
    <div class="cp-section">Production & clients</div>
    <div class="bp-prods">${prodRows}</div>
    ${m.outputs ? `<div class="cp-section">Drop rate — Groupe A</div><div id="bp-drop-slot"></div>` : ""}
    <div class="cp-section">Recettes</div>
    <div id="bp-graph-slot"></div>`;

  body.querySelectorAll("[data-res]").forEach((n) => { n.onclick = () => openResource(n.dataset.res); });
  body.querySelectorAll("[data-cust]").forEach((n) => { n.onclick = () => openCodexCustomer(n.dataset.cust); });
  if (m.outputs) renderDropRate($("#bp-drop-slot"), m.outputs);
  renderGraph($("#bp-graph-slot"), m.id);
}

// Drop-rate section: an optional level dropdown (meta only) + one bar per tier
// showing the group-A tier probabilities at `dropLevel`. Rebuilt in place on
// dropdown change so it stays dynamic when the config gets rebalanced later.
function renderDropRate(slot, rid) {
  slot.innerHTML = "";
  const levels = levelsFor(rid);
  if (!levels.length) { slot.appendChild(el("div", "menu-muted", "Pas de table de drop pour cette ressource.")); return; }
  if (!levels.includes(dropLevel)) dropLevel = levels[0];

  // level picker (meta): fixed level in-game -> just a label; otherwise a compact
  // stepper (‹ Niveau N ›) that walks the defined levels — mobile-friendly, no
  // native full-screen <select>.
  if (fixedLevel != null) {
    slot.appendChild(el("div", "bp-drop-lvl", `Niveau ${dropLevel}`));
  } else {
    const i = levels.indexOf(dropLevel);
    const step = el("div", "bp-drop-pick", `<span>Niveau</span>`);
    const stepper = el("div", "bp-drop-step");
    const prev = el("button", "bp-drop-arrow", "‹");
    const val = el("div", "bp-drop-val", `Niveau ${dropLevel}`);
    const next = el("button", "bp-drop-arrow", "›");
    prev.disabled = i <= 0;
    next.disabled = i >= levels.length - 1;
    prev.onclick = () => { if (i > 0) { dropLevel = levels[i - 1]; renderDropRate(slot, rid); } };
    next.onclick = () => { if (i < levels.length - 1) { dropLevel = levels[i + 1]; renderDropRate(slot, rid); } };
    stepper.append(prev, val, next);
    step.appendChild(stepper);
    slot.appendChild(step);
  }

  const tiers = dropTiers(rid, dropLevel);
  if (!tiers) return;
  const maxT = Game.cfg.maxTier;
  // Config values are weights, not percentages: normalize over the group's total.
  const totalW = tiers.reduce((s, w) => s + (w || 0), 0);
  const bars = el("div", "bp-drop-bars");
  for (let t = 1; t <= maxT; t++) {
    const pct = totalW > 0 ? Math.round(((tiers[t - 1] || 0) / totalW) * 100) : 0;
    const row = el("div", "bp-drop-row" + (pct > 0 ? "" : " zero"));
    const tSprite = (res(rid).tiers[t] || {}).spriteId || res(rid).spriteId;
    const img = `<img class="bp-drop-icon" src="${sprite(tSprite, "Ressources")}">`;
    const track = `<div class="bp-drop-track"><div class="bp-drop-fill" style="width:${pct}%;background:${TIER_COLORS[t - 1] || "#888"}"></div></div>`;
    row.innerHTML = `${img}<span class="bp-drop-name">Tier ${t}</span>${track}<span class="bp-drop-pct">${pct}%</span>`;
    bars.appendChild(row);
  }
  slot.appendChild(bars);
}

function renderGraph(slot, focusId) {
  const { rel, edges } = relevantGraph(focusId, showUses);

  // scope toggle: every interacting recipe, or only the chain up to this building
  slot.innerHTML =
    `<label class="bg-toggle"><input type="checkbox" id="bg-uses"${showUses ? " checked" : ""}>
      Afficher les recettes qui utilisent ce bâtiment</label>`;
  slot.querySelector("#bg-uses").onchange = (e) => { showUses = e.target.checked; renderGraph(slot, focusId); };

  // a base-resource building with no recipe still renders: one lone block on the canvas
  const pos = layout(rel, edges);

  slot.appendChild(el("div", "bg-legend",
    `<span><i class="dot focus"></i>Ce bâtiment</span><span><i class="dot up"></i>Ingrédients</span>` +
    (showUses ? `<span><i class="dot down"></i>Utilisé dans</span><span><i class="dot ctx"></i>Autres ingrédients</span>` : "")));
  const box = el("div", "bgraph");
  slot.appendChild(box);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
  box.appendChild(svg);

  // arrowheads per relation color
  const defs = document.createElementNS(SVG_NS, "defs");
  ["up", "down", "ctx"].forEach((k) => {
    const mk = document.createElementNS(SVG_NS, "marker");
    mk.setAttribute("id", "arr-" + k); mk.setAttribute("viewBox", "0 0 10 10");
    mk.setAttribute("refX", "9"); mk.setAttribute("refY", "5");
    mk.setAttribute("markerWidth", "7"); mk.setAttribute("markerHeight", "7"); mk.setAttribute("orient", "auto-start-reverse");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "M0,0 L10,5 L0,10 z"); p.setAttribute("class", "arr " + k);
    mk.appendChild(p); defs.appendChild(mk);
  });
  svg.appendChild(defs);

  // edges under nodes
  edges.forEach((e) => {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const kind = edgeKind(rel.get(e.from), rel.get(e.to));
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
    path.setAttribute("class", "bedge " + kind);
    path.setAttribute("marker-end", `url(#arr-${kind})`);
    svg.appendChild(path);
    if (e.qty > 1) {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", (x1 + x2) / 2); t.setAttribute("y", (y1 + y2) / 2 - 4);
      t.setAttribute("class", "edge-lbl"); t.setAttribute("text-anchor", "middle");
      t.textContent = "×" + e.qty;
      svg.appendChild(t);
    }
  });

  // nodes
  rel.forEach((kind, id) => {
    const p = pos[id];
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "bn " + kind);
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", NODE_W); rect.setAttribute("height", NODE_H); rect.setAttribute("rx", 10);
    g.appendChild(rect);

    let name, spriteId, isMachine = !id.startsWith("res:");
    if (isMachine) { const md = machineDef(id); name = md.displayName; spriteId = md.spriteId; }
    else { const r = res(id.slice(4)); name = r.displayName; spriteId = r.tiers ? (r.tiers[1] || {}).spriteId || r.spriteId : r.spriteId; }

    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("href", sprite(spriteId, isMachine ? "Machines" : "Ressources"));
    img.setAttribute("x", 6); img.setAttribute("y", 10); img.setAttribute("width", 36); img.setAttribute("height", 36);
    g.appendChild(img);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", 48); text.setAttribute("y", 22); text.setAttribute("class", "bn-name");
    wrapName(name).forEach((line, i) => {
      const ts = document.createElementNS(SVG_NS, "tspan");
      ts.setAttribute("x", 48); ts.setAttribute("dy", i === 0 ? 0 : 12);
      ts.textContent = line;
      text.appendChild(ts);
    });
    g.appendChild(text);

    // mini icons: what it produces (+ attracted customer) — readable, and each
    // opens its own codex page (the rest of the node refocuses the building).
    const iconClick = (node, fn) => node.addEventListener("click", (e) => { if (svg._dragDist > 6) return; e.stopPropagation(); fn(); });
    if (isMachine) {
      const md = machineDef(id);
      let ix = NODE_W - 20;
      productsOf(md).forEach((rid) => {
        customersFor(rid).forEach((c) => {
          const ci = document.createElementNS(SVG_NS, "image");
          ci.setAttribute("href", sprite(c.spriteId, "Characters")); ci.setAttribute("class", "bn-mini");
          ci.setAttribute("x", ix); ci.setAttribute("y", NODE_H - 20); ci.setAttribute("width", 16); ci.setAttribute("height", 16);
          iconClick(ci, () => openCodexCustomer(c.id));
          g.appendChild(ci); ix -= 18;
        });
        const oi = document.createElementNS(SVG_NS, "image");
        oi.setAttribute("href", sprite(res(rid).spriteId, "Ressources")); oi.setAttribute("class", "bn-mini");
        oi.setAttribute("x", ix); oi.setAttribute("y", NODE_H - 20); oi.setAttribute("width", 16); oi.setAttribute("height", 16);
        iconClick(oi, () => openResource(rid));
        g.appendChild(oi); ix -= 18;
      });
      g.addEventListener("click", () => { if (svg._dragDist > 6) return; openBuildingPanel(id); });
    } else {
      iconClick(g, () => openResource(id.slice(4)));   // raw-resource node -> its resource widget
    }
    svg.appendChild(g);
  });

  // initial view: fit everything (finger/wheel zoom from there)
  const xs = [...rel.keys()].map((id) => pos[id].x), ys = [...rel.keys()].map((id) => pos[id].y);
  const pad = 24;
  const vb = {
    x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + NODE_W + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + NODE_H + pad * 2,
  };
  setupPanZoom(svg, vb);
}

function edgeKind(srcRel, dstRel) {
  if (dstRel === "focus" || (srcRel === "up" && dstRel === "up")) return "up";
  if ((srcRel === "focus" || srcRel === "down") && dstRel === "down") return "down";
  return "ctx";
}

function wrapName(name, max = 14) {
  const words = String(name).split(" ");
  const lines = [""];
  words.forEach((w) => {
    if ((lines[lines.length - 1] + " " + w).trim().length <= max) lines[lines.length - 1] = (lines[lines.length - 1] + " " + w).trim();
    else lines.push(w);
  });
  if (lines.length > 2) { lines.length = 2; lines[1] = lines[1].slice(0, max - 1) + "…"; }
  return lines;
}

// ---------- Pan / zoom (mouse drag + wheel, touch drag + pinch) ----------
function setupPanZoom(svg, vb) {
  const apply = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  apply();
  const minW = 200, maxW = vb.w * 4;
  const scale = () => vb.w / svg.getBoundingClientRect().width;

  const zoomAt = (cx, cy, f) => {          // f > 1 zooms out
    const r = svg.getBoundingClientRect();
    const px = vb.x + (cx - r.left) * (vb.w / r.width);
    const py = vb.y + (cy - r.top) * (vb.h / r.height);
    const w = Math.min(maxW, Math.max(minW, vb.w * f));
    const realF = w / vb.w;
    vb.x = px - (px - vb.x) * realF; vb.y = py - (py - vb.y) * realF;
    vb.w *= realF; vb.h *= realF;
    apply();
  };

  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });

  const pointers = new Map();
  let lastPinch = 0;
  svg._dragDist = 0;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) svg._dragDist = 0;
  });
  svg.addEventListener("pointermove", (e) => {
    const pt = pointers.get(e.pointerId); if (!pt) return;
    if (pointers.size === 1) {
      const s = scale();
      vb.x -= (e.clientX - pt.x) * s; vb.y -= (e.clientY - pt.y) * s;
      svg._dragDist += Math.abs(e.clientX - pt.x) + Math.abs(e.clientY - pt.y);
      apply();
    } else if (pointers.size === 2) {
      svg._dragDist = 99;
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastPinch > 0 && dist > 0) zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, lastPinch / dist);
      lastPinch = dist;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
}
