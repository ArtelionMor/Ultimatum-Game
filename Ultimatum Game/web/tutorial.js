/* Market Ultimatum — tutorial.js
 * Onboarding overlay driven by the `feature_unlock` sheet.
 *
 * Each row carries a `tutorial` style and a `target` chain:
 *  - black_mask : the screen goes dark except a hole punched over the target.
 *    The game PAUSES and every other control is unreachable until the player
 *    actually performs the action. A hand sprite comes in after HAND_DELAY.
 *  - red_dot    : a badge pinned on the target, cleared by the first click.
 *    Several can live at once; they never block anything.
 *
 * A chain ("character_tab, dog, equip_hat") is walked one click at a time, and
 * how far the player got is persisted (Meta.tutorialStep) so nothing replays.
 *
 * Targets are logical names, mapped to the DOM here — deliberately in code and
 * not in the sheet: selectors follow the markup, which is ours to change, while
 * the sheet follows the design.
 */
"use strict";

import { $ } from "./helpers.js";
import { Meta } from "./meta.js";

const HAND_DELAY = 3;        // seconds of a black_mask on screen before the hand
const EVAL_PERIOD = 0.2;     // seconds between two full re-evaluations
const PAD = 6;               // px of breathing room around a highlighted target

// Logical target name -> CSS selector. Names not listed here fall through to the
// dynamic patterns in resolveSelector() below.
const TARGETS = {
  buy_a_worker: '#shop-bar [data-tut="buy_a_worker"]',
  marketting: '#shop-bar [data-tut="marketting"]',
  storage: '#shop-bar [data-tut="storage"]',
  merge_button: "#inv-merge",
  upgrade_button: "#machine-list .machine button.upgrade",
  // "+" on a machine card: the one-click path to staffing (assignWorker falls
  // back to the first free worker), so it fits inside a single mask hole —
  // drag & drop would need the worker bar open at the same time.
  assign_a_worker: "#machine-list .machine .machine-buttons button:not(.ghost):not(.upgrade)",
  x2_button: '#speed-sel button[data-speed="2"]',
  x4_button: '#speed-sel button[data-speed="4"]',
  chest_tab: '#menu-tabs button[data-tab="chests"]',
  character_tab: '#menu-tabs button[data-tab="characters"]',
  equip_hat: '#character-body .cd-slot[data-slot="hat"]',
  // The sheet calls it hud-money, but the feature it teaches is the end-of-round
  // market breakdown: the target is the "Argent" toggle of that screen's pie.
  hud_money: '[data-tut="results_money_toggle"]',
  results_money_toggle: '[data-tut="results_money_toggle"]',
};

// Outcome targets: what the player must ACHIEVE, not the button they press.
// Staffing a machine can be done three ways (the machine's +, drag & drop, or
// tap-the-worker-then-tap-the-machine), so watching for a click would leave the
// tutorial unfinished whenever the player took another route — and it would then
// pop back up the next time that button happened to be enabled.
// Some of them also need SEVERAL holes at once: you cannot drag from a masked
// chip onto a masked card. `nodes` is optional — without it the hole comes from
// TARGETS as usual and only the completion test changes.
// Who stands where: worker uid -> machine id ("" when idle in the bar).
const workerPositions = (game) => {
  const at = {};
  (game.player ? game.player.workers : []).forEach((w) => { at[w.uid] = w.machineId || ""; });
  return at;
};

