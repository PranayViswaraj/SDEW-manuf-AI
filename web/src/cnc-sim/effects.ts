/**
 * Cutting effects: curled chips (temper colours) thrown from the cut, a coolant stream from the
 * nozzle with splash at the tip, and a small spark. No allocation per frame.
 */
import * as THREE from 'three';
import { dotTexture } from './textures';

const CHIP_COLOURS = ['#cfd5db', '#d9b45e', '#c48a3a', '#4a6aa8', '#b9c0c8', '#e0c070'];

/** Small curled ribbon (a few turns of a flattened helix). */
function chipGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const a = t * Math.PI * 3.2;
    const r = 1.1 * (1 - t * 0.35);
    pts.push(new THREE.Vector3(Math.cos(a) * r, t * 1.6, Math.sin(a) * r));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 36, 0.16, 4, false);
}

export class Effects {
  readonly group = new THREE.Group();
  private chips: THREE.InstancedMesh;
  private chipMax: number;
  private chipLive = 0;
  // per chip: x y z vx vy vz rx ry rz wx wy wz life scale
  private cs: Float32Array;
  private nextChip = 0;
  private dummy = new THREE.Object3D();
  private coolant: THREE.Points;
  private cPos: Float32Array;
  private cVel: Float32Array;
  private cLife: Float32Array;
  private spark: THREE.Sprite;
  private sparkLight = new THREE.PointLight('#ffb366', 0, 30, 1.8);
  private floorY = -168;
  private emitAcc = 0;
  private disposables: { dispose(): void }[] = [];
  enabled = true;

