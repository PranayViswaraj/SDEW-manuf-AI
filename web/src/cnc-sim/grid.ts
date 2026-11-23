/**
 * Material of the turned part on a 2D grid in the part frame (p along the axis, r = radius).
 * p = 0 is the bar's front end in the first setup. A move removes every cell its swept cutting
 * shape covers (no CSG). Cells remember when they were cut, for the yellow fade.
 */
import { radial, spanAt } from '../sim/lathe/stock';
import { hull, toolGeometry } from '../sim/lathe/tools';
import type { Point } from '../sim/lathe/types';
import { SIM_CONFIG } from './config';
import { F, STRIDE, type Job, type JobSetup } from './job';
import { getUnknownDrill, toolFor } from './tools';

export interface GridState {
  occ: Uint8Array;
  /** 0 = never cut, else 1 + round(simTime * 10). */
  cut: Uint16Array;
}

export class Grid {
  readonly res = SIM_CONFIG.gridRes;
  readonly pMin = -3;
  readonly pMax: number;
  readonly R: number;
  readonly np: number;
  readonly nr: number;
  occ: Uint8Array;
  cut: Uint16Array;
  /** Bumped on every change (for the mesh). */
  version = 0;

  constructor() {
    const s = SIM_CONFIG.stock;
    this.pMax = s.length + 3;
    this.R = s.diameter / 2;
    this.np = Math.ceil((this.pMax - this.pMin) / this.res);
    this.nr = Math.ceil((this.R + 0.5) / this.res);
    this.occ = new Uint8Array(this.np * this.nr);
    this.cut = new Uint16Array(this.np * this.nr);
    this.reset();
  }

  reset() {
    const s = SIM_CONFIG.stock;
    this.occ.fill(0);
    this.cut.fill(0);
    for (let j = 0; j < this.np; j++) {
      const p = this.pAt(j);
      if (p < 0 || p > s.length) continue;
      for (let k = 0; k < this.nr; k++) if (this.rAt(k) < this.R) this.occ[j * this.nr + k] = 1;
    }
    this.version++;
  }

  pAt(j: number) {
    return this.pMin + (j + 0.5) * this.res;
  }
  rAt(k: number) {
    return (k + 0.5) * this.res;
  }

  state(): GridState {
    return { occ: this.occ.slice(), cut: this.cut.slice() };
  }
  restore(s: GridState) {
    this.occ.set(s.occ);
    this.cut.set(s.cut);
    this.version++;
  }

  /** Clear cells under a convex polygon given in (p, r). Returns cells removed. */
  stamp(poly: Point[], t: number): number {
    if (poly.length < 1) return 0;
    let pLo = Infinity;
    let pHi = -Infinity;
    for (const q of poly) {
      if (q[0] < pLo) pLo = q[0];
      if (q[0] > pHi) pHi = q[0];
    }
    const j0 = Math.max(0, Math.floor((pLo - this.pMin) / this.res));
    const j1 = Math.min(this.np - 1, Math.floor((pHi - this.pMin) / this.res));
    const stampT = 1 + Math.min(65000, Math.round(t * 10));
    let removed = 0;
    for (let j = j0; j <= j1; j++) {
      const z0 = this.pMin + j * this.res;
      const span = spanAt(poly, z0, z0 + this.res);
      if (!span) continue;
      const [lo, hi] = radial(span[0], span[1]);
      const k0 = Math.max(0, Math.ceil(lo / this.res - 0.5));
      const k1 = Math.min(this.nr - 1, Math.floor(hi / this.res - 0.5));
      const row = j * this.nr;
      for (let k = k0; k <= k1; k++) {
        if (this.occ[row + k]) {
          this.occ[row + k] = 0;
          this.cut[row + k] = stampT;
          removed++;
        }
      }
    }
    if (removed) this.version++;
    return removed;
  }

  /** Solid at (p, r)? */
  solid(p: number, r: number): boolean {
    const j = Math.floor((p - this.pMin) / this.res);
    const k = Math.floor(Math.abs(r) / this.res);
    if (j < 0 || j >= this.np || k >= this.nr) return false;
    return this.occ[j * this.nr + k] === 1;
  }

