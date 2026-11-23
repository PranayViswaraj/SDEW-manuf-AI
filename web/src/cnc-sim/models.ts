/**
 * Machine and tool models for <cnc-simulator>: built from three.js primitives, no model files.
 *
 * Frame: three.js X = machine Z (spindle axis, + towards the tailstock), Y = machine X (radius,
 * the tool side is +Y), Z = towards the operator. Units: mm. Every tool is built with its
 * programmed point (tip) at the origin.
 */
import * as THREE from 'three';
import type { Point } from '../sim/lathe/types';
import { cuttingShape } from './grid';
import { brushedTexture, paintTexture } from './textures';
import { toolFor } from './tools';

// ---------------------------------------------------------------------------- materials

export type MatName =
  | 'carbide'
  | 'carbideTop'
  | 'steel'
  | 'steelDark'
  | 'tin'
  | 'tinFlute'
  | 'tinVC'
  | 'black'
  | 'turret'
  | 'screw'
  | 'chuck'
  | 'jaw'
  | 'paint'
  | 'paintDark'
  | 'cast'
  | 'way'
  | 'stainless'
  | 'tray'
  | 'hose'
  | 'lamp';

export class Materials {
  private cache = new Map<MatName, THREE.Material>();
  private textures: THREE.Texture[] = [];
  private brushed = brushedTexture();
  private paint = paintTexture();

  constructor() {
    this.textures.push(this.brushed, this.paint);
  }

  get(name: MatName): THREE.Material {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
    const b = this.brushed;
    const m: THREE.Material = {
      carbide: () => std({ color: '#3d434b', metalness: 0.7, roughness: 0.38 }),
      carbideTop: () => std({ color: '#c9a24a', metalness: 0.9, roughness: 0.3 }), // TiN-coated rake face
      steel: () => std({ color: '#9aa3ad', metalness: 0.92, roughness: 0.32, roughnessMap: b }),
      steelDark: () => std({ color: '#4a525c', metalness: 0.85, roughness: 0.4, roughnessMap: b }),
      tin: () => std({ color: '#d6ab45', metalness: 0.95, roughness: 0.24 }),
      tinFlute: () => std({ color: '#8a6a22', metalness: 0.9, roughness: 0.35 }),
      tinVC: () => std({ vertexColors: true, metalness: 0.95, roughness: 0.25 }),
      black: () => std({ color: '#16191d', metalness: 0.5, roughness: 0.5 }),
      turret: () => std({ color: '#7c8792', metalness: 0.85, roughness: 0.32, roughnessMap: b }),
      screw: () => std({ color: '#d2d7dc', metalness: 1, roughness: 0.18 }),
      chuck: () => std({ color: '#8b949e', metalness: 0.9, roughness: 0.28, roughnessMap: b }),
      jaw: () => std({ color: '#5d6670', metalness: 0.85, roughness: 0.35, roughnessMap: b }),
      paint: () =>
        std({ color: '#e4e8ec', metalness: 0.05, roughness: 0.55, bumpMap: this.paint, bumpScale: 0.4 }),
      paintDark: () =>
        std({ color: '#2c333b', metalness: 0.2, roughness: 0.6, bumpMap: this.paint, bumpScale: 0.3 }),
      cast: () =>
        std({ color: '#5a646f', metalness: 0.3, roughness: 0.65, bumpMap: this.paint, bumpScale: 0.6 }),
      way: () => std({ color: '#c7ced5', metalness: 1, roughness: 0.14, roughnessMap: b }),
      stainless: () => std({ color: '#8f98a2', metalness: 0.9, roughness: 0.38, roughnessMap: b }),
      tray: () => std({ color: '#262c33', metalness: 0.5, roughness: 0.7 }),
      hose: () => std({ color: '#2a6fd6', metalness: 0.15, roughness: 0.45 }),
      lamp: () =>
        new THREE.MeshStandardMaterial({ color: '#fff7e6', emissive: '#fff1d0', emissiveIntensity: 2.2 }),
    }[name]();
    this.cache.set(name, m);
    return m;
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.cache.clear();
  }
}

