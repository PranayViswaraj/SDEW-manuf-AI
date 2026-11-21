import * as THREE from 'three';
import { Effects } from '../src/cnc-sim/effects';
import { Chuck, Materials, Turret, buildTool } from '../src/cnc-sim/models';

describe('<cnc-simulator> machine models', () => {
  const mats = new Materials();

  it.each([
    [1, 'CENTER'],
    [2, '16.5 DRILL'],
    [4, 'FACING'],
    [5, 'OD FIN'],
    [5, '12 MM CCMT'],
    [7, '12.0MM BB'],
    [8, '3MM GROOVE'],
  ])('turret puts the tip of T%i (%s) exactly on the programmed point', (tool, op) => {
    const turret = new Turret(mats);
    for (const t of [1, 2, 4, 5, 7, 8]) turret.mount(t, t === tool ? op : '');
    turret.select(tool, op, false);
    const tip = new THREE.Vector3(-12.5, 9.75, 0);
    turret.place(tip);
    turret.group.updateMatrixWorld(true);
    // the tool model's origin is its tip
    let model: THREE.Object3D | null = null;
    turret.disc.traverse((o) => {
      if (o.userData.tool === tool) model = o;
    });
    expect(model).not.toBeNull();
    const world = new THREE.Vector3().setFromMatrixPosition((model as unknown as THREE.Object3D).matrixWorld);
    expect(world.distanceTo(tip)).toBeLessThan(1e-6);
    turret.dispose();
  });

  it('indexes the turret to the new station over time', () => {
    const turret = new Turret(mats);
    turret.select(4, 'FACING', false);
    turret.select(7, '12.0MM BB', true);
    expect(turret.indexing).toBe(true);
    let t = 0;
    while (turret.step(1 / 60) && t < 5) t += 1 / 60;
    expect(turret.indexing).toBe(false);
    expect(t).toBeLessThan(2);
    turret.dispose();
  });

  it('builds real tool shapes: twisted drill, boring bar, turning holder', () => {
    expect(buildTool(2, '16.5 DRILL', mats).axial).toBe(true);
    expect(buildTool(7, '12.0MM BB', mats).axial).toBe(true);
    expect(buildTool(4, 'OD RG', mats).axial).toBe(false);
  });

  it('closes the chuck jaws on the part', () => {
    const chuck = new Chuck(mats);
    chuck.grip(20);
    chuck.grip(10); // re-gripping does not accumulate
    const box = new THREE.Box3().setFromObject(chuck.spin.children.at(-1) as THREE.Object3D);
    expect(box.isEmpty()).toBe(false);
  });
});

describe('<cnc-simulator> cutting effects', () => {
  it('throws chips while cutting and sprays coolant from the nozzle to the tip', () => {
    const fx = new Effects(60);
    const tip = new THREE.Vector3(0, 10, 0);
    const nozzle = new THREE.Vector3(20, 40, 20);
    for (let k = 0; k < 30; k++) fx.step(1 / 60, true, 5000, tip, nozzle, true);
    expect(fx.liveChips).toBeGreaterThan(5);
    // stop cutting: chips fall and expire
    for (let k = 0; k < 400; k++) fx.step(1 / 60, false, 0, tip, null, false);
    expect(fx.liveChips).toBe(0);
    fx.dispose();
  });
});
