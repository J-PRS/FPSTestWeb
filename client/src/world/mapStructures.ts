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
