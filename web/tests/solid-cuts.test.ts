import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SolidFeature } from '../src/api/types';
import { cutters, describeSolid, radiusAt } from '../src/lib/solidCuts';
import { cutSolid } from '../src/lib/solidMesh';

const base: SolidFeature = {
  kind: 'other',
  z: null,
  z_from: null,
  z_to: null,
  diameter: null,
  diameter_end: null,
  width: null,
  depth: null,
  radius: null,
  across_flats: null,
  pcd: null,
  angle: null,
  tilt: null,
  count: 1,
  through: true,
  end: null,
  evidence: '',
};
const feat = (f: Partial<SolidFeature>): SolidFeature => ({ ...base, ...f });

// 3216C11701: tube Ø25 / Ø19 x 50 (outer and inner outline, [mm from the front face, radius])
const OUTER: [number, number][] = [
  [0, 12.5],
  [50, 12.5],
];
const SADDLE = feat({ kind: 'saddle', radius: 15.5, end: 'back', z: 41, angle: 90 });
const HOLE = feat({
  kind: 'cross_hole',
  z: 35,
  diameter: 16.5,
  diameter_end: 19.5,
  through: false,
  depth: 3,
});

function tube(): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(9.5, 0),
    new THREE.Vector2(12.5, 0),
    new THREE.Vector2(12.5, 50),
    new THREE.Vector2(9.5, 50),
    new THREE.Vector2(9.5, 0),
  ];
  return new THREE.LatheGeometry(pts, 64);
}
const volume = (g: THREE.BufferGeometry) => {
  const p = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : p.count;
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i) : i);
  let vol = 0;
  for (let i = 0; i < n; i += 3) vol += v(i).dot(new THREE.Vector3().crossVectors(v(i + 1), v(i + 2))) / 6;
  return Math.abs(vol);
};
const maxY = (g: THREE.BufferGeometry, x: number, z: number) => {
  g.computeBoundingBox();
  const p = g.getAttribute('position');
  let m = -Infinity;
  for (let i = 0; i < p.count; i++)
    if (Math.abs(p.getX(i) - x) < 1.5 && Math.abs(p.getZ(i) - z) < 1.5) m = Math.max(m, p.getY(i));
  return m;
};

describe('non-turned features in the 3D model', () => {
  it('places the saddle cylinder beyond the deepest point and the hole from the outside', () => {
    const { cuts, skipped } = cutters([SADDLE, HOLE], OUTER, 50);
    expect(skipped).toEqual([]);
    const [saddle, hole] = cuts;
    expect(saddle.at[1]).toBeCloseTo(41 + 15.5); // centre of the cutting cylinder
    expect(saddle.axis[2]).toBeCloseTo(1); // axis at 90° = toward the viewer
    expect(hole.rBottom).toBeCloseTo(8.25); // Ø16.5 inside
    expect(hole.rTop).toBeCloseTo(9.75); // Ø19.5 at the outside
    expect(hole.at[0]).toBeGreaterThan(9.5); // on the top (angle 0), from the outside in
    expect(radiusAt(OUTER, 20)).toBe(12.5);
  });

  it('cuts the saddle and the hole out of the turned tube', () => {
    const body = tube();
    const before = volume(body);
    const cut = cutSolid(body, cutters([SADDLE, HOLE], OUTER, 50).cuts);
    expect(cut).not.toBe(body);
    const after = volume(cut);
    expect(after).toBeLessThan(before * 0.97);
    // at the saddle's sides (x = ±12.5, z = 0: across the cutter axis) the end is cut down to
    // 41 + 15.5 - sqrt(15.5² - 12.5²) ≈ 47.3; in the cutter's own plane (x = 0) the end stays 41..
    expect(maxY(cut, 12.5, 0)).toBeLessThan(48);
  });

  it('skips a feature that lacks a size and says so', () => {
    const { cuts, skipped } = cutters([feat({ kind: 'hex', z_from: 0, z_to: 10 })], OUTER, 50);
    expect(cuts).toEqual([]);
    expect(skipped).toEqual([0]);
  });

  it('describes each feature in one line', () => {
    expect(describeSolid(HOLE)).toBe('Cross hole Ø16.5→Ø19.5 (tapered), 3 deep, z 35');
    expect(describeSolid(SADDLE)).toBe('Saddle cut R15.5 on the back end, deepest at z 41');
    expect(describeSolid(feat({ kind: 'hex', across_flats: 22, z_from: 0, z_to: 12 }))).toBe(
      'Hexagon 22 across flats, z 0–12',
    );
  });
});
