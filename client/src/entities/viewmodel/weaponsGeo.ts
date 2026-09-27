import * as THREE from 'three';
import { WeaponType } from '../../../../shared/weapons.js';
import { getMuzzleFlashTexture } from '../../effects/glowTexture.js';

// Procedural weapon geometry — every viewmodel gun built from primitives.
// Extracted from ViewModel's constructor; returns the built maps so the
// class keeps no build-time locals.
export interface WeaponMeshes {
  weapons: Map<number, THREE.Group>;
  muzzleNodes: Map<number, THREE.Object3D>;
  chainBarrels: THREE.Group;
}

export function buildWeaponMeshes(parent: THREE.Group, muzzleZ: Record<number, number>): WeaponMeshes {
  const weapons = new Map<number, THREE.Group>();
  const muzzleNodes = new Map<number, THREE.Object3D>();
  let chainBarrels: THREE.Group = new THREE.Group();

const bodyMat = new THREE.MeshLambertMaterial({ color: 0x555a60, emissive: 0x1c1e20 });
const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2d30, emissive: 0x0e0f10 });
const boreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

const mkTube = (r1: number, r2: number, len: number, z: number, mat: THREE.Material) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 8), mat);
  m.rotation.x = Math.PI / 2;
  m.position.z = z;
  return m;
};
const mkBore = (r: number, z: number) => {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 8), boreMat);
  m.position.z = z;
  return m;
};

// Weapon 0 — bolt/rocket launcher: chunky faceted slab-sided body like
// JP's Unity ref — straight octagonal block, stepped muzzle shroud, top
// rail split by a notch, boxy rear receiver. Not tapered; the wedge in
// the ref is perspective.
const rocket = new THREE.Group();
rocket.add(mkTube(0.125, 0.125, 0.5, -0.08, bodyMat)); // main slab barrel
rocket.add(mkTube(0.145, 0.145, 0.14, -0.36, darkMat)); // muzzle shroud
rocket.add(mkBore(0.11, -0.431));
const rRecv = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.21, 0.2), darkMat);
rRecv.position.set(0, 0.01, 0.22);
rocket.add(rRecv);
// top rail with the notch: two runs separated by a gap near the receiver
const railF = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.3), darkMat);
railF.position.set(0, 0.135, -0.16);
rocket.add(railF);
const railR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.1), darkMat);
railR.position.set(0, 0.14, 0.1);
rocket.add(railR);

// Weapon 1 — disc launcher: stubby wide tube with a flat disc face
const disc = new THREE.Group();
disc.add(mkTube(0.15, 0.16, 0.34, 0.02, bodyMat));
disc.add(mkTube(0.17, 0.17, 0.05, -0.16, darkMat));
const discFace = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 16), darkMat);
discFace.rotation.x = Math.PI / 2;
discFace.position.z = -0.19;
disc.add(discFace);
disc.visible = false;

// Weapon 2 — chaingun: 3 thin barrels triangulated around center.
// Barrels stop at the housing face (z=-0.02) — a buried rear stem
// just clips through the receiver while spinning; nothing inside
// the body is visible anyway.
const chain = new THREE.Group();
chainBarrels = new THREE.Group();
// The bake pipeline treats "barrels" as a kept-separate node — it's the
// only viewmodel part that animates, so it can't fold into the merged mesh.
chainBarrels.name = 'barrels';
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  const barrel = mkTube(0.035, 0.035, 0.33, -0.18, bodyMat);
  barrel.position.x = Math.cos(a) * 0.06;
  barrel.position.y = Math.sin(a) * 0.06;
  chainBarrels.add(barrel);
}
chain.add(chainBarrels);
chain.add(mkTube(0.09, 0.11, 0.28, 0.12, darkMat)); // receiver housing
chain.visible = false;

