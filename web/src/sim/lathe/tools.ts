/**
 * Tool geometry for the lathe simulation, in the (z, r) plane with the programmed point at 0,0.
 *
 * Convention: Z right, X (radius) up. The FANUC imaginary tip number tells where the nose centre
 * is from the programmed point. Shapes come only from the tool data (insert / holder ISO codes,
 * widths, diameters). When a value is missing the tool cuts at its tip point only and the
 * simulation says so: it never invents an insert or a holder.
 */

import type { InsertShape, Point, SimTool, ToolRole } from './types';

const DEG = Math.PI / 180;

/** Included angle of ISO insert shapes. */
export const SHAPE_ANGLE: Record<string, number> = { C: 80, D: 55, V: 35, W: 80, T: 60, S: 90, K: 55 };

/** ISO holder style letter -> lead (approach) angle, degrees. */
const HOLDER_STYLE: Record<string, number> = {
  A: 90,
  B: 75,
  D: 45,
  E: 60,
  F: 90,
  G: 90,
  H: 107.5,
  J: 93,
  K: 75,
  L: 95,
  N: 63,
  Q: 107.5,
  R: 75,
  S: 45,
  T: 60,
  U: 93,
  V: 72.5,
  Y: 85,
};

/** Nose centre offset (signs of dz, dr) from the imaginary tip, by FANUC tip number. */
export function tipSigns(tip: number | null): [number, number] {
  switch (tip) {
    case 1:
      return [-1, -1];
    case 2:
      return [1, -1];
    case 3:
      return [1, 1];
    case 4:
      return [-1, 1];
    case 5:
      return [-1, 0];
    case 6:
      return [0, -1];
    case 7:
      return [1, 0];
    case 8:
      return [0, 1];
    default:
      return [0, 0];
  }
}

/** Read an ISO turning insert code, e.g. "CNMG 120408" -> shape C, edge 12, nose 0.8. */
export function parseInsertCode(code: string): { shape: InsertShape; size: number; nose: number } | null {
  const m = code.toUpperCase().match(/\b([CDVWTSRK])[A-Z]{2,3}\s*-?\s*(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return { shape: m[1] as InsertShape, size: Number(m[2]), nose: Number(m[4]) / 10 };
}

/** Read an ISO holder / boring bar code, e.g. "PCLNR 2525M12" or "S20S-SCLCR09". */
export function parseHolderCode(code: string): {
  shape: InsertShape;
  lead: number;
  hand: 'R' | 'L' | 'N';
  shank: number | null;
  bar: number | null;
} | null {
  const t = code.toUpperCase().replace(/\s+/g, '');
  const m = t.match(/([PMSCDT])([CDVWTSRK])([A-Z])([NPBCE])([RLN])(\d{2})?(\d{2})?/);
  if (!m || HOLDER_STYLE[m[3]] === undefined) return null;
  const bar = t.match(/^[ASECF](\d{2})[A-Z]/);
  return {
    shape: m[2] as InsertShape,
    lead: HOLDER_STYLE[m[3]],
    hand: m[5] as 'R' | 'L' | 'N',
    shank: m[6] ? Number(m[6]) : null,
    bar: bar ? Number(bar[1]) : null,
  };
}

/** Default FANUC tip number for a tool role (standard convention, shown as "from tool type"). */
export function defaultTip(role: ToolRole): number | null {
  if (role === 'od') return 3;
  if (role === 'bore') return 2;
  if (role === 'groove' || role === 'part' || role === 'thread') return 8;
  if (role === 'drill') return 0;
  return null;
}

// ------------------------------------------------------------------ polygons

export interface ToolGeometry {
  /** Cutting part of the insert (convex). Removes material. */
  insert: Point[];
  /** Holder / blade / bar body (convex parts). Must never touch material. Empty = unknown. */
  holder: Point[][];
  /** Cutting edge directions (deg, from +Z towards +r) for the rubbing check, or null. */
  wedge: { a1: number; a2: number } | null;
  /** Nose centre offset from the programmed point (for G41/G42 placement). */
  nose: { r: number; signs: [number, number] };
  /** False when the shape is unknown and the tool is a point. */
  shaped: boolean;
  /** Short reason the shape is a point, for the warning. */
  missing: string[];
}

const dir = (a: number): Point => [Math.cos(a * DEG), Math.sin(a * DEG)];
const add = (p: Point, q: Point, k = 1): Point => [p[0] + q[0] * k, p[1] + q[1] * k];

/** Convex hull (monotone chain), counter-clockwise. */
export function hull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12)
      lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12)
      upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function mirror(poly: Point[], mz: boolean, mr: boolean): Point[] {
  return poly.map(([z, r]) => [mz ? -z : z, mr ? -r : r]);
}

