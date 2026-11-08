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
let cz = 0;
const cnSeg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  cn.add(mkTube(r1, r2, len, cz - len / 2, mat));
  cz -= len;
};
cnSeg(0.1, 0.13, 0.04, bodyMat);   // breech cap flare
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
for (let i = 0; i < 3; i += 1) {
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
  new THREE.MeshBasicMaterial({ color: 0x44_BB_FF })
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
for (let i = 0; i < CHAIN_BARRELS; i += 1) {
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
  for (let i = 0; i < 3; i += 1) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.12), boreMat);
    slot.position.set(side * 0.092, 0.015 - i * 0.055, 0.08);
    chain.add(slot);
  }
}
const chainCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.115, 0.05, 12), darkMat);
chainCollar.rotation.x = Math.PI / 2;
chainCollar.position.z = -0.29;
chainBarrels.add(chainCollar);
for (let i = 0; i < CHAIN_BARRELS; i += 1) {
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
for (let i = 0; i < 3; i += 1) {
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
chain.add(mkBore(0.1, -0.3));
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 12), darkMat);
drum.rotation.z = Math.PI / 2;
drum.position.set(-0.08, -0.14, 0.12);
chain.add(drum);
const drumCap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.15, 8), bodyMat);
drumCap.rotation.z = Math.PI / 2;
drumCap.position.copy(drum.position);
chain.add(drumCap);
for (let i = 0; i < 4; i += 1) {
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

// mkRakk v1 (2026-10): the original cliff-racer — squat icosahedron body,
// flat box wings, glow eyes. Read as a black kite/plane hybrid at range;
// the flat slabs carried no membrane silhouette. Retired for the
// articulated two-segment scalloped wing.
export function mkRakk_v1(): THREE.Group {
  const g = new THREE.Group();
  const hide = new THREE.MeshLambertMaterial({ color: 0x54_41_3F });
  const memb = new THREE.MeshLambertMaterial({ color: 0x4A_2F_3A, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), hide);
  body.scale.set(0.75, 0.6, 1);
  g.add(body);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.7, 4), hide);
    ear.position.set(s * 0.28, 0.55, 0.55);
    ear.rotation.set(-0.2, 0, s * 0.35);
    g.add(ear);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 1.1), memb);
    wing.position.set(s * 1.1, 0.15, -0.15);
    wing.rotation.y = -s * 0.45;
    wing.rotation.z = s * 0.15;
    g.add(wing);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.7), memb);
  tail.position.set(0, -0.1, -1.1);
  tail.rotation.x = -0.3;
  g.add(tail);
  g.scale.setScalar(0.8); // Rakk.scale
  g.visible = false;
  return g;
}

// mkBolt v1 (2026-10): the slab launcher — flat octagonal block, trench
// rail, box receiver. Reads as a generic rocket tube, nothing bolt/
// crossbow about it. Retired for the T:A-style skeletal crossbow; the
// w0_baked.glb of this mesh is parked as w0_baked.glb.old.
export function mkBolt_v1(): THREE.Group {
const rocket = new THREE.Group();
rocket.add(mkTube(0.125, 0.125, 0.52, -0.06, bodyMat)); // main slab barrel
const rFace = new THREE.Mesh(new THREE.CylinderGeometry(0.126, 0.126, 0.03, 8), darkMat);
rFace.rotation.x = Math.PI / 2;
rFace.position.z = -0.335;
rocket.add(rFace);
rocket.add(mkBore(0.11, -0.351));
const rRecv = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.21, 0.2), darkMat);
rRecv.position.set(0, 0.01, 0.22);
rocket.add(rRecv);
for (const side of [-1, 1]) {
  const wallF = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.075, 0.28), darkMat);
  wallF.position.set(side * 0.045, 0.13, -0.14);
  rocket.add(wallF);
  const wallR = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.1), darkMat);
  wallR.position.set(side * 0.045, 0.145, 0.09);
  rocket.add(wallR);
}
const channelFloor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.015, 0.42), darkMat);
channelFloor.position.set(0, 0.095, -0.05);
rocket.add(channelFloor);
return rocket;
}

