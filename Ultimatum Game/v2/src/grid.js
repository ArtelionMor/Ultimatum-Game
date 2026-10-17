// Pure factory floor: a grid with 2×2 machines, 1×1 conveyor belts and the
// items travelling on them. No DOM.
//
// Item stages: 0 = fruit, 1 = juice, 2 = bottle. A machine takes items of its
// `input_stage` on its input port and pushes `output_stage` items out of its
// output port. The warehouse (2×2, fixed) takes bottles from any side.
//
// Rotation r = flow direction: 0 → right, 1 → down, 2 → left, 3 → up.
// A machine at (x, y) with r = 0 takes from (x-1, y) and outputs to (x+2, y);
// the other rotations follow the same "lane on row/col 0" rule (see ports()).

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const key = (x, y) => x + ',' + y;
const SIZE = 2;

export function machineDef(cfg, type) { return cfg.machines.find(m => m.id === type); }

export function createGrid(cfg) {
  const g = cfg.grid;
  const grid = { cols: g.cols, rows: g.rows, machines: [], belts: {}, nextId: 1, v: 0 };
  grid.machines.push({ id: 0, type: 'warehouse', x: g.warehouse_x, y: g.warehouse_y, rot: 3, lvl: 1, buf: 0, out: null, prog: 0, status: 'ok' });
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

export function placeCost(cfg, grid, type) {
  if (type === 'belt') return cfg.grid.belt_cost;
  const d = machineDef(cfg, type);
  return Math.ceil(d.cost * Math.pow(d.cost_mult, countOf(grid, type)));
}

export const machineRate = (d, lvl) => d.base_rate * Math.pow(d.rate_mult, lvl - 1);
export const upgradeCost = (d, lvl) => Math.ceil(d.up_cost * Math.pow(d.up_cost_mult, lvl - 1));

// --- Edits (caller pays; these only check the layout) -------------------------

export function canPlaceMachine(grid, x, y) {
  for (let dx = 0; dx < SIZE; dx++) for (let dy = 0; dy < SIZE; dy++) {
    const cx = x + dx, cy = y + dy;
    if (!inside(grid, cx, cy) || machineAt(grid, cx, cy) || beltAt(grid, cx, cy)) return false;
  }
  return true;
}

export function placeMachine(grid, type, x, y, rot) {
  if (!canPlaceMachine(grid, x, y)) return null;
  const m = { id: grid.nextId++, type, x, y, rot, lvl: 1, buf: 0, out: null, prog: 0, status: 'idle' };
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

export function setBeltDir(grid, x, y, dir) {
  const b = beltAt(grid, x, y);
  if (!b || b.dir === dir) return false;
  b.dir = dir;
  changed(grid);
  return true;
}

export function removeBelt(grid, x, y) {
  if (!beltAt(grid, x, y)) return false;
  delete grid.belts[key(x, y)];
  changed(grid);
  return true;
}

export function removeMachine(grid, m) {
  if (m.type === 'warehouse') return false;
  grid.machines = grid.machines.filter(o => o !== m);
  changed(grid);
  return true;
}

// Rotate in place (the footprint doesn't move, only the ports).
export function rotateMachine(grid, m) {
  if (m.type === 'warehouse') return false;
  m.rot = (m.rot + 1) % 4;
  m.out = null;
  changed(grid);
  return true;
}

// --- Simulation --------------------------------------------------------------

// Try to move an item of `stage` from cell (sx, sy) into cell (tx, ty).
function accept(cfg, grid, sx, sy, tx, ty, stage, ctx) {
  if (!inside(grid, tx, ty)) return false;
  const b = beltAt(grid, tx, ty);
  if (b) {
    if (b.item !== null) return false;
    const [dx, dy] = DIRS[b.dir];
    if (tx + dx === sx && ty + dy === sy) return false; // belt points back at the source
    b.item = stage; b.p = 0;
    return true;
  }
  const m = machineAt(grid, tx, ty);
  if (!m) return false;
  if (m.type === 'warehouse') {
    if (stage !== cfg.grid.final_stage || ctx.room() <= 0) return false;
    ctx.deliver();
    return true;
  }
  const d = machineDef(cfg, m.type);
  const p = ports(m);
  if (p.in[0] !== sx || p.in[1] !== sy || d.input_stage !== stage || m.buf >= cfg.grid.machine_buffer) return false;
  m.buf++;
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
    const [dx, dy] = DIRS[grid.belts[k].dir];
    const nk = key(x + dx, y + dy);
    return (dist[k] = grid.belts[nk] ? Math.min(1e9, depth(nk) + 1) : 0);
  };
  const list = Object.keys(grid.belts).map(k => { const [x, y] = k.split(',').map(Number); return { k, x, y, d: depth(k) }; });
  list.sort((a, b) => a.d - b.d);
  orderCache.set(grid, { v: grid.v, list });
  return list;
}

// ctx = { room: () => free warehouse slots, deliver: () => void }
export function stepGrid(cfg, grid, dt, ctx) {
  const speed = cfg.grid.belt_speed;
  for (const { x, y, k } of beltOrder(grid)) {
    const b = grid.belts[k];
    if (!b || b.item === null) continue;
    b.p = Math.min(1, b.p + speed * dt);
    if (b.p < 1) continue;
    const [dx, dy] = DIRS[b.dir];
    if (accept(cfg, grid, x, y, x + dx, y + dy, b.item, ctx)) { b.item = null; b.p = 0; }
  }
  for (const m of grid.machines) {
    if (m.type === 'warehouse') continue;
    const d = machineDef(cfg, m.type);
    if (m.out === null) {
      const fed = d.input_stage === null || m.buf > 0;
      if (fed) {
        m.prog += dt * machineRate(d, m.lvl) / 60;
        if (m.prog >= 1) {
          m.prog = 0;
          if (d.input_stage !== null) m.buf--;
          m.out = d.output_stage;
        }
        m.wait = 0;
        m.status = 'ok';
      } else {
        // Waiting for the next item is normal; only flag a real shortage.
        m.wait = (m.wait || 0) + dt;
        m.status = m.wait > 3 ? 'starved' : 'ok';
      }
    }
    if (m.out !== null) {
      const p = ports(m);
      if (accept(cfg, grid, p.outCell[0], p.outCell[1], p.out[0], p.out[1], m.out, ctx)) { m.out = null; m.status = 'ok'; }
      else m.status = 'blocked';
    }
  }
}

// Upper bound of the floor's output (units/min): the weakest stage, summing the
// machines of each type. Ignores belts, so it is what a well-wired floor gives.
export function gridCapacity(cfg, grid) {
  let cap = Infinity;
  for (const d of cfg.machines) {
    let sum = 0;
    for (const m of grid.machines) if (m.type === d.id) sum += machineRate(d, m.lvl);
    cap = Math.min(cap, sum);
  }
  return isFinite(cap) ? cap : 0;
}

// Quality of the bottles: average level of the machines that add quality.
export function gridQuality(cfg, grid) {
  let q = cfg.player.start_quality, n = 0, sum = 0;
  for (const m of grid.machines) {
    if (m.type === 'warehouse') continue;
    const d = machineDef(cfg, m.type);
    if (!d.quality_per_level) continue;
    n++; sum += d.quality_per_level * (m.lvl - 1);
  }
  if (n) q += sum / n;
  return Math.min(cfg.player.quality_max, q);
}