// Weapon 3 — mortar: fat short tube with a wide muzzle + rear base
const mortar = new THREE.Group();
mortar.add(mkTube(0.19, 0.16, 0.42, -0.02, darkMat));
mortar.add(mkTube(0.22, 0.20, 0.1, -0.22, bodyMat)); // flared muzzle
mortar.add(mkBore(0.17, -0.271));
mortar.add(mkTube(0.1, 0.14, 0.14, 0.2, darkMat)); // breech
mortar.visible = false;

// Weapon 4 — grenade launcher: MGL-style revolver — fat drum slung
// under the barrel ahead of the receiver block, skeletal stock.
const gl = new THREE.Group();
gl.add(mkTube(0.095, 0.105, 0.3, -0.2, bodyMat));  // barrel over the drum
gl.add(mkTube(0.115, 0.115, 0.07, -0.36, darkMat)); // muzzle collar
gl.add(mkBore(0.085, -0.396));
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.17, 12), darkMat);
drum.rotation.z = Math.PI / 2; // axis across the gun
drum.position.set(0, -0.09, -0.08);
gl.add(drum);
const drumHub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8), bodyMat);
drumHub.rotation.z = Math.PI / 2;
drumHub.position.copy(drum.position);
gl.add(drumHub);
const glRecv = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.2), bodyMat);
glRecv.position.set(0, -0.02, 0.12);
gl.add(glRecv);
const glStock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.18), darkMat);
glStock.position.set(0, -0.03, 0.32);
gl.add(glStock);
const glGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.06), darkMat);
glGrip.position.set(0, -0.16, 0.02);
glGrip.rotation.x = 0.3;
gl.add(glGrip);
gl.visible = false;

// Weapon 5 — flak cannon: wide boxy breech + short ribbed barrel
const flak = new THREE.Group();
flak.add(mkTube(0.17, 0.15, 0.3, -0.08, bodyMat));
flak.add(mkTube(0.19, 0.19, 0.06, -0.24, darkMat)); // muzzle ring
flak.add(mkBore(0.15, -0.271));
const flakBox = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.3), darkMat);
flakBox.position.set(0, 0, 0.16);
flak.add(flakBox);
// Top vents — the UT flak "grill"
for (let i = 0; i < 3; i++) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), bodyMat);
  vent.position.set(0, 0.11, 0.08 + i * 0.08);
  flak.add(vent);
}
flak.visible = false;

// Weapon 6 — plasma gun: twin slim tubes + glowing emitter ring
const plasma = new THREE.Group();
plasma.add(mkTube(0.09, 0.09, 0.45, -0.02, bodyMat));
const sideTube = mkTube(0.04, 0.04, 0.35, -0.01, darkMat);
sideTube.position.x = 0.09;
plasma.add(sideTube);
plasma.add(mkTube(0.11, 0.13, 0.06, -0.24, darkMat)); // emitter collar
plasma.add(mkBore(0.08, -0.271));
const plasmaGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.075, 0.075, 0.02, 16),
  new THREE.MeshBasicMaterial({ color: 0x33ffaa })
);
plasmaGlow.rotation.x = Math.PI / 2;
plasmaGlow.position.z = -0.272;
plasma.add(plasmaGlow);
plasma.visible = false;

// Weapon 7 — railgun: Q3's fat coil-cannon. Thick central bore, a stack
// of fat accelerator coils ribbing the barrel, glowing muzzle ring.
// The silhouette reads "industrial capacitor bank", not sniper rifle.
const rail = new THREE.Group();
// Fat bore — the barrel itself is the chunk
rail.add(mkTube(0.13, 0.14, 0.55, -0.08, bodyMat));
// Coil stack: fat rings ribbing the barrel — THE railgun read
for (let i = 0; i < 4; i++) {
  const coil = mkTube(0.165, 0.165, 0.05, -0.3 + i * 0.14, darkMat);
  rail.add(coil);
  // Cyan energy slit between coils — the capacitor glow peeking through
  const glowRing = mkTube(0.15, 0.15, 0.02, -0.23 + i * 0.14,
    new THREE.MeshBasicMaterial({ color: 0x55bbff }));
  rail.add(glowRing);
}
// Flared muzzle + glow bore
rail.add(mkTube(0.16, 0.18, 0.08, -0.38, darkMat));
const muzzleGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.11, 0.11, 0.02, 16),
  new THREE.MeshBasicMaterial({ color: 0x66ccff })
);
muzzleGlow.rotation.x = Math.PI / 2;
muzzleGlow.position.z = -0.421;
rail.add(muzzleGlow);
// Rear capacitor housing — big drum behind the receiver
const capDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.16, 12), darkMat);
capDrum.rotation.x = Math.PI / 2;
capDrum.position.set(0, -0.02, 0.22);
rail.add(capDrum);
rail.visible = false;

