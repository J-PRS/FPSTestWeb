import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';

// Static map structures — the server's map spec arrives on gameState and
// every client builds identical geometry locally. Primitives stay dumb:
// one shared box geometry, per-kind material, merged into a handful of
// draw calls regardless of piece count. Collision is the next layer —
// for now these are cover you can stand behind, not walls that stop you.
const TINTS = {
  neutral: 0x4a5058,
  alpha: 0x3a5a80,
  bravo: 0x80483a,
} as const;

let built: THREE.Group | null = null;

let dome: THREE.Mesh | null = null;

/** Drop the arena dome — admin hot-reload removed the boundary. */
export function clearArenaDome(scene: THREE.Scene): void {
  if (!dome) return;
  scene.remove(dome);
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  dome = null;
}

/** Translucent dome marking the arena boundary (Quicksand-style). Non-
 * blocking — visible geometry only; enforcement is a separate layer. */
export function buildArenaDome(a: { x: number; z: number; radius: number }, groundY: number, scene: THREE.Scene): void {
  if (dome) {
    scene.remove(dome);
    dome.geometry.dispose();
    (dome.material as THREE.Material).dispose();
    dome = null;
  }
  const mat = new THREE.MeshBasicMaterial({
    color: 0x66ccff, transparent: true, opacity: 0,
    side: THREE.BackSide, depthWrite: false,
  });
  dome = new THREE.Mesh(
    new THREE.SphereGeometry(a.radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    mat,
  );
  // Tribes-style: the barrier is invisible at range and fades in only near
  // the shell — so both inside-approach and outside-approach measure
  // distance to the shell surface, not the dome center.
  dome.onBeforeRender = (_r, _s, cam) => {
    const dx = cam.position.x - a.x;
    const dy = cam.position.y - groundY;
    const dz = cam.position.z - a.z;
    const distToShell = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - a.radius);
    mat.opacity = Math.max(0, Math.min(0.35, (1 - distToShell / 80) * 0.35));
    dome!.visible = mat.opacity > 0.004;
  };
  dome.position.set(a.x, groundY, a.z);
  dome.matrixAutoUpdate = false;
  dome.matrixWorldAutoUpdate = false;
  dome.updateMatrix();
  dome.updateMatrixWorld(true);
  scene.add(dome);
}

export function buildStructures(list: StructureSpec[], scene: THREE.Scene): void {
  if (built) {
    scene.remove(built);
    built.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    built = null;
  }
  if (!list.length) return;
  built = new THREE.Group();
  built.name = 'mapStructures';
  built.matrixAutoUpdate = false;
  built.matrixWorldAutoUpdate = false;
  const mats = {
    neutral: new THREE.MeshLambertMaterial({ color: TINTS.neutral }),
    alpha: new THREE.MeshLambertMaterial({ color: TINTS.alpha }),
    bravo: new THREE.MeshLambertMaterial({ color: TINTS.bravo }),
  };
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  // Bake every piece into one geometry per material — a map's worth of
  // cover is ~40 static boxes, and per-mesh draws were ~40 program keys
  // per frame for pixels that never move.
  const byMat = new Map<keyof typeof mats, THREE.BufferGeometry[]>();
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  for (const s of list) {
    const key = s.team ?? 'neutral';
    _p.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
    _e.set(0, s.rotY ?? 0, 0);
    if (s.kind === 'ramp') _e.x = -Math.PI / 7;
    _q.setFromEuler(_e);
    _s.set(s.size.x, s.size.y, s.size.z);
    _m.compose(_p, _q, _s);
    const g = (s.kind === 'pillar' ? cyl : unit).clone().applyMatrix4(_m);
    (byMat.get(key) ?? byMat.set(key, []).get(key)!).push(g);
  }
  for (const [key, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mats[key]);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    built.add(mesh);
    for (const g of geos) g.dispose();
  }
  built.updateMatrixWorld(true);
  scene.add(built);
}
