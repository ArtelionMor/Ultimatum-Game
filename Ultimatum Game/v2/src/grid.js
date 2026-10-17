// Pure factory floor: a grid with 2×2 machines, 1×1 conveyor belts and the
// items travelling on them. No DOM.
//
// An item is a small int: stage × 8 + tier. Stages: 0 = fruit, 1 = juice,
// 2 = bottle; tier = quality ★1..★5. A "make" machine takes items of its
// `input_stage` on its input port and pushes `output_stage` items (same tier)
// out of its output port. A "refine" machine merges items of one tier into
// items of the next tier. How many go in / come out, the speed and a
// harvester's output ★ come from the machine's recipe (cfg.recipes; m.recipe,
// null = the base recipe). Finished items wait in the m.out queue. An Outcome (`sink: true`, 2×2, movable,
// one placed at start) takes any item from any side and sends it to its market.
//
// Rotation r = flow direction: 0 → right, 1 → down, 2 → left, 3 → up.
// A machine at (x, y) with r = 0 takes from (x-1, y) and outputs to (x+2, y);
// the other rotations follow the same "lane on row/col 0" rule (see ports()).

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const item = (stage, tier) => stage * 8 + tier;
export const stageOf = it => it >> 3;
export const tierOf = it => it & 7;
const key = (x, y) => x + ',' + y;
const SIZE = 2;

export function machineDef(cfg, type) { return cfg.machines.find(m => m.id === type); }

const baseCache = new WeakMap();
export function baseRecipe(cfg, type) {
  let c = baseCache.get(cfg);
  if (!c) { c = {}; baseCache.set(cfg, c); }
  return c[type] || (c[type] = cfg.recipes.find(r => r.machine === type && r.base) || { inputs: 1, outputs: 1, rate_mult: 1, out_tier: 1 });
}
export const recipeOf = (cfg, m) => (m.recipe && cfg.recipes.find(r => r.id === m.recipe)) || baseRecipe(cfg, m.type);
export const recipesFor = (cfg, type) => cfg.recipes.filter(r => r.machine === type);

export function createGrid(cfg) {
  const g = cfg.grid;
  const grid = { cols: g.cols, rows: g.rows, machines: [], belts: {}, nextId: 1, v: 0 };
  grid.machines.push({ id: 0, type: 'outcome', x: g.outcome_x, y: g.outcome_y, rot: 3, lvl: 1, buf: [], out: [], prog: 0, status: 'ok' });
  return grid;
}

// Input / output port cells (outside the machine) and the lane cells inside it.
export function ports(m) {
  const { x, y, rot } = m;
  switch (rot) {
    case 0: return { in: [x - 1, y], inCell: [x, y], out: [x + 2, y], outCell: [x + 1, y] };
    case 1: return { in: [x, y - 1], inCell: [x, y], out: [x, y + 2], outCell: [x, y + 1] };
    case 2: return { in: [x + 2, y], inCell: [x + 1, y], out: [x - 1, y], outCell: [x, y] };
    default: return { in: [x, y + 2], inCell: [x, y + 1], out: [x, y - 1], outCell: [x, y] };
  }
}

// --- Occupancy -------------------------------------------------------------

const occCache = new WeakMap();
export function occupancy(grid) {
  const c = occCache.get(grid);
  if (c && c.v === grid.v) return c.map;
  const map = new Map();
  for (const m of grid.machines)
    for (let dx = 0; dx < SIZE; dx++) for (let dy = 0; dy < SIZE; dy++) map.set(key(m.x + dx, m.y + dy), m);
  occCache.set(grid, { v: grid.v, map });
  return map;
}

export const machineAt = (grid, x, y) => occupancy(grid).get(key(x, y)) || null;
export const beltAt = (grid, x, y) => grid.belts[key(x, y)] || null;
const inside = (grid, x, y) => x >= 0 && y >= 0 && x < grid.cols && y < grid.rows;
const changed = grid => { grid.v++; };

// --- Costs -----------------------------------------------------------------