/** Shadows on every mesh of a group. */
export function shadows(o: THREE.Object3D, cast = true, receive = true) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = cast;
      m.receiveShadow = receive;
    }
  });
}

export function disposeGroup(o: THREE.Object3D) {
  o.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder whose axis runs along three.js X. */
const cylX = (r0: number, r1: number, len: number, seg = 32) => {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  g.rotateZ(-Math.PI / 2); // +Y axis -> +X, r0 at -X end
  return g;
};
const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
};

// ---------------------------------------------------------------------------- machine

/** Slant-bed lathe around the work: bed and ways, enclosure, chip tray, work lamp. Static. */
export function buildMachine(mat: Materials): THREE.Group {
  const g = new THREE.Group();
  // slant bed (45 deg) with two hardened, ground box ways
  const bed = mesh(box(560, 40, 170), mat.get('cast'), 20, -118, -40);
  bed.rotation.x = -Math.PI / 4;
  g.add(bed);
  for (const [y, z] of [
    [-84, -56],
    [-118, -22],
  ]) {
    const way = mesh(box(540, 10, 18), mat.get('way'), 20, y, z);
    way.rotation.x = -Math.PI / 4;
    g.add(way);
  }
  // chip tray / floor
  g.add(mesh(box(640, 8, 300), mat.get('tray'), 20, -175, 20));
  // enclosure: brushed stainless back wall, side walls, roof with a lamp strip
  g.add(mesh(box(640, 360, 6), mat.get('stainless'), 20, 0, -150));
  const left = mesh(box(6, 360, 300), mat.get('paintDark'), -300, 0, 0);
  g.add(left);
  g.add(mesh(box(640, 6, 300), mat.get('paintDark'), 20, 180, 0));
  const lamp = mesh(box(260, 3, 14), mat.get('lamp'), 40, 176, -40);
  g.add(lamp);
  shadows(g, false, true);
  return g;
}

/** Headstock casting and spindle nose behind the chuck (moves with the chuck per setup). */
export function buildHeadstock(mat: Materials): THREE.Group {
  const g = new THREE.Group();
  const housing = mesh(box(150, 210, 230), mat.get('paint'), -150, 0, -30);
  g.add(housing);
  g.add(mesh(box(152, 14, 232), mat.get('paintDark'), -150, 98, -30));
  // spindle nose (A2-6 style) between headstock and chuck
  g.add(mesh(cylX(52, 52, 40, 48), mat.get('steelDark'), -95, 0, 0));
  g.add(mesh(cylX(56, 56, 8, 48), mat.get('steel'), -72, 0, 0));
  shadows(g);
  return g;
}

// ---------------------------------------------------------------------------- chuck

/** Hydraulic 3-jaw chuck: body, face ring, master jaws, stepped top jaws with bolts. */
export class Chuck {
  readonly group = new THREE.Group();
  readonly spin = new THREE.Group();
  private jaws: THREE.Group[] = [];
  static readonly R = 80;
  static readonly LEN = 62;