// Weapon 8 — lightning gun: Q3's tesla prod. Chunky insulated body, two
// prongs converging on a glowing emitter ball — the arc jumps between
// them, not out of a bore. Reads instantly different from the cannons.
const lg = new THREE.Group();
lg.add(mkTube(0.12, 0.14, 0.42, 0.02, bodyMat)); // insulated body
lg.add(mkTube(0.15, 0.15, 0.07, 0.2, darkMat));  // grip ring
const lgGlowMat = new THREE.MeshBasicMaterial({ color: 0x8fdcff });
for (const side of [-1, 1]) {
  const prong = mkTube(0.028, 0.016, 0.3, -0.24, darkMat);
  prong.position.x = side * 0.07;
  prong.rotation.y = -side * 0.12; // converge on the emitter point
  lg.add(prong);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), lgGlowMat);
  tip.position.set(side * 0.07 * 0.82, 0, -0.38);
  lg.add(tip);
}
// Emitter ball between the prongs — the tesla node the arc springs from
const emitter = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), lgGlowMat);
emitter.position.set(0, 0, -0.4);
lg.add(emitter);
// Ceramic ribs on the body — electrical hardware, not gun furniture
for (let i = 0; i < 3; i++) {
  lg.add(mkTube(0.135, 0.135, 0.03, -0.06 + i * 0.1, darkMat));
}
lg.visible = false;

// Weapon 9 — shotgun: heavy pumpgun. Fat bore over a full-length shell
// tube, chunky receiver, big ribbed pump — reads "combat shotgun" the
// instant you see the paired under-barrel stack.
const sg = new THREE.Group();
sg.add(mkTube(0.115, 0.115, 0.6, -0.08, bodyMat));  // THICK barrel — bore sells it
sg.add(mkTube(0.135, 0.135, 0.09, -0.36, darkMat)); // heavy muzzle collar
sg.add(mkBore(0.095, -0.406));
// Shell tube — parallel under the barrel for its full length, THE
// pumpgun silhouette read (barrel-over-mag = shotgun, not rifle)
const magTube = mkTube(0.068, 0.068, 0.52, -0.02, darkMat);
magTube.position.y = -0.15;
sg.add(magTube);
// Receiver — oversized block, wider than tall, between barrel and stock
const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.18, 0.24), bodyMat);
receiver.position.set(0, -0.01, 0.2);
sg.add(receiver);
// Side-saddle shells — three red hulls on the receiver flank. THE
// shotgun read: nothing else in the arsenal carries colored shells.
const shellMat = new THREE.MeshLambertMaterial({ color: 0xa8241a, emissive: 0x2a0604 });
const brassMat = new THREE.MeshLambertMaterial({ color: 0xb08a3a, emissive: 0x241a08 });
for (let i = 0; i < 3; i++) {
  const hull = mkTube(0.022, 0.022, 0.07, 0, shellMat);
  hull.position.set(-0.085, 0.03, 0.09 + i * 0.08); // a row along the flank
  sg.add(hull);
  const brass = mkTube(0.024, 0.024, 0.018, 0, brassMat);
  brass.position.copy(hull.position);
  brass.position.z += 0.044; // brass cup at the hull's rear
  sg.add(brass);
}
// Ejection port — dark notch on the receiver's right side
const port = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.11), darkMat);
port.position.set(0.098, 0.03, 0.16);
sg.add(port);
// Pump grip — fat ribbed slide under the fore-end, wide as the hand
const pump = mkTube(0.085, 0.085, 0.19, -0.13, darkMat);
pump.position.y = -0.15;
sg.add(pump);
for (let i = 0; i < 4; i++) {
  const rib = mkTube(0.092, 0.092, 0.02, -0.2 + i * 0.05, bodyMat);
  rib.position.y = -0.15;
  sg.add(rib);
}
// Heat-shield vents along the barrel top — rows of holes read at scale
for (let i = 0; i < 4; i++) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.045), darkMat);
  vent.position.set(0, 0.12, -0.24 + i * 0.1);
  sg.add(vent);
}
// Bead sight on the muzzle collar — tiny nub, classic pumpgun read
const bead = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), darkMat);
bead.position.set(0, 0.15, -0.38);
sg.add(bead);
// Stock — dropped buttstock with a visible grip wedge
const stock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.26), darkMat);
stock.position.set(0, -0.08, 0.34);
sg.add(stock);
const sgGrip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.06), darkMat);
sgGrip.position.set(0, -0.12, 0.16);
sgGrip.rotation.x = 0.3;
sg.add(sgGrip);
sg.visible = false;