export const countOf = (grid, type) => grid.machines.filter(m => m.type === type).length;
export const isSink = (cfg, m) => !!machineDef(cfg, m.type)?.sink;

// `first_free`: the first copy of that machine costs nothing (onboarding).
// Special belt cells: splitter, crossing, tunnel (counted by entrance: a pair is one).
export const beltKind = b => (b.split ? 'splitter' : b.cross ? 'crossing' : b.tunnel ? 'tunnel' : 'belt');
export const kindCount = (grid, kind) =>
  Object.values(grid.belts).filter(b => beltKind(b) === kind && (kind !== 'tunnel' || b.tunnel.role === 'in')).length;

export function placeCost(cfg, grid, type) {
  if (type === 'belt') return cfg.grid.belt_cost;
  if (type === 'splitter' || type === 'crossing' || type === 'tunnel') {
    const g = cfg.grid;
    return Math.ceil(g[type + '_cost'] * Math.pow(g[type + '_cost_mult'], kindCount(grid, type)));
  }
  const d = machineDef(cfg, type), n = countOf(grid, type);
  if (d.first_free && n === 0) return 0;
  return Math.ceil(d.cost * Math.pow(d.cost_mult, n));
}

export const machineRate = (d, lvl) => d.base_rate * Math.pow(d.rate_mult, lvl - 1);
export const upgradeCost = (d, lvl) => Math.ceil(d.up_cost * Math.pow(d.up_cost_mult, lvl - 1));

// --- Edits (caller pays; these only check the layout) -------------------------

// Belts don't block a machine: building on them breaks them.
// `ignore`: a machine being moved doesn't block its own new spot.
export function canPlaceMachine(grid, x, y, ignore = null) {
  for (let dx = 0; dx < SIZE; dx++) for (let dy = 0; dy < SIZE; dy++) {
    const cx = x + dx, cy = y + dy;
    const m = inside(grid, cx, cy) ? machineAt(grid, cx, cy) : null;
    if (!inside(grid, cx, cy) || (m && m !== ignore)) return false;
  }
  return true;
}

// Belts under a 2×2 footprint (what building there would break).
export function beltsUnder(grid, x, y) {
  const out = [];
  for (let dx = 0; dx < SIZE; dx++) for (let dy = 0; dy < SIZE; dy++) if (beltAt(grid, x + dx, y + dy)) out.push([x + dx, y + dy]);
  return out;
}
function clearBelts(grid, x, y) {
  const under = beltsUnder(grid, x, y);
  for (const [bx, by] of under) delete grid.belts[key(bx, by)];
  return under.length;
}

// Move a machine (Outcome included) for free; keeps its level and contents.
// Returns the number of belts broken, or -1 if the spot is taken.
export function moveMachine(grid, m, x, y) {
  if (!canPlaceMachine(grid, x, y, m)) return -1;
  const broken = clearBelts(grid, x, y);
  m.x = x; m.y = y;
  changed(grid);
  return broken;
}

export function placeMachine(grid, type, x, y, rot) {
  if (!canPlaceMachine(grid, x, y)) return null;
  const broken = clearBelts(grid, x, y);
  const m = { id: grid.nextId++, type, x, y, rot, lvl: 1, recipe: null, buf: [], out: [], prog: 0, status: 'idle', broken };
  grid.machines.push(m);
  changed(grid);
  return m;
}

export function canPlaceBelt(grid, x, y) {
  return inside(grid, x, y) && !machineAt(grid, x, y) && !beltAt(grid, x, y);
}

export function placeBelt(grid, x, y, dir) {
  if (!canPlaceBelt(grid, x, y)) return null;
  const b = { dir, item: null, p: 0 };
  grid.belts[key(x, y)] = b;
  changed(grid);
  return b;
}

