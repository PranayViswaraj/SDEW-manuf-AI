/**
 * Bar material for the lathe simulation: a profile around the spindle axis.
 *
 * For every Z column we keep the outer radius of material and the inner radius of any bore. A
 * move removes what the insert sweeps: for a convex insert moving in a straight line the swept
 * area is exactly the convex hull of the insert at the start and at the end of the move.
 */

import type { MaterialSnapshot, Point, ThreadZone } from './types';

export type CutMode = 'outer' | 'inner' | 'auto' | 'thread';

/** r-range of a convex polygon over a column [z0, z1] (signed r), or null. */
export function spanAt(poly: Point[], z0: number, z1: number): [number, number] | null {
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const p of poly) {
    if (p[0] < zmin) zmin = p[0];
    if (p[0] > zmax) zmax = p[0];
  }
  if (zmax <= z0 + 1e-9 || zmin >= z1 - 1e-9) {
    if (!(zmax === zmin && zmax > z0 && zmax < z1)) return null;
  }
  const z = Math.min(Math.max((z0 + z1) / 2, zmin), zmax);
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    if ((p[0] <= z && q[0] >= z) || (q[0] <= z && p[0] >= z)) {
      const dz = q[0] - p[0];
      if (Math.abs(dz) < 1e-12) {
        lo = Math.min(lo, p[1], q[1]);
        hi = Math.max(hi, p[1], q[1]);
      } else {
        const r = p[1] + ((z - p[0]) / dz) * (q[1] - p[1]);
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
    }
  }
  if (n === 1) return [poly[0][1], poly[0][1]];
  return lo <= hi ? [lo, hi] : null;
}

/** Signed r-range -> radius range around the axis (a range across the axis starts at 0). */
export function radial(lo: number, hi: number): [number, number] {
  if (lo >= 0) return [lo, hi];
  if (hi <= 0) return [-hi, -lo];
  return [0, Math.max(-lo, hi)];
}

export interface CutResult {
  /** Removed section area (mm², one side of the axis). */
  area: number;
  /** Area that would have been removed from the part after it was cut off. */
  droppedArea: number;
  /** Lowest column touched (for part-off detection). */
  touched: [number, number] | null;
}

export class Stock {
  readonly zMin: number;
  readonly res: number;
  readonly n: number;
  outer: Float32Array;
  inner: Float32Array;
  tagOuter: Uint8Array;
  tagInner: Uint8Array;
  partedAt: number | null = null;
  threads: ThreadZone[] = [];