  constructor(maxChips = 160) {
    this.chipMax = maxChips;
    const geo = chipGeometry();
    const mat = new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.3, color: '#ffffff' });
    this.chips = new THREE.InstancedMesh(geo, mat, maxChips);
    this.chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color();
    for (let i = 0; i < maxChips; i++) this.chips.setColorAt(i, c.set(CHIP_COLOURS[i % CHIP_COLOURS.length]));
    this.chips.count = 0;
    this.chips.frustumCulled = false;
    this.chips.castShadow = true;
    this.cs = new Float32Array(maxChips * 14);

    const N = 360;
    this.cPos = new Float32Array(N * 3);
    this.cVel = new Float32Array(N * 3);
    this.cLife = new Float32Array(N);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.cPos, 3).setUsage(THREE.DynamicDrawUsage));
    const dot = dotTexture('rgba(220,240,255,0.95)', 'rgba(160,210,255,0)');
    this.coolant = new THREE.Points(
      cg,
      new THREE.PointsMaterial({
        size: 2.2,
        map: dot,
        transparent: true,
        depthWrite: false,
        color: '#bfe3ff',
        opacity: 0.8,
      }),
    );
    this.coolant.frustumCulled = false;
    const sparkTex = dotTexture('rgba(255,220,160,1)', 'rgba(255,140,40,0)');
    this.spark = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sparkTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.spark.scale.setScalar(5);
    this.group.add(this.chips, this.coolant, this.spark, this.sparkLight);
    this.disposables.push(
      geo,
      mat,
      cg,
      this.coolant.material as THREE.Material,
      dot,
      sparkTex,
      this.spark.material,
    );
  }

  setFloor(y: number) {
    this.floorY = y;
  }

  setMaxChips(n: number) {
    this.chipMax = Math.min(n, this.cs.length / 14);
  }

  /**
   * Advance by dt (s). `rate` = material removed per second (relative), `tip` cutting point,
   * `nozzle` coolant nozzle (or null), `dirSign` throws chips towards +Z (operator) or away.
   */
  step(
    dt: number,
    cutting: boolean,
    rate: number,
    tip: THREE.Vector3,
    nozzle: THREE.Vector3 | null,
    coolantOn: boolean,
  ) {
    if (!this.enabled) {
      this.chips.count = 0;
      this.coolant.visible = false;
      this.spark.visible = false;
      this.sparkLight.intensity = 0;
      return false;
    }
    const cs = this.cs;
    // ---- emit chips in proportion to the removal rate
    if (cutting) {
      this.emitAcc += dt * Math.min(60, 8 + rate * 0.02);
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        const i = this.nextChip;
        this.nextChip = (this.nextChip + 1) % this.chipMax;
        const o = i * 14;
        cs[o] = tip.x;
        cs[o + 1] = tip.y + 0.5;
        cs[o + 2] = tip.z + 1.5;
        cs[o + 3] = 20 + Math.random() * 45;
        cs[o + 4] = 40 + Math.random() * 70;
        cs[o + 5] = 30 + Math.random() * 80;
        cs[o + 6] = Math.random() * 6.3;
        cs[o + 7] = Math.random() * 6.3;
        cs[o + 8] = Math.random() * 6.3;
        cs[o + 9] = (Math.random() - 0.5) * 22;
        cs[o + 10] = (Math.random() - 0.5) * 22;
        cs[o + 11] = (Math.random() - 0.5) * 22;
        cs[o + 12] = 2.2;
        cs[o + 13] = 0.7 + Math.random() * 0.9;
      }
    } else this.emitAcc = 0;
    let live = 0;
    for (let i = 0; i < this.chipMax; i++) {
      const o = i * 14;
      if (cs[o + 12] <= 0) continue;
      cs[o + 4] -= 900 * dt; // gravity (slowed for readability)
      cs[o] += cs[o + 3] * dt;
      cs[o + 1] += cs[o + 4] * dt;
      cs[o + 2] += cs[o + 5] * dt;
      if (cs[o + 1] < this.floorY) {
        cs[o + 1] = this.floorY;
        cs[o + 4] *= -0.25;
        cs[o + 3] *= 0.5;
        cs[o + 5] *= 0.5;
        cs[o + 9] *= 0.4;
        cs[o + 10] *= 0.4;
        cs[o + 11] *= 0.4;
      }
      cs[o + 6] += cs[o + 9] * dt;
      cs[o + 7] += cs[o + 10] * dt;
      cs[o + 8] += cs[o + 11] * dt;
      cs[o + 12] -= dt;
      const d = this.dummy;
      d.position.set(cs[o], cs[o + 1], cs[o + 2]);
      d.rotation.set(cs[o + 6], cs[o + 7], cs[o + 8]);
      d.scale.setScalar(cs[o + 13] * Math.min(1, cs[o + 12] * 2));
      d.updateMatrix();
      this.chips.setMatrixAt(live, d.matrix);
      // keep each live chip's colour with it
      live++;
    }
    this.chipLive = live;
    this.chips.count = live;
    this.chips.instanceMatrix.needsUpdate = true;

    // ---- coolant: stream from the nozzle to the tip, splashing off the work
    const on = coolantOn && !!nozzle;
    this.coolant.visible = on || this.cLife.some((l) => l > 0);
    if (this.coolant.visible) {
      const N = this.cLife.length;
      const spawn = on ? Math.floor(N * dt * 2.6) + 1 : 0;
      for (let k = 0, i = 0; i < N && k < spawn; i++) {
        if (this.cLife[i] > 0) continue;
        const o = i * 3;
        const nz = nozzle as THREE.Vector3;
        this.cPos[o] = nz.x + (Math.random() - 0.5) * 0.8;
        this.cPos[o + 1] = nz.y + (Math.random() - 0.5) * 0.8;
        this.cPos[o + 2] = nz.z + (Math.random() - 0.5) * 0.8;
        const sp = 260 + Math.random() * 60;
        const dx = tip.x - nz.x;
        const dy = tip.y - nz.y;
        const dz = tip.z - nz.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        this.cVel[o] = (dx / len) * sp + (Math.random() - 0.5) * 12;
        this.cVel[o + 1] = (dy / len) * sp + (Math.random() - 0.5) * 12;
        this.cVel[o + 2] = (dz / len) * sp + (Math.random() - 0.5) * 12;
        this.cLife[i] = 1.6;
        k++;
      }
      for (let i = 0; i < N; i++) {
        if (this.cLife[i] <= 0) {
          this.cPos[i * 3 + 1] = -1e5;
          continue;
        }
        const o = i * 3;
        this.cVel[o + 1] -= 600 * dt;
        this.cPos[o] += this.cVel[o] * dt;
        this.cPos[o + 1] += this.cVel[o + 1] * dt;
        this.cPos[o + 2] += this.cVel[o + 2] * dt;
        // splash when the stream reaches the work at the tip
        const ddx = this.cPos[o] - tip.x;
        const ddy = this.cPos[o + 1] - tip.y;
        const ddz = this.cPos[o + 2] - tip.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz < 9 && this.cVel[o + 1] < 0) {
          this.cVel[o] = (Math.random() - 0.2) * 90;
          this.cVel[o + 1] = 30 + Math.random() * 60;
          this.cVel[o + 2] = 30 + Math.random() * 90;
        }
        if (this.cPos[o + 1] < this.floorY) this.cLife[i] = 0;
        this.cLife[i] -= dt;
      }
      (this.coolant.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    // ---- spark at the cutting point
    const flick = 0.7 + Math.random() * 0.3;
    this.spark.visible = cutting;
    this.spark.position.copy(tip);
    (this.spark.material as THREE.SpriteMaterial).opacity = cutting ? 0.55 * flick : 0;
    this.sparkLight.position.copy(tip);
    this.sparkLight.intensity = cutting ? 120 * flick : 0;
    return live > 0 || cutting || this.coolant.visible;
  }

  get liveChips() {
    return this.chipLive;
  }

  clear() {
    for (let i = 0; i < this.cs.length; i += 14) this.cs[i + 12] = 0;
    this.cLife.fill(0);
    this.chips.count = 0;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
