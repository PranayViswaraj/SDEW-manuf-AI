/**
 * three.js scene of <cnc-simulator>. three.js X = program Z (spindle axis), Y = radius on the
 * tool side, Z = towards the operator. The part is built in its own frame and placed per setup.
 *
 * Realistic look: PBR materials with environment reflections, soft key-light shadows, turned
 * surface finish, detailed chuck, 12-station turret carrying every tool of the job, coolant hose,
 * chips and coolant. Quality levels trade resolution and shadows for frame rate.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SIM_CONFIG } from './config';
import type { Grid } from './grid';
import { F, MOVE_TYPE, STRIDE, type Job, type JobSetup } from './job';
import { PartMeshBuilder } from './mesh';
import { Effects } from './effects';
import { Chuck, Materials, Turret, buildHeadstock, buildMachine, shadows } from './models';
import { setUnknownDrill } from './tools';
import { labelTexture, turnedTexture } from './textures';

export type Look = 'real' | 'video' | 'enhanced';
export type ViewPreset = 'iso' | 'front' | 'top' | 'follow';
export type Quality = 'high' | 'balanced' | 'fast';

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
const REAL_COLOURS = { stock: '#7d8791', fresh: '#ffcf73', machined: '#dde3e8', cap: '#a8b1ba' };

export class CncScene {
  renderer!: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  controls!: OrbitControls;
  private envTex: THREE.Texture | null = null;
  private follow = false;
  private theme: Theme;
  private quality: Quality = 'balanced';
  // lights
  private hemi = new THREE.HemisphereLight('#f3f6fa', '#3a4048', 0.5);
  private key = new THREE.DirectionalLight('#ffffff', 2.4);
  private fill = new THREE.DirectionalLight('#cfe0ff', 0.7);
  // models
  private mats = new Materials();
  private machine: THREE.Group;
  private spindle = new THREE.Group(); // headstock + chuck, placed per setup
  private chuck: Chuck;
  private turret: Turret;
  private fx = new Effects();
  // part
  private builder: PartMeshBuilder;
  private turned = turnedTexture();
  private partVideo: THREE.MeshLambertMaterial;
  private partReal: THREE.MeshStandardMaterial;
  private partMesh: THREE.Mesh;
  private partEdges: THREE.LineSegments;
  private partPlace = new THREE.Group();
  private partSpin = new THREE.Group();
  private pivot = new THREE.Group();
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
  private camAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private job: Job | null = null;
  private setup = -1;
  private look: Look = 'real';
  private cutaway = true;
  private tool = -1;
  private disposables: { dispose(): void }[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tipWorld = new THREE.Vector3();
  width = 1;
  height = 1;

  constructor(
    private host: HTMLElement,
    theme: Theme,
  ) {
    this.theme = theme;
    this.createRenderer();

    // lights: sky/ground, key with soft shadows, cool fill
    this.key.position.set(140, 260, 210);
    this.key.castShadow = true;
    const sc = this.key.shadow.camera;
    sc.left = -230;
    sc.right = 230;
    sc.top = 230;
    sc.bottom = -230;
    sc.near = 10;
    sc.far = 900;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.6;
    this.key.shadow.radius = 4;
    this.key.target.position.set(-20, -20, 0);
    this.fill.position.set(-260, 120, -120);
    this.scene.add(this.hemi, this.key, this.key.target, this.fill);
    this.scene.fog = new THREE.Fog('#1a1f25', 700, 1600);

    // machine
    this.machine = buildMachine(this.mats);
    this.chuck = new Chuck(this.mats);
    this.spindle.add(buildHeadstock(this.mats), this.chuck.group);
    this.turret = new Turret(this.mats);
    this.scene.add(this.machine, this.spindle, this.turret.group, this.fx.group);

    // part
    this.builder = new PartMeshBuilder(REAL_COLOURS);
    this.partVideo = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    this.turned.repeat.set(1, 1);
    this.partReal = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.92,
      roughness: 0.26,
      roughnessMap: this.turned,
      bumpMap: this.turned,
      bumpScale: 0.12,
      envMapIntensity: 1.15,
    });
    this.partReal.shadowSide = THREE.BackSide;
    this.partMesh = new THREE.Mesh(this.builder.geometry, this.partReal);
    this.partMesh.frustumCulled = false;
    this.partMesh.castShadow = true;
    this.partMesh.receiveShadow = true;
    this.partEdges = new THREE.LineSegments(
      this.builder.edges,
      new THREE.LineBasicMaterial({ color: '#1e3a8a', transparent: true, opacity: 0.35 }),
    );
    this.partEdges.frustumCulled = false;
    this.partEdges.visible = false;
    this.partPlace.add(this.partMesh, this.partEdges);
    this.partSpin.add(this.partPlace);
    this.pivot.add(this.partSpin);
    this.scene.add(this.pivot);
    this.disposables.push(
      this.builder,
      this.partVideo,
      this.partReal,
      this.turned,
      this.partEdges.material as THREE.Material,
      this.mats,
      this.fx,
      this.turret,
    );

    // view cube
    const faces = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'].map(
      (t) => new THREE.MeshBasicMaterial({ map: labelTexture(t, '#f8fafc', '#0f172a') }),
    );
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), faces);
    this.cubeScene.add(this.cube);
    this.disposables.push(this.cube.geometry, ...faces, ...faces.map((f) => f.map as THREE.Texture));
    const arrow = (dir: THREE.Vector3, colour: string, text: string) => {
      this.triScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1.1, colour, 0.28, 0.16));
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: labelTexture(text, 'rgba(0,0,0,0)', colour, 64, false),
          depthTest: false,
        }),
      );
      sp.position.copy(dir).multiplyScalar(1.45);
      sp.scale.setScalar(0.55);
      this.triScene.add(sp);
      this.disposables.push(sp.material, sp.material.map as THREE.Texture);
    };
    arrow(new THREE.Vector3(1, 0, 0), '#3b82f6', 'Z');
    arrow(new THREE.Vector3(0, 1, 0), '#ef4444', 'X');
    arrow(new THREE.Vector3(0, 0, 1), '#22c55e', 'Y');

    this.setLook('real');
    // start light; Auto steps up only when the frame rate shows there is headroom
    this.setQuality('fast');
  }

  private createRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    pmrem.dispose();
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    this.host.appendChild(el);
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 1400;
    this.controls.zoomSpeed = 1.1;
  }

  /** high: sharp + 2k shadows; balanced: 1.25x + 1k shadows; fast: 1x, no shadows, fewer chips. */
  setQuality(q: Quality) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(dpr, q === 'high' ? 2 : q === 'balanced' ? 1.25 : 1));
    const shadowsOn = q !== 'fast';
    this.renderer.shadowMap.enabled = shadowsOn;
    this.key.castShadow = shadowsOn;
    const size = q === 'high' ? 2048 : 1024;
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.fx.setMaxChips(q === 'fast' ? 50 : q === 'balanced' ? 110 : 160);
    this.builder.setSegments(q === 'high' ? 96 : q === 'balanced' ? 72 : 48);
    this.meshHz = q === 'high' ? 30 : q === 'balanced' ? 20 : 12;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material) (m.material as THREE.Material).needsUpdate = true;
    });
    this.renderer.setSize(this.width, this.height, false);
  }
  /** How often the part mesh may be rebuilt while cutting (Hz). */
  meshHz = 20;

  get qualityLevel() {
    return this.quality;
  }

  setTheme(t: Theme) {
    this.theme = t;
    if (this.look !== 'real') this.scene.background = new THREE.Color(t.viewport);
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
      real ? REAL_COLOURS : { stock: this.theme.stock, fresh: this.theme.fresh, cap: this.theme.cap },
    );
    this.partMesh.material = real ? this.partReal : look === 'video' ? this.partVideo : this.partReal;
    if (!real) {
      this.partReal.metalness = 0.15;
      this.partReal.roughness = 0.45;
      this.partReal.bumpScale = 0;
    } else {
      this.partReal.metalness = 0.92;
      this.partReal.roughness = 0.26;
      this.partReal.bumpScale = 0.12;
    }
    this.partReal.needsUpdate = true;
    this.partEdges.visible = look === 'enhanced';
    this.machine.visible = real;
    this.spindle.children[0].visible = real; // headstock
    this.scene.background = new THREE.Color(real ? '#1b2128' : this.theme.viewport);
    this.scene.fog = real ? new THREE.Fog('#1b2128', 700, 1600) : null;
    this.hemi.intensity = real ? 0.5 : 1.3;
    this.key.intensity = real ? 2.4 : 1.8;
    this.scene.environment = this.envTex; // metal needs reflections in every look
  }

  setCutaway(on: boolean) {
    this.cutaway = on;
  }

  // ------------------------------------------------------------------ camera presets

  setView(v: ViewPreset) {
    this.follow = v === 'follow';
    if (v === 'iso') {
      this.frame();
      return;
    }
    const t = this.controls.target;
    const d = this.camera.position.distanceTo(t);
    const dir =
      v === 'front'
        ? new THREE.Vector3(0, 0.1, 1)
        : v === 'top'
          ? new THREE.Vector3(0, 1, 0.03)
          : new THREE.Vector3(0.45, 0.35, 0.82);
    this.camAnim = {
      from: this.camera.position.clone().sub(t),
      to: dir.normalize().multiplyScalar(v === 'follow' ? Math.min(d, 140) : d),
      t: 0,
    };
  }

  /** Frame the part, chuck and the tool area at a 3/4 angle. */
  frame() {
    this.follow = false;
    const target = new THREE.Vector3(S.faceStockFront - S.length / 2 + 14, 18, 0);
    const d = S.length * 3.7 + 95;
    this.controls.target.copy(target);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(target).add(new THREE.Vector3(0.38, 0.3, 0.87).normalize().multiplyScalar(d));
    this.camera.lookAt(target);
    this.controls.update();
  }

  // ------------------------------------------------------------------ job

  setJob(job: Job) {
    this.job = job;
    // same drill size the worker cut with (a "U DRILL" comment gives none)
    setUnknownDrill(job.drillGuess);
    this.setup = -1;
    this.tool = -1;
    for (const l of [this.ghost, this.feeds, this.rapids]) {
      l.parent?.remove(l);
      l.geometry.dispose();
      (l.material as THREE.Material | undefined)?.dispose?.();
    }
    // mount every tool of the job in its turret station (first operation that uses it)
    const seen = new Set<number>();
    for (const op of job.ops)
      if (op.tool && !seen.has(op.tool)) {
        seen.add(op.tool);
        this.turret.mount(op.tool, op.name);
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
      // travel to / from the reference points (G28 / G30) is far off the part: not drawn
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
      new THREE.LineBasicMaterial({
        color: this.theme.ghost,
        transparent: true,
        opacity: 0.4,
        depthTest: false,
      }),
    );
    this.feeds = new THREE.LineSegments(
      geo(feed, feedCol),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
    );
    this.rapids = new THREE.LineSegments(
      geo(rapid),
      new THREE.LineDashedMaterial({
        color: this.theme.rapid,
        dashSize: 1.2,
        gapSize: 1.0,
        depthTest: false,
        transparent: true,
      }),
    );
    this.rapids.computeLineDistances();
    for (const l of [this.ghost, this.feeds, this.rapids]) {
      l.frustumCulled = false;
      l.renderOrder = 5;
      this.scene.add(l);
    }
    if (!this.current.parent) {
      this.current = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: '#facc15', depthTest: false, transparent: true }),
      );
      this.current.frustumCulled = false;
      this.current.renderOrder = 6;
      this.scene.add(this.current);
    }
    this.fx.clear();
    this.frame();
  }

  /** Show setup k: part orientation, chuck, path ranges. Returns true if it should flip. */
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
    if (s.orient === 0) {
      this.partPlace.scale.x = -1;
      this.partPlace.position.x = S.faceStockFront;
    } else {
      this.partPlace.scale.x = 1;
      this.partPlace.position.x = -(S.length - S.faceStockBack);
    }
  }

  private placeChuck(s: JobSetup, grid: Grid) {
    // jaws reach 28 mm in front of the chuck face: keep them 2 mm behind the deepest cut
    const face = s.chuckZ - 30;
    this.spindle.position.x = face;
    const gripZ = s.chuckZ - 14;
    const p = s.orient === 0 ? S.faceStockFront - gripZ : S.length - S.faceStockBack + gripZ;
    this.chuck.grip(Math.max(4, grid.outerAt(p)));
  }

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

  /** Tool at programmed point (z, x diameter). `retract` lifts it during a tool change. */
  placeTool(tool: number, opName: string, z: number, x: number, retract: number) {
    if (tool > 0) {
      this.turret.select(tool, opName, this.tool > 0);
      this.tool = tool;
    }
    this.turret.group.visible = tool > 0 || this.tool > 0;
    this.tipWorld.set(z + retract * 0.3, x / 2 + retract, 0);
    this.turret.place(this.tipWorld);
  }

  /** Path reveal up to move i (fraction f), within the current setup. */
  showProgress(i: number, f: number, z: number, x: number) {
    if (!this.job || this.setup < 0) return;
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
    this.chuck.spin.rotation.x = angle;
    this.partSpin.rotation.x = partToo ? angle : 0;
  }

  /** Chips, coolant and spark. `rate` = cells removed per second. */
  effects(dt: number, cutting: boolean, playing: boolean, rate = 0, coolant = true): boolean {
    const nozzle = this.turret.nozzleWorld(this.tmp2);
    return this.fx.step(
      dt,
      cutting && playing,
      rate,
      this.tipWorld,
      coolant && playing && cutting ? nozzle : null,
      coolant && playing && cutting,
    );
  }

  setEffects(on: boolean) {
    this.fx.enabled = on;
  }

  // ------------------------------------------------------------------ camera helpers

  mmPerPixel(): number {
    const d = this.camera.position.distanceTo(this.controls.target);
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return h / this.height;
  }

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
    if (Math.abs(n.y) > 0.9) to.z += 0.02 * dist;
    this.follow = false;
    this.camAnim = { from: this.camera.position.clone().sub(this.controls.target), to, t: 0 };
    return true;
  }

  private cubeSize() {
    return Math.round(Math.min(96, Math.max(64, this.width * 0.08)));
  }

  /** Camera animation, damping, follow, turret index. Returns true while anything moves. */
  updateCamera(dt: number): boolean {
    let moving = false;
    if (this.turret.step(dt)) moving = true;
    if (this.follow) {
      const delta = this.tmp
        .copy(this.tipWorld)
        .sub(this.controls.target)
        .multiplyScalar(Math.min(1, dt * 4));
      if (delta.lengthSq() > 1e-4) {
        this.controls.target.add(delta);
        this.camera.position.add(delta);
        moving = true;
      }
    }
    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + dt / 0.6);
      const e = a.t < 0.5 ? 4 * a.t * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 3) / 2;
      const len = a.from.length() + (a.to.length() - a.from.length()) * e;
      this.tmp
        .copy(a.from)
        .normalize()
        .lerp(this.tmp2.copy(a.to).normalize(), e)
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
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.triScene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.envTex?.dispose();
    this.key.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { shadows };
