/**
 * Material-removal simulation for the lathe backplot (visual aid only, fixed rules, no AI).
 *
 * The bar is modelled as a section in the Z-R plane: for every Z column (0.1 mm) we keep the
 * outer radius of material and the inner radius of any hole. Feed moves remove material by tool
 * kind (from the tool name in the program comments); rapid moves never cut.
 */

export type Point = [number, number]; // [z, r]

export interface SimSegment {
  block: number;
  line: number;
  tool: number | null;
  kind: 'rapid' | 'feed';
  points: Point[];
  op?: number;
  label?: string;
}

export type ToolKind = 'external' | 'internal' | 'drill' | 'groove' | 'none';

export interface ToolInfo {
  kind: ToolKind;
  /** Drill: hole diameter (mm). Groove/parting: insert width (mm). */
  size: number | null;
  /** No tool name in the program: inside/outside is guessed from where the tip is. */
  guessed?: boolean;
}

/** Decide how a tool cuts from its name, e.g. "32.0 UDRILL", "3MM PARTING", "BORE FIN". */
export function classifyTool(label: string): ToolInfo {
  const t = label.toUpperCase();
  if (!t.trim()) return { kind: 'external', size: null, guessed: true };
  if (/STOP/.test(t)) return { kind: 'none', size: null }; // bar stopper: never cuts
  if (/DRILL|\bU\s?D\b|\bUD\b/.test(t)) {
    const m = t.match(/(\d+(?:\.\d+)?)/);
    return { kind: 'drill', size: m ? Number(m[1]) : null };
  }
  if (/PART|GROOV/.test(t)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*MM/);
    return { kind: 'groove', size: m ? Number(m[1]) : 3 };
  }
  if (/\bBOR|\bID\b|CSK/.test(t)) return { kind: 'internal', size: null };
  return { kind: 'external', size: null };
}

// ---------------------------------------------------------------- timeline

export const SPEED_FEED = 25; // mm per second of animation at 1x
export const SPEED_RAPID = 140;

export interface Move {
  seg: SimSegment;
  from: Point;
  to: Point;
  length: number;
  t0: number; // seconds
  t1: number;
}

export interface Timeline {
  moves: Move[];
  duration: number;
  blocks: number[]; // block index at the start of each drawn block, in order
}

export function buildTimeline(segments: SimSegment[]): Timeline {
  const moves: Move[] = [];
  let t = 0;
  const blocks: number[] = [];
  for (const seg of segments) {
    if (blocks[blocks.length - 1] !== seg.block) blocks.push(seg.block);
    for (let i = 1; i < seg.points.length; i++) {
      const from = seg.points[i - 1];
      const to = seg.points[i];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const dt = length / (seg.kind === 'rapid' ? SPEED_RAPID : SPEED_FEED);
      moves.push({ seg, from, to, length, t0: t, t1: t + dt });
      t += dt;
    }
  }
  return { moves, duration: t, blocks };
}

/** Index of the move active at time t (binary search). */
export function moveAt(tl: Timeline, t: number): number {
  let lo = 0;
  let hi = tl.moves.length - 1;
  if (hi < 0) return -1;
  if (t >= tl.duration) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.moves[mid].t1 < t)
      lo = mid + 1; // a boundary belongs to the move that just ended
    else hi = mid;
  }
  return lo;
}

export function positionAt(tl: Timeline, t: number): { point: Point; move: Move } | null {
  const i = moveAt(tl, t);
  if (i < 0) return null;
  const m = tl.moves[i];
  const span = m.t1 - m.t0;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - m.t0) / span)) : 1;
  return { move: m, point: [m.from[0] + (m.to[0] - m.from[0]) * f, m.from[1] + (m.to[1] - m.from[1]) * f] };
}

/** Time at which a block ends (for "next block" stepping). */
export function blockEndTime(tl: Timeline, block: number): number {
  let end = 0;
  for (const m of tl.moves) if (m.seg.block === block) end = m.t1;
  return end;
}

// ---------------------------------------------------------------- material

export const RES = 0.1; // mm per column

export class Material {
  readonly zMin: number;
  readonly zMax: number;
  readonly barR: number;
  readonly outer: Float32Array;
  readonly inner: Float32Array;

  constructor(zMin: number, zMax: number, barR: number, zFront: number) {
    this.zMin = zMin;
    this.zMax = zMax;
    this.barR = barR;
    const n = Math.max(1, Math.ceil((zMax - zMin) / RES) + 1);
    this.outer = new Float32Array(n);
    this.inner = new Float32Array(n);
    for (let i = 0; i < n; i++) this.outer[i] = this.zOf(i) <= zFront ? barR : 0;
  }