  /** Solid at (p, r) and everywhere within `d` of it (the point is at least d deep in metal). */
  deepIn(p: number, r: number, d: number): boolean {
    return (
      this.solid(p, r) &&
      this.solid(p - d, r) &&
      this.solid(p + d, r) &&
      this.solid(p, r - d) &&
      this.solid(p, r + d)
    );
  }

  /** Outer radius of material at part position p (for the chuck jaws). */
  outerAt(p: number): number {
    const j = Math.min(this.np - 1, Math.max(0, Math.floor((p - this.pMin) / this.res)));
    for (let k = this.nr - 1; k >= 0; k--) if (this.occ[j * this.nr + k]) return this.rAt(k) + this.res / 2;
    return 0;
  }
}

/** Program Z -> part position p for a setup. */
export function toPart(setup: Pick<JobSetup, 'orient'>, z: number): number {
  const s = SIM_CONFIG.stock;
  return setup.orient === 0 ? s.faceStockFront - z : s.length - s.faceStockBack + z;
}

/** Cutting shape of a tool in an operation, (z, r) relative to the programmed point. */
const shapeCache = new Map<string, Point[]>();
export function cuttingShape(tool: number, opName: string): Point[] {
  const key = `${tool}|${opName}|${getUnknownDrill()}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  let poly: Point[];
  const def = toolFor(tool, opName);
  if (def?.role === 'stopper') {
    poly = []; // the bar stop never cuts
  } else if (def?.axial && def.width) {
    // Face groove blade: X is its outer edge, it cuts along -Z.
    const w = def.width;
    poly = [
      [0, -w],
      [8, -w],
      [8, 0],
      [0, 0],
    ];
  } else {
    poly = toolGeometry(def).insert;
    if (!poly.length) poly = [[0, 0]];
  }
  shapeCache.set(key, poly);
  return poly;
}

/**
 * Where the tool tip of move i first passes at least `depth` deep through material (checked
 * against the material before the move), or null. Part ends within the face allowances are left
 * out: how much stock really sits there is an estimate.
 */
export function tipThroughMaterial(grid: Grid, job: Job, i: number, depth: number): number | null {
  const o = i * STRIDE;
  const mv = job.moves;
  const setup = job.setups[mv[o + F.setup]];
  const x0 = mv[o + F.x0] / 2;
  const z0 = mv[o + F.z0];
  const x1 = mv[o + F.x1] / 2;
  const z1 = mv[o + F.z1];
  const s = SIM_CONFIG.stock;
  const lo = s.faceStockFront + depth;
  const hi = s.length - s.faceStockBack - depth;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(len / grid.res));
  // the tip starts on the surface it has just cut: only what it travels into counts
  const skip = Math.ceil(((depth + grid.res) / Math.max(len, 1e-9)) * n);
  for (let k = skip; k <= n; k++) {
    const f = k / n;
    const p = toPart(setup, z0 + (z1 - z0) * f);
    if (p < lo || p > hi) continue;
    if (grid.deepIn(p, x0 + (x1 - x0) * f, depth)) return f;
  }
  return null;
}

/** Remove the material of move i (fraction f0..f1 of it). Returns cells removed. */
export function cutMove(grid: Grid, job: Job, i: number, f0 = 0, f1 = 1): number {
  const o = i * STRIDE;
  const mv = job.moves;
  const type = mv[o + F.type];
  if (type === 3 || type === 4 || f1 <= f0) return 0;
  const tool = mv[o + F.tool];
  if (!tool) return 0;
  const setup = job.setups[mv[o + F.setup]];
  const op = job.ops[mv[o + F.op]];
  const shape = cuttingShape(tool, op.name);
  if (!shape.length) return 0;
  const x0 = mv[o + F.x0] / 2;
  const z0 = mv[o + F.z0];
  const x1 = mv[o + F.x1] / 2;
  const z1 = mv[o + F.z1];
  const a: Point = [z0 + (z1 - z0) * f0, x0 + (x1 - x0) * f0];
  const b: Point = [z0 + (z1 - z0) * f1, x0 + (x1 - x0) * f1];
  const pts: Point[] = [];
  for (const q of shape) {
    pts.push([toPart(setup, a[0] + q[0]), a[1] + q[1]]);
    pts.push([toPart(setup, b[0] + q[0]), b[1] + q[1]]);
  }
  const t = mv[o + F.t0] + (mv[o + F.t1] - mv[o + F.t0]) * f1;
  return grid.stamp(hull(pts), t);
}