  constructor(mat: Materials) {
    const R = Chuck.R;
    const L = Chuck.LEN;
    // body: revolved profile (radius, axial) around three Y, then turned onto X
    const prof = [
      new THREE.Vector2(12, -L),
      new THREE.Vector2(R - 4, -L),
      new THREE.Vector2(R, -L + 4),
      new THREE.Vector2(R, -6),
      new THREE.Vector2(R - 5, 0),
      new THREE.Vector2(26, 0),
      new THREE.Vector2(22, -4),
      new THREE.Vector2(12, -4),
    ];
    const body = new THREE.LatheGeometry(prof, 72);
    body.rotateZ(-Math.PI / 2);
    this.spin.add(mesh(body, mat.get('chuck')));
    // face ring and register lines
    const ring = new THREE.TorusGeometry(R - 10, 0.8, 6, 72);
    ring.rotateY(Math.PI / 2);
    this.spin.add(mesh(ring, mat.get('steelDark'), 0.2));
    // mounting bolt heads round the face
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 6;
      const bolt = mesh(
        cylX(3.2, 3.2, 3, 16),
        mat.get('black'),
        1,
        (R - 18) * Math.cos(a),
        (R - 18) * Math.sin(a),
      );
      this.spin.add(bolt);
    }
    // three jaws: master jaw in its slot + stepped top jaw bolted on
    for (let k = 0; k < 3; k++) {
      const jaw = new THREE.Group();
      const slot = mesh(box(1.5, 46, 18), mat.get('black'), 0.2, 40, 0);
      slot.userData.fixed = true;
      jaw.add(slot);
      const master = mesh(box(12, 30, 16), mat.get('jaw'), 6, 0, 0); // radial along +Y
      master.name = 'master';
      jaw.add(master);
      const top1 = mesh(box(22, 14, 20), mat.get('steel'), 17, -8, 0); // grip step
      const top2 = mesh(box(12, 14, 20), mat.get('steel'), 11, 6, 0); // back step
      jaw.add(top1, top2);
      for (const dy of [-10, 2]) jaw.add(mesh(cylX(2.6, 2.6, 2, 12), mat.get('black'), 28.5, dy, 0));
      jaw.rotation.x = (k * 2 * Math.PI) / 3 + Math.PI / 6;
      this.jaws.push(jaw);
      this.spin.add(jaw);
    }
    this.group.add(this.spin);
    shadows(this.group);
  }

  /** Jaws close on the part: grip radius r (mm). */
  grip(r: number) {
    for (const jaw of this.jaws) {
      // the top jaw's grip face (local y = -15) sits on radius r
      for (const c of jaw.children) {
        if (c.userData.fixed) continue;
        const base = (c.userData.y0 as number | undefined) ?? c.position.y;
        c.userData.y0 = base;
        c.position.y = base + r + 15;
      }
    }
  }
}

// ---------------------------------------------------------------------------- tools

export interface ToolModel {
  group: THREE.Group;
  /** Axial tools (drills, boring bars, face groove) point along -X from the turret face. */
  axial: boolean;
  /** Radial tools: distance from the tip up to the shank end. Axial: from the tip to the holder end. */
  reach: number;
  /** Axial tools: height of the tool axis above the tip (where the holder centre is). */
  axisY: number;
}

function bounds(shape: Point[]) {
  let zMax = 0;
  let rMax = 0;
  let rMin = 0;
  for (const [z, r] of shape) {
    zMax = Math.max(zMax, z);
    rMax = Math.max(rMax, r);
    rMin = Math.min(rMin, r);
  }
  return { zMax, rMax, rMin };
}

/** Insert: extruded cutting shape, carbide with a coated rake face. */
function insertMesh(shape: Point[], mat: Materials): THREE.Group {
  const g = new THREE.Group();
  if (shape.length < 3) {
    g.add(mesh(new THREE.SphereGeometry(0.8, 12, 10), mat.get('carbide')));
    return g;
  }
  const sh = new THREE.Shape(shape.map(([z, r]) => new THREE.Vector2(z, r)));
  const body = new THREE.ExtrudeGeometry(sh, {
    depth: 4.6,
    bevelEnabled: true,
    bevelSize: 0.18,
    bevelThickness: 0.18,
    bevelSegments: 2,
  });
  body.translate(0, 0, -2.3);
  g.add(mesh(body, mat.get('carbide')));
  const top = new THREE.ShapeGeometry(sh);
  g.add(mesh(top, mat.get('carbideTop'), 0, 0, 2.52));
  return g;
}