// mkMortar v1 (2026-11): fat tube + flared muzzle, base plate and bipod
// under the breech, shell hopper on the left flank. Archived verbatim —
// every identity part sat below/beside the tube, so in first person it
// read as a stubby pipe. Replaced by the bell-mouth + top pan-drum build.
export function mkMortar_v1(): THREE.Group {
const mortar = new THREE.Group();
mortar.add(mkTube(0.19, 0.16, 0.42, -0.02, darkMat)); // main bore tube
mortar.add(mkTube(0.22, 0.2, 0.1, -0.22, bodyMat)); // flared muzzle
mortar.add(mkBore(0.17, -0.271));
// Breech block + base plate — the mortar's tell: a flat plate the tube
// seats on, like it's meant to be slammed down
mortar.add(mkTube(0.1, 0.14, 0.14, 0.2, darkMat));
const mBase = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.24), bodyMat);
mBase.position.set(0, -0.17, 0.2);
mortar.add(mBase);
// Bipod struts — angled legs off the mid-tube, the "crew-served" read
for (const side of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.05), darkMat);
  leg.position.set(side * 0.14, -0.14, -0.1);
  leg.rotation.z = -side * 0.5;
  mortar.add(leg);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.08), darkMat);
  foot.position.set(side * 0.2, -0.24, -0.1);
  mortar.add(foot);
}
// Shell hopper on the left flank — a rack of finned bombs, tips
// visible above the tube. Live ordnance = the mortar read.
const finMat = new THREE.MeshLambertMaterial({ color: 0x5A_4A_28, emissive: 0x18_12_05 });
for (let i = 0; i < 3; i += 1) {
  const shell = mkTube(0.035, 0.035, 0.16, -0.05 + i * 0.09, bodyMat);
  shell.position.set(-0.15, -0.02, shell.position.z);
  mortar.add(shell);
  // Fin cross at the shell's tail
  const finV = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.07, 0.06), finMat);
  finV.position.set(-0.15, -0.02, -0.05 + i * 0.09 + 0.09);
  mortar.add(finV);
  const finH = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.01, 0.06), finMat);
  finH.position.set(-0.15, -0.02, -0.05 + i * 0.09 + 0.09);
  mortar.add(finH);
}
// Front sight post on the muzzle ring
const mSight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.025), darkMat);
mSight.position.set(0, 0.22, -0.22);
mortar.add(mSight);
mortar.visible = false;
return mortar;
}

// mkPistol v1 (2026-11): stacked-box autopistol - slide/frame/grip all
// raw BoxGeometry slabs; readable but the crudest model in the kit.
// Replaced by the chamfered-slide + extruded-frame version.
export function mkPistol_v1(): THREE.Group {
const pistol = new THREE.Group();
const BORE_Y = 0.045;
const pBarrel = mkTube(0.022, 0.022, 0.06, -0.16, darkMat);
pBarrel.position.y = BORE_Y;
pistol.add(pBarrel);
const pBore = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 8), darkMat);
pBore.rotation.x = Math.PI / 2;
pBore.position.set(0, BORE_Y, -0.192);
pistol.add(pBore);
const slide = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.26), bodyMat);
slide.position.set(0, 0.055, -0.06);
pistol.add(slide);
const spine = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.24), darkMat);
spine.position.set(0, 0.088, -0.06);
pistol.add(spine);
for (const base of [-0.16, 0.05]) {
  for (let i = 0; i < 4; i += 1) {
    const serr = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.04, 0.01), darkMat);
    serr.position.set(0, 0.055, base + i * 0.016);
    pistol.add(serr);
  }
}
const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.22), darkMat);
pFrame.position.set(0, 0, -0.03);
pistol.add(pFrame);
const railP = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.09), darkMat);
railP.position.set(0, -0.033, -0.12);
pistol.add(railP);
for (let i = 0; i < 2; i += 1) {
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.022, 0.008), darkMat);
  slot.position.set(0, -0.033, -0.14 + i * 0.035);
  pistol.add(slot);
}
const gFront = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.012), darkMat);
gFront.position.set(0, -0.06, -0.05);
pistol.add(gFront);
const gBottom = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.08), darkMat);
gBottom.position.set(0, -0.085, -0.01);
pistol.add(gBottom);
const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.03, 0.012), darkMat);
trigger.position.set(0, -0.055, 0);
trigger.rotation.x = 0.25;
pistol.add(trigger);
const gripMat = new THREE.MeshLambertMaterial({ color: 0x33_36_2F, emissive: 0x0B_0C_0A });
const gs = new THREE.Shape();
gs.moveTo(0, 0);
gs.lineTo(-0.005, -0.11);
gs.quadraticCurveTo(0.005, -0.135, 0.03, -0.14);
gs.lineTo(0.065, -0.14);
gs.quadraticCurveTo(0.075, -0.13, 0.07, -0.09);
gs.lineTo(0.05, -0.005);
gs.lineTo(0, 0);
const gripGeo = new THREE.ExtrudeGeometry(gs, { depth: 0.055, steps: 3, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2 });
const pGrip = new THREE.Mesh(gripGeo, gripMat);
pGrip.rotation.y = -Math.PI / 2;
pGrip.position.set(0.028, -0.02, 0.08);
pistol.add(pGrip);
const pSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.014), darkMat);
pSight.position.set(0, 0.1, -0.165);
pistol.add(pSight);
const pRear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.02), darkMat);
pRear.position.set(0, 0.098, 0.055);
pistol.add(pRear);
pistol.visible = false;
return pistol;
}

// Registry for the Gun Lab — key is a display label.
export const ARCHIVE_BUILDERS: [string, () => THREE.Group][] = [
  ['cannon_v1', mkCannon_v1],
  ['plasmagun_v1', mkPlasmaGun_v1],
  ['chaingun_v1', mkChaingun_v1],
  ['rakk_v1', mkRakk_v1],
  ['bolt_v1', mkBolt_v1],
  ['mortar_v1', mkMortar_v1],
  ['pistol_v1', mkPistol_v1],
];