  get columns(): number {
    return this.outer.length;
  }

  zOf(i: number): number {
    return this.zMin + i * RES;
  }

  idx(z: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.round((z - this.zMin) / RES)));
  }

  hasMaterial(i: number): boolean {
    return this.outer[i] > this.inner[i] + 1e-3;
  }

  /** Remove material for a tool tip at (z, r). Returns the removed area (mm², upper half). */
  cut(z: number, r: number, tool: ToolInfo): number {
    let removed = 0;
    const start = this.idx(z);
    const n = this.columns;
    let kind = tool.kind;
    if (kind === 'none') return 0;
    if (tool.guessed && this.isInsideWall(start, r)) kind = 'internal';
    if (kind === 'groove') {
      const w = tool.size ?? 3;
      const lo = this.idx(z - w);
      for (let i = lo; i <= start; i++) removed += this.lowerOuter(i, Math.abs(r));
      return removed;
    }
    if (kind === 'drill') {
      const hole = (tool.size ?? 0) / 2 + Math.abs(r);
      if (hole <= 0) return 0;
      for (let i = start; i < n; i++) removed += this.raiseInner(i, hole);
      return removed;
    }
    if (kind === 'internal') {
      for (let i = start; i < n; i++) removed += this.raiseInner(i, Math.abs(r));
      return removed;
    }
    for (let i = start; i < n; i++) removed += this.lowerOuter(i, Math.abs(r)); // external
    return removed;
  }

  /** Unnamed tool: internal if its tip is in the inner half of the wall (or inside a hole). */
  private isInsideWall(i: number, r: number): boolean {
    if (!this.hasMaterial(i)) return false;
    return Math.abs(r) < (this.inner[i] + this.outer[i]) / 2;
  }

  private lowerOuter(i: number, r: number): number {
    if (r >= this.outer[i]) return 0;
    const before = this.outer[i] - this.inner[i];
    this.outer[i] = Math.max(r, this.inner[i]);
    return Math.max(0, before - (this.outer[i] - this.inner[i])) * RES;
  }

  private raiseInner(i: number, r: number): number {
    if (r <= this.inner[i]) return 0;
    const before = Math.max(0, this.outer[i] - this.inner[i]);
    this.inner[i] = Math.min(r, Math.max(this.outer[i], this.inner[i]));
    return Math.max(0, before - Math.max(0, this.outer[i] - this.inner[i])) * RES;
  }

  /** SVG path of the material section (upper half, y = -r). Mirror it for the lower half. */
  toPath(): string {
    const parts: string[] = [];
    let i = 0;
    const n = this.columns;
    while (i < n) {
      while (i < n && !this.hasMaterial(i)) i++;
      if (i >= n) break;
      const start = i;
      while (i < n && this.hasMaterial(i)) i++;
      const end = i - 1;
      const top: string[] = [];
      const bottom: string[] = [];
      for (let k = start; k <= end; k++) {
        const z = this.zOf(k).toFixed(2);
        top.push(`${z},${(-this.outer[k]).toFixed(3)}`);
        bottom.push(`${z},${(-this.inner[k]).toFixed(3)}`);
      }
      parts.push(`M${top.join('L')}L${bottom.reverse().join('L')}Z`);
    }
    return parts.join('');
  }
}

/** Sample a straight move every `step` mm (always includes the end point). */
export function samplesAlong(from: Point, to: Point, step = 0.2): Point[] {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.ceil(len / step));
  const out: Point[] = [];
  for (let k = 1; k <= n; k++) {
    const f = k / n;
    out.push([from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]);
  }
  return out;
}

/** Stock for one operation: the bar from the face (plus a facing allowance) to past the deepest cut. */
export function stockFor(
  segments: SimSegment[],
  barDiameter: number | null,
): {
  zMin: number;
  zMax: number;
  zFront: number;
  barR: number;
  estimated: boolean;
} {
  const feed = segments.filter((s) => s.kind === 'feed').flatMap((s) => s.points);
  const all = segments.flatMap((s) => s.points);
  const maxR = feed.length ? Math.max(...feed.map((p) => Math.abs(p[1]))) : 10;
  const minZ = feed.length ? Math.min(...feed.map((p) => p[0])) : -10;
  const maxZ = all.length ? Math.max(...all.map((p) => p[0])) : 5;
  const barR = barDiameter && barDiameter > 0 ? barDiameter / 2 : Math.ceil(maxR + 1);
  return {
    zMin: Math.floor(minZ - 6),
    zMax: Math.ceil(Math.max(maxZ, 2) + 1),
    zFront: 1, // facing allowance in front of program zero (estimated)
    barR,
    estimated: !(barDiameter && barDiameter > 0),
  };
}