// Weapon 10 — cannon: Serious Sam naval gun rebuilt per JP's Blender
// ref — stacked bulged barrel sections separated by pinch rings, huge
// bore, rounded breech ball.
const cn = new THREE.Group();
let cz = 0.0; // running z, barrel extends toward -Z from breech
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
// cz ends ≈ -0.46; muzzle ring's own capped face serves as the dark bore.
const cnBall = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), darkMat);
cnBall.position.set(0, -0.02, 0.06);               // rounded breech ball
cn.add(cnBall);
cn.visible = false;

// Weapon 11 — rocket launcher: classic RPG profile. Long launch tube,
// flared muzzle bell, conical warhead tip protruding past the tube
// (loaded look = the RPG read), stubby exhaust cone at the rear.
const rpg = new THREE.Group();
rpg.add(mkTube(0.11, 0.11, 0.62, -0.02, bodyMat));        // launch tube
rpg.add(mkTube(0.16, 0.11, 0.12, -0.36, darkMat));        // muzzle bell flare
rpg.add(mkTube(0.02, 0.13, 0.14, 0.36, darkMat));         // rear exhaust cone
const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 8), shellMat);
warhead.rotation.x = -Math.PI / 2; // nose forward
warhead.position.z = -0.42;
rpg.add(warhead);
const whBody = mkTube(0.09, 0.09, 0.08, -0.33, shellMat);  // warhead body
rpg.add(whBody);
// Trigger grip + rear sight post
const rpgGrip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.07), darkMat);
rpgGrip.position.set(0, -0.14, 0.08);
rpgGrip.rotation.x = 0.25;
rpg.add(rpgGrip);
const rpgSight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.03), darkMat);
rpgSight.position.set(0, 0.14, -0.1);
rpg.add(rpgSight);
rpg.visible = false;

// Sidearms — compact silhouettes so the hold-out swap reads instantly.
// Pistol: slide + stubby barrel + raked grip.
const pistol = new THREE.Group();
pistol.add(mkTube(0.03, 0.03, 0.16, -0.08, darkMat)); // barrel
const slide = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.24), bodyMat);
slide.position.set(0, 0.02, -0.05);
pistol.add(slide);
const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.08), darkMat);
pGrip.position.set(0, -0.09, 0.06);
pGrip.rotation.x = 0.35;
pistol.add(pGrip);
const pSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), darkMat);
pSight.position.set(0, 0.07, -0.15);
pistol.add(pSight);
pistol.visible = false;

