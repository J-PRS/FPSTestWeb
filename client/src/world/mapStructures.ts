import * as THREE from 'three';
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

const KIND_ROT: Record<StructureSpec['kind'], (m: THREE.Mesh, s: StructureSpec) => void> = {
  box: () => {},
  wall: () => {},
  pillar: () => {},
  // Ramp = box pitched forward so its low lip touches the ground in -Z.
  ramp: (m, s) => {
    m.rotation.x = -Math.PI / 7;
  },
};

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
  dome.updateMatrix();
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
  const mats = {
    neutral: new THREE.MeshLambertMaterial({ color: TINTS.neutral }),
    alpha: new THREE.MeshLambertMaterial({ color: TINTS.alpha }),
    bravo: new THREE.MeshLambertMaterial({ color: TINTS.bravo }),
  };
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  for (const s of list) {
    const mat = mats[s.team ?? 'neutral'];
    const mesh = new THREE.Mesh(s.kind === 'pillar' ? cyl : unit, mat);
    mesh.scale.set(s.size.x, s.size.y, s.size.z);
    mesh.position.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
    if (s.rotY) mesh.rotation.y = s.rotY;
    KIND_ROT[s.kind]?.(mesh, s);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    built.add(mesh);
  }
  scene.add(built);
}
