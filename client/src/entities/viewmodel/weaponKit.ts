import * as THREE from 'three';

// Shared material palette + tube/bore helpers for the procedural weapon
// builders. Hoisted so every family file (weaponsGeo, weaponsGeoEnergy,
// weaponsGeoSidearm) builds against the same palette.
export const bodyMat = new THREE.MeshLambertMaterial({ color: 0x555a60, emissive: 0x1c1e20 });
export const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2d30, emissive: 0x0e0f10 });
export const boreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
export const shellMat = new THREE.MeshLambertMaterial({ color: 0xa8241a, emissive: 0x2a0604 });
export const brassMat = new THREE.MeshLambertMaterial({ color: 0xb08a3a, emissive: 0x241a08 });

export const mkTube = (r1: number, r2: number, len: number, z: number, mat: THREE.Material) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 8), mat);
  m.rotation.x = Math.PI / 2;
  m.position.z = z;
  return m;
};
export const mkBore = (r: number, z: number) => {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 8), boreMat);
  m.position.z = z;
  return m;
};
