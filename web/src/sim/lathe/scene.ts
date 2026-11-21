/**
 * three.js scene for the lathe simulation. Three.js X = program Z, Y = radius (tool side),
 * three.js Z = depth (towards the operator). Units: mm.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toolOutline } from './engine';
import type { Stock } from './stock';
import { OP_KINDS, type Point, type SimInput, type SimMove, type SimResult, type SimTool } from './types';

export type ViewName = 'iso' | 'front' | 'top' | 'section' | 'follow';
export type ColourMode = 'ops' | 'compare';

/** Machined-surface colour per operation (raw bar = index 0). */
export const OP_COLOURS: string[] = [
  '#6b7280', // raw bar
  '#e5e7eb', // Face
  '#cbd5e1', // Rough
  '#f8fafc', // Finish
  '#fcd34d', // Groove
  '#a5f3fc', // Thread
  '#c4b5fd', // Drill
  '#93c5fd', // Bore
  '#fca5a5', // Part-off
  '#d1d5db', // Other
];
const COMPARE_COLOURS = ['#9ca3af', '#22c55e', '#ef4444', '#f59e0b'];
const SECTION_CAP = '#b45309';

const SEGS = 48;

interface Frame {
  mat: Stock;
  matVersion: number;
  move: SimMove | null;
  pos: Point | null;
  cutting: boolean;
  removed: number;
  playing: boolean;
  speed: number;
}

