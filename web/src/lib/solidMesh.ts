import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { Cutter } from './solidCuts';

/**
 * The profile with every corner sharper than `maxTurnDeg` doubled, so the revolved surface keeps
 * a hard edge there: shared vertices would blend the normals of the face and the diameter and
 * make a square shoulder or a 45° chamfer look rounded.
 */
export function sharpCorners(pts: THREE.Vector2[], maxTurnDeg = 20): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const limit = Math.cos((maxTurnDeg * Math.PI) / 180);
  pts.forEach((p, i) => {
    out.push(p.clone());
    if (i === 0 || i === pts.length - 1) return;
    const a = new THREE.Vector2().subVectors(p, pts[i - 1]);
    const b = new THREE.Vector2().subVectors(pts[i + 1], p);
    if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return;
    if (a.normalize().dot(b.normalize()) < limit) out.push(p.clone());
  });
  return out;
}

/** A closed ring (annulus x length, centred, axis +Y): the cutter for a face groove. */
function ringGeometry(rIn: number, rOut: number, length: number): THREE.BufferGeometry {
  const h = length / 2;
  const pts = [
    new THREE.Vector2(rIn, -h),
    new THREE.Vector2(rOut, -h),
    new THREE.Vector2(rOut, h),
    new THREE.Vector2(rIn, h),
    new THREE.Vector2(rIn, -h),
  ];
  return new THREE.LatheGeometry(pts, 96);
}

/** The cutting shape as a mesh in the part's own frame (axis +Y, y from the front face). */
export function cutterBrush(c: Cutter): Brush {
  const geo =
    c.shape === 'cylinder'
      ? new THREE.CylinderGeometry(c.rTop ?? 1, c.rBottom ?? 1, c.length, 48)
      : c.shape === 'ring'
        ? ringGeometry(c.rInner ?? 0.5, c.rTop ?? 1, c.length)
        : new THREE.BoxGeometry(c.width ?? 1, c.length, c.depth ?? 1);
  const b = new Brush(geo);
  const y = new THREE.Vector3(...c.axis).normalize();
  if (c.shape === 'box' && c.side) {
    const z = new THREE.Vector3(...c.side).normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    b.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  } else b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), y);
  b.position.set(...c.at);
  b.updateMatrixWorld();
  return b;
}

/** The turned body with every non-turned feature cut out of it (the body alone if that fails). */
export function cutSolid(body: THREE.BufferGeometry, cuts: Cutter[]): THREE.BufferGeometry {
  if (!cuts.length) return body;
  try {
    const ev = new Evaluator();
    ev.attributes = ['position', 'normal'];
    ev.useGroups = false;
    let result = new Brush(body);
    result.updateMatrixWorld();
    for (const c of cuts) {
      const tool = cutterBrush(c);
      result = ev.evaluate(result, tool, SUBTRACTION);
      tool.geometry.dispose();
    }
    return result.geometry;
  } catch {
    return body;
  }
}
