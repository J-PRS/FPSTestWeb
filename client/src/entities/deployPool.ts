import * as THREE from 'three';

// Instanced part pools for deployable visuals: every unit of a kind draws
// from shared InstancedMeshes instead of owning real meshes, so N planted
// sentries/stations/shields cost a flat handful of draws (see the 16v16
// deploy-farm profile — ~40 turrets × 8 meshes was the densest loose-mesh
// cluster in the scene). Slots are matrices composed from each unit's own
// transform locals — slew/recoil/spin need no scene-graph walk.

export const ZERO_M4 = new THREE.Matrix4().makeScale(0, 0, 0);

export interface PartPool {
  mesh: THREE.InstancedMesh;
  free: number[];
}

export function makePartPool(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): PartPool {
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.count = cap;
  mesh.frustumCulled = false; // units span the map
  // Standard Lambert depth uses the built-in program — the instanced
  // shadow GL failure was custom-material-specific (swarm.ts). Pass
  // cast=false for Basic glow parts (they'd cast opaque blobs).
  mesh.castShadow = !(mat instanceof THREE.MeshBasicMaterial);
  for (let i = 0; i < cap; i += 1) { mesh.setMatrixAt(i, ZERO_M4); }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  const free: number[] = [];
  for (let i = cap - 1; i >= 0; i -= 1) { free.push(i); }
  return { mesh, free };
}

export function takeSlot(pool: PartPool): number {
  return pool.free.pop() ?? -1;
}

export function releaseSlot(pool: PartPool, slot: number): void {
  if (slot < 0) {return;}
  pool.mesh.setMatrixAt(slot, ZERO_M4);
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.free.push(slot);
}