/** Twisted drill: point, two helical flutes, margin, shank. Tip at origin, body along +X. */
function twistDrill(d: number, mat: Materials): { group: THREE.Group; reach: number } {
  const r = d / 2;
  const cone = r / Math.tan((59 * Math.PI) / 180);
  const fluteLen = Math.max(4.5 * d, 18);
  const shankLen = Math.max(2.5 * d, 16);
  const slices = 120;
  const around = 40;
  const pitch = d * 3.2; // helix lead
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const gold = new THREE.Color('#d6ab45');
  const flute = new THREE.Color('#6b5218');
  for (let i = 0; i <= slices; i++) {
    const x = (i / slices) * (cone + fluteLen);
    const scale = x < cone ? Math.max(0.02, x / cone) : 1;
    const twist = (x / pitch) * Math.PI * 2;
    for (let j = 0; j <= around; j++) {
      const th = (j / around) * Math.PI * 2;
      const c = Math.cos(2 * (th - twist));
      const depth = Math.max(0, c - 0.15) / 0.85; // two flutes
      const rr = r * scale * (1 - 0.42 * Math.pow(depth, 1.6));
      pos.push(x, rr * Math.cos(th), rr * Math.sin(th));
      const k = Math.min(1, depth * 1.4);
      const cc = gold.clone().lerp(flute, k);
      col.push(cc.r, cc.g, cc.b);
    }
  }
  for (let i = 0; i < slices; i++)
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + around + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const g = new THREE.Group();
  g.add(mesh(geo, mat.get('tinVC')));
  const x0 = cone + fluteLen;
  g.add(mesh(cylX(r * 0.96, r * 0.96, shankLen, 28), mat.get('tin'), x0 + shankLen / 2));
  // collet holder
  const hx = x0 + shankLen;
  g.add(mesh(cylX(r + 4, r + 9, 18, 32), mat.get('steelDark'), hx + 9));
  g.add(mesh(cylX(r + 12, r + 12, 22, 32), mat.get('steel'), hx + 29));
  return { group: g, reach: hx + 40 };
}

/** Build the tool in a station, for an operation (the shape can depend on the job). */
export function buildTool(tool: number, opName: string, mat: Materials): ToolModel {
  const group = new THREE.Group();
  const def = toolFor(tool, opName);
  const role = def?.role ?? 'unknown';
  const shape = cuttingShape(tool, opName);
  const { zMax, rMax, rMin } = bounds(shape);
  if (role === 'drill') {
    const d = def?.drillDiameter ?? 6;
    const dr = twistDrill(d, mat);
    group.add(dr.group);
    shadows(group);
    return { group, axial: true, reach: dr.reach, axisY: 0 };
  }
  if (role === 'stopper') {
    // bar stop: a round bar with a hardened pad, square to the bar face
    const len = 70;
    group.add(mesh(cylX(5, 5, 4, 32), mat.get('black'), 2));
    group.add(mesh(cylX(8, 8, len, 32), mat.get('steel'), 4 + len / 2));
    group.add(mesh(cylX(14, 14, 24, 32), mat.get('steelDark'), len - 6));
    shadows(group);
    return { group, axial: true, reach: len + 8, axisY: 0 };
  }
  if (role === 'bore' || def?.axial) {
    const grooveTool = !!def?.axial;
    group.add(insertMesh(shape, mat));
    const bar = grooveTool ? 12 : (def?.barDiameter ?? 12);
    const yc = grooveTool ? (rMax + rMin) / 2 : def?.tipDirection === 2 ? -(bar / 2 + 0.8) : bar / 2 + 0.8;
    const len = 78;
    const barGeo = cylX(bar / 2, bar / 2, len, 32);
    group.add(mesh(barGeo, mat.get('steelDark'), zMax + len / 2 - 2, yc));
    // clamp seat at the insert and the flat on the bar
    group.add(
      mesh(
        box(Math.max(8, zMax + 4), bar * 0.5, bar * 0.9),
        mat.get('steelDark'),
        zMax / 2 + 1,
        yc + (yc < 0 ? bar * 0.35 : -bar * 0.35),
      ),
    );
    group.add(mesh(box(len * 0.6, 0.6, bar * 0.7), mat.get('steel'), zMax + len * 0.55, yc + bar / 2 - 0.2));
    // sleeve in the holder
    group.add(mesh(cylX(bar / 2 + 6, bar / 2 + 6, 26, 32), mat.get('steel'), zMax + len - 8));
    group.children[group.children.length - 1].position.y = yc;
    shadows(group);
    return { group, axial: true, reach: zMax + len + 5, axisY: yc };
  }
  // radial turning / grooving holder: insert, top clamp, screw, head, square shank
  group.add(insertMesh(shape, mat));
  const cx = Math.max(3, zMax * 0.45);
  const clamp = mesh(
    box(Math.max(6, zMax * 0.55), 2.4, 5.6),
    mat.get('black'),
    cx,
    Math.max(2.5, rMax * 0.55),
    2.6,
  );
  clamp.rotation.z = -0.15;
  group.add(clamp);
  const screw = new THREE.CylinderGeometry(1.4, 1.4, 1.6, 16);
  screw.rotateX(Math.PI / 2);
  group.add(mesh(screw, mat.get('screw'), cx + 1, Math.max(2.5, rMax * 0.55) + 0.5, 3.9));
  const headH = 12;
  const head = mesh(
    box(Math.max(16, zMax + 8), headH, 20),
    mat.get('steelDark'),
    cx,
    rMax + headH / 2 - 1,
    0,
  );
  group.add(head);
  const shankLen = 62;
  group.add(mesh(box(20, shankLen, 20), mat.get('steel'), cx, rMax + headH + shankLen / 2 - 1, 0));
  shadows(group);
  return { group, axial: false, reach: rMax + headH + shankLen - 1, axisY: 0 };
}