// --- Splitters ----------------------------------------------------------------
// A belt cell with `split`: items enter from behind and leave by two outputs.
// shape: 'sl' = straight (main) + left, 'sr' = straight (main) + right,
//        'lr' = left (main) + right. Left/right are seen in the travel direction.
// mode: '50' / '30' / '70' = share of the main output; 'prio' = main first,
//        second only when the main one is blocked.
export const SPLIT_SHAPES = ['sl', 'sr', 'lr'];
export const SPLIT_MODES = ['50', '30', '70', 'prio'];

// Make the belt at (x, y) a splitter, or place a new one. Returns the belt.
export function placeSplitter(grid, x, y, dir) {
  let b = beltAt(grid, x, y);
  if (b && beltKind(b) !== 'belt') return null;
  if (!b) { if (!canPlaceBelt(grid, x, y)) return null; b = grid.belts[key(x, y)] = { dir, item: null, p: 0 }; }
  b.split = { shape: 'sl', mode: '50', n: [0, 0] };
  changed(grid);
  return b;
}

export function setSplit(grid, x, y, patch) {
  const b = beltAt(grid, x, y);
  if (!b?.split) return false;
  Object.assign(b.split, patch, { n: [0, 0] });
  changed(grid);
  return true;
}

// --- Crossing -------------------------------------------------------------------
// Items going left/right and up/down pass straight through without mixing:
// cross.h / cross.v = { item, p, dir } or null. b.item stays null.
export function placeCrossing(grid, x, y) {
  let b = beltAt(grid, x, y);
  if (b && (b.split || b.cross || b.tunnel)) return null;
  if (!b) { if (!canPlaceBelt(grid, x, y)) return null; b = grid.belts[key(x, y)] = { dir: 0, item: null, p: 0 }; }
  b.item = null; b.p = 0;
  b.cross = { h: null, v: null };
  changed(grid);
  return b;
}

// --- Tunnel ---------------------------------------------------------------------
// Entrance at (x, y), exit `len` cells further in `dir`; items jump from one to
// the other, under whatever lies between. Ends store the offset to each other.
export function canPlaceTunnel(cfg, grid, x, y, dir, len) {
  if (len < 2 || len > cfg.grid.tunnel_max_gap + 1) return false;
  const [dx, dy] = DIRS[dir], ex = x + dx * len, ey = y + dy * len;
  const free = (cx, cy) => { const b = beltAt(grid, cx, cy); return inside(grid, cx, cy) && !machineAt(grid, cx, cy) && (!b || beltKind(b) === 'belt'); };
  return free(x, y) && free(ex, ey);
}

export function placeTunnel(cfg, grid, x, y, dir, len) {
  if (!canPlaceTunnel(cfg, grid, x, y, dir, len)) return null;
  const [dx, dy] = DIRS[dir], ex = x + dx * len, ey = y + dy * len;
  grid.belts[key(x, y)] = { dir, item: null, p: 0, tunnel: { role: 'in', dx: ex - x, dy: ey - y } };
  grid.belts[key(ex, ey)] = { dir, item: null, p: 0, tunnel: { role: 'out', dx: x - ex, dy: y - ey } };
  changed(grid);
  return true;
}

// The other end, or null if the pair got broken (one end moved or built over).
export function tunnelPartner(grid, x, y, b) {
  const ox = x + b.tunnel.dx, oy = y + b.tunnel.dy, o = beltAt(grid, ox, oy);
  return o?.tunnel && o.tunnel.role !== b.tunnel.role && ox + o.tunnel.dx === x && oy + o.tunnel.dy === y ? { x: ox, y: oy, b: o } : null;
}

// The two output directions [main, second] of a splitter.
export function splitDirs(b) {
  const left = (b.dir + 3) % 4, right = (b.dir + 1) % 4;
  return b.split.shape === 'sl' ? [b.dir, left] : b.split.shape === 'sr' ? [b.dir, right] : [left, right];
}

// Output order for the next item: the pattern's pick first, the other as fallback.
function splitOrder(b) {
  const s = b.split;
  if (s.mode === 'prio') return [0, 1];
  const w = Number(s.mode) / 100, ws = [w, 1 - w];
  // Smooth weighted round-robin: the output furthest behind its share goes next.
  const first = (s.n[0] + 1) / ws[0] <= (s.n[1] + 1) / ws[1] ? 0 : 1;
  return [first, 1 - first];
}