const GESTURES = {
  // Put any free worker on any machine, however the player gets it done.
  assign_a_worker: {
    watch: workerPositions,
    done: (before, after) => Object.keys(after).some((uid) => !before[uid] && after[uid]),
  },
  // Move a worker from one machine to another. Source = a staffed machine's
  // chip, destination = la PASTILLE de l'autre machine (#machine-dots) : dans le
  // carrousel, deux cartes ne sont jamais visibles en entier en même temps, mais
  // chip + pastille tiennent toujours à l'écran ensemble — et la pastille est une
  // vraie cible de drop (dropTargetAt). Une seule machine : geste impossible, le
  // mask ne s'ouvre pas, comme avant.
  drag_n_drop_a_worker: {
    nodes(game) {
      const from = game.player.machines.find((m) => m.crew.length && m._node);
      if (!from) return null;
      const toIdx = game.player.machines.findIndex((m) => m !== from && m.crew.length < game.lvl(m).maxWorkers);
      if (toIdx < 0) return null;
      const chip = from._node.querySelector(".wchip");
      const dot = document.querySelectorAll("#machine-dots .mdot")[toIdx];
      return chip && dot ? [chip, dot] : null;
    },
    // Done when a worker that was on a machine now stands on a DIFFERENT one —
    // recalling it to the bar doesn't count as a switch.
    watch: workerPositions,
    done: (before, after) => Object.keys(before).some((uid) => before[uid] && after[uid] && before[uid] !== after[uid]),
  },
};

