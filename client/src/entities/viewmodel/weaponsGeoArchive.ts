import * as THREE from 'three';
import { bodyMat, darkMat, boreMat, brassMat, mkTube, mkBore } from './weaponKit.js';

// Retired weapon builders — kept for Gun Lab A/B reference, NOT wired
// into the live viewmodel. When a mk* gets redesigned, move the old
// version here under a dated name so the sheet can still render it.

// mkCannon v1 (2026-10): ring-stack bombard. The reinforcing hoops
// swelled to ~1.6x the tube radius — read as stacked donuts, not a
// tapered barrel. Replaced by the tapering-tube + crowned-hoop version.
export function mkCannon_v1(): THREE.Group {
const cn = new THREE.Group();
let cz = 0.0;
const cnSeg = (r1: number, r2: number, len: number, mat: THREE.Material) => {
  cn.add(mkTube(r1, r2, len, cz - len / 2, mat));
  cz -= len;
};
cnSeg(0.10, 0.13, 0.04, bodyMat);   // breech cap flare
cnSeg(0.13, 0.16, 0.05, bodyMat);   // bulge 1 out
cnSeg(0.16, 0.11, 0.05, bodyMat);   // bulge 1 in
cnSeg(0.105, 0.105, 0.02, darkMat); // pinch ring
cnSeg(0.11, 0.165, 0.06, bodyMat);  // bulge 2 out
cnSeg(0.165, 0.11, 0.05, bodyMat);  // bulge 2 in
cnSeg(0.105, 0.105, 0.02, darkMat); // pinch ring
cnSeg(0.11, 0.155, 0.06, bodyMat);  // bulge 3 out
cnSeg(0.155, 0.175, 0.04, bodyMat); // muzzle flare
cnSeg(0.175, 0.175, 0.02, darkMat); // muzzle ring
const cnBall = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), darkMat);
cnBall.position.set(0, -0.02, 0.06);
cn.add(cnBall);
cn.visible = false;
return cn;
}

// mkPlasmaGun v1 (2026-10): tube body + three thin prongs around a collar.
// Archived verbatim before the next plasma pass — generic tube-and-needles
// silhouette, kept for A/B.
export function mkPlasmaGun_v1(): THREE.Group {
const plasmagun = new THREE.Group();
plasmagun.add(mkTube(0.11, 0.12, 0.34, -0.05, bodyMat));
for (let i = 0; i < 3; i++) {
  const prong = mkTube(0.025, 0.025, 0.22, -0.2, darkMat);
  const a = (i / 3) * Math.PI * 2;
  prong.position.x = Math.cos(a) * 0.09;
  prong.position.y = Math.sin(a) * 0.09;
  plasmagun.add(prong);
}
plasmagun.add(mkTube(0.12, 0.13, 0.05, -0.22, darkMat)); // emitter collar
plasmagun.add(mkBore(0.09, -0.246));
const plasmagunGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.08, 0.08, 0.02, 16),
  new THREE.MeshBasicMaterial({ color: 0x44bbff })
);
plasmagunGlow.rotation.x = Math.PI / 2;
plasmagunGlow.position.z = -0.247;
plasmagun.add(plasmagunGlow);
plasmagun.visible = false;
return plasmagun;
}

