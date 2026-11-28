import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { Cutter } from './solidCuts';

/** The cutting shape as a mesh in the part's own frame (axis +Y, y from the front face). */
export function cutterBrush(c: Cutter): Brush {
  const geo =
    c.shape === 'cylinder'
      ? new THREE.CylinderGeometry(c.rTop ?? 1, c.rBottom ?? 1, c.length, 48)
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
