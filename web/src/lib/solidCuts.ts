import type { SolidFeature } from '../api/types';

/**
 * Cutting shapes for the non-turned features (cross holes, saddle cuts, flats, hexagons, slots,
 * face holes), in the revolved part's own frame: the axis is +Y, y = mm from the front face
 * (0 .. length), and the direction at angle a around the axis (0 = top of the main view, 90 =
 * toward the viewer) is (cos a, 0, sin a). PartPreview3D subtracts them from the turned body.
 */
export type Vec3 = [number, number, number];
export interface Cutter {
  shape: 'cylinder' | 'box' | 'ring';
  /** Centre of the shape. */
  at: Vec3;
  /** Direction of the shape's own Y axis (cylinder axis; box height). */
  axis: Vec3;
  /** Cylinder: radius at its +axis end and at its -axis end, and its length. */
  rTop?: number;
  rBottom?: number;
  /** Ring (face groove): inner radius; rTop is its outer radius. */
  rInner?: number;
  length: number;
  /** Box: size across (perpendicular to axis and to `side`), and along `side`. */
  width?: number;
  depth?: number;
  /** Box: direction of its depth (the box's own Z axis). */
  side?: Vec3;
  /** Which feature (index in the solid list) this shape cuts. */
  feature: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
export const around = (deg: number): Vec3 => [Math.cos(rad(deg)), 0, Math.sin(rad(deg))];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Outside radius of the turned body at y (from the outer outline, [y, r] points). */
export function radiusAt(outer: [number, number][], y: number): number {
  let best = 0;
  for (let i = 0; i + 1 < outer.length; i++) {
    const [y0, r0] = outer[i];
    const [y1, r1] = outer[i + 1];
    if (y < Math.min(y0, y1) - 1e-6 || y > Math.max(y0, y1) + 1e-6) continue;
    const r = Math.abs(y1 - y0) < 1e-9 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    best = Math.max(best, r);
  }
  return best || Math.max(0, ...outer.map((p) => p[1]));
}

/** Every cutting shape for the solid list; features that lack a number are skipped (listed). */
export function cutters(
  solid: SolidFeature[],
  outer: [number, number][],
  length: number,
): { cuts: Cutter[]; skipped: number[] } {
  const maxR = Math.max(1, ...outer.map((p) => p[1]));
  const big = 2 * maxR + 4; // longer than the part is wide
  const cuts: Cutter[] = [];
  const skipped: number[] = [];
  const Y: Vec3 = [0, 1, 0];
  solid.forEach((f, i) => {
    const a0 = f.angle ?? 0;
    const n = Math.max(1, f.count || 1);
    const before = cuts.length;
    const ring = (step: number) => Array.from({ length: n }, (_, k) => a0 + (k * step) / n);
    switch (f.kind) {
      case 'cross_hole': {
        if (f.z === null || f.diameter === null) break;
        const r1 = f.diameter / 2;
        const r2 = (f.diameter_end ?? f.diameter) / 2; // at the outside
        const R = radiusAt(outer, f.z);
        for (const a of ring(360)) {
          let dir = around(a);
          if (f.tilt) dir = norm(add(mul(dir, Math.cos(rad(f.tilt))), mul(Y, Math.sin(rad(f.tilt)))));
          const base: Vec3 = [0, f.z, 0];
          if (f.through) {
            cuts.push({
              shape: 'cylinder',
              at: base,
              axis: dir,
              rTop: r2,
              rBottom: r2,
              length: big,
              feature: i,
            });
          } else {
            // from the outside inward: depth if given, else to the axis
            const d = Math.min(f.depth ?? R, R + 1);
            const inner = R - d;
            const len = d + 2; // 2 mm clear of the outside
            const mid = inner + len / 2;
            cuts.push({
              shape: 'cylinder',
              at: add(base, mul(dir, mid)),
              axis: dir,
              rTop: r2,
              rBottom: r1,
              length: len,
              feature: i,
            });
          }
        }
        break;
      }
      case 'saddle': {
        if (f.z === null || f.radius === null) break;
        const back = f.end !== 'front';
        const cy = back ? f.z + f.radius : f.z - f.radius;
        cuts.push({
          shape: 'cylinder',
          at: [0, cy, 0],
          axis: around(a0),
          rTop: f.radius,
          rBottom: f.radius,
          length: big,
          feature: i,
        });
        break;
      }
      case 'flat':
      case 'hex':
      case 'square': {
        if (f.z_from === null || f.z_to === null) break;
        // hex: 6 flats, square: 4; a flat: as many as counted (two when across flats is given)
        const sides = f.kind === 'hex' ? 6 : f.kind === 'square' ? 4 : f.across_flats !== null ? 2 : n;
        const z0 = Math.min(f.z_from, f.z_to);
        const z1 = Math.max(f.z_from, f.z_to);
        const R = Math.max(radiusAt(outer, z0), radiusAt(outer, z1), radiusAt(outer, (z0 + z1) / 2));
        const h = f.across_flats !== null ? f.across_flats / 2 : f.depth !== null ? R - f.depth : null;
        if (h === null || h <= 0) break;
        for (const a of Array.from({ length: sides }, (_, k) => a0 + (k * 360) / sides)) {
          const dir = around(a);
          const thick = big;
          cuts.push({
            shape: 'box',
            at: add([0, (z0 + z1) / 2, 0], mul(dir, h + thick / 2)),
            axis: Y,
            length: z1 - z0,
            width: big,
            depth: thick,
            side: dir,
            feature: i,
          });
        }
        break;
      }
      case 'slot':
      case 'keyway': {
        if (f.width === null || f.depth === null) break;
        if (f.end) {
          // across an end face: through the whole diameter, depth along the axis
          const y = f.end === 'back' ? length - f.depth / 2 + 1 : f.depth / 2 - 1;
          const dir = around(a0 + 90);
          cuts.push({
            shape: 'box',
            at: [0, y, 0],
            axis: Y,
            length: f.depth + 2,
            width: f.width,
            depth: big,
            side: dir,
            feature: i,
          });
          break;
        }
        if (f.z_from === null || f.z_to === null) break;
        const z0 = Math.min(f.z_from, f.z_to);
        const z1 = Math.max(f.z_from, f.z_to);
        const R = radiusAt(outer, (z0 + z1) / 2);
        for (const a of ring(360)) {
          const dir = around(a);
          const thick = f.depth + 2;
          cuts.push({
            shape: 'box',
            at: add([0, (z0 + z1) / 2, 0], mul(dir, R - f.depth + thick / 2)),
            axis: Y,
            length: z1 - z0,
            width: f.width,
            depth: thick,
            side: dir,
            feature: i,
          });
        }
        break;
      }
      case 'face_groove': {
        if (f.diameter === null || f.depth === null) break;
        const rOut = f.diameter / 2;
        const rIn = f.diameter_end !== null ? f.diameter_end / 2 : f.width !== null ? rOut - f.width : null;
        if (rIn === null || rIn <= 0 || rIn >= rOut) break;
        const len = f.depth + 1; // 1 mm clear of the face
        const y = f.end === 'front' ? f.depth - len / 2 : length - f.depth + len / 2;
        cuts.push({
          shape: 'ring',
          at: [0, y, 0],
          axis: Y,
          rTop: rOut,
          rInner: rIn,
          length: len,
          feature: i,
        });
        break;
      }
      case 'face_hole': {
        if (f.diameter === null || f.pcd === null) break;
        const back = f.end === 'back';
        const d = f.through ? length + 2 : (f.depth ?? length) + 1;
        const y = back ? length - d / 2 + 1 : d / 2 - 1;
        for (const a of ring(360)) {
          const p = mul(around(a), f.pcd / 2);
          cuts.push({
            shape: 'cylinder',
            at: [p[0], y, p[2]],
            axis: Y,
            rTop: f.diameter / 2,
            rBottom: f.diameter / 2,
            length: d,
            feature: i,
          });
        }
        break;
      }
      default:
        break; // knurl, spline, other: listed, not cut
    }
    if (cuts.length === before && !['knurl', 'spline', 'other'].includes(f.kind)) skipped.push(i);
  });
  return { cuts, skipped };
}

const mm = (v: number | null) => (v === null ? '?' : `${Math.round(v * 1000) / 1000}`);
const LABEL: Record<SolidFeature['kind'], string> = {
  cross_hole: 'Cross hole',
  saddle: 'Saddle cut',
  flat: 'Flat',
  hex: 'Hexagon',
  square: 'Square',
  slot: 'Slot',
  keyway: 'Keyway',
  face_hole: 'Face hole',
  face_groove: 'Face groove',
  knurl: 'Knurl',
  spline: 'Spline',
  other: 'Other',
};

/** One line for the engineer: what it is, its size and where (mm from the front face). */
export function describeSolid(f: SolidFeature): string {
  const n = f.count > 1 ? `${f.count} × ` : '';
  const span = f.z_from !== null && f.z_to !== null ? `, z ${mm(f.z_from)}–${mm(f.z_to)}` : '';
  const at = f.angle ? ` at ${mm(f.angle)}°` : '';
  switch (f.kind) {
    case 'cross_hole':
      return (
        `${n}${LABEL[f.kind]} Ø${mm(f.diameter)}` +
        (f.diameter_end !== null && f.diameter_end !== f.diameter
          ? `→Ø${mm(f.diameter_end)} (tapered)`
          : '') +
        (f.through ? ' through' : `, ${mm(f.depth)} deep`) +
        `, z ${mm(f.z)}${at}` +
        (f.tilt ? `, tilted ${mm(f.tilt)}°` : '')
      );
    case 'saddle':
      return `${LABEL[f.kind]} R${mm(f.radius)} on the ${f.end ?? '?'} end, deepest at z ${mm(f.z)}`;
    case 'flat':
      return `${n}${LABEL[f.kind]}${f.across_flats !== null ? ` ${mm(f.across_flats)} across flats` : `, ${mm(f.depth)} deep`}${span}${at}`;
    case 'hex':
    case 'square':
      return `${LABEL[f.kind]} ${mm(f.across_flats)} across flats${span}`;
    case 'slot':
    case 'keyway':
      return `${n}${LABEL[f.kind]} ${mm(f.width)} wide × ${mm(f.depth)} deep${f.end ? ` across the ${f.end} face` : span}${at}`;
    case 'face_groove':
      return (
        `${LABEL[f.kind]} Ø${mm(f.diameter)}` +
        (f.diameter_end !== null
          ? `/Ø${mm(f.diameter_end)}`
          : f.width !== null
            ? `, ${mm(f.width)} wide`
            : '') +
        `, ${mm(f.depth)} deep, ${f.end ?? '?'} face (face-grooving tool)`
      );
    case 'face_hole':
      return `${n}${LABEL[f.kind]} Ø${mm(f.diameter)} on PCD ${mm(f.pcd)}, ${f.end ?? '?'} face${f.through ? ', through' : `, ${mm(f.depth)} deep`}`;
    default:
      return `${LABEL[f.kind]}${span}${f.evidence ? `: ${f.evidence}` : ''}`;
  }
}