// Revolver: long barrel + big cylinder + hammer — the hand-cannon profile.
const revolver = new THREE.Group();
revolver.add(mkTube(0.032, 0.032, 0.24, -0.14, darkMat)); // long barrel
const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.08, 8), bodyMat);
cyl.rotation.z = Math.PI / 2;
cyl.position.set(0, 0, 0.02);
revolver.add(cyl);
const frame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.15), bodyMat);
frame.position.set(0, 0.045, -0.06);
revolver.add(frame);
const rGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08), darkMat);
rGrip.position.set(0, -0.09, 0.09);
rGrip.rotation.x = 0.45;
revolver.add(rGrip);
const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.025), darkMat);
hammer.position.set(0, 0.05, 0.1);
revolver.add(hammer);
revolver.visible = false;

// Map is keyed by WeaponType, never positionally — Grenade/Slam/Melee
// have no gun model (belt throw / fist), so they map to nothing.
const models: [number, THREE.Group][] = [
  [WeaponType.Rocket, rocket],
  [WeaponType.Disc, disc],
  [WeaponType.DiscPull, disc],
  [WeaponType.Chaingun, chain],
  [WeaponType.Mortar, mortar],
  [WeaponType.GrenadeLauncher, gl],
  [WeaponType.Flak, flak],
  [WeaponType.Plasma, plasma],
  [WeaponType.Railgun, rail],
  [WeaponType.Lightning, lg],
  [WeaponType.Shotgun, sg],
  [WeaponType.Cannon, cn],
  [WeaponType.RocketLauncher, rpg],
  [WeaponType.Pistol, pistol],
  [WeaponType.Revolver, revolver],
];
for (const [wt, g] of models) {
  weapons.set(wt, g);
  parent.add(g);
  const mz = new THREE.Object3D();
  mz.position.z = muzzleZ[wt] ?? -0.35;
  g.add(mz);
  muzzleNodes.set(wt, mz);
}
  return { weapons, muzzleNodes, chainBarrels };
}

export interface HandFlash {
  fistGroup: THREE.Group;
  flashMat: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMesh2: THREE.Mesh;
}

// Fist flight path (group-local space): off-screen bottom-left → jab center
export const FIST_OFF = new THREE.Vector3(-0.42, -0.34, -0.5);
export const FIST_JAB = new THREE.Vector3(-0.02, -0.14, -0.62);

export function buildHandAndFlash(parent: THREE.Group): HandFlash {
// Muzzle flash — single billboard quad at the bore, additive, ~70ms.
// Random roll each shot keeps it from looking identical.
const flashMat = new THREE.MeshBasicMaterial({
  map: getMuzzleFlashTexture(), // starburst alpha — kills the square edge
  color: 0xffc866,
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
flashMesh.position.set(0, 0, -0.42); // just past the bore
flashMesh.visible = false;
parent.add(flashMesh);
// Second quad at 45° — crossed pair reads as a star-burst, not a square
const flashMesh2 = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
flashMesh2.position.set(0, 0, -0.42);
flashMesh2.rotation.z = Math.PI / 4;
flashMesh2.visible = false;
parent.add(flashMesh2);

// Off-hand fist for melee — chunky glove: palm block + knuckle row.
// Parked off-screen bottom-left until punch() jabs it across the frame.
const fistGroup = new THREE.Group();
const gloveMat = new THREE.MeshLambertMaterial({ color: 0x3a3d42, emissive: 0x111214 });
const knuckleMat = new THREE.MeshLambertMaterial({ color: 0x8a4a3a, emissive: 0x20100c });
const palm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.14), gloveMat);
fistGroup.add(palm);
for (let i = 0; i < 4; i++) {
  const k = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.03, 0.03), knuckleMat);
  k.position.set(-0.036 + i * 0.024, 0.03, -0.07);
  fistGroup.add(k);
}
const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6), gloveMat);
wrist.rotation.x = Math.PI / 2;
wrist.position.set(0, -0.02, 0.11);
fistGroup.add(wrist);
fistGroup.position.copy(FIST_OFF);
fistGroup.rotation.set(0.15, 0.25, -0.1);
fistGroup.visible = false;
parent.add(fistGroup);
  return { fistGroup, flashMat, flashMesh, flashMesh2 };
}