export const Tutorial = {
  game: null,
  mask: null,        // { fid, name, node } currently masked, or null
  gesture: null,     // { fid, name, total, spec, watch } — outlives the mask
  dots: [],          // [{ fid, name, node, el }]
  _evalTimer: 0,
  _handTimer: 0,
  _layer: null,

  init(game) {
    this.game = game;
    this._layer = document.createElement("div");
    this._layer.id = "tut-layer";
    document.body.appendChild(this._layer);
    // Capture phase: we must see the click on the target before the widget it
    // opens re-renders the element out from under us.
    document.addEventListener("click", (e) => this.onClick(e), true);
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },

  // The play loop freezes while a mask is up: the prep countdown must not run
  // down behind a modal the player cannot dismiss without acting.
  isBlocking() { return !!this.mask; },

  tick() {
    const now = performance.now() / 1000;
    const dt = this._last ? Math.min(0.2, now - this._last) : 0;
    this._last = now;
    this._evalTimer -= dt;
    this.checkGesture();
    if (this._evalTimer <= 0) { this._evalTimer = EVAL_PERIOD; this.evaluate(); }
    if (this.mask) this._handTimer += dt;
    this.reposition();
  },

  // ---------- what should be on screen right now ----------
  // Every feature whose trigger fired, whose tutorial isn't finished, and whose
  // current target is actually reachable. Sheet order decides priority.
  pending() {
    const fu = this.game.cfg.featureUnlocks || {};
    const out = [];
    Object.keys(fu).forEach((fid) => {
      const f = fu[fid];
      if (!f.tutorial || !f.targets.length) return;
      if (Meta.tutorialDone(fid) || !Meta.featureUnlocked(fid)) return;
      const name = f.targets[Meta.tutorialStep(fid)];
      if (name) out.push({ fid, kind: f.tutorial, name, total: f.targets.length });
    });
    return out;
  },

  // A gesture finishes on the move landing, not on a click — and that move is
  // usually what makes its own target unreachable (the machine's "+" disables the
  // instant the worker sits down). reposition() then tears the mask down on the
  // very next frame, so the watch has to outlive the mask: otherwise the step is
  // never marked done and the black screen comes back the next time a worker is
  // free — i.e. at every purchase.
  checkGesture() {
    const g = this.gesture;
    if (!g || !this.game.player) return;
    if (!g.spec.done(g.watch, g.spec.watch(this.game))) return;
    Meta.advanceTutorial(g.fid, g.total);
    this.gesture = null;
    if (this.mask && this.mask.fid === g.fid) this.clearMask();
    this._evalTimer = 0;
  },

  evaluate() {
    this.noteStock();
    const pend = this.pending();
    // The chain moved on (or another run reset it): stop watching a step that is
    // no longer the one being taught.
    if (this.gesture && !pend.some((p) => p.fid === this.gesture.fid && p.name === this.gesture.name)) this.gesture = null;

    // --- black_mask: one at a time, the first one whose target is actionable ---
    const wanted = pend.find((p) => p.kind === "black_mask" && this.resolveNodes(p.name, { scroll: true }));
    if (!wanted || !this.mask || this.mask.fid !== wanted.fid || this.mask.name !== wanted.name) {
      this.clearMask();
      if (wanted) this.openMask(wanted);
    }

    // --- red_dot: all of them, deduplicated by target (two chains can share a
    // step — `character` and `gears` both start on the characters tab). ---
    const dots = [];
    const seen = [];
    pend.forEach((p) => {
      if (p.kind !== "red_dot" || seen.includes(p.name)) return;
      const node = this.resolve(p.name, { needEnabled: false });
      if (!node) return;
      seen.push(p.name);
      dots.push({ fid: p.fid, name: p.name, node });
    });
    this.syncDots(dots);
  },

  // Feed the stock-based triggers (reach_N_in_stock, reach_N_of_X). They ask for
  // a RECORD, so a snapshot every EVAL_PERIOD is enough — Meta keeps the max.
  noteStock() {
    const p = this.game.player;
    if (!p || !p.stock) return;
    let total = 0; const per = {}; const tiers = [];
    for (const rid in p.stock) {
      let n = 0;
      for (const t in p.stock[rid]) {
        if (p.stock[rid][t] > 0) { n += p.stock[rid][t]; tiers.push(rid + ":" + t); }
      }
      if (n > 0) { per[rid] = n; total += n; }
    }
    Meta.noteStock(total, per, tiers);
  },

  // ---------- target resolution ----------
  resolveSelector(name) {
    const key = name.replace(/-/g, "_");
    if (TARGETS[key]) return TARGETS[key];
    // [ressource_tier3] -> any inventory tile of that tier
    const tier = /^\[ressource_tier(\d+)\]$/.exec(name);
    if (tier) return `#inventory-bar .inv-unit[data-tier="${tier[1]}"]`;
    // slot_tennisBall -> the character slot card; anything else is read as a
    // character id (the "dog" step of the characters chain).
    if (/^slot_/.test(name)) return `[data-tut="${name}"]`;
    return `[data-tut="char_${name}"]`;
  },
  // Having a rectangle is NOT enough. #content scrolls, so a target can sit below
  // the fold with a perfectly good rect while the worker bar is what the finger
  // actually lands on — the mask would then frame a spot where the action can't
  // be performed, and since the shields block scrolling the player is stuck.
  // The real test is a hit test: the target must be the topmost thing at its own
  // centre. `scroll` lets a mask pull its target into view before giving up.
  hittable(node) {
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === node || node.contains(hit));
  },
  // Les achats et l'inventaire vivent dans des bottom sheets fermées par défaut :
  // une cible peut être dans le DOM mais invisible. Un mask a le droit d'OUVRIR la
  // sheet qui la contient (le tutoriel amène le joueur à l'endroit qu'il enseigne) ;
  // un red_dot, non — il attend que le joueur ouvre lui-même.
  ensureSheet(node) {
    const ov = node.closest("#boutique-overlay, #stock-overlay");
    if (!ov || !ov.classList.contains("hidden")) return false;
    if (ov.id === "boutique-overlay") this.game.openBoutique(); else this.game.openStock();
    return true;   // elle s'ouvre (transition .26 s) : re-testé aux frames suivantes
  },
  // A target counts as reachable only when it is laid out, hittable and — for a
  // mask — still enabled: masking a disabled button would trap the player behind
  // an action they cannot perform (no money for the worker, machine maxed…).
  resolve(name, opts) {
    const needEnabled = !opts || opts.needEnabled !== false;
    const nodes = [...document.querySelectorAll(this.resolveSelector(name))]
      .filter((n) => !needEnabled || !(n.disabled || n.classList.contains("locked")));
    const ready = nodes.find((n) => this.hittable(n));
    if (ready) return ready;
    // Nothing tappable: for a mask, open the owning sheet / scroll the first
    // candidate into view and re-test. `inline: "center"` : le carrousel de
    // machines scrolle horizontalement. Already-centred targets make this a
    // no-op, so it is safe to run from the per-frame reposition.
    if (opts && opts.scroll && nodes.length) {
      if (this.ensureSheet(nodes[0])) return null;
      nodes[0].scrollIntoView({ block: "center", inline: "center" });
      if (this.hittable(nodes[0])) return nodes[0];
    }
    return null;
  },
  // Every element a mask must leave reachable. A gesture needs both ends open at
  // once; if they can't be on screen together the move is impossible and we
  // return null rather than framing half of it.
  resolveNodes(name, opts) {
    const g = GESTURES[name];
    // An outcome target without its own `nodes` still gets its hole from TARGETS:
    // only the way it FINISHES differs.
    if (!g || !g.nodes) { const n = this.resolve(name, opts); return n ? [n] : null; }
    let nodes = g.nodes(this.game);
    if (!nodes) return null;
    if (nodes.every((n) => this.hittable(n))) return nodes;
    if (opts && opts.scroll) {
      nodes[0].scrollIntoView({ block: "center", inline: "center" });
      nodes = g.nodes(this.game);   // the scroll may have re-rendered the cards
      if (nodes && nodes.every((n) => this.hittable(n))) return nodes;
    }
    return null;
  },

  // ---------- black mask ----------
  openMask(p) {
    // A widget opened just before the unlock would sit on top of the holes.
    const nodes = this.resolveNodes(p.name, { scroll: true });
    if (!nodes) return;
    this.closeStackedOverlays(nodes);
    const spec = GESTURES[p.name] || null;
    this.mask = { fid: p.fid, name: p.name, nodes, total: p.total, gesture: spec };
    // A gesture has no button to click: we watch the game state instead and
    // record where everyone stood the moment the watch started. Re-opening the
    // same mask must NOT restart it — that would forget the move the player has
    // already made.
    if (spec && !(this.gesture && this.gesture.fid === p.fid && this.gesture.name === p.name)) {
      this.gesture = { fid: p.fid, name: p.name, total: p.total, spec, watch: spec.watch(this.game) };
    }
    this._handTimer = 0;
    const box = document.createElement("div");
    box.className = "tut-mask";
    box.innerHTML = '<img class="tut-hand" src="sprites/TutorialHand.png" alt="">';
    this._layer.appendChild(box);
    this.mask.box = box;
    this.mask.shields = [];
    this.mask.rings = [];
    this.reposition();
  },
  clearMask() {
    if (this.mask && this.mask.box) this.mask.box.remove();
    this.mask = null;
  },
  // Shields are pooled, not rebuilt: reposition runs every frame.
  shieldPool(n) {
    const m = this.mask;
    while (m.shields.length > n) m.shields.pop().remove();
    while (m.shields.length < n) {
      const s = document.createElement("div");
      s.className = "tut-shield";
      s.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
      m.box.appendChild(s);
      m.shields.push(s);
    }
    return m.shields;
  },
  ringPool(n) {
    const m = this.mask;
    while (m.rings.length > n) m.rings.pop().remove();
    while (m.rings.length < n) {
      const r = document.createElement("div");
      r.className = "tut-ring";
      m.box.appendChild(r);
      m.rings.push(r);
    }
    return m.rings;
  },
  // Carve one hole out of a list of rectangles, splitting each overlapping one
  // into the bands that survive around it. Repeating this per hole is what lets
  // a gesture keep two far-apart elements reachable at the same time.
  subtract(rects, hole) {
    const out = [];
    rects.forEach((r) => {
      const rx2 = r.x + r.w, ry2 = r.y + r.h, hx2 = hole.x + hole.w, hy2 = hole.y + hole.h;
      if (hole.x >= rx2 || hx2 <= r.x || hole.y >= ry2 || hy2 <= r.y) { out.push(r); return; }
      if (hole.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: hole.y - r.y });
      if (hy2 < ry2) out.push({ x: r.x, y: hy2, w: r.w, h: ry2 - hy2 });
      const my = Math.max(r.y, hole.y), mh = Math.min(ry2, hy2) - my;
      if (mh > 0) {
        if (hole.x > r.x) out.push({ x: r.x, y: my, w: hole.x - r.x, h: mh });
        if (hx2 < rx2) out.push({ x: hx2, y: my, w: rx2 - hx2, h: mh });
      }
    });
    return out.filter((r) => r.w > 0.5 && r.h > 0.5);
  },
  // Close whatever the player had open, except a widget holding one of the targets.
  closeStackedOverlays(nodes) {
    document.querySelectorAll(".overlay:not(.hidden)").forEach((o) => {
      if ((nodes || []).some((n) => o.contains(n))) return;
      o.classList.add("hidden");
      o.classList.remove("open");   // the merge sheet also slides on .open
    });
  },

  // ---------- red dots ----------
  syncDots(wanted) {
    // drop the ones that no longer apply
    this.dots = this.dots.filter((d) => {
      if (wanted.some((w) => w.fid === d.fid && w.name === d.name)) return true;
      d.el.remove();
      return false;
    });
    wanted.forEach((w) => {
      let d = this.dots.find((x) => x.fid === w.fid && x.name === w.name);
      if (!d) {
        const el = document.createElement("div");
        el.className = "tut-dot";
        this._layer.appendChild(el);
        this.dots.push(d = { fid: w.fid, name: w.name, el });
      }
      d.node = w.node;   // re-render swaps the element, keep the badge alive
    });
  },

  // ---------- geometry ----------
  reposition() {
    const W = window.innerWidth, H = window.innerHeight;
    if (this.mask) {
      // Re-resolve every frame: targets get re-rendered, and since the shields
      // block scrolling, keeping them in view is on us.
      const nodes = this.resolveNodes(this.mask.name, { scroll: true });
      if (!nodes) { this.clearMask(); return; }   // target vanished (screen change)
      this.mask.nodes = nodes;
      const holes = nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
      });
      // Start from the whole viewport and carve every hole out of it.
      let rects = [{ x: 0, y: 0, w: W, h: H }];
      holes.forEach((h) => { rects = this.subtract(rects, h); });
      const shields = this.shieldPool(rects.length);
      rects.forEach((r, i) => {
        shields[i].style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      });
      const rings = this.ringPool(holes.length);
      holes.forEach((h, i) => {
        rings[i].style.cssText = `left:${h.x}px;top:${h.y}px;width:${h.w}px;height:${h.h}px`;
      });
      const hand = this.mask.box.querySelector(".tut-hand");
      if (this._handTimer >= HAND_DELAY) {
        hand.classList.add("on");
        // on the first hole — for a gesture that is where the move STARTS
        const r = nodes[0].getBoundingClientRect();
        hand.style.left = (r.left + r.width / 2 - 40) + "px";
        hand.style.top = (r.top + r.height / 2 - 10) + "px";
      } else hand.classList.remove("on");
    }
    this.dots.forEach((d) => {
      if (!d.node || !d.node.isConnected) { d.node = this.resolve(d.name, { needEnabled: false }); }
      // A dot never scrolls the page: it just hides until the player brings the
      // target on screen themselves. Same hit test, so it can't end up floating
      // over whatever happens to cover its target.
      if (!d.node || !this.hittable(d.node)) { d.el.classList.remove("on"); return; }
      const r = d.node.getBoundingClientRect();
      d.el.classList.add("on");
      d.el.style.left = (r.right - 7) + "px";
      d.el.style.top = (r.top - 3) + "px";
    });
  },

  // ---------- progression ----------
  // Capture-phase click: a tap on the current target walks the chain one step.
  onClick(e) {
    if (!this.mask && !this.dots.length) return;
    // Walk every tutorial waiting on this element, not just the badge that got
    // drawn: two chains can share a step (`character` and `gears` both start on
    // the characters tab) and one dot stands in for both.
    const hits = this.pending().filter((p) => {
      if (GESTURES[p.name]) return false;   // gestures finish on the move, not a tap
      const node = this.resolve(p.name, { needEnabled: false });
      return node && node.contains(e.target);
    });
    if (!hits.length) return;
    hits.forEach((p) => Meta.advanceTutorial(p.fid, p.total));
    // Let the click do its job first — the next step usually lives in the widget
    // it is about to open.
    this._evalTimer = 0;
    if (this.mask && hits.some((p) => p.fid === this.mask.fid)) this.clearMask();
  },
};