// ---------------------------------------------------------------------------- turret

/**
 * 12-station turret, axis along X. Every tool of the job sits in its station; the disc indexes so
 * the station in use points down at the part. The turret is placed so that tool's tip is exactly
 * on the programmed point.
 */
export class Turret {
  readonly group = new THREE.Group(); // positioned every frame
  readonly disc = new THREE.Group(); // rotates when indexing
  private stations = new Map<
    number,
    { holder: THREE.Group; model: ToolModel; key: string; tip: THREE.Vector3 }
  >();
  private angle = 0;
  private target = 0;
  private active = 0;
  static readonly N = 12;
  static readonly R = 62;
  private nozzle = new THREE.Group();
  nozzleTip = new THREE.Vector3();

  constructor(private mat: Materials) {
    const R = Turret.R;
    const N = Turret.N;
    const discGeo = new THREE.CylinderGeometry(R, R, 44, N);
    discGeo.rotateZ(-Math.PI / 2);
    discGeo.rotateX(Math.PI / N);
    this.disc.add(mesh(discGeo, mat.get('turret')));
    const cap = cylX(30, 30, 50, 40);
    this.disc.add(mesh(cap, mat.get('steelDark')));
    const coupling = new THREE.TorusGeometry(40, 2, 8, 48);
    coupling.rotateY(Math.PI / 2);
    this.disc.add(mesh(coupling, mat.get('steel'), 22.5));
    // empty station blocks all round
    for (let s = 0; s < N; s++) {
      const blk = mesh(box(40, 14, 30), mat.get('steelDark'), 0, -(R + 6), 0);
      const st = new THREE.Group();
      st.add(blk);
      st.rotation.x = (s * 2 * Math.PI) / N;
      this.disc.add(st);
    }
    // turret body behind the disc (cross slide)
    this.group.add(mesh(box(70, 70, 70), mat.get('paint'), 58, 0, 0));
    this.group.add(this.disc, this.nozzle);
    shadows(this.group);
  }

  private stationAngle(tool: number) {
    return (((tool - 1) % Turret.N) * 2 * Math.PI) / Turret.N;
  }