export function setBeltDir(grid, x, y, dir) {
  const b = beltAt(grid, x, y);
  if (!b || b.dir === dir) return false;
  b.dir = dir;
  changed(grid);
  return true;
}

export function removeBelt(grid, x, y) {
  const b = beltAt(grid, x, y);
  if (!b) return false;
  delete grid.belts[key(x, y)];
  // A tunnel goes as a pair.
  const o = b.tunnel && tunnelPartner(grid, x, y, b);
  if (o) delete grid.belts[key(o.x, o.y)];
  changed(grid);
  return true;
}

// The last Outcome can't go: nothing could be sold any more.
export function removeMachine(grid, m) {
  if (m.type === 'outcome' && countOf(grid, 'outcome') <= 1) return false;
  grid.machines = grid.machines.filter(o => o !== m);
  changed(grid);
  return true;
}

// --- Bigger floor, groups ---------------------------------------------------------

// The floor grows to the right and downwards, so nothing built moves.
export function expandGrid(grid, n) { grid.cols += n; grid.rows += n; changed(grid); }

// Machines and belts touching the cell rectangle [x0..x1] × [y0..y1] (inclusive).
export function selectRect(grid, x0, y0, x1, y1) {
  const machines = grid.machines.filter(m => m.x <= x1 && m.x + SIZE - 1 >= x0 && m.y <= y1 && m.y + SIZE - 1 >= y0);
  const belts = Object.keys(grid.belts).filter(k => { const [x, y] = k.split(',').map(Number); return x >= x0 && x <= x1 && y >= y0 && y <= y1; });
  return { machines, belts };
}

