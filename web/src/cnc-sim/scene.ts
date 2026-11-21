/**
 * three.js scene of <cnc-simulator>. three.js X = program Z (spindle axis), Y = radius on the
 * tool side, Z = towards the operator. The part is built in its own frame and placed per setup.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Point } from '../sim/lathe/types';
import { SIM_CONFIG } from './config';
import { cuttingShape, type Grid } from './grid';
import { F, MOVE_TYPE, STRIDE, type Job, type JobSetup } from './job';
import { PartMeshBuilder } from './mesh';
import { AXIAL_GROOVE_TOOLS, toolFor } from './tools';

export type Look = 'real' | 'video' | 'enhanced';
export type ViewPreset = 'iso' | 'front' | 'top' | 'follow';

export interface Theme {
  viewport: string;
  stock: string;
  fresh: string;
  cap: string;
  rapid: string;
  ghost: string;
  fixture: string;
  holder: string;
  insert: string;
}

const S = SIM_CONFIG.stock;

function label(text: string, bg: string, fg: string, size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = '#94a3b8';
  g.lineWidth = 6;
  g.strokeRect(3, 3, size - 6, size - 6);
  g.fillStyle = fg;
  g.font = `bold ${Math.round(size / 5.2)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, size / 2, size / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class CncScene {
  renderer!: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.5, 4000);
  controls!: OrbitControls;
  private antialias = false;
  private envTex: THREE.Texture | null = null;
  private follow = false;
  private theme: Theme;
  private hemi = new THREE.HemisphereLight('#ffffff', '#94a3b8', 1.6);
  private sun = new THREE.DirectionalLight('#ffffff', 1.6);
  // part
  private builder: PartMeshBuilder;
  private partMat: THREE.MeshLambertMaterial;
  private partStdMat: THREE.MeshStandardMaterial;
  private partMesh: THREE.Mesh;
  private partEdges: THREE.LineSegments;
  private partPlace = new THREE.Group(); // orientation of the current setup
  private partSpin = new THREE.Group();
  private pivot = new THREE.Group(); // flip animation
  // chuck
  private chuck = new THREE.Group();
  private chuckSpin = new THREE.Group();
  private jaws: THREE.Mesh[] = [];
  // tool
  private toolRoot = new THREE.Group();
  private toolBody = new THREE.Group();
  private toolKey = '';
  // paths
  private ghost = new THREE.LineSegments();
  private feeds = new THREE.LineSegments();
  private rapids = new THREE.LineSegments();
  private current = new THREE.Line();
  private feedBefore = new Int32Array(1);
  private rapidBefore = new Int32Array(1);
  // view cube + triad
  private cubeScene = new THREE.Scene();
  private cubeCam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private cube!: THREE.Mesh;
  private triScene = new THREE.Scene();
  private triCam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private ray = new THREE.Raycaster();
  private camAnim: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    up0: THREE.Vector3;
    up1: THREE.Vector3;
    t: number;
  } | null = null;
  private job: Job | null = null;
  private setup = -1;
  private look: Look = 'video';
  private cutaway = true;
  private disposables: { dispose(): void }[] = [];
  private tmp = new THREE.Vector3();
  width = 1;
  height = 1;

  constructor(
    private host: HTMLElement,
    theme: Theme,
  ) {
    this.theme = theme;
    this.createRenderer(false);
    this.camera.position.set(80, 60, 110);
    this.scene.add(this.hemi, this.sun);
    this.sun.position.set(60, 120, 90);

    this.builder = new PartMeshBuilder({ stock: theme.stock, fresh: theme.fresh, cap: theme.cap });
    this.partMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    this.partStdMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      roughness: 0.45,
      metalness: 0.15,
    });
    this.partMesh = new THREE.Mesh(this.builder.geometry, this.partMat);
    this.partMesh.frustumCulled = false;
    this.partEdges = new THREE.LineSegments(
      this.builder.edges,
      new THREE.LineBasicMaterial({ color: '#1e3a8a', transparent: true, opacity: 0.35 }),
    );
    this.partEdges.frustumCulled = false;
    this.partEdges.visible = false;
    this.partPlace.add(this.partMesh, this.partEdges);
    this.partSpin.add(this.partPlace);
    this.pivot.add(this.partSpin);
    this.scene.add(this.pivot, this.chuck, this.toolRoot);
    this.toolRoot.add(this.toolBody);
    this.disposables.push(
      this.builder,
      this.partMat,
      this.partStdMat,
      this.partEdges.material as THREE.Material,
    );

    // chuck: body + 3 jaws (fixture)
    const grey = new THREE.MeshStandardMaterial({ color: '#7b8590', metalness: 0.85, roughness: 0.3 });
    const greyDark = new THREE.MeshStandardMaterial({ color: '#4b5563', metalness: 0.8, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 28, 48), grey);
    body.rotation.z = Math.PI / 2;
    body.position.x = -20 - 12;
    this.chuckSpin.add(body);
    for (let k = 0; k < 3; k++) {
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(10, 14, 10), greyDark);
      jaw.userData.angle = (k * 2 * Math.PI) / 3 + Math.PI / 6;
      this.jaws.push(jaw);
      this.chuckSpin.add(jaw);
    }
    this.chuck.add(this.chuckSpin);
    this.disposables.push(grey, greyDark, body.geometry, this.jaws[0].geometry);
    this.buildMachine();

    // view cube
    const faces = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'].map(
      (t) => new THREE.MeshBasicMaterial({ map: label(t, '#f8fafc', '#0f172a') }),
    );
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), faces);
    this.cubeScene.add(this.cube);
    this.disposables.push(this.cube.geometry, ...faces, ...faces.map((f) => f.map as THREE.Texture));
    // axis triad: X (radius, up) red, Z (spindle) blue, Y green
    const arrow = (dir: THREE.Vector3, colour: string, text: string) => {
      const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1.1, colour, 0.28, 0.16);
      this.triScene.add(a);
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: label(text, 'rgba(0,0,0,0)', colour, 64), depthTest: false }),
      );
      sp.position.copy(dir).multiplyScalar(1.45);
      sp.scale.setScalar(0.55);
      this.triScene.add(sp);
      this.disposables.push(sp.material, sp.material.map as THREE.Texture);
    };
    arrow(new THREE.Vector3(1, 0, 0), '#2563eb', 'Z');
    arrow(new THREE.Vector3(0, 1, 0), '#dc2626', 'X');
    arrow(new THREE.Vector3(0, 0, 1), '#16a34a', 'Y');

    this.setTheme(theme);
  }

  private createRenderer(antialias: boolean) {
    const old = this.renderer;
    this.antialias = antialias;
    this.renderer = new THREE.WebGLRenderer({
      antialias,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex?.dispose();
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    pmrem.dispose();
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    if (old) {
      old.domElement.replaceWith(this.renderer.domElement);
      old.dispose();
    } else this.host.appendChild(this.renderer.domElement);
    const target = this.controls?.target.clone();
    this.controls?.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    if (target) this.controls.target.copy(target);
    this.renderer.setSize(this.width, this.height, false);
  }

  /** Turn antialias on once the frame rate is known to hold (re-creates the renderer). */
  upgradeAntialias() {
    if (!this.antialias) this.createRenderer(true);
  }
  get hasAntialias() {
    return this.antialias;
  }

  setTheme(t: Theme) {
    this.theme = t;
    this.scene.background = new THREE.Color(t.viewport);
    this.builder.setColours({ stock: t.stock, fresh: t.fresh, cap: t.cap });
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  setLook(look: Look) {
    this.look = look;
    const real = look === 'real';
    this.builder.setColours(
      real
        ? { stock: '#c4ccd4', fresh: '#f2b84b', cap: '#8f9aa6' }
        : { stock: this.theme.stock, fresh: this.theme.fresh, cap: this.theme.cap },
    );
    this.partStdMat.metalness = real ? 0.9 : 0.15;
    this.partStdMat.roughness = real ? 0.24 : 0.45;
    this.partStdMat.opacity = real ? 1 : 0.92;
    this.partStdMat.transparent = !real;
    this.partStdMat.needsUpdate = true;
    this.scene.background = new THREE.Color(real ? '#20262e' : this.theme.viewport);
    this.machine.visible = real;
    this.partMesh.material = look === 'video' ? this.partMat : this.partStdMat;
    this.partEdges.visible = look === 'enhanced';
    if (real) this.partMesh.material = this.partStdMat;
    this.hemi.intensity = look === 'video' ? 1.6 : 1.1;
    this.sun.intensity = look === 'video' ? 1.6 : 2.2;
  }

  private machine = new THREE.Group();

  /** Slant-bed lathe around the part: bed, headstock, enclosure, coolant nozzle. */
  private buildMachine() {
    const m = (c: string, metal = 0.6, rough = 0.5) => {
      const mat = new THREE.MeshStandardMaterial({ color: c, metalness: metal, roughness: rough });
      this.disposables.push(mat);
      return mat;
    };
    const box = (
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      rx = 0,
    ) => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.disposables.push(g);
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      this.machine.add(mesh);
      return mesh;
    };
    const paint = m('#d9dee3', 0.1, 0.55);
    const dark = m('#2f363e', 0.5, 0.5);
    const cast = m('#4a535c', 0.4, 0.6);
    // slant bed with two hardened ways
    box(420, 18, 120, cast, -20, -92, -10, -0.5);
    box(400, 6, 10, m('#b8c0c8', 1, 0.18), -20, -78, -40, -0.5);
    box(400, 6, 10, m('#b8c0c8', 1, 0.18), -20, -102, 8, -0.5);
    // headstock housing behind the chuck
    box(110, 150, 150, paint, -150, -10, -20);
    box(112, 8, 152, dark, -150, 62, -20);
    // enclosure back wall and floor tray
    box(520, 280, 6, m('#3a424b', 0.3, 0.7), -20, 20, -110);
    box(520, 6, 220, m('#262c33', 0.3, 0.8), -20, -130, 0);
    this.scene.add(this.machine);
  }

  /** Camera presets. Follow keeps the tool in view. */
  setView(v: ViewPreset) {
    this.follow = v === 'follow';
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    const dir =
      v === 'front'
        ? new THREE.Vector3(0, 0.12, 1)
        : v === 'top'
          ? new THREE.Vector3(0, 1, 0.02)
          : new THREE.Vector3(0.35, 0.42, 0.84);
    if (v === 'iso') {
      this.frame();
      return;
    }
    this.camAnim = {
      from: this.camera.position.clone().sub(t),
      to: dir.normalize().multiplyScalar(v === 'follow' ? Math.min(d, 90) : d),
      up0: this.camera.up.clone(),
      up1: new THREE.Vector3(0, 1, 0),
      t: 0,
    };
  }

  setCutaway(on: boolean) {
    this.cutaway = on;
  }

  // ------------------------------------------------------------------ job

  setJob(job: Job) {
    this.job = job;
    this.setup = -1;
    this.toolKey = '';
    for (const l of [this.ghost, this.feeds, this.rapids]) {
      l.geometry.dispose();
      (l.material as THREE.Material | undefined)?.dispose?.();
    }
    const n = job.count;
    const ghost: number[] = [];
    const feed: number[] = [];
    const feedCol: number[] = [];
    const rapid: number[] = [];
    this.feedBefore = new Int32Array(n + 1);
    this.rapidBefore = new Int32Array(n + 1);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const m = job.moves;
      this.feedBefore[i] = feed.length / 6;
      this.rapidBefore[i] = rapid.length / 6;
      const type = m[o + F.type];
      if (type === MOVE_TYPE.dwell || type === MOVE_TYPE.index || !m[o + F.known]) {
        ghost.push(0, 0, 0, 0, 0, 0);
        continue;
      }
      const seg = [m[o + F.z0], m[o + F.x0] / 2, 0.08, m[o + F.z1], m[o + F.x1] / 2, 0.08];
      // Travel to / from the reference points (G28 / G30) is far off the part: not drawn.
      const far = Math.max(m[o + F.z0], m[o + F.z1]) > 40 || Math.max(m[o + F.x0], m[o + F.x1]) > 90;
      ghost.push(...(far ? [0, 0, 0, 0, 0, 0] : seg));
      if (type === MOVE_TYPE.rapid) rapid.push(...(far ? [0, 0, 0, 0, 0, 0] : seg));
      else {
        feed.push(...seg);
        col.set(job.ops[m[o + F.op]].colour);
        feedCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    }
    this.feedBefore[n] = feed.length / 6;
    this.rapidBefore[n] = rapid.length / 6;
    const geo = (arr: number[], colours?: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      if (colours) g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
      return g;
    };
    this.ghost = new THREE.LineSegments(
      geo(ghost),
      new THREE.LineBasicMaterial({ color: this.theme.ghost, transparent: true, opacity: 0.45 }),
    );
    this.feeds = new THREE.LineSegments(
      geo(feed, feedCol),
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    this.rapids = new THREE.LineSegments(
      geo(rapid),
      new THREE.LineDashedMaterial({ color: this.theme.rapid, dashSize: 1.2, gapSize: 1.0 }),
    );
    this.rapids.computeLineDistances();
    for (const l of [this.ghost, this.feeds, this.rapids]) {
      l.frustumCulled = false;
      this.scene.add(l);
    }
    if (!this.current.parent) {
      this.current = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: '#0f172a' }),
      );
      this.current.frustumCulled = false;
      this.scene.add(this.current);
    }
    this.frame();
  }

  /** Frame the part at a 3/4 angle. */
  frame() {
    this.follow = false;
    const mid = S.faceStockFront - S.length / 2 + 10;
    const target = new THREE.Vector3(mid, 4, 0);
    const d = S.length * 1.55 + 30;
    this.controls.target.copy(target);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(target).add(new THREE.Vector3(0.35, 0.42, 0.84).normalize().multiplyScalar(d));
    this.camera.lookAt(target);
    this.controls.update();
  }

  /** Show setup k: part orientation, chuck, path ranges. */
  showSetup(k: number, grid: Grid, animate: boolean): boolean {
    if (!this.job || k === this.setup) return false;
    const prev = this.setup;
    this.setup = k;
    const s = this.job.setups[k];
    this.placePart(s);
    this.placeChuck(s, grid);
    return animate && prev >= 0;
  }

  private placePart(s: JobSetup) {
    // part frame p -> program z: orient 0: z = faceFront - p ; orient 1: z = p - (L - faceBack)
    if (s.orient === 0) {
      this.partPlace.scale.x = -1;
      this.partPlace.position.x = S.faceStockFront;
    } else {
      this.partPlace.scale.x = 1;
      this.partPlace.position.x = -(S.length - S.faceStockBack);
    }
  }

  private placeChuck(s: JobSetup, grid: Grid) {
    this.chuck.position.x = s.chuckZ;
    const p =
      s.orient === 0 ? S.faceStockFront - (s.chuckZ - 6) : S.length - S.faceStockBack + (s.chuckZ - 6);
    const r = Math.max(4, grid.outerAt(p));
    for (const j of this.jaws) {
      const a = j.userData.angle as number;
      const rr = r + 11;
      j.position.set(-7, rr * Math.cos(a), rr * Math.sin(a));
      j.rotation.x = a - Math.PI / 2;
    }
  }

  /** Flip animation progress e (0..1): the part turns 180 degrees about the vertical axis. */
  flip(e: number) {
    const mid = S.faceStockFront - S.length / 2;
    this.pivot.position.x = mid;
    this.partSpin.position.x = -mid;
    this.pivot.rotation.y = Math.PI * (1 - e);
    if (e >= 1) {
      this.pivot.rotation.y = 0;
      this.pivot.position.x = 0;
      this.partSpin.position.x = 0;
    }
  }

  rebuildPart(grid: Grid, now: number) {
    return this.builder.build(grid, now, this.cutaway, this.look === 'enhanced');
  }

  /** Tool at programmed point (z, x diameter); retract offset for tool-change animation. */
  placeTool(tool: number, opName: string, z: number, x: number, retract: number) {
    const key = `${tool}|${opName}`;
    if (key !== this.toolKey) {
      this.toolKey = key;
      this.buildTool(tool, opName);
    }
    this.toolRoot.visible = tool > 0;
    this.toolRoot.position.set(z + retract * 0.4, x / 2 + retract, 0.1);
  }

  private mats: Record<string, THREE.MeshStandardMaterial> | null = null;
  private material(name: 'carbide' | 'steel' | 'tin' | 'dark' | 'turret' | 'screw') {
    if (!this.mats) {
      this.mats = {
        carbide: new THREE.MeshStandardMaterial({ color: '#3a3f47', metalness: 0.75, roughness: 0.32 }),
        steel: new THREE.MeshStandardMaterial({ color: '#8d969f', metalness: 0.9, roughness: 0.3 }),
        tin: new THREE.MeshStandardMaterial({ color: '#d4a843', metalness: 0.95, roughness: 0.25 }),
        dark: new THREE.MeshStandardMaterial({ color: '#2b3138', metalness: 0.6, roughness: 0.45 }),
        turret: new THREE.MeshStandardMaterial({ color: '#5b6672', metalness: 0.75, roughness: 0.35 }),
        screw: new THREE.MeshStandardMaterial({ color: '#c0c6cc', metalness: 1, roughness: 0.2 }),
      };
      this.disposables.push(...Object.values(this.mats));
    }
    return this.mats[name];
  }

  /** Real-looking tool: insert on a clamped shank, twist drill, boring bar or grooving blade, on an
   * 8-station turret that indexes to the station in use. */
  private buildTool(tool: number, opName: string) {
    for (const c of [...this.toolBody.children]) {
      this.toolBody.remove(c);
      c.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    if (!tool) return;
    const shape = cuttingShape(tool, opName);
    const def = toolFor(tool, opName);
    const role = def?.role ?? 'unknown';
    let zMax = 0;
    let rMax = 0;
    let rMin = 0;
    for (const [z, r] of shape as Point[]) {
      zMax = Math.max(zMax, z);
      rMax = Math.max(rMax, r);
      rMin = Math.min(rMin, r);
    }
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      this.toolBody.add(mesh);
      return mesh;
    };
    const axialGroove = AXIAL_GROOVE_TOOLS.has(tool);
    let mountX = 0;
    let mountY = 0;
    if (role === 'drill') {
      // Twist drill (TiN gold): 118 deg point, body with flutes, shank into a holder.
      const d = def?.drillDiameter ?? 6;
      const r = d / 2;
      const cone = r / Math.tan((59 * Math.PI) / 180);
      const body = Math.max(5 * d, 30);
      const prof = [
        new THREE.Vector2(0.001, 0),
        new THREE.Vector2(r, cone),
        new THREE.Vector2(r, body),
        new THREE.Vector2(r * 0.92, body + 2),
        new THREE.Vector2(r * 0.92, body + 30),
        new THREE.Vector2(0.001, body + 30),
      ];
      const g = new THREE.LatheGeometry(prof, 28);
      g.rotateZ(-Math.PI / 2); // lathe axis (y) -> +x
      add(g, this.material('tin'), 0, 0);
      // flutes: two dark helical grooves suggested by thin twisted bands
      const flute = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          Array.from({ length: 40 }, (_, i) => {
            const t = i / 39;
            const a = t * Math.PI * 2 * (body / (d * 1.6));
            return new THREE.Vector3(
              cone + t * (body - cone),
              Math.cos(a) * r * 0.98,
              Math.sin(a) * r * 0.98,
            );
          }),
        ),
        120,
        Math.max(0.22, r * 0.07),
        5,
      );
      add(flute, this.material('dark'), 0, 0);
      const flute2 = flute.clone();
      flute2.rotateX(Math.PI);
      add(flute2, this.material('dark'), 0, 0);
      const holder = new THREE.CylinderGeometry(r + 6, r + 6, 26, 28);
      holder.rotateZ(Math.PI / 2);
      add(holder, this.material('steel'), body + 30 + 8, 0);
      mountX = body + 30 + 21;
      mountY = 0;
    } else if (role === 'bore' || axialGroove) {
      // Round boring bar (or face-groove holder) along +Z with the insert at its tip.
      const ins = this.insertMesh(shape);
      this.toolBody.add(ins);
      const bar = axialGroove ? 10 : (def?.barDiameter ?? 12);
      const yc = axialGroove ? (rMax + rMin) / 2 : def?.tipDirection === 2 ? -(bar / 2 + 0.8) : bar / 2 + 0.8;
      const len = 70;
      const g = new THREE.CylinderGeometry(bar / 2, bar / 2, len, 28);
      g.rotateZ(Math.PI / 2);
      add(g, this.material('steel'), zMax + len / 2 - 2, yc);
      const sleeve = new THREE.CylinderGeometry(bar / 2 + 5, bar / 2 + 5, 24, 28);
      sleeve.rotateZ(Math.PI / 2);
      add(sleeve, this.material('dark'), zMax + len - 6, yc);
      mountX = zMax + len + 6;
      mountY = yc;
    } else {
      // Turning / grooving: carbide insert, clamp screw, square steel shank going up into the turret.
      this.toolBody.add(this.insertMesh(shape));
      const cx = Math.max(3, zMax * 0.45);
      const screw = new THREE.CylinderGeometry(1.1, 1.1, 1.2, 12);
      screw.rotateX(Math.PI / 2);
      add(screw, this.material('screw'), cx, Math.max(2, rMax * 0.45), 2.6);
      const head = new THREE.BoxGeometry(Math.max(14, zMax + 6), 10, 14);
      add(head, this.material('dark'), cx, rMax + 3, 0);
      const shank = new THREE.BoxGeometry(16, 46, 16);
      add(shank, this.material('steel'), cx, rMax + 31, 0);
      mountX = cx;
      mountY = rMax + 54;
    }
    // Turret: 8-station disc, axis along Z, the station in use pointing at the part.
    const turret = new THREE.Group();
    const R = 46;
    const discG = new THREE.CylinderGeometry(R, R, 34, 8);
    discG.rotateZ(Math.PI / 2);
    turret.add(new THREE.Mesh(discG, this.material('turret')));
    const hubG = new THREE.CylinderGeometry(18, 18, 40, 24);
    hubG.rotateZ(Math.PI / 2);
    turret.add(new THREE.Mesh(hubG, this.material('dark')));
    for (let s = 0; s < 8; s++) {
      const a = (s * Math.PI) / 4;
      const blk = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 22), this.material('dark'));
      blk.position.set(0, -(R + 4) * Math.cos(a), (R + 4) * Math.sin(a));
      blk.rotation.x = a;
      turret.add(blk);
      if (s) {
        const stub = new THREE.Mesh(new THREE.BoxGeometry(10, 16, 10), this.material('steel'));
        stub.position.set(0, -(R + 18) * Math.cos(a), (R + 18) * Math.sin(a));
        stub.rotation.x = a;
        turret.add(stub);
      }
    }
    turret.position.set(mountX, mountY + R + 2, 0);
    this.turret = turret;
    this.toolBody.add(turret);
    const stations = 8;
    this.turretTarget = ((tool - 1) * 2 * Math.PI) / stations;
    this.turretAngle = this.turretTarget + Math.PI / 4; // index in from the previous station
  }

  private turret: THREE.Group | null = null;
  private turretAngle = 0;
  private turretTarget = 0;

  /** Animate the turret indexing (called every frame). */
  stepTurret(dt: number): boolean {
    if (!this.turret) return false;
    const d = this.turretTarget - this.turretAngle;
    if (Math.abs(d) < 1e-3) return false;
    this.turretAngle += d * Math.min(1, dt * 10);
    // the station in use stays pointing at the part: rotate the other stations around it
    this.turret.rotation.x = this.turretAngle - this.turretTarget;
    return true;
  }

  private insertMesh(shape: Point[]): THREE.Mesh {
    if (shape.length < 3)
      return new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), this.material('carbide'));
    const sh = new THREE.Shape(shape.map(([z, r]) => new THREE.Vector2(z, r)));
    const g = new THREE.ExtrudeGeometry(sh, {
      depth: 4.8,
      bevelEnabled: true,
      bevelSize: 0.2,
      bevelThickness: 0.2,
      bevelSegments: 2,
    });
    g.translate(0, 0, -2.4);
    return new THREE.Mesh(g, this.material('carbide'));
  }

  /** Path reveal up to move i (fraction f), within the current setup. */
  showProgress(i: number, f: number, z: number, x: number) {
    if (!this.job) return;
    const s = this.job.setups[this.setup];
    const a = s.firstMove;
    const done = Math.min(i + (f >= 1 ? 1 : 0), s.lastMove + 1);
    this.ghost.geometry.setDrawRange(a * 2, (s.lastMove + 1 - a) * 2);
    const f0 = this.feedBefore[a];
    this.feeds.geometry.setDrawRange(f0 * 2, (this.feedBefore[done] - f0) * 2);
    const r0 = this.rapidBefore[a];
    this.rapids.geometry.setDrawRange(r0 * 2, (this.rapidBefore[done] - r0) * 2);
    const o = i * STRIDE;
    const m = this.job.moves;
    const p = this.current.geometry.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, m[o + F.z0], m[o + F.x0] / 2, 0.12);
    p.setXYZ(1, z, x / 2, 0.12);
    p.needsUpdate = true;
  }

  setPathsVisible(v: boolean) {
    this.ghost.visible = this.feeds.visible = this.rapids.visible = this.current.visible = v;
  }

  spin(angle: number, partToo: boolean) {
    this.chuckSpin.rotation.x = angle;
    this.partSpin.rotation.x = partToo ? angle : 0;
  }

  // ------------------------------------------------------------------ camera helpers

  /** mm per CSS pixel at the orbit target. */
  mmPerPixel(): number {
    const d = this.camera.position.distanceTo(this.controls.target);
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return h / this.height;
  }

  /** Clicked in the view cube corner? Snap the camera to that face. Returns true if handled. */
  cubeClick(px: number, py: number): boolean {
    const size = this.cubeSize();
    const x0 = this.width - size - 8;
    if (px < x0 || px > x0 + size || py < 8 || py > 8 + size) return false;
    const ndc = new THREE.Vector2(((px - x0) / size) * 2 - 1, -(((py - 8) / size) * 2 - 1));
    this.ray.setFromCamera(ndc, this.cubeCam);
    const hit = this.ray.intersectObject(this.cube)[0];
    if (!hit?.face) return true;
    const n = hit.face.normal.clone();
    const dist = this.camera.position.distanceTo(this.controls.target);
    const to = n.clone().multiplyScalar(dist);
    if (Math.abs(n.y) > 0.9) to.z += 0.001 * dist; // avoid looking straight down the up vector
    this.camAnim = {
      from: this.camera.position.clone().sub(this.controls.target),
      to,
      up0: this.camera.up.clone(),
      up1: new THREE.Vector3(0, 1, 0),
      t: 0,
    };
    return true;
  }

  private cubeSize() {
    return Math.round(Math.min(96, Math.max(64, this.width * 0.09)));
  }

  /** Advance camera damping / animation. Returns true while something is still moving. */
  updateCamera(dt: number): boolean {
    let moving = false;
    if (this.follow && this.toolRoot.visible) {
      const want = this.toolRoot.position;
      const delta = this.tmp
        .copy(want)
        .sub(this.controls.target)
        .multiplyScalar(Math.min(1, dt * 4));
      if (delta.lengthSq() > 1e-6) {
        this.controls.target.add(delta);
        this.camera.position.add(delta);
        moving = true;
      }
    }
    if (this.stepTurret(dt)) moving = true;
    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + dt / 0.5);
      const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
      const len = a.from.length() + (a.to.length() - a.from.length()) * e;
      this.tmp
        .copy(a.from)
        .normalize()
        .lerp(this.tmp.clone().copy(a.to).normalize(), e)
        .normalize()
        .multiplyScalar(len);
      this.camera.position.copy(this.controls.target).add(this.tmp);
      this.camera.lookAt(this.controls.target);
      if (a.t >= 1) this.camAnim = null;
      moving = true;
    }
    if (this.controls.update()) moving = true;
    return moving;
  }

  render() {
    const r = this.renderer;
    r.setViewport(0, 0, this.width, this.height);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    // view cube (top right) and triad (bottom left) follow the main camera
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target).normalize();
    const size = this.cubeSize();
    r.setScissorTest(true);
    r.clearDepth();
    this.cubeCam.position.copy(dir).multiplyScalar(5.2);
    this.cubeCam.up.copy(this.camera.up);
    this.cubeCam.lookAt(0, 0, 0);
    r.setViewport(this.width - size - 8, this.height - size - 8, size, size);
    r.setScissor(this.width - size - 8, this.height - size - 8, size, size);
    r.render(this.cubeScene, this.cubeCam);
    this.triCam.position.copy(dir).multiplyScalar(6);
    this.triCam.up.copy(this.camera.up);
    this.triCam.lookAt(0, 0, 0);
    r.setViewport(8, 8, 84, 84);
    r.setScissor(8, 8, 84, 84);
    r.render(this.triScene, this.triCam);
    r.setScissorTest(false);
  }

  // ------------------------------------------------------------------ chips, coolant, cut glow

  private fx: {
    chips: THREE.InstancedMesh;
    state: Float32Array; // per chip: x y z vx vy vz rx ry rz life
    next: number;
    coolant: THREE.Points;
    phase: Float32Array;
    glow: THREE.PointLight;
    spark: THREE.Mesh;
    dummy: THREE.Object3D;
  } | null = null;

  private ensureFx() {
    if (this.fx) return this.fx;
    const N = 90;
    const chips = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.7, 0.13, 4, 10, Math.PI * 1.5),
      new THREE.MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.85, roughness: 0.3 }),
      N,
    );
    chips.frustumCulled = false;
    chips.count = 0;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(140 * 3), 3));
    const coolant = new THREE.Points(
      cg,
      new THREE.PointsMaterial({
        color: '#38bdf8',
        size: 1.1,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );
    coolant.frustumCulled = false;
    coolant.visible = false;
    const glow = new THREE.PointLight('#fb923c', 0, 40, 1.6);
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 12, 10),
      new THREE.MeshBasicMaterial({
        color: '#fdba74',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(chips, coolant, glow, spark);
    const phase = new Float32Array(140);
    for (let i = 0; i < phase.length; i++) phase[i] = Math.random();
    this.fx = {
      chips,
      state: new Float32Array(N * 10),
      next: 0,
      coolant,
      phase,
      glow,
      spark,
      dummy: new THREE.Object3D(),
    };
    this.disposables.push(
      chips.geometry,
      chips.material as THREE.Material,
      cg,
      coolant.material as THREE.Material,
    );
    this.disposables.push(spark.geometry, spark.material as THREE.Material);
    return this.fx;
  }

  /** Chips fly off while cutting, coolant sprays at the tip, the tip glows. Returns true if alive. */
  effects(dt: number, cutting: boolean, playing: boolean): boolean {
    const fx = this.ensureFx();
    const tip = this.toolRoot.position;
    const N = fx.state.length / 10;
    const s = fx.state;
    if (cutting && playing) {
      for (let k = 0; k < 2; k++) {
        const i = fx.next;
        fx.next = (fx.next + 1) % N;
        const o = i * 10;
        s[o] = tip.x;
        s[o + 1] = tip.y;
        s[o + 2] = tip.z + 0.5;
        s[o + 3] = 8 + Math.random() * 25;
        s[o + 4] = 15 + Math.random() * 30;
        s[o + 5] = 10 + Math.random() * 35;
        s[o + 6] = Math.random() * 6;
        s[o + 7] = Math.random() * 6;
        s[o + 8] = Math.random() * 6;
        s[o + 9] = 1.1;
      }
    }
    let alive = 0;
    for (let i = 0; i < N; i++) {
      const o = i * 10;
      if (s[o + 9] <= 0) continue;
      s[o + 4] -= 160 * dt;
      s[o] += s[o + 3] * dt;
      s[o + 1] += s[o + 4] * dt;
      s[o + 2] += s[o + 5] * dt;
      s[o + 6] += 9 * dt;
      s[o + 7] += 7 * dt;
      s[o + 9] -= dt;
      fx.dummy.position.set(s[o], s[o + 1], s[o + 2]);
      fx.dummy.rotation.set(s[o + 6], s[o + 7], s[o + 8]);
      fx.dummy.updateMatrix();
      fx.chips.setMatrixAt(alive++, fx.dummy.matrix);
    }
    fx.chips.count = alive;
    fx.chips.instanceMatrix.needsUpdate = true;
    const on = cutting && playing;
    fx.coolant.visible = on;
    if (on) {
      const p = fx.coolant.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nx = tip.x + 22;
      const ny = tip.y + 28;
      const nz = tip.z + 14;
      for (let i = 0; i < fx.phase.length; i++) {
        fx.phase[i] = (fx.phase[i] + dt * 2.4) % 1;
        const t = fx.phase[i];
        const j = ((i * 7.31) % 1) - 0.5;
        const k = ((i * 3.77) % 1) - 0.5;
        p.setXYZ(
          i,
          nx + (tip.x - nx) * t + j * 2.5 * t,
          ny + (tip.y - ny) * t + k * 2.5 * t,
          nz + (tip.z - nz) * t,
        );
      }
      p.needsUpdate = true;
    }
    const flick = 0.75 + Math.random() * 0.25;
    fx.glow.position.copy(tip);
    fx.spark.position.copy(tip);
    fx.glow.intensity = on ? 350 * flick : 0;
    (fx.spark.material as THREE.MeshBasicMaterial).opacity = on ? 0.85 * flick : 0;
    return alive > 0 || on;
  }

  canvas() {
    return this.renderer.domElement;
  }

  dispose() {
    this.controls.dispose();
    for (const d of this.disposables) d.dispose();
    for (const l of [this.ghost, this.feeds, this.rapids, this.current]) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
    this.triScene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    this.envTex?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
