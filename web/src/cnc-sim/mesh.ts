/**
 * Revolve the material grid into one reused BufferGeometry.
 *
 * Surfaces of a turned part are cylinders (where the radius of a material edge stays the same
 * along the axis) and flat rings (where it changes). Both come straight from the grid: runs of
 * columns with the same edge radius become one band; changes between neighbouring columns become
 * ring walls. The cut-away shows the grid itself as flat caps.
 *
 * Every vertex has a colour (raw bar / freshly cut fading to machined) and a UV: u goes round the
 * part, v along it (bands) or out from the axis (faces), so a feed-mark texture reads as turning.
 */
import * as THREE from 'three';
import { SIM_CONFIG } from './config';
import type { Grid } from './grid';

/** Colour levels: 0 = just cut ... FADE-1 = machined (old cut), RAW = never cut (bar stock). */
const FADE = 8;
const RAW = FADE;
const LV = FADE + 1;
/** Texture repeat: feed marks every 2 mm of length. */
const UV_MM = 2;

export interface MeshColours {
  /** Bar stock as delivered (never cut). */
  stock: string;
  /** Freshly cut surface. */
  fresh: string;
  /** Machined surface once the fresh colour has faded. */
  machined?: string;
  /** Cut-away faces. */
  cap: string;
}

function grow(arr: Float32Array, n: number, keep: number): Float32Array {
  if (arr.length >= n) return arr;
  const next = new Float32Array(Math.ceil(n * 1.5));
  next.set(arr.subarray(0, keep));
  return next;
}

export class PartMeshBuilder {
  readonly geometry = new THREE.BufferGeometry();
  readonly edges = new THREE.BufferGeometry();
  private pos = new Float32Array(300000 * 3);
  private nrm = new Float32Array(300000 * 3);
  private col = new Float32Array(300000 * 3);
  private uv = new Float32Array(300000 * 2);
  private lin = new Float32Array(60000 * 3);
  private n = 0;
  private ln = 0;
  private palette = new Float32Array(LV * 3);
  private capRGB = [0, 0, 0];
  private cos: Float32Array;
  private sin: Float32Array;
  private uvU: Float32Array;
  private segs = 0;
  private phiA = 0;
  private phiB = 0;
  private cutaway = true;
  // scratch for band merging
  private openKey = new Int32Array(4096);
  private openStart = new Int32Array(4096);
  private openCount = 0;
  private nextKey = new Int32Array(4096);
  private nextStart = new Int32Array(4096);

  constructor(colours: MeshColours) {
    this.setColours(colours);
    this.cos = new Float32Array(SIM_CONFIG.segments + 1);
    this.sin = new Float32Array(SIM_CONFIG.segments + 1);
    this.uvU = new Float32Array(SIM_CONFIG.segments + 1);
    this.attach();
  }

  setColours(c: MeshColours) {
    const a = new THREE.Color(c.fresh);
    const b = new THREE.Color(c.machined ?? c.stock);
    for (let l = 0; l < FADE; l++) {
      const f = l / (FADE - 1);
      this.palette[l * 3] = a.r + (b.r - a.r) * f;
      this.palette[l * 3 + 1] = a.g + (b.g - a.g) * f;
      this.palette[l * 3 + 2] = a.b + (b.b - a.b) * f;
    }
    const raw = new THREE.Color(c.stock);
    this.palette[RAW * 3] = raw.r;
    this.palette[RAW * 3 + 1] = raw.g;
    this.palette[RAW * 3 + 2] = raw.b;
    const cap = new THREE.Color(c.cap);
    this.capRGB = [cap.r, cap.g, cap.b];
  }