function simplify(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [z1, r1] = pts[a];
    const [z2, r2] = pts[b];
    const dz = z2 - z1;
    const dr = r2 - r1;
    const len = Math.hypot(dz, dr) || 1e-9;
    let best = -1;
    let dist = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dr * (pts[i][0] - z1) - dz * (pts[i][1] - r1)) / len;
      if (d > dist) {
        dist = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Section outline(s) of the material, one closed loop per separate piece. */
function outlines(mat: Stock, from: number, to: number, threadMinor: (i: number) => number | null) {
  const loops: { outer: { p: Point; i: number }[]; inner: { p: Point; i: number }[] }[] = [];
  let i = from;
  while (i <= to) {
    while (i <= to && !mat.has(i)) i++;
    if (i > to) break;
    const start = i;
    while (i <= to && mat.has(i)) i++;
    const end = i - 1;
    const outer: { p: Point; i: number }[] = [];
    const inner: { p: Point; i: number }[] = [];
    const z0 = mat.zMin + start * mat.res;
    const z1 = mat.zMin + (end + 1) * mat.res;
    const oAt = (k: number) => threadMinor(k) ?? mat.outer[k];
    outer.push({ p: [z0, oAt(start)], i: start });
    inner.push({ p: [z0, mat.inner[start]], i: start });
    for (let k = start; k <= end; k++) {
      const z = mat.zOf(k);
      const o = oAt(k);
      const prev = k > start ? oAt(k - 1) : o;
      if (Math.abs(o - prev) > 3 * mat.res) {
        const zb = mat.zMin + k * mat.res;
        outer.push({ p: [zb, prev], i: k - 1 }, { p: [zb, o], i: k });
      }
      outer.push({ p: [z, o], i: k });
      const n = mat.inner[k];
      const pn = k > start ? mat.inner[k - 1] : n;
      if (Math.abs(n - pn) > 3 * mat.res) {
        const zb = mat.zMin + k * mat.res;
        inner.push({ p: [zb, pn], i: k - 1 }, { p: [zb, n], i: k });
      }
      inner.push({ p: [z, n], i: k });
    }
    outer.push({ p: [z1, oAt(end)], i: end });
    inner.push({ p: [z1, mat.inner[end]], i: end });
    loops.push({ outer: simplifyTagged(outer), inner: simplifyTagged(inner) });
  }
  return loops;
}

function simplifyTagged(pts: { p: Point; i: number }[]) {
  const kept = simplify(
    pts.map((x) => x.p),
    0.004,
  );
  const set = new Set(kept);
  return pts.filter((x) => set.has(x.p));
}

/** Revolve a profile polyline into a strip mesh (flat between profile points, smooth around). */
function revolve(
  pos: number[],
  nrm: number[],
  col: number[],
  path: { p: Point; c: THREE.Color }[],
  phi0: number,
  phi1: number,
  segs: number,
) {
  for (let k = 0; k + 1 < path.length; k++) {
    const [za, ra] = path[k].p;
    const [zb, rb] = path[k + 1].p;
    if (ra < 1e-4 && rb < 1e-4) continue;
    const dz = zb - za;
    const dr = rb - ra;
    const len = Math.hypot(dz, dr);
    if (len < 1e-6) continue;
    const nz = -dr / len;
    const nr = dz / len;
    const c = path[k].c;
    for (let s = 0; s < segs; s++) {
      const p0 = phi0 + ((phi1 - phi0) * s) / segs;
      const p1 = phi0 + ((phi1 - phi0) * (s + 1)) / segs;
      const v = (z: number, r: number, f: number) => [z, r * Math.cos(f), r * Math.sin(f)];
      const n = (f: number) => [nz, nr * Math.cos(f), nr * Math.sin(f)];
      const A = v(za, ra, p0);
      const B = v(zb, rb, p0);
      const C = v(zb, rb, p1);
      const D = v(za, ra, p1);
      const N0 = n(p0);
      const N1 = n(p1);
      pos.push(...A, ...C, ...B, ...A, ...D, ...C);
      nrm.push(...N0, ...N1, ...N0, ...N0, ...N1, ...N1);
      for (let q = 0; q < 6; q++) col.push(c.r, c.g, c.b);
    }
  }
}

function threadMesh(
  zone: { zFront: number; zBack: number; major: number; minor: number; pitch: number },
  phi0: number,
  phi1: number,
  colour: string,
): THREE.Mesh | null {
  const len = zone.zFront - zone.zBack;
  if (len <= 0 || zone.pitch <= 0) return null;
  const nz = Math.min(800, Math.ceil(len / (zone.pitch / 10)));
  const nphi = 36;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let a = 0; a <= nphi; a++) {
    const phi = phi0 + ((phi1 - phi0) * a) / nphi;
    for (let b = 0; b <= nz; b++) {
      const z = zone.zBack + (len * b) / nz;
      const u = ((((z - zone.zFront) / zone.pitch + phi / (2 * Math.PI)) % 1) + 1) % 1;
      const r = zone.minor + (zone.major - zone.minor) * (1 - Math.abs(2 * u - 1));
      pos.push(z, r * Math.cos(phi), r * Math.sin(phi));
    }
  }
  for (let a = 0; a < nphi; a++)
    for (let b = 0; b < nz; b++) {
      const i = a * (nz + 1) + b;
      idx.push(i, i + nz + 1, i + 1, i + 1, i + nz + 1, i + nz + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({
      color: colour,
      metalness: 0.75,
      roughness: 0.3,
      side: THREE.DoubleSide,
    }),
  );
}

function extrude(
  poly: Point[],
  depth: number,
  colour: string,
  opts: Partial<THREE.MeshStandardMaterialParameters> = {},
) {
  if (poly.length < 3) return null;
  const shape = new THREE.Shape(poly.map(([z, r]) => new THREE.Vector2(z, r)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return new THREE.Mesh(
    g,
    new THREE.MeshStandardMaterial({ color: colour, metalness: 0.6, roughness: 0.4, ...opts }),
  );
}

export class LatheScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private spin = new THREE.Group();
  private partMesh: THREE.Mesh | null = null;
  private capMesh: THREE.Mesh | null = null;
  private threadMeshes: THREE.Mesh[] = [];
  private dropped: THREE.Group | null = null;
  private dropVel = 0;
  private turret = new THREE.Group();
  private turretDisk = new THREE.Group();
  private toolGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private current: THREE.Line;
  private glow: THREE.PointLight;
  private glowBall: THREE.Mesh;
  private chips: THREE.InstancedMesh;
  private chipState: {
    p: THREE.Vector3;
    v: THREE.Vector3;
    r: THREE.Euler;
    w: THREE.Vector3;
    life: number;
  }[] = [];
  private coolant: THREE.Points;
  private coolantT = new Float32Array(160);
  private result: SimResult | null = null;
  private input: SimInput | null = null;
  private tools = new Map<number, SimTool>();
  private activeTool: number | null = null;
  private turretAngle = 0;
  private turretTarget = 0;
  private matVersion = -1;
  private section = false;
  private colourMode: ColourMode = 'ops';
  private view: ViewName = 'iso';
  private lastTip = new THREE.Vector3();
  private size = 60;
  private centre = new THREE.Vector3();
  calm = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor('#0f172a');
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight('#e0f2fe', '#1e293b', 1.1));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(150, 300, 250);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#93c5fd', 0.8);
    rim.position.set(-200, 100, -200);
    this.scene.add(rim);

    this.scene.add(this.spin, this.turret, this.pathGroup);
    this.turret.add(this.turretDisk, this.toolGroup);

    this.current = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: '#facc15' }),
    );
    this.scene.add(this.current);

    this.glow = new THREE.PointLight('#fb923c', 0, 60, 1.5);
    this.glowBall = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 12),
      new THREE.MeshBasicMaterial({
        color: '#fdba74',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.glow, this.glowBall);

    this.chips = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.9, 0.16, 4, 10, Math.PI * 1.6),
      new THREE.MeshStandardMaterial({ color: '#d6d3d1', metalness: 0.8, roughness: 0.35 }),
      90,
    );
    this.chips.count = 0;
    this.chips.frustumCulled = false;
    this.scene.add(this.chips);

    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(160 * 3), 3));
    this.coolant = new THREE.Points(
      cg,
      new THREE.PointsMaterial({
        color: '#7dd3fc',
        size: 1.4,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    this.coolant.frustumCulled = false;
    this.coolant.visible = false;
    for (let i = 0; i < this.coolantT.length; i++) this.coolantT[i] = Math.random();
    this.scene.add(this.coolant);

    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setResult(result: SimResult, input: SimInput) {
    this.result = result;
    this.input = input;
    this.tools = new Map(input.tools.map((t) => [t.number, t]));
    this.matVersion = -1;
    this.activeTool = null;
    this.buildMachine();
    this.buildPath();
    const g = result.grid;
    const zFront = g.faceZ;
    const zBack = g.chuckZ ?? g.zMin + 20;
    this.size = Math.max(g.barR * 2.4, (zFront - zBack) * 1.3, 60);
    this.centre.set((zFront + zBack) / 2, g.barR * 0.6, 0);
    this.setView(this.view);
  }

  private clear(group: THREE.Object3D) {
    for (const c of [...group.children]) {
      group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
  }

  private buildMachine() {
    const r = this.result as SimResult;
    this.clear(this.spin);
    this.clear(this.turretDisk);
    this.partMesh = this.capMesh = null;
    this.threadMeshes = [];
    const g = r.grid;
    const barR = g.barR;
    const chuckZ = g.chuckZ ?? g.zMin + 20;
    const chuckR = Math.max((this.input?.machine.chuckDiameter ?? 0) / 2, barR + 45);
    const unknown = g.chuckZ === null;
    const steel = (c: string) =>
      new THREE.MeshStandardMaterial({
        color: c,
        metalness: 0.55,
        roughness: 0.45,
        transparent: unknown,
        opacity: unknown ? 0.35 : 1,
      });
    // Chuck body (axis along X).
    const body = new THREE.Mesh(new THREE.CylinderGeometry(chuckR, chuckR, 55, 48), steel('#475569'));
    body.rotation.z = Math.PI / 2;
    body.position.x = chuckZ - 28 - 27.5;
    this.spin.add(body);
    // Three jaws.
    for (let k = 0; k < 3; k++) {
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(28, chuckR - barR - 4, 18), steel('#94a3b8'));
      const a = (k * 2 * Math.PI) / 3;
      const rr = barR + (chuckR - barR - 4) / 2;
      jaw.position.set(chuckZ - 14, rr * Math.cos(a), rr * Math.sin(a));
      jaw.rotation.x = a;
      this.spin.add(jaw);
    }
    // Bar back into the spindle.
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(barR, barR, 140, 40), steel('#6b7280'));
    tail.rotation.z = Math.PI / 2;
    tail.position.x = g.zMin - 70;
    this.spin.add(tail);
    // Headstock (does not spin).
    const head = this.scene.getObjectByName('headstock');
    if (head) this.scene.remove(head);
    const hs = new THREE.Mesh(
      new THREE.BoxGeometry(120, chuckR * 2.6, chuckR * 2.4),
      new THREE.MeshStandardMaterial({ color: '#1e3a8a', metalness: 0.3, roughness: 0.6 }),
    );
    hs.name = 'headstock';
    hs.position.set(chuckZ - 83 - 60, 0, 0);
    this.scene.add(hs);
    // Turret disk with stations.
    const stations = this.input?.machine.turretStations ?? 8;
    const disk = new THREE.Mesh(
      new THREE.CylinderGeometry(48, 48, 34, 8),
      new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.5, roughness: 0.5 }),
    );
    disk.rotation.z = Math.PI / 2;
    this.turretDisk.add(disk);
    for (let s = 0; s < stations; s++) {
      const a = (s * 2 * Math.PI) / stations;
      const blk = new THREE.Mesh(
        new THREE.BoxGeometry(34, 22, 26),
        new THREE.MeshStandardMaterial({
          color: this.tools.has(s + 1) ? '#64748b' : '#3f4a5a',
          metalness: 0.5,
          roughness: 0.5,
        }),
      );
      blk.position.set(0, -54 * Math.cos(a), 54 * Math.sin(a));
      blk.rotation.x = -a;
      this.turretDisk.add(blk);
    }
  }

  private buildPath() {
    const r = this.result as SimResult;
    this.clear(this.pathGroup);
    const rapid: number[] = [];
    const feed: number[] = [];
    for (const m of r.moves) {
      if (!m.known || m.kind === 'dwell' || m.kind === 'index') continue;
      const arr = m.kind === 'rapid' ? rapid : feed;
      arr.push(m.from[0], m.from[1], 0.2, m.to[0], m.to[1], 0.2);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rapid, 3));
    const rl = new THREE.LineSegments(
      rg,
      new THREE.LineDashedMaterial({
        color: '#94a3b8',
        dashSize: 1.5,
        gapSize: 1.2,
        transparent: true,
        opacity: 0.6,
      }),
    );
    rl.computeLineDistances();
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(feed, 3));
    const fl = new THREE.LineSegments(
      fg,
      new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.7 }),
    );
    this.pathGroup.add(rl, fl);
  }

  setPathVisible(v: boolean) {
    this.pathGroup.visible = v;
  }

  setSection(on: boolean) {
    if (this.section === on) return;
    this.section = on;
    this.matVersion = -1;
  }

  setColourMode(m: ColourMode) {
    if (this.colourMode === m) return;
    this.colourMode = m;
    this.matVersion = -1;
  }

  setView(v: ViewName) {
    this.view = v;
    const c = this.centre;
    const s = this.size;
    this.camera.up.set(0, 1, 0);
    if (v === 'iso') this.camera.position.set(c.x + s * 1.1, c.y + s * 1.2, c.z + s * 2.0);
    else if (v === 'front' || v === 'section') this.camera.position.set(c.x, c.y, c.z + s * 2.4);
    else if (v === 'top') {
      this.camera.up.set(0, 0, -1);
      this.camera.position.set(c.x, c.y + s * 2.6, c.z + 0.01);
    } else if (v === 'follow')
      this.camera.position.set(
        this.lastTip.x + s * 0.35,
        this.lastTip.y + s * 0.25,
        this.lastTip.z + s * 0.5,
      );
    this.controls.target.copy(v === 'follow' ? this.lastTip : c);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private rebuildPart(mat: Stock) {
    const r = this.result as SimResult;
    if (this.partMesh) {
      this.spin.remove(this.partMesh);
      this.partMesh.geometry.dispose();
    }
    if (this.capMesh) {
      this.spin.remove(this.capMesh);
      this.capMesh.geometry.dispose();
    }
    for (const t of this.threadMeshes) {
      this.spin.remove(t);
      t.geometry.dispose();
    }
    this.threadMeshes = [];
    const phi0 = this.section ? Math.PI : 0;
    const phi1 = 2 * Math.PI;
    const segs = this.section ? SEGS / 2 : SEGS;
    const colours = OP_COLOURS.map((c) => new THREE.Color(c));
    const cmp = COMPARE_COLOURS.map((c) => new THREE.Color(c));
    const compare = this.colourMode === 'compare' && r.compare;
    const outerColour = (i: number) =>
      compare ? cmp[r.compare!.state[i]] : (colours[mat.tagOuter[i]] ?? colours[0]);
    const innerColour = (i: number) =>
      compare ? cmp[r.compare!.inner[i]] : (colours[mat.tagInner[i]] ?? colours[0]);
    const thr = mat.threads.filter((t) => t.external && t.pitch > 0);
    const minorAt = (i: number) => {
      const z = mat.zOf(i);
      const t = thr.find((x) => z <= x.zFront && z >= x.zBack);
      return t ? t.minor : null;
    };
    const lastAttached = mat.partedAt === null ? mat.n - 1 : mat.idx(mat.partedAt);
    const build = (from: number, to: number) => {
      const pos: number[] = [];
      const nrm: number[] = [];
      const col: number[] = [];
      const capTris: number[] = [];
      for (const loop of outlines(mat, from, to, minorAt)) {
        const o = loop.outer.map((x) => ({ p: x.p, c: outerColour(x.i) }));
        const inn = loop.inner.map((x) => ({ p: x.p, c: innerColour(x.i) })).reverse();
        const faceR = { p: o[o.length - 1].p, c: colours[1] };
        const faceL = { p: inn[inn.length - 1].p, c: colours[0] };
        const path = [...o, { ...faceR }, ...inn, { ...faceL }, o[0]];
        // End faces take the colour of the op that cut them.
        path[o.length - 1] = { ...o[o.length - 1], c: o[o.length - 1].c };
        revolve(pos, nrm, col, path, phi0, phi1, segs);
      }
      if (this.section) {
        // Cut face: one strip per run of equal columns (robust, no polygon triangulation).
        let k = from;
        while (k <= to) {
          if (!mat.has(k)) {
            k++;
            continue;
          }
          const o = minorAt(k) ?? mat.outer[k];
          const n = mat.inner[k];
          let e = k;
          while (
            e + 1 <= to &&
            mat.has(e + 1) &&
            Math.abs((minorAt(e + 1) ?? mat.outer[e + 1]) - o) < 1e-4 &&
            Math.abs(mat.inner[e + 1] - n) < 1e-4
          )
            e++;
          const z0 = mat.zMin + k * mat.res;
          const z1 = mat.zMin + (e + 1) * mat.res;
          for (const sg of [1, -1]) {
            const a = [z0, sg * n, 0.01];
            const b = [z1, sg * n, 0.01];
            const c = [z1, sg * o, 0.01];
            const d = [z0, sg * o, 0.01];
            capTris.push(...a, ...b, ...c, ...a, ...c, ...d);
          }
          k = e + 1;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          metalness: 0.7,
          roughness: 0.32,
          side: THREE.DoubleSide,
        }),
      );
      let cap: THREE.Mesh | null = null;
      if (capTris.length) {
        const cg = new THREE.BufferGeometry();
        cg.setAttribute('position', new THREE.Float32BufferAttribute(capTris, 3));
        cg.computeVertexNormals();
        cap = new THREE.Mesh(
          cg,
          new THREE.MeshStandardMaterial({ color: SECTION_CAP, roughness: 0.8, side: THREE.DoubleSide }),
        );
      }
      return { mesh, cap };
    };
    const attached = build(0, lastAttached);
    this.partMesh = attached.mesh;
    this.capMesh = attached.cap;
    this.spin.add(this.partMesh);
    if (this.capMesh) this.spin.add(this.capMesh);
    for (const t of thr) {
      if (mat.partedAt !== null && t.zBack > mat.partedAt) continue;
      const m = threadMesh(t, phi0, phi1, compare ? COMPARE_COLOURS[1] : OP_COLOURS[5]);
      if (m) {
        this.threadMeshes.push(m);
        this.spin.add(m);
      }
    }
    // The cut-off part falls away.
    if (mat.partedAt !== null) {
      if (!this.dropped) {
        this.dropped = new THREE.Group();
        this.scene.add(this.dropped);
        this.dropVel = 0;
      }
      this.clear(this.dropped);
      const piece = build(lastAttached + 1, mat.n - 1);
      this.dropped.add(piece.mesh);
      if (piece.cap) this.dropped.add(piece.cap);
      for (const t of thr) {
        if (t.zBack <= mat.partedAt) continue;
        const m = threadMesh(t, phi0, phi1, OP_COLOURS[5]);
        if (m) this.dropped.add(m);
      }
    } else if (this.dropped) {
      this.clear(this.dropped);
      this.scene.remove(this.dropped);
      this.dropped = null;
    }
  }

  private placeTool(move: SimMove | null, pos: Point | null) {
    if (!move || !pos) return;
    const tool = move.tool !== null ? this.tools.get(move.tool) : undefined;
    const dir: Point = [move.to[0] - move.from[0], move.to[1] - move.from[1]];
    const out = toolOutline(tool, pos, Math.hypot(dir[0], dir[1]) > 1e-9 ? dir : null, move.comp);
    if (move.tool !== this.activeTool) {
      this.activeTool = move.tool;
      this.clear(this.toolGroup);
      const local = (p: Point[]) => p.map(([z, r]) => [z - out.tip[0], r - out.tip[1]] as Point);
      const ins = extrude(local(out.insert), 4.8, '#fbbf24', {
        metalness: 0.4,
        roughness: 0.3,
        emissive: '#3b2a00',
      });
      if (ins) this.toolGroup.add(ins);
      for (const h of out.holder) {
        const m = extrude(local(h), tool?.role === 'bore' || tool?.role === 'drill' ? 10 : 22, '#475569');
        if (m) this.toolGroup.add(m);
      }
      if (!out.holder.length && !out.geometry.shaped) {
        const marker = new THREE.Mesh(
          new THREE.ConeGeometry(1.5, 6, 12),
          new THREE.MeshStandardMaterial({ color: '#f97316' }),
        );
        marker.position.set(0, 3, 0);
        this.toolGroup.add(marker);
      }
      const stations = this.input?.machine.turretStations ?? 8;
      if (move.tool !== null) this.turretTarget = ((move.tool - 1) * 2 * Math.PI) / stations;
      const box = new THREE.Box3().setFromObject(this.toolGroup);
      const top = Number.isFinite(box.max.y) ? box.max.y : 20;
      const right = Number.isFinite(box.max.x) ? box.max.x : 20;
      this.turretDisk.position.set(Math.max(20, right * 0.6), top + 55, 0);
    }
    this.turret.position.set(out.tip[0], out.tip[1], 0);
    this.lastTip.set(out.tip[0], out.tip[1], 0);
  }

  /** Draw one frame. dt in seconds of wall time. */
  frame(f: Frame, dt: number) {
    if (!this.result) return;
    if (f.matVersion !== this.matVersion) {
      this.matVersion = f.matVersion;
      this.rebuildPart(f.mat);
    }
    this.placeTool(f.move, f.pos);
    const m = f.move;
    // Spindle: real rpm, shown slower above 6 rev/s so it does not strobe.
    // In half section the part stays still so the cut face always faces the camera.
    if (this.section) this.spin.rotation.x = 0;
    else if (m && m.spindle !== 'off' && f.playing && !this.calm) {
      const rps = Math.min((m.rpm ?? 0) / 60, 6) * Math.min(1, f.speed);
      this.spin.rotation.x += (m.spindle === 'cw' ? -1 : 1) * rps * 2 * Math.PI * dt;
    }
    // Turret index.
    const d = this.turretTarget - this.turretAngle;
    this.turretAngle += Math.abs(d) < 1e-3 ? d : d * Math.min(1, dt * 8);
    this.turretDisk.rotation.x = this.turretAngle;
    // Current move.
    if (m) {
      const p = this.current.geometry.getAttribute('position') as THREE.BufferAttribute;
      p.setXYZ(0, m.from[0], m.from[1], 0.4);
      p.setXYZ(1, m.to[0], m.to[1], 0.4);
      p.needsUpdate = true;
      this.current.geometry.computeBoundingSphere();
      (this.current.material as THREE.LineBasicMaterial).color.set(
        m.kind === 'rapid' ? '#f87171' : '#facc15',
      );
    }
    // Cut glow, chips, coolant.
    const tip = this.lastTip;
    const cutting = f.cutting && f.playing;
    this.glow.position.copy(tip);
    this.glowBall.position.copy(tip);
    const flicker = 0.75 + Math.random() * 0.25;
    this.glow.intensity = cutting ? 900 * flicker : 0;
    (this.glowBall.material as THREE.MeshBasicMaterial).opacity = cutting ? 0.8 * flicker : 0;
    if (!this.calm)
      this.effects(dt, cutting && f.removed > 0, !!m?.coolant && m.spindle !== 'off' && f.playing);
    else {
      this.chips.count = 0;
      this.coolant.visible = false;
    }
    if (this.dropped) {
      const ground = -(this.result.grid.barR + 120);
      if (this.dropped.position.y > ground) {
        this.dropVel += 2000 * dt;
        this.dropped.position.y = Math.max(ground, this.dropped.position.y - this.dropVel * dt);
        this.dropped.rotation.z -= dt * 0.6;
      }
    }
    if (this.view === 'follow') {
      const delta = tip.clone().sub(this.controls.target);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Reset the falling part (after a jump back in time). */
  resetDrop() {
    if (this.dropped) {
      this.dropped.position.set(0, 0, 0);
      this.dropped.rotation.set(0, 0, 0);
      this.dropVel = 0;
    }
  }

  private effects(dt: number, chipsOn: boolean, coolantOn: boolean) {
    const tip = this.lastTip;
    if (chipsOn && this.chipState.length < 90) {
      for (let k = 0; k < 2; k++)
        this.chipState.push({
          p: tip.clone(),
          v: new THREE.Vector3(10 + Math.random() * 40, 30 + Math.random() * 50, 20 + Math.random() * 50),
          r: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
          w: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
          life: 1.1,
        });
    }
    const dummy = new THREE.Object3D();
    let n = 0;
    for (const c of this.chipState) {
      c.v.y -= 250 * dt;
      c.p.addScaledVector(c.v, dt);
      c.r.x += c.w.x * dt;
      c.r.y += c.w.y * dt;
      c.r.z += c.w.z * dt;
      c.life -= dt;
      if (c.life <= 0) continue;
      dummy.position.copy(c.p);
      dummy.rotation.copy(c.r);
      dummy.updateMatrix();
      this.chips.setMatrixAt(n++, dummy.matrix);
    }
    this.chipState = this.chipState.filter((c) => c.life > 0);
    this.chips.count = n;
    this.chips.instanceMatrix.needsUpdate = true;
    this.coolant.visible = coolantOn;
    if (coolantOn) {
      const nozzle = new THREE.Vector3(tip.x + 30, tip.y + 45, tip.z + 18);
      const p = this.coolant.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < this.coolantT.length; i++) {
        this.coolantT[i] = (this.coolantT[i] + dt * 2.2) % 1;
        const t = this.coolantT[i];
        const j = (i * 7.31) % 1;
        p.setXYZ(
          i,
          nozzle.x + (tip.x - nozzle.x) * t + (j - 0.5) * 3 * t,
          nozzle.y + (tip.y - nozzle.y) * t + (((i * 3.7) % 1) - 0.5) * 3 * t,
          nozzle.z + (tip.z - nozzle.z) * t,
        );
      }
      p.needsUpdate = true;
    }
  }

  canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  dispose() {
    this.controls.dispose();
    this.clear(this.spin);
    this.clear(this.turret);
    this.clear(this.pathGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { OP_KINDS };