const POINT_TOOL: Point[] = [
  [0, 0],
  [0.02, 0],
  [0.02, 0.02],
  [0, 0.02],
];

/** Wedge insert for tip direction 3 (external, cutting towards the chuck), then mirrored. */
function wedgeInsert(
  eps: number,
  lead: number,
  size: number,
  rn: number,
  triangle: boolean,
): { poly: Point[]; a1: number; a2: number } {
  const a1 = 180 - lead; // main edge
  const a2 = a1 - eps; // minor edge
  const c: Point = [rn, rn];
  const pts: Point[] = [];
  if (rn > 1e-6) {
    const start = a2 - 90;
    const end = a1 + 90 - 360;
    const n = 10;
    for (let k = 0; k <= n; k++) pts.push(add(c, dir(start + ((end - start) * k) / n), rn));
  } else pts.push([0, 0]);
  // Sharp corner of the two edge lines, and the edge ends.
  const t1 = rn > 1e-6 ? add(c, dir(a1 + 90), rn) : ([0, 0] as Point);
  const t2 = rn > 1e-6 ? add(c, dir(a2 - 90), rn) : ([0, 0] as Point);
  const e1 = add(t1, dir(a1), size);
  const e2 = add(t2, dir(a2), size);
  pts.push(e1, e2);
  if (!triangle) pts.push(add(e1, dir(a2), size)); // far corner of a rhombic / square insert
  return { poly: hull(pts), a1, a2 };
}