export function groupBox(sel) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of sel.machines) { x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x + SIZE - 1); y1 = Math.max(y1, m.y + SIZE - 1); }
  for (const k of sel.belts) { const [x, y] = k.split(',').map(Number); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

// Can the whole group slide by (dx, dy)? Other machines block it; other belts
// in the way get broken. Returns { ok, broken: [belt keys] }.
export function groupMoveCheck(grid, sel, dx, dy) {
  const inSel = new Set(sel.machines), selBelts = new Set(sel.belts), broken = new Set();
  const cellOk = (x, y) => {
    if (!inside(grid, x, y)) return false;
    const m = machineAt(grid, x, y);
    if (m && !inSel.has(m)) return false;
    const k = key(x, y);
    if (grid.belts[k] && !selBelts.has(k)) broken.add(k);
    return true;
  };
  for (const m of sel.machines)
    for (let ox = 0; ox < SIZE; ox++) for (let oy = 0; oy < SIZE; oy++) if (!cellOk(m.x + dx + ox, m.y + dy + oy)) return { ok: false, broken: [] };
  for (const k of sel.belts) { const [x, y] = k.split(',').map(Number); if (!cellOk(x + dx, y + dy)) return { ok: false, broken: [] }; }
  return { ok: true, broken: [...broken] };
}

// Slide the group; belts keep their direction (and what they carry).
// Returns the number of belts broken, or -1. `sel.belts` is updated in place.
export function moveGroup(grid, sel, dx, dy) {
  const chk = groupMoveCheck(grid, sel, dx, dy);
  if (!chk.ok) return -1;
  for (const k of chk.broken) delete grid.belts[k];
  const moved = sel.belts.map(k => { const [x, y] = k.split(',').map(Number); const b = grid.belts[k]; delete grid.belts[k]; return [key(x + dx, y + dy), b]; });
  for (const [k, b] of moved) grid.belts[k] = b;
  sel.belts = moved.map(([k]) => k);
  for (const m of sel.machines) { m.x += dx; m.y += dy; }
  changed(grid);
  return chk.broken.length;
}

export function setMachineRot(grid, m, rot) {
  if (m.type === 'outcome' || m.rot === rot) return false;
  m.rot = rot;
  changed(grid);
  return true;
}

// Rotate in place (the footprint doesn't move, only the ports).
export function rotateMachine(grid, m) {
  if (m.type === 'outcome') return false;
  m.rot = (m.rot + 1) % 4;
  changed(grid);
  return true;
}

// --- Simulation --------------------------------------------------------------

// Try to move item `it` from cell (sx, sy) into cell (tx, ty).
function accept(cfg, grid, sx, sy, tx, ty, it, ctx) {
  if (!inside(grid, tx, ty)) return false;
  const b = beltAt(grid, tx, ty);
  if (b) {
    if (b.cross) {
      const d = DIRS.findIndex(([dx, dy]) => tx - sx === dx && ty - sy === dy), lane = d % 2 ? 'v' : 'h';
      if (d < 0 || b.cross[lane]) return false;
      b.cross[lane] = { item: it, p: 0, dir: d };
      return true;
    }
    if (b.tunnel?.role === 'out') return false;   // fed by its entrance only
    if (b.item !== null) return false;
    const [dx, dy] = DIRS[b.dir];
    if (tx + dx === sx && ty + dy === sy) return false; // belt points back at the source
    if (b.split && (tx - dx !== sx || ty - dy !== sy)) return false; // splitters take items from behind only
    if (b.split && splitDirs(b).some(d => tx + DIRS[d][0] === sx && ty + DIRS[d][1] === sy)) return false;
    b.item = it; b.p = 0;
    return true;
  }
  const m = machineAt(grid, tx, ty);
  if (!m) return false;
  const d = machineDef(cfg, m.type);
  if (d.sink) {
    if (ctx.room(stageOf(it)) <= 0) return false;
    ctx.deliver(it);
    return true;
  }
  const p = ports(m);
  const cap = Math.max(cfg.grid.machine_buffer, recipeOf(cfg, m).inputs * 2);
  if (p.in[0] !== sx || p.in[1] !== sy) return false;
  if (d.input_stage !== stageOf(it)) { m.wrong = stageOf(it); return false; }   // shown as ❌ on the machine
  if (m.buf.length >= cap) return false;
  m.buf.push(it);
  return true;
}

// Belts closest to their destination move first, so a full belt advances as a block.
const orderCache = new WeakMap();
function beltOrder(grid) {
  const c = orderCache.get(grid);
  if (c && c.v === grid.v) return c.list;
  const dist = {};
  const depth = k => {
    if (dist[k] !== undefined) return dist[k];
    dist[k] = 1e9; // cycle guard
    const [x, y] = k.split(',').map(Number);
    const b = grid.belts[k];
    let best = 0;
    if (b.cross) return (dist[k] = 0);
    if (b.tunnel?.role === 'in') { const o = tunnelPartner(grid, x, y, b); return (dist[k] = o ? Math.min(1e9, depth(key(o.x, o.y)) + 1) : 0); }
    for (const d of b.split ? splitDirs(b) : [b.dir]) {
      const nk = key(x + DIRS[d][0], y + DIRS[d][1]);
      if (grid.belts[nk]) best = Math.max(best, Math.min(1e9, depth(nk) + 1));
    }
    return (dist[k] = best);
  };
  const list = Object.keys(grid.belts).map(k => { const [x, y] = k.split(',').map(Number); return { k, x, y, d: depth(k) }; });
  list.sort((a, b) => a.d - b.d);
  orderCache.set(grid, { v: grid.v, list });
  return list;
}

// What a machine would do next: { use: [indices in buf], out: [items] } or null.
const many = (n, it) => Array.from({ length: n }, () => it);
function nextJob(d, m, r) {
  if (d.input_stage === null) return { use: [], out: many(r.outputs, item(d.output_stage, r.out_tier)) };
  if (d.kind !== 'refine') {
    // Takes the first `inputs` items; the product keeps the lowest ★ used.
    if (m.buf.length < r.inputs) return null;
    const use = [...Array(r.inputs).keys()];
    const tier = Math.min(...use.map(i => tierOf(m.buf[i])));
    return { use, out: many(r.outputs, item(d.output_stage, tier)) };
  }
  if (!m.buf.length) return null;
  // Refine: top-tier items pass straight through; else merge the lowest full tier.
  const top = m.buf.findIndex(it => tierOf(it) >= d.max_tier);
  if (top >= 0) return { use: [top], out: [m.buf[top]], instant: true };
  const byTier = {};
  m.buf.forEach((it, i) => (byTier[tierOf(it)] ||= []).push(i));
  for (let t = 1; t < d.max_tier; t++) if ((byTier[t]?.length || 0) >= r.inputs)
    return { use: byTier[t].slice(0, r.inputs), out: many(r.outputs, item(d.output_stage, t + 1)) };
  return null;
}

// ctx = { room: stage => free stock for that item, deliver: item => void }
export function stepGrid(cfg, grid, dt, ctx) {
  const speed = cfg.grid.belt_speed;
  for (const { x, y, k } of beltOrder(grid)) {
    const b = grid.belts[k];
    if (b?.cross) {
      for (const lane of ['h', 'v']) {
        const c = b.cross[lane];
        if (!c) continue;
        c.p = Math.min(1, c.p + speed * dt);
        if (c.p < 1) continue;
        const [dx, dy] = DIRS[c.dir];
        if (accept(cfg, grid, x, y, x + dx, y + dy, c.item, ctx)) b.cross[lane] = null;
      }
      continue;
    }
    if (!b || b.item === null) continue;
    b.p = Math.min(1, b.p + speed * dt);
    if (b.p < 1) continue;
    if (b.tunnel?.role === 'in') {
      // Jump to the exit as soon as it is free.
      const o = tunnelPartner(grid, x, y, b);
      if (o && o.b.item === null) { o.b.item = b.item; o.b.p = 0; b.item = null; b.p = 0; }
      continue;
    }
    if (b.split) {
      const dirs = splitDirs(b);
      for (const i of splitOrder(b)) {
        const [dx, dy] = DIRS[dirs[i]];
        if (accept(cfg, grid, x, y, x + dx, y + dy, b.item, ctx)) { b.item = null; b.p = 0; b.split.n[i]++; break; }
      }
      continue;
    }
    const [dx, dy] = DIRS[b.dir];
    if (accept(cfg, grid, x, y, x + dx, y + dy, b.item, ctx)) { b.item = null; b.p = 0; }
  }
  for (const m of grid.machines) {
    const d = machineDef(cfg, m.type);
    if (d.sink) continue;
    if (!m.out.length) {
      const r = recipeOf(cfg, m);
      const job = nextJob(d, m, r);
      if (job) {
        m.prog = job.instant ? 1 : m.prog + dt * machineRate(d, m.lvl) * r.rate_mult / 60;
        if (m.prog >= 1) {
          m.prog = 0;
          m.buf = m.buf.filter((_, i) => !job.use.includes(i));
          m.out = job.out;
        }
        m.wait = 0;
        m.status = 'ok';
      } else {
        // Waiting for the next item is normal; only flag a real shortage.
        m.wait = (m.wait || 0) + dt;
        m.status = m.wrong !== undefined ? 'wrong' : m.wait > 3 ? 'starved' : 'ok';
      }
    }
    delete m.wrong;
    if (m.out.length) {
      const p = ports(m);
      if (accept(cfg, grid, p.outCell[0], p.outCell[1], p.out[0], p.out[1], m.out[0], ctx)) { m.out.shift(); m.status = 'ok'; }
      else m.status = 'blocked';
    }
  }
}

// Output of the machines making `stage` (units/min), ignoring belts.
export function stageCapacity(cfg, grid, stage) {
  let sum = 0;
  for (const m of grid.machines) {
    const d = machineDef(cfg, m.type);
    if (d.sink || d.kind === 'refine' || d.output_stage !== stage) continue;
    const r = recipeOf(cfg, m);
    sum += machineRate(d, m.lvl) * r.rate_mult * r.outputs;
  }
  return sum;
}