// mkChaingun v1 (2026-10): six exposed thin barrels + torus race/clamp.
// Archived verbatim — the cluster read "pipes on a box"; replaced by the
// fat-hex three-throat language shared with the railgun.
function arcExtrudeAt(shape: THREE.Shape, zFront: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), mat);
  m.position.z = zFront;
  return m;
}
export function mkChaingun_v1(): THREE.Group {
const chain = new THREE.Group();
const chainBarrels = new THREE.Group();
chainBarrels.name = 'barrels';
const CHAIN_BARRELS = 6;
const CLUSTER_R = 0.09;
for (let i = 0; i < CHAIN_BARRELS; i++) {
  const a = (i / CHAIN_BARRELS) * Math.PI * 2;
  const barrel = mkTube(0.04, 0.04, 0.62, -0.62, bodyMat, 4);
  barrel.position.x = Math.cos(a) * CLUSTER_R;
  barrel.position.y = Math.sin(a) * CLUSTER_R;
  barrel.userData.barrel = true;
  barrel.userData.baseZ = barrel.position.z;
  chainBarrels.add(barrel);
  const root = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 8), darkMat);
  root.rotation.x = Math.PI / 2;
  root.position.set(Math.cos(a) * CLUSTER_R, Math.sin(a) * CLUSTER_R, -0.315);
  chainBarrels.add(root);
}
chain.add(chainBarrels);
const housing = new THREE.Shape();
housing.moveTo(-0.1, -0.1);
housing.lineTo(0.1, -0.1);
housing.lineTo(0.085, 0.085);
housing.lineTo(-0.085, 0.085);
housing.closePath();
chain.add(arcExtrudeAt(housing, 0.02, 0.13, bodyMat));
chain.add(mkTube(0.125, 0.12, 0.33, -0.145, bodyMat));
for (const side of [-1, 1]) {
  for (let i = 0; i < 3; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.12), boreMat);
    slot.position.set(side * 0.092, 0.015 - i * 0.055, 0.08);
    chain.add(slot);
  }
}
const chainCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.115, 0.05, 12), darkMat);
chainCollar.rotation.x = Math.PI / 2;
chainCollar.position.z = -0.29;
chainBarrels.add(chainCollar);
for (let i = 0; i < CHAIN_BARRELS; i++) {
  const a = (i / 6) * Math.PI * 2;
  const stud = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.024), bodyMat);
  stud.position.set(Math.cos(a) * 0.098, Math.sin(a) * 0.098, -0.315);
  chainBarrels.add(stud);
}
const race = new THREE.Mesh(new THREE.TorusGeometry(CLUSTER_R + 0.07, 0.022, 6, 16), darkMat);
race.position.z = -0.88;
chain.add(race);
const clamp = new THREE.Mesh(new THREE.TorusGeometry(CLUSTER_R + 0.045, 0.016, 6, 14), bodyMat);
clamp.position.z = -0.88;
chainBarrels.add(clamp);
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.58, 5), darkMat);
  rod.rotation.x = Math.PI / 2;
  rod.position.set(Math.cos(a) * (CLUSTER_R + 0.06), Math.sin(a) * (CLUSTER_R + 0.06), -0.58);
  chain.add(rod);
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.06), darkMat);
  lug.rotation.z = a;
  lug.position.set(Math.cos(a) * (CLUSTER_R + 0.045), Math.sin(a) * (CLUSTER_R + 0.045), -0.31);
  chain.add(lug);
}
chain.add(mkBore(0.1, -0.30));
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 12), darkMat);
drum.rotation.z = Math.PI / 2;
drum.position.set(-0.08, -0.14, 0.12);
chain.add(drum);
const drumCap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.15, 8), bodyMat);
drumCap.rotation.z = Math.PI / 2;
drumCap.position.copy(drum.position);
chain.add(drumCap);
for (let i = 0; i < 4; i++) {
  const link = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.024, 0.05), brassMat);
  link.position.set(-0.06, -0.09 + i * 0.035, 0.2 - i * 0.02);
  link.rotation.x = 0.4;
  chain.add(link);
}
const chainRecv = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.08), darkMat);
chainRecv.position.set(0, -0.03, 0.2);
chain.add(chainRecv);
const chainRail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.2), darkMat);
chainRail.position.set(0, 0.115, 0.08);
chain.add(chainRail);
const chainGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.07), darkMat);
chainGrip.position.set(0.05, -0.16, 0.22);
chainGrip.rotation.x = 0.3;
chain.add(chainGrip);
chain.position.z = 0.15;
chain.visible = false;
return chain;
}

// Registry for the Gun Lab — key is a display label.
export const ARCHIVE_BUILDERS: [string, () => THREE.Group][] = [
  ['cannon_v1', mkCannon_v1],
  ['plasmagun_v1', mkPlasmaGun_v1],
  ['chaingun_v1', mkChaingun_v1],
];