export function toolGeometry(tool: SimTool | undefined): ToolGeometry {
  const missing: string[] = [];
  const point = (why: string[]): ToolGeometry => ({
    insert: POINT_TOOL,
    holder: [],
    wedge: null,
    nose: { r: 0, signs: [0, 0] },
    shaped: false,
    missing: why,
  });
  if (!tool) return point(['tool not in the tool list']);
  const tip = tool.tipDirection;
  const [sz, sr] = tipSigns(tip);
  const mz = sz < 0;
  const mr = sr < 0;
  const rn = tool.noseRadius ?? 0;
  const role = tool.role;

  if (role === 'stopper') return { ...point([]), insert: [], missing: [] };

  if (role === 'drill') {
    const d = tool.drillDiameter;
    if (!d) return point(['drill diameter']);
    const h = d / 2;
    const cone = h / Math.tan(59 * DEG);
    const flute = Math.max(5 * d, 30);
    return {
      insert: [
        [0, 0],
        [cone, h],
        [flute, h],
        [flute, -h],
        [cone, -h],
      ],
      holder: [
        [
          [flute, -h * 1.1],
          [flute + 70, -h * 1.1],
          [flute + 70, h * 1.1],
          [flute, h * 1.1],
        ],
      ],
      wedge: null,
      nose: { r: 0, signs: [0, 0] },
      shaped: true,
      missing: [],
    };
  }

  if (role === 'groove' || role === 'part') {
    const w = tool.width;
    if (!w) missing.push('insert width');
    if (!tool.refEdge) missing.push('reference edge');
    if (missing.length) return point(missing);
    const z0 = tool.refEdge === 'left' ? 0 : -(w as number);
    const z1 = z0 + (w as number);
    const insert: Point[] = [
      [z0, 0],
      [z1, 0],
      [z1, 5],
      [z0, 5],
    ];
    const holder: Point[][] = tool.holder
      ? [
          [
            [z0 + 0.15, 5],
            [z1 - 0.15, 5],
            [z1 - 0.15, 32],
            [z0 + 0.15, 32],
          ],
          [
            [z0 - 6, 32],
            [z1 + 14, 32],
            [z1 + 14, 70],
            [z0 - 6, 70],
          ],
        ]
      : [];
    return {
      insert: mr ? mirror(insert, false, true) : insert,
      holder: holder.map((p) => (mr ? mirror(p, false, true) : p)),
      wedge: null,
      nose: { r: 0, signs: [0, 0] },
      shaped: true,
      missing: [],
    };
  }

  if (role === 'thread') {
    const ang = tool.threadAngle;
    if (!ang) return point(['thread angle']);
    const h = 3;
    const half = Math.tan((ang / 2) * DEG) * h;
    const insert: Point[] = [
      [0, 0],
      [half, h],
      [-half, h],
    ];
    const holder: Point[][] = tool.holder
      ? [
          [
            [half + 1, h + 0.5],
            [half + 22, h + 0.5],
            [half + 22, 90],
            [half + 1, 90],
          ],
        ]
      : [];
    return {
      insert: mr ? mirror(insert, false, true) : insert,
      holder: holder.map((p) => (mr ? mirror(p, false, true) : p)),
      wedge: null,
      nose: { r: 0, signs: [0, 0] },
      shaped: true,
      missing: [],
    };
  }

  // Turning / boring inserts.
  if (!tool.shape) missing.push('insert shape');
  if (tool.noseRadius === null) missing.push('nose radius');
  if (tip === null) missing.push('tip direction');
  if (tool.shape !== 'R' && tool.leadAngle === null) missing.push('lead angle (holder)');
  if (tool.insertSize === null) missing.push('insert size');
  if (missing.length) return point(missing);

  let poly: Point[];
  let wedge: { a1: number; a2: number } | null = null;
  const size = tool.insertSize as number;
  if (tool.shape === 'R') {
    const rr = size / 2;
    poly = [];
    for (let k = 0; k < 24; k++) poly.push(add([rr, rr], dir((360 * k) / 24), rr));
  } else {
    const eps = SHAPE_ANGLE[tool.shape as string] ?? 80;
    const w = wedgeInsert(eps, tool.leadAngle as number, size, rn, tool.shape === 'T' || tool.shape === 'W');
    poly = w.poly;
    wedge = { a1: w.a1, a2: w.a2 };
  }
  // Holder body behind the insert.
  const holder: Point[][] = [];
  if (tool.holder) {
    if (role === 'bore') {
      const d = tool.barDiameter ?? null;
      if (d) {
        // Bar body in the tip-3 frame (mirrored below the tip with the insert for tip 2).
        const f = 0.65 * d; // tip distance from the bar axis
        const z0 = 0.4 * size;
        holder.push([
          [z0, f - d / 2],
          [z0 + 4 * d + 80, f - d / 2],
          [z0 + 4 * d + 80, f + d / 2],
          [z0, f + d / 2],
        ]);
      } else missing.push('boring bar diameter');
    } else {
      const ws = wedge ?? { a1: 90, a2: 0 };
      // Head of the holder: behind the insert, a little inside both cutting edges.
      const a = add(add([rn, rn], dir(ws.a1), 0.75 * size), dir(ws.a1 - 90), 0.3 * size);
      const b = add(add([rn, rn], dir(ws.a2), size), dir(ws.a2 + 90), 0.35 * size);
      const shank = 25;
      const zR = Math.max(b[0], a[0] + shank);
      holder.push(hull([a, b, [a[0], a[1] + 110], [zR, Math.max(b[1], a[1]) + 110], [zR, b[1]]]));
    }
  }
  const tf = (p: Point[]) => mirror(p, mz, mr);
  if (wedge && (mz || mr)) {
    let { a1, a2 } = wedge;
    if (mr) [a1, a2] = [-a2, -a1];
    if (mz) [a1, a2] = [180 - a2, 180 - a1];
    wedge = { a1, a2 };
  }
  return {
    insert: tf(poly),
    holder: holder.map(tf),
    wedge,
    nose: { r: rn, signs: [sz, sr] },
    shaped: true,
    missing,
  };
}

/** Angle (deg, 0..360) of a direction. */
export function angleOf(d: Point): number {
  const a = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  return (a + 360) % 360;
}

/** True when angle `a` lies inside the wedge [a1, a2] (either order) widened by `margin`. */
export function insideWedge(a: number, w: { a1: number; a2: number }, margin: number): boolean {
  const lo = Math.min(w.a1, w.a2) - margin;
  const hi = Math.max(w.a1, w.a2) + margin;
  for (const k of [-360, 0, 360]) if (a + k > lo && a + k < hi) return true;
  return false;
}