  private attach() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.edges.setAttribute('position', new THREE.BufferAttribute(this.lin, 3));
  }

  private ensure(extraVerts: number) {
    const need = (this.n + extraVerts) * 3;
    if (need <= this.pos.length) return;
    this.pos = grow(this.pos, need, this.n * 3);
    this.nrm = grow(this.nrm, need, this.n * 3);
    this.col = grow(this.col, need, this.n * 3);
    this.uv = grow(this.uv, (this.n + extraVerts) * 2, this.n * 2);
    this.geometry.dispose();
    this.attach();
  }

  private ensureLines(extra: number) {
    const need = (this.ln + extra) * 3;
    if (need <= this.lin.length) return;
    this.lin = grow(this.lin, need, this.ln * 3);
    this.edges.setAttribute('position', new THREE.BufferAttribute(this.lin, 3));
  }

  private v(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: number,
    u: number,
    w: number,
  ) {
    const i = this.n * 3;
    this.pos[i] = x;
    this.pos[i + 1] = y;
    this.pos[i + 2] = z;
    this.nrm[i] = nx;
    this.nrm[i + 1] = ny;
    this.nrm[i + 2] = nz;
    if (c < 0) {
      this.col[i] = this.capRGB[0];
      this.col[i + 1] = this.capRGB[1];
      this.col[i + 2] = this.capRGB[2];
    } else {
      this.col[i] = this.palette[c * 3];
      this.col[i + 1] = this.palette[c * 3 + 1];
      this.col[i + 2] = this.palette[c * 3 + 2];
    }
    const t = this.n * 2;
    this.uv[t] = u;
    this.uv[t + 1] = w;
    this.n++;
  }

  /** Cylinder band from p0 to p1 at radius r; sign +1 outside surface, -1 bore surface. */
  private band(p0: number, p1: number, r: number, sign: number, level: number, lines: boolean) {
    const S = this.segs;
    this.ensure(S * 6);
    const w0 = p0 / UV_MM;
    const w1 = p1 / UV_MM;
    for (let s = 0; s < S; s++) {
      const c0 = this.cos[s];
      const s0 = this.sin[s];
      const c1 = this.cos[s + 1];
      const s1 = this.sin[s + 1];
      const u0 = this.uvU[s];
      const u1 = this.uvU[s + 1];
      if (sign > 0) {
        this.v(p0, r * c0, r * s0, 0, c0, s0, level, u0, w0);
        this.v(p0, r * c1, r * s1, 0, c1, s1, level, u1, w0);
        this.v(p1, r * c0, r * s0, 0, c0, s0, level, u0, w1);
        this.v(p1, r * c0, r * s0, 0, c0, s0, level, u0, w1);
        this.v(p0, r * c1, r * s1, 0, c1, s1, level, u1, w0);
        this.v(p1, r * c1, r * s1, 0, c1, s1, level, u1, w1);
      } else {
        this.v(p0, r * c0, r * s0, 0, -c0, -s0, level, u0, w0);
        this.v(p1, r * c0, r * s0, 0, -c0, -s0, level, u0, w1);
        this.v(p0, r * c1, r * s1, 0, -c1, -s1, level, u1, w0);
        this.v(p1, r * c0, r * s0, 0, -c0, -s0, level, u0, w1);
        this.v(p1, r * c1, r * s1, 0, -c1, -s1, level, u1, w1);
        this.v(p0, r * c1, r * s1, 0, -c1, -s1, level, u1, w0);
      }
    }
    if (lines) this.ring(p0, r);
  }

  /** Flat ring at p between r0 and r1, facing +p (dir 1) or -p (dir -1). */
  private wall(p: number, r0: number, r1: number, dir: number, level: number, lines: boolean) {
    const S = this.segs;
    this.ensure(S * 6);
    const w0 = r0 / UV_MM;
    const w1 = r1 / UV_MM;
    for (let s = 0; s < S; s++) {
      const c0 = this.cos[s];
      const s0 = this.sin[s];
      const c1 = this.cos[s + 1];
      const s1 = this.sin[s + 1];
      const u0 = this.uvU[s];
      const u1 = this.uvU[s + 1];
      if (dir > 0) {
        this.v(p, r0 * c0, r0 * s0, 1, 0, 0, level, u0, w0);
        this.v(p, r1 * c0, r1 * s0, 1, 0, 0, level, u0, w1);
        this.v(p, r1 * c1, r1 * s1, 1, 0, 0, level, u1, w1);
        this.v(p, r0 * c0, r0 * s0, 1, 0, 0, level, u0, w0);
        this.v(p, r1 * c1, r1 * s1, 1, 0, 0, level, u1, w1);
        this.v(p, r0 * c1, r0 * s1, 1, 0, 0, level, u1, w0);
      } else {
        this.v(p, r0 * c0, r0 * s0, -1, 0, 0, level, u0, w0);
        this.v(p, r1 * c1, r1 * s1, -1, 0, 0, level, u1, w1);
        this.v(p, r1 * c0, r1 * s0, -1, 0, 0, level, u0, w1);
        this.v(p, r0 * c0, r0 * s0, -1, 0, 0, level, u0, w0);
        this.v(p, r0 * c1, r0 * s1, -1, 0, 0, level, u1, w0);
        this.v(p, r1 * c1, r1 * s1, -1, 0, 0, level, u1, w1);
      }
    }
    if (lines) this.ring(p, r1);
  }

  private ring(p: number, r: number) {
    if (r < 0.2) return;
    const S = this.segs;
    this.ensureLines(S * 2);
    for (let s = 0; s < S; s++) {
      const i = this.ln * 3;
      this.lin[i] = p;
      this.lin[i + 1] = r * this.cos[s];
      this.lin[i + 2] = r * this.sin[s];
      this.lin[i + 3] = p;
      this.lin[i + 4] = r * this.cos[s + 1];
      this.lin[i + 5] = r * this.sin[s + 1];
      this.ln += 2;
    }
  }

  /** Rectangle in the cut plane at angle phi. normal is (0, ny, nz). */
  private capRect(p0: number, p1: number, r0: number, r1: number, phi: number, ny: number, nz: number) {
    this.ensure(6);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    // flat cut face: constant UV (no feed marks on a sectioned face)
    this.v(p0, r0 * c, r0 * s, 0, ny, nz, -1, 0.5, 0.25);
    this.v(p1, r0 * c, r0 * s, 0, ny, nz, -1, 0.5, 0.25);
    this.v(p1, r1 * c, r1 * s, 0, ny, nz, -1, 0.5, 0.25);
    this.v(p0, r0 * c, r0 * s, 0, ny, nz, -1, 0.5, 0.25);
    this.v(p1, r1 * c, r1 * s, 0, ny, nz, -1, 0.5, 0.25);
    this.v(p0, r1 * c, r1 * s, 0, ny, nz, -1, 0.5, 0.25);
  }

  /** Rebuild from the grid. now = simulated seconds (for the fade). */
  build(g: Grid, now: number, cutaway: boolean, lines: boolean) {
    const S = cutaway ? Math.round((SIM_CONFIG.segments * 3) / 4) : SIM_CONFIG.segments;
    if (S !== this.segs || cutaway !== this.cutaway) {
      this.segs = S;
      this.cutaway = cutaway;
      this.phiA = cutaway ? Math.PI / 2 : 0;
      this.phiB = 2 * Math.PI;
      for (let s = 0; s <= S; s++) {
        const phi = this.phiA + ((this.phiB - this.phiA) * s) / S;
        this.cos[s] = Math.cos(phi);
        this.sin[s] = Math.sin(phi);
        this.uvU[s] = (phi / (2 * Math.PI)) * 4;
      }
    }
    this.n = 0;
    this.ln = 0;
    const { occ, cut, nr, np, res, pMin } = g;
    const fade = SIM_CONFIG.fadeSeconds;
    const level = (cell: number) => {
      const c = cut[cell];
      if (!c) return RAW;
      const age = now - (c - 1) / 10;
      if (age <= 0) return 0;
      return Math.min(FADE - 1, Math.floor((age / fade) * (FADE - 1)));
    };

    // ---- cylinder bands: merge runs of columns with the same edge (radius, side, colour)
    this.openCount = 0;
    for (let j = 0; j <= np; j++) {
      let nNext = 0;
      if (j < np) {
        const row = j * nr;
        let prev = 0;
        for (let k = 0; k <= nr; k++) {
          const cur = k < nr ? occ[row + k] : 0;
          if (cur !== prev) {
            const sign = prev ? 1 : -1; // material below -> outside surface
            const lv = level(prev ? (k < nr ? row + k : row + k - 1) : row + k - 1);
            if (!(sign < 0 && k === 0)) {
              const key = ((k * 2 + (sign > 0 ? 1 : 0)) * LV + lv) | 0;
              this.nextKey[nNext] = key;
              let start = j;
              for (let o = 0; o < this.openCount; o++)
                if (this.openKey[o] === key) {
                  start = this.openStart[o];
                  this.openKey[o] = -1;
                  break;
                }
              this.nextStart[nNext] = start;
              nNext++;
            }
          }
          prev = cur;
        }
      }
      for (let o = 0; o < this.openCount; o++) {
        const key = this.openKey[o];
        if (key < 0) continue;
        const lv = key % LV;
        const kk = Math.floor(key / LV);
        const sign = kk % 2 ? 1 : -1;
        const k = Math.floor(kk / 2);
        this.band(pMin + this.openStart[o] * res, pMin + j * res, k * res, sign, lv, lines);
      }
      for (let o = 0; o < nNext; o++) {
        this.openKey[o] = this.nextKey[o];
        this.openStart[o] = this.nextStart[o];
      }
      this.openCount = nNext;
    }

    // ---- ring walls where neighbouring columns differ
    for (let j = 1; j < np; j++) {
      const a = (j - 1) * nr;
      const b = j * nr;
      const p = pMin + j * res;
      let k = 0;
      while (k < nr) {
        const da = occ[a + k];
        const db = occ[b + k];
        if (da === db) {
          k++;
          continue;
        }
        const dir = da ? 1 : -1; // material on the low-p side faces +p
        const lv = level(da ? b + k : a + k);
        const k0 = k;
        k++;
        while (k < nr && occ[a + k] !== occ[b + k] && (occ[a + k] ? 1 : -1) === dir) {
          if (level(da ? b + k : a + k) !== lv) break;
          k++;
        }
        this.wall(p, k0 * res, k * res, dir, lv, lines);
      }
    }

    // ---- cut-away caps: occupied runs, merged across identical columns
    if (cutaway) {
      let runStart = -1;
      let runKey = '';
      let runs: [number, number][] = [];
      const flush = (jEnd: number) => {
        if (runStart < 0) return;
        for (const [k0, k1] of runs) {
          const p0 = pMin + runStart * res;
          const p1 = pMin + jEnd * res;
          this.capRect(p0, p1, k0 * res, k1 * res, this.phiA, 1, 0);
          this.capRect(p0, p1, k0 * res, k1 * res, 0, 0, 1);
        }
      };
      for (let j = 0; j < np; j++) {
        const row = j * nr;
        let key = '';
        const cur: [number, number][] = [];
        let k = 0;
        while (k < nr) {
          if (!occ[row + k]) {
            k++;
            continue;
          }
          const k0 = k;
          while (k < nr && occ[row + k]) k++;
          cur.push([k0, k]);
          key += `${k0},${k};`;
        }
        if (key !== runKey) {
          flush(j);
          runStart = cur.length ? j : -1;
          runKey = key;
          runs = cur;
        }
      }
      flush(np);
    }

    for (const name of ['position', 'normal', 'color', 'uv']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
    }
    this.geometry.setDrawRange(0, this.n);
    const la = this.edges.getAttribute('position') as THREE.BufferAttribute;
    la.needsUpdate = true;
    this.edges.setDrawRange(0, this.ln);
    return this.n / 3;
  }

  dispose() {
    this.geometry.dispose();
    this.edges.dispose();
  }
}
