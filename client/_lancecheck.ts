// Temporary: verify mkShocklance geometry is finite + roughly spear-shaped.
import * as THREE from 'three';
import { mkShocklance } from './src/entities/viewmodel/weaponsGeoEnergy.js';
import { WeaponType } from '../shared/weapons.js';

const g = mkShocklance();
g.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(g);
const size = box.getSize(new THREE.Vector3());
let nan = 0, meshes = 0;
g.traverse((o): void => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) {return;}
  meshes += 1;
  const p = m.geometry.getAttribute('position');
  for (let i = 0; i < p.count; i += 1) {
    if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) {nan += 1;}
  }
});
console.log('wt', WeaponType.Shocklance, '| meshes', meshes, '| NaN verts', nan);
console.log('size', size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3),
  '| z-span', box.min.z.toFixed(3), '..', box.max.z.toFixed(3));
// The muzzle node isn't part of the builder (parked by buildWeaponMeshes at
// muzzleZ=-0.52) — assert the emitter corona sits within ~3cm of it.
let coronaZ = 0;
g.traverse((o): void => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry.type === 'SphereGeometry' && (m.geometry.parameters.radius > 0.04)) {coronaZ = m.position.z;} });
console.log('corona z', coronaZ.toFixed(3), 'vs muzzle -0.52');