  constructor(zMin: number, zMax: number, res: number, barR: number, faceZ: number) {
    this.zMin = zMin;
    this.res = res;
    this.n = Math.max(1, Math.ceil((zMax - zMin) / res));
    this.outer = new Float32Array(this.n);
    this.inner = new Float32Array(this.n);
    this.tagOuter = new Uint8Array(this.n);
    this.tagInner = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) this.outer[i] = this.zOf(i) <= faceZ ? barR : 0;
  }

  /** Centre Z of column i. */
  zOf(i: number): number {
    return this.zMin + (i + 0.5) * this.res;
  }

  idx(z: number): number {
    return Math.max(0, Math.min(this.n - 1, Math.floor((z - this.zMin) / this.res)));
  }

  has(i: number): boolean {
    return this.outer[i] > this.inner[i] + 1e-4;
  }

  dropped(i: number): boolean {
    return this.partedAt !== null && this.zOf(i) > this.partedAt;
  }

  snapshot(): MaterialSnapshot {
    return {
      outer: this.outer.slice(),
      inner: this.inner.slice(),
      tagOuter: this.tagOuter.slice(),
      tagInner: this.tagInner.slice(),
      partedAt: this.partedAt,
      threads: this.threads.map((t) => ({ ...t })),
    };
  }

  restore(s: MaterialSnapshot): void {
    this.outer = s.outer.slice();
    this.inner = s.inner.slice();
    this.tagOuter = s.tagOuter.slice();
    this.tagInner = s.tagInner.slice();
    this.partedAt = s.partedAt;
    this.threads = s.threads.map((t) => ({ ...t }));
  }

  private columns(poly: Point[]): [number, number] | null {
    if (!poly.length) return null;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const p of poly) {
      zmin = Math.min(zmin, p[0]);
      zmax = Math.max(zmax, p[0]);
    }
    const i0 = Math.floor((zmin - this.zMin) / this.res + 1e-6);
    const i1 = Math.floor((zmax - this.zMin) / this.res - 1e-6);
    if (i1 < 0 || i0 >= this.n) return null;
    return [Math.max(0, i0), Math.min(this.n - 1, i1)];
  }

  /** True when a convex body (holder) overlaps material (with a small clearance). */
  overlaps(poly: Point[], clearance = 0.05): boolean {
    const cols = this.columns(poly);
    if (!cols) return false;
    for (let i = cols[0]; i <= cols[1]; i++) {
      if (!this.has(i) || this.dropped(i)) continue;
      const s = spanAt(poly, this.zMin + i * this.res, this.zMin + (i + 1) * this.res);
      if (!s) continue;
      const [lo, hi] = radial(s[0], s[1]);
      if (hi > this.inner[i] + clearance && lo < this.outer[i] - clearance) return true;
    }
    return false;
  }

  /** Remove what the swept insert covers. `tag` is the operation colour index (1..). */
  /** True when column i lies in a cut thread (a thread tool moving there is in its own groove). */
  inThread(i: number): boolean {
    const z = this.zOf(i);
    return this.threads.some((t) => z <= t.zFront + 1e-6 && z >= t.zBack - 1e-6);
  }

  cut(poly: Point[], mode: CutMode, tag: number, pitch = 0): CutResult {
    // A thread tool that is not threading (approach / retract) cuts like an OD tool, except
    // inside the thread it already cut.
    const retract = mode === 'thread' && pitch <= 0;
    if (retract) mode = 'outer';
    const res: CutResult = { area: 0, droppedArea: 0, touched: null };
    const cols = this.columns(poly);
    if (!cols) return res;
    for (let i = cols[0]; i <= cols[1]; i++) {
      if (!this.has(i) || (retract && this.inThread(i))) continue;
      const s = spanAt(poly, this.zMin + i * this.res, this.zMin + (i + 1) * this.res);
      if (!s) continue;
      const [lo, hi] = radial(s[0], s[1]);
      const o = this.outer[i];
      const inn = this.inner[i];
      if (hi <= inn + 1e-4 || lo >= o - 1e-4) continue;
      if (this.dropped(i)) {
        res.droppedArea += (Math.min(hi, o) - Math.max(lo, inn)) * this.res;
        continue;
      }
      let m = mode;
      if (m === 'auto') m = o - hi < lo - inn ? 'outer' : 'inner';
      if (m === 'thread') {
        this.threadCut(i, lo, hi, pitch);
        res.area += 1e-3;
      } else if (m === 'outer') {
        if (lo <= inn + 1e-4) {
          res.area += (o - inn) * this.res;
          this.outer[i] = 0;
          this.inner[i] = 0;
        } else {
          res.area += (o - lo) * this.res;
          this.outer[i] = lo;
          this.tagOuter[i] = tag;
        }
      } else {
        if (hi >= o - 1e-4) {
          res.area += (o - inn) * this.res;
          this.outer[i] = 0;
          this.inner[i] = 0;
        } else {
          res.area += (hi - inn) * this.res;
          this.inner[i] = hi;
          this.tagInner[i] = tag;
        }
      }
      if (!res.touched) res.touched = [i, i];
      else res.touched[1] = i;
    }
    if (res.touched) this.detectPartOff(res.touched);
    return res;
  }

  private threadCut(i: number, lo: number, hi: number, pitch: number) {
    const z = this.zOf(i);
    const o = this.outer[i];
    const inn = this.inner[i];
    const external = o - hi < lo - inn;
    let zone = this.threads.find(
      (t) =>
        t.external === external && Math.abs(t.pitch - pitch) < 1e-6 && z >= t.zBack - 3 && z <= t.zFront + 3,
    );
    if (!zone) {
      zone = { zFront: z, zBack: z, major: external ? o : inn, minor: external ? o : inn, pitch, external };
      this.threads.push(zone);
    }
    zone.zFront = Math.max(zone.zFront, z);
    zone.zBack = Math.min(zone.zBack, z);
    if (external) {
      zone.major = Math.max(zone.major, o);
      zone.minor = Math.min(zone.minor, lo);
    } else {
      zone.major = Math.min(zone.major, inn);
      zone.minor = Math.max(zone.minor, hi);
    }
  }

  /** The part is cut off when an empty column has material on both sides of it. */
  private detectPartOff(touched: [number, number]) {
    if (this.partedAt !== null) return;
    for (let i = touched[0]; i <= touched[1]; i++) {
      if (this.has(i)) continue;
      let front = false;
      for (let k = i + 1; k < this.n && !front; k++) front = this.has(k);
      let back = false;
      for (let k = i - 1; k >= 0 && !back; k--) back = this.has(k);
      if (front && back) {
        // Cut plane: the highest empty column of this gap.
        let j = i;
        while (j + 1 < this.n && !this.has(j + 1)) j++;
        this.partedAt = this.zMin + j * this.res;
        return;
      }
    }
  }
}
