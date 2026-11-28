import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { SolidFeature } from '../api/types';
import { cutters } from '../lib/solidCuts';
import { cutSolid, sharpCorners } from '../lib/solidMesh';

/**
 * The part: revolved from its outline (outer and inner, part coordinates), with the non-turned
 * features the drawing shows (cross holes, saddle cuts, flats, hexagons, slots) cut into it, so it
 * looks like the drawing's isometric view. Drag to turn.
 * Renders only when something changes (no animation loop), so it costs nothing while idle.
 */
export default function PartPreview3D({
  outer,
  inner,
  solid = [],
  height = 300,
}: {
  outer: [number, number][];
  inner: [number, number][];
  /** Non-turned features (cross holes, saddle cuts, flats ...) cut into the turned body. */
  solid?: SolidFeature[];
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || outer.length < 2) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = 'This browser has no WebGL: the 3D view cannot be shown.';
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;

    // profile in (radius, axial) for LatheGeometry: outer front→back, then inner back→front
    const L = outer[outer.length - 1][0];
    const pts: THREE.Vector2[] = [];
    const inn = inner.length ? inner : [[0, 0] as [number, number], [L, 0] as [number, number]];
    pts.push(new THREE.Vector2(Math.max(inn[0][1], 0.001), 0));
    for (const [p, r] of outer) pts.push(new THREE.Vector2(r, p));
    pts.push(new THREE.Vector2(Math.max(inn[inn.length - 1][1], 0.001), L));
    for (let i = inn.length - 1; i >= 0; i--)
      pts.push(new THREE.Vector2(Math.max(inn[i][1], 0.001), inn[i][0]));
    // corners stay sharp (faces, shoulders, chamfers); only real curves are shaded smooth
    const body = new THREE.LatheGeometry(sharpCorners(pts), 96);
    body.computeVertexNormals();
    const geo = cutSolid(body, cutters(solid, outer, L).cuts);
    if (geo !== body) body.dispose();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x30353b,
      metalness: 0.85,
      roughness: 0.32,
      side: THREE.DoubleSide,
    });
    const part = new THREE.Mesh(geo, mat);
    part.rotation.z = Math.PI / 2; // axis along X
    part.position.x = L / 2;
    const holder = new THREE.Group();
    holder.add(part);
    scene.add(holder);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-1, 2, 3);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.25));

    const maxR = Math.max(...outer.map((o) => o[1]), 1);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 5000);
    let rotX = -0.35;
    let rotY = 0.5;
    const fit = () => {
      const w = el.clientWidth || 600;
      renderer.setSize(w, height, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = w / height;
      const span = Math.max(L, maxR * 2) * 1.25;
      const d = span / 2 / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, camera.aspect);
      camera.position.set(0, 0, d);
      camera.updateProjectionMatrix();
    };
    const draw = () => {
      holder.rotation.set(rotY, rotX, 0);
      renderer.render(scene, camera);
    };
    fit();
    draw();

    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      rotX += (e.clientX - drag.x) * 0.01;
      rotY = Math.max(-1.2, Math.min(1.2, rotY + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
      draw();
    };
    const up = () => (drag = null);
    const c = renderer.domElement;
    c.style.cursor = 'grab';
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    const ro = new ResizeObserver(() => {
      fit();
      draw();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      geo.dispose();
      mat.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      c.remove();
    };
  }, [outer, inner, solid, height]);
  return <div ref={host} style={{ height }} aria-label="3D view of the part (drag to turn)" role="img" />;
}