  /** Mount (or swap) the tool in its station for an operation. */
  mount(tool: number, opName: string) {
    if (tool <= 0) return;
    const key = `${tool}|${opName}`;
    const cur = this.stations.get(tool);
    if (cur?.key === key) return;
    if (cur) {
      this.disc.remove(cur.holder);
      disposeGroup(cur.holder);
    }
    const model = buildTool(tool, opName, this.mat);
    const holder = new THREE.Group();
    const R = Turret.R;
    // station frame: -Y points away from the disc centre (towards the part when in use)
    const tip = new THREE.Vector3();
    if (model.axial) {
      // holder block on the station, tool along -X out of the disc face
      holder.add(mesh(box(34, 26, 34), this.mat.get('steel'), -30, -(R + 14), 0));
      tip.set(-30 - 17 - model.reach, -(R + 14) - model.axisY, 0);
    } else {
      holder.add(mesh(box(34, 18, 34), this.mat.get('steel'), 0, -(R + 16), 0));
      tip.set(0, -(R + 25) - model.reach, 0);
    }
    model.group.position.copy(tip);
    model.group.userData.tool = tool;
    holder.add(model.group);
    holder.rotation.x = this.stationAngle(tool);
    shadows(holder);
    this.disc.add(holder);
    // tip in the disc frame
    const tipDisc = tip.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), holder.rotation.x);
    this.stations.set(tool, { holder, model, key, tip: tipDisc });
  }

  /** Make `tool` the one in use; the disc indexes to it. */
  select(tool: number, opName: string, animate: boolean) {
    this.mount(tool, opName);
    if (tool === this.active) return;
    this.active = tool;
    this.target = -this.stationAngle(tool);
    // shortest way round
    while (this.target - this.angle > Math.PI) this.target -= 2 * Math.PI;
    while (this.target - this.angle < -Math.PI) this.target += 2 * Math.PI;
    if (!animate) this.angle = this.target;
    this.disc.rotation.x = this.angle;
    this.buildNozzle();
  }

  /** Index animation step. Returns true while turning. */
  step(dt: number): boolean {
    const d = this.target - this.angle;
    if (Math.abs(d) < 1e-4) {
      if (this.angle !== this.target) {
        this.angle = this.target;
        this.disc.rotation.x = this.angle;
      }
      return false;
    }
    this.angle += d * Math.min(1, dt * 9);
    this.disc.rotation.x = this.angle;
    return true;
  }

  /** Put the turret so the active tool's tip is at `tip` (world). */
  place(tip: THREE.Vector3) {
    const st = this.stations.get(this.active);
    if (!st) {
      this.group.position.copy(tip);
      return;
    }
    const local = st.tip.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), this.target);
    this.group.position.copy(tip).sub(local);
  }

  /** Articulated coolant hose from the turret to just above the tip of the tool in use. */
  private buildNozzle() {
    for (const c of [...this.nozzle.children]) {
      this.nozzle.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const st = this.stations.get(this.active);
    if (!st) return;
    const tipLocal = st.tip.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), this.target);
    const base = new THREE.Vector3(-18, -Turret.R * 0.35, 40);
    const end = tipLocal.clone().add(new THREE.Vector3(16, 20, 16));
    const ctrl = base
      .clone()
      .lerp(end, 0.5)
      .add(new THREE.Vector3(0, 14, 16));
    const curve = new THREE.QuadraticBezierCurve3(base, ctrl, end);
    this.nozzle.add(mesh(new THREE.TubeGeometry(curve, 48, 2.3, 12, false), this.mat.get('hose')));
    // Loc-Line segment rings along the hose
    const rings = Math.max(6, Math.round(curve.getLength() / 6));
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const ring = new THREE.TorusGeometry(2.5, 0.55, 8, 16);
      const m = mesh(ring, this.mat.get('hose'));
      m.position.copy(curve.getPoint(t));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(t));
      this.nozzle.add(m);
    }
    const dir = tipLocal.clone().sub(end).normalize();
    const tipGeo = new THREE.CylinderGeometry(1.2, 2.6, 8, 14);
    const tipMesh = mesh(tipGeo, this.mat.get('hose'), end.x, end.y, end.z);
    tipMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    tipMesh.position.addScaledVector(dir, 4);
    this.nozzle.add(tipMesh);
    this.nozzleTip.copy(end).addScaledVector(dir, 8);
    shadows(this.nozzle, true, false);
  }

  /** Nozzle tip in world space. */
  nozzleWorld(out: THREE.Vector3) {
    return out.copy(this.nozzleTip).add(this.group.position);
  }

  get indexing() {
    return Math.abs(this.target - this.angle) > 1e-3;
  }

  dispose() {
    disposeGroup(this.group);
  }
}
