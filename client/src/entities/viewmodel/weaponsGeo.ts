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

const bodyMat = new THREE.MeshLambertMaterial({ color: 0x555a60, emissive: 0x1c1e20 });
const darkMat = new THREE.MeshLambertMaterial({ color: 0x2a2d30, emissive: 0x0e0f10 });
const boreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
const shellMat = new THREE.MeshLambertMaterial({ color: 0xa8241a, emissive: 0x2a0604 });
const brassMat = new THREE.MeshLambertMaterial({ color: 0xb08a3a, emissive: 0x241a08 });

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
function mkRocket(): THREE.Group {
const rocket = new THREE.Group();
// Equal-width slab all the way to the face — the ref has NO stepped
// shroud; the front is flush with the body. End plate is a thin flush
// ring so the muzzle reads as a bore in a flat face, not a fattened tip.
rocket.add(mkTube(0.125, 0.125, 0.52, -0.06, bodyMat)); // main slab barrel
const rFace = new THREE.Mesh(new THREE.CylinderGeometry(0.126, 0.126, 0.03, 8), darkMat);
rFace.rotation.x = Math.PI / 2;
rFace.position.z = -0.335;
rocket.add(rFace);
rocket.add(mkBore(0.11, -0.351));
const rRecv = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.21, 0.2), darkMat);
rRecv.position.set(0, 0.01, 0.22);
rocket.add(rRecv);
// Deep top channel — the ref's rail reads as a TRENCH cut into the
// slab: tall side walls, not a thin strip. Long front run, notch gap,
// then a taller rear block where the channel ends in a step.
for (const side of [-1, 1]) {
  const wallF = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.075, 0.28), darkMat);
  wallF.position.set(side * 0.045, 0.13, -0.14);
  rocket.add(wallF);
  const wallR = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.1), darkMat);
  wallR.position.set(side * 0.045, 0.145, 0.09);
  rocket.add(wallR);
}
// Channel floor — recessed, keeps the trench readable from behind
const channelFloor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.015, 0.42), darkMat);
channelFloor.position.set(0, 0.095, -0.05);
rocket.add(channelFloor);
return rocket;
}

// Weapon 1 — disc launcher (T1/T2 spinfusor DNA, not a copy): the
// silhouette is a FORK — two flat mag rails sandwiching a vertical disc
// you can see seated in the breach, glowing hub at the axle. No barrel
// tube at all; the disc IS the weapon.
function mkDisc(): THREE.Group {
const disc = new THREE.Group();
const discRailGeo = new THREE.BoxGeometry(0.035, 0.16, 0.52);
for (const side of [-1, 1]) {
  const rail = new THREE.Mesh(discRailGeo, bodyMat);
  rail.position.set(side * 0.075, 0, -0.08);
  disc.add(rail);
  // Rail tips narrow toward the muzzle — the prongs the disc spins
  // between, mag-lev style
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.07, 0.14), darkMat);
  tip.position.set(side * 0.075, 0.045, -0.38);
  disc.add(tip);
}
// The chambered disc — edge-on vertical disc filling the fork, slightly
// proud of the rails so the round profile reads at viewmodel distance.
// Amber emissive hub so "loaded" is visible even in shadow.
const discLoadedMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45, emissive: 0x14161a });
const loadedDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.02, 16), discLoadedMat);
loadedDisc.rotation.z = Math.PI / 2; // axis across the gun — disc plane faces forward
loadedDisc.position.set(0, 0.01, -0.18);
disc.add(loadedDisc);
const hubMat = new THREE.MeshBasicMaterial({ color: 0xffb038 });
for (const side of [-1, 1]) {
  const hub = new THREE.Mesh(new THREE.CircleGeometry(0.03, 10), hubMat);
  hub.position.set(side * 0.014, 0.01, -0.18);
  hub.rotation.y = side * Math.PI / 2;
  disc.add(hub);
}
// Axle blocks clamping the disc between the rails
for (const side of [-1, 1]) {
  const axle = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.09), darkMat);
  axle.position.set(side * 0.075, 0.01, -0.18);
  disc.add(axle);
}
// Breech block behind the fork — mag feed comes up through it
const discRecv = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.22), bodyMat);
discRecv.position.set(0, -0.01, 0.2);
disc.add(discRecv);
// Spare-disc magazine on top of the breech — a short stack of edges
// visible over the top rail, the ammo read
const magDiscGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.018, 12);
for (let i = 0; i < 3; i++) {
  const mag = new THREE.Mesh(magDiscGeo, darkMat);
  mag.rotation.z = Math.PI / 2;
  mag.position.set(0, 0.1, 0.14 + i * 0.025);
  disc.add(mag);
}
// Grip under the breech
const discGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), darkMat);
discGrip.position.set(0, -0.13, 0.14);
discGrip.rotation.x = 0.35;
disc.add(discGrip);
disc.visible = false;
return disc;
}

// Weapon 2 — chaingun: the ref reads as one long chamfered slab
// swallowing the barrel cluster — barrels peek out the front of a heavy
// shroud, dark recessed channel under the belly. Not three floating
// sticks: the SHROUD is the gun.
function mkChaingun(): { g: THREE.Group; barrels: THREE.Group } {
const chain = new THREE.Group();
const chainBarrels = new THREE.Group();
// The bake pipeline treats "barrels" as a kept-separate node — it's the
// only viewmodel part that animates, so it can't fold into the merged mesh.
chainBarrels.name = 'barrels';
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  // longer, thicker barrels on a wider ring so they still read as a
  // cluster where they exit the shroud
  const barrel = mkTube(0.045, 0.045, 0.5, -0.28, bodyMat);
  barrel.position.x = Math.cos(a) * 0.075;
  barrel.position.y = Math.sin(a) * 0.075;
  chainBarrels.add(barrel);
}
chain.add(chainBarrels);
// Chamfered slab shroud — a flattened octagonal prism gives the cut
// corners the ref shows. Swallows the barrels' rear 2/3; they spin
// inside it and protrude past the front collar.
const chainShroud = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.14, 0.58, 8), bodyMat);
chainShroud.rotation.x = Math.PI / 2;
chainShroud.scale.x = 1.35;   // wide slab, chamfered shoulders
chainShroud.scale.y = 0.85;   // NB: local y = cylinder axis → shortens, not flattens
chainShroud.position.z = -0.02;
chain.add(chainShroud);
// Dark recessed channel under the belly — the ref's lower slot where
// the drive train lives. Two stacked boxes step the underside.
const chainBelly = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.5), darkMat);
chainBelly.position.set(0, -0.105, -0.05);
chain.add(chainBelly);
const chainBelly2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.3), darkMat);
chainBelly2.position.set(0, -0.15, 0.05);
chain.add(chainBelly2);
// Front collar — the bearing plate the barrels exit through. A gatling
// collar SPINS with the cluster, so it lives in chainBarrels. A symmetric
// ring's rotation is invisible though — the bolt studs on its face are
// what sell the spin.
const chainCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.04, 8), darkMat);
chainCollar.rotation.x = Math.PI / 2;
chainCollar.position.z = -0.27;
chainBarrels.add(chainCollar);
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  const stud = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), bodyMat);
  stud.position.set(Math.cos(a) * 0.105, Math.sin(a) * 0.105, -0.28);
  chainBarrels.add(stud);
}
// Bore face behind the collar ring so the muzzle doesn't read hollow
chain.add(mkBore(0.1, -0.25));
// Rear receiver block + top rail to match the family
const chainRecv = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.16, 0.2), darkMat);
chainRecv.position.set(0, 0, 0.32);
chain.add(chainRecv);
const chainRail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.3), darkMat);
chainRail.position.set(0, 0.135, -0.08);
chain.add(chainRail);
// Grip — the shroud's belly means it mounts lower than most guns
const chainGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.07), darkMat);
chainGrip.position.set(0, -0.19, 0.18);
chainGrip.rotation.x = 0.3;
chain.add(chainGrip);
chain.visible = false;
return { g: chain, barrels: chainBarrels };
}

// Weapon 3 — mortar: an artillery piece, not a pipe. The reads: FAT
// bore tube, base plate under the breech, bipod struts on the fore-end,
// a shell hopper on the flank with finned bomb tips peeking out.
function mkMortar(): THREE.Group {
const mortar = new THREE.Group();
mortar.add(mkTube(0.19, 0.16, 0.42, -0.02, darkMat)); // main bore tube
mortar.add(mkTube(0.22, 0.20, 0.1, -0.22, bodyMat)); // flared muzzle
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
const finMat = new THREE.MeshLambertMaterial({ color: 0x5a4a28, emissive: 0x181205 });
for (let i = 0; i < 3; i++) {
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

// Weapon 4 — grenade launcher: MGL-style revolver — fat drum slung
// under the barrel ahead of the receiver block, skeletal stock.
function mkGrenadeLauncher(): THREE.Group {
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
// Six chamber bores ringed around the drum face — the revolver read.
// Solid drum looked like a wheel; dark mouths with brass rims sell
// "six 40mm chambers" at viewmodel distance.
const chamberRimMat = new THREE.MeshLambertMaterial({ color: 0x8a7a4a, emissive: 0x1a1408 });
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  const cy = -0.09 + Math.sin(a) * 0.105;
  const cz = -0.08 + Math.cos(a) * 0.105;
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.032, 10), boreMat);
  mouth.position.set(0.086, cy, cz);
  mouth.rotation.y = Math.PI / 2;
  gl.add(mouth);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 10), chamberRimMat);
  rim.position.set(0.085, cy, cz);
  rim.rotation.y = Math.PI / 2;
  gl.add(rim);
}
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
return gl;
}

// Sticky launcher: T2's bomb mortar — a fat launch tube feeding from a
// horizontal bomb drum under the breech, latching spike at the muzzle.
// The "sticky" read is a row of live ordnance in the drum window, not a
// bubble on top — the old glowing pink ball looked like a toy hopper.
function mkSticky(): THREE.Group {
const sticky = new THREE.Group();
sticky.add(mkTube(0.125, 0.135, 0.34, -0.14, bodyMat)); // launch tube — longer, heavier
sticky.add(mkTube(0.15, 0.145, 0.07, -0.34, darkMat)); // muzzle collar
sticky.add(mkBore(0.105, -0.376));
// Latching spike protruding past the bore — the glue tip the bombs get
// skewered on. THE silhouette detail that separates it from a GL clone.
const spike = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.1, 6), darkMat);
spike.rotation.x = -Math.PI / 2;
spike.position.set(0, 0.1, -0.4);
sticky.add(spike);
const spikeBase = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.06), darkMat);
spikeBase.position.set(0, 0.1, -0.35);
sticky.add(spikeBase);
// Bomb drum under the barrel — axis across the gun, half-buried in the
// receiver like the GL drum but set LOW so it reads slung, not fat.
const stickyDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 10), darkMat);
stickyDrum.rotation.z = Math.PI / 2;
stickyDrum.position.set(0, -0.11, -0.06);
sticky.add(stickyDrum);
// Chambered bombs peeking through the drum's front face — five dark
// shells ringed around the hub, each with a fuse nub. Visible ordnance =
// the "sticky bombs loaded" read at viewmodel distance.
const bombMat = new THREE.MeshLambertMaterial({ color: 0x1e2226, emissive: 0x0a0c0e });
const fuseMat = new THREE.MeshBasicMaterial({ color: 0xffaa22 }); // amber fuse glow — hazard, not candy
for (let i = 0; i < 5; i++) {
  const a = (i / 5) * Math.PI * 2;
  const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 6), bombMat);
  bomb.position.set(0.081, -0.11 + Math.sin(a) * 0.075, -0.06 + Math.cos(a) * 0.075);
  sticky.add(bomb);
  const fuse = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.03), fuseMat);
  fuse.position.copy(bomb.position);
  fuse.position.x += 0.038;
  sticky.add(fuse);
}
// Drum hub pin
const stickyHub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.19, 8), bodyMat);
stickyHub.rotation.z = Math.PI / 2;
stickyHub.position.copy(stickyDrum.position);
sticky.add(stickyHub);
// Receiver — taller slab behind the drum, carries the launcher's bulk
const stickyRecv = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.2), bodyMat);
stickyRecv.position.set(0, -0.01, 0.14);
sticky.add(stickyRecv);
// Warning stripe across the receiver flank — ordnance hardware marking,
// not decoration. Same trick as the shotgun's red shells.
const warnMat = new THREE.MeshLambertMaterial({ color: 0xcc8818, emissive: 0x301f04 });
const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.152, 0.03, 0.14), warnMat);
stripe.position.set(0, 0.03, 0.14);
sticky.add(stripe);
// Rear stock plate + grip — matches the GL's stance so the family reads
const stickyStock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.16), darkMat);
stickyStock.position.set(0, -0.04, 0.3);
sticky.add(stickyStock);
const stickyGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.06), darkMat);
stickyGrip.position.set(0, -0.14, 0.06);
stickyGrip.rotation.x = 0.3;
sticky.add(stickyGrip);
sticky.visible = false;
return sticky;
}

// Weapon 5 — flak cannon: UT's chunky front-loader. Wide ribbed barrel
// with a DEEP flared bore, breech box with the top grill, and the tell
// UT players know: a break-open loading slot with shells in a clip.
function mkFlak(): THREE.Group {
const flak = new THREE.Group();
flak.add(mkTube(0.17, 0.15, 0.3, -0.08, bodyMat));
// Ribbed barrel — two pinch ribs along the tube, not just the ring
for (let i = 0; i < 2; i++) {
  flak.add(mkTube(0.175, 0.175, 0.025, -0.14 + i * 0.09, darkMat));
}
flak.add(mkTube(0.19, 0.19, 0.06, -0.24, darkMat)); // muzzle ring
// Deep flared bore — flak throws a shell, not a slug: the muzzle is a
// bell with a visible dark throat, wider than the old flat disc read
flak.add(mkBore(0.155, -0.271));
const flakThroat = mkTube(0.155, 0.12, 0.05, -0.24, boreMat);
flak.add(flakThroat);
const flakBox = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.3), darkMat);
flakBox.position.set(0, 0, 0.16);
flak.add(flakBox);
// Top vents — the UT flak "grill"
for (let i = 0; i < 3; i++) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), bodyMat);
  vent.position.set(0, 0.11, 0.08 + i * 0.08);
  flak.add(vent);
}
// Loading slot on the right flank — the break-open port
const loadSlot = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.09, 0.16), boreMat);
loadSlot.position.set(0.105, 0.02, 0.14);
flak.add(loadSlot);
// Shell clip beside the port — three stubby brass rounds nose-up
const flakShellMat = new THREE.MeshLambertMaterial({ color: 0xa86a20, emissive: 0x241503 });
for (let i = 0; i < 3; i++) {
  const round = mkTube(0.028, 0.028, 0.05, 0, flakShellMat);
  round.rotation.z = 0; // axis already across? keep vertical stack look
  round.position.set(0.115, -0.03, 0.08 + i * 0.06);
  flak.add(round);
}
// Grip
const flakGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), darkMat);
flakGrip.position.set(0, -0.15, 0.18);
flakGrip.rotation.x = 0.3;
flak.add(flakGrip);
flak.visible = false;
return flak;
}

// Weapon 6 — plasma cannon: a fat energy projector, not a tube — heavy
// finned emitter head up front, glowing core slats behind it, capacitor
// bottle under the receiver. T2's plasma gun reads BULKY — the emitter
// dish is the widest thing on the model.
function mkPlasmaCannon(): THREE.Group {
const plasma = new THREE.Group();
// Main body — shorter and much fatter than the old slim tube
plasma.add(mkTube(0.115, 0.13, 0.3, 0.0, bodyMat));
// Flared emitter head — a wide shallow dish the bolt charges inside.
// Two nested cones: outer bell + inner throat.
const plasmaBell = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.115, 0.1, 10), darkMat);
plasmaBell.rotation.x = Math.PI / 2;
plasmaBell.position.z = -0.2;
plasma.add(plasmaBell);
const plasmaThroat = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.08, 10), darkMat);
plasmaThroat.rotation.x = Math.PI / 2;
plasmaThroat.position.z = -0.29;
plasma.add(plasmaThroat);
plasma.add(mkBore(0.085, -0.331));
// Emitter core — big green iris recessed in the throat, wider than the
// old ring so the muzzle reads HOT at viewmodel distance
const plasmaGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.078, 0.078, 0.02, 14),
  new THREE.MeshBasicMaterial({ color: 0x33ffaa })
);
plasmaGlow.rotation.x = Math.PI / 2;
plasmaGlow.position.z = -0.332;
plasma.add(plasmaGlow);
// Cooling fins — four flat blades radiating off the emitter head, the
// silhouette detail that separates "energy projector" from "tube"
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.14), darkMat);
  fin.position.set(Math.cos(a) * 0.115, Math.sin(a) * 0.115, -0.15);
  fin.rotation.z = a;
  plasma.add(fin);
}
// Core slats — green glow strips along the body so the energy read
// isn't only at the muzzle
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  const slat = new THREE.Mesh(
    new THREE.BoxGeometry(0.015, 0.015, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x22cc88 })
  );
  slat.position.set(Math.cos(a) * 0.125, Math.sin(a) * 0.125, 0.0);
  plasma.add(slat);
}
// Capacitor bottle under the receiver — a fat cell slung low, same
// trick as the GL drum / sticky magazine: ammo you can see
const plasmaCell = mkTube(0.07, 0.07, 0.22, 0.05, darkMat);
plasmaCell.position.y = -0.13;
plasma.add(plasmaCell);
const plasmaCellGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.045, 0.045, 0.015, 10),
  new THREE.MeshBasicMaterial({ color: 0x33ffaa })
);
plasmaCellGlow.rotation.x = Math.PI / 2;
plasmaCellGlow.position.set(0, -0.13, -0.07);
plasma.add(plasmaCellGlow);
// Receiver block + top rail to sit in the family
const plasmaRecv = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.16), bodyMat);
plasmaRecv.position.set(0, -0.01, 0.22);
plasma.add(plasmaRecv);
const plasmaRail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.26), darkMat);
plasmaRail.position.set(0, 0.135, 0.02);
plasma.add(plasmaRail);
const plasmaGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), darkMat);
plasmaGrip.position.set(0, -0.15, 0.14);
plasmaGrip.rotation.x = 0.3;
plasma.add(plasmaGrip);
plasma.visible = false;
return plasma;
}

// Weapon — plasma gun (Quake-style rapid bolts): shorter and squatter
// than the cannon — three prongs around a hot blue emitter, reads as a
// repeater, not a launcher.
function mkPlasmaGun(): THREE.Group {
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

// Weapon 7 — railgun: Q3's fat coil-cannon. Thick central bore, a stack
// of fat accelerator coils ribbing the barrel, glowing muzzle ring.
// The silhouette reads "industrial capacitor bank", not sniper rifle.
function mkRailgun(): THREE.Group {
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
return rail;
}

// Weapon 8 — lightning gun: Q3's tesla prod. Chunky insulated body, two
// prongs converging on a glowing emitter ball — the arc jumps between
// them, not out of a bore. Reads instantly different from the cannons.
function mkLightningGun(): THREE.Group {
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
return lg;
}

// Weapon 9 — shotgun: heavy pumpgun. Fat bore over a full-length shell
// tube, chunky receiver, big ribbed pump — reads "combat shotgun" the
// instant you see the paired under-barrel stack.
function mkShotgun(): THREE.Group {
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
// (shellMat/brassMat hoisted to module scope — the RPG warhead shares them.)
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
return sg;
}

// Weapon 10 — cannon: Serious Sam naval gun rebuilt per JP's Blender
// ref — stacked bulged barrel sections separated by pinch rings, huge
// bore, rounded breech ball.
function mkCannon(): THREE.Group {
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
return cn;
}

// Weapon 11 — rocket launcher: classic RPG profile. Long launch tube,
// flared muzzle bell, conical warhead tip protruding past the tube
// (loaded look = the RPG read), stubby exhaust cone at the rear.
function mkRpg(): THREE.Group {
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
return rpg;
}

// Sidearms — compact silhouettes so the hold-out swap reads instantly.
// Pistol: slide + stubby barrel + raked grip.
function mkPistol(): THREE.Group {
const pistol = new THREE.Group();
pistol.add(mkTube(0.03, 0.03, 0.16, -0.08, darkMat)); // barrel
const slide = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.24), bodyMat);
slide.position.set(0, 0.02, -0.05);
pistol.add(slide);
// Frame under the slide — the slide alone floats; a lower rail ties it
// to the grip like a real autopistol
const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.18), darkMat);
pFrame.position.set(0, -0.035, -0.04);
pistol.add(pFrame);
// Slide serrations at the rear — the ribbing that says "this part moves"
for (let i = 0; i < 4; i++) {
  const serr = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.05, 0.012), darkMat);
  serr.position.set(0, 0.02, 0.02 + i * 0.022);
  pistol.add(serr);
}
// Ejection port notch on the slide's right side
const pPort = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.025, 0.07), darkMat);
pPort.position.set(0.032, 0.05, -0.04);
pistol.add(pPort);
// Trigger guard — a thin U under the frame
const pGuard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.07), darkMat);
pGuard.position.set(0, -0.075, -0.02);
pistol.add(pGuard);
const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.08), darkMat);
pGrip.position.set(0, -0.09, 0.06);
pGrip.rotation.x = 0.35;
pistol.add(pGrip);
const pSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), darkMat);
pSight.position.set(0, 0.07, -0.15);
pistol.add(pSight);
// Rear sight notch so the sight line reads front-to-back
const pRear = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.02), darkMat);
pRear.position.set(0, 0.065, 0.06);
pistol.add(pRear);
pistol.visible = false;
return pistol;
}

// Revolver: long barrel + big cylinder + hammer — the hand-cannon profile.
function mkRevolver(): THREE.Group {
const revolver = new THREE.Group();
revolver.add(mkTube(0.032, 0.032, 0.24, -0.14, darkMat)); // long barrel
// Underlug — the rib under the barrel that makes it read heavy-frame,
// not derringer
const underlug = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.22), darkMat);
underlug.position.set(0, -0.045, -0.12);
revolver.add(underlug);
const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.08, 8), bodyMat);
cyl.rotation.z = Math.PI / 2;
cyl.position.set(0, 0, 0.02);
revolver.add(cyl);
// Fluted cylinder — grooves along each chamber so the drum reads as
// chambers, not a washer
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  const flute = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.012, 0.018), darkMat);
  flute.position.set(0, Math.sin(a) * 0.055, 0.02 + Math.cos(a) * 0.055);
  revolver.add(flute);
}
const frame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.15), bodyMat);
frame.position.set(0, 0.045, -0.06);
revolver.add(frame);
// Topstrap over the cylinder — closes the frame silhouette
const topstrap = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.12), bodyMat);
topstrap.position.set(0, 0.05, 0.02);
revolver.add(topstrap);
const rGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08), darkMat);
rGrip.position.set(0, -0.09, 0.09);
rGrip.rotation.x = 0.45;
revolver.add(rGrip);
const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.025), darkMat);
hammer.position.set(0, 0.05, 0.1);
revolver.add(hammer);
// Front sight blade at the muzzle
const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.015), darkMat);
rSight.position.set(0, 0.055, -0.24);
revolver.add(rSight);
revolver.visible = false;
return revolver;
}

// Map is keyed by WeaponType, never positionally — Grenade/Slam/Melee
// have no gun model (belt throw / fist), so they map to nothing.
const MODEL_BUILDERS: [number, () => THREE.Group][] = [
  [WeaponType.Rocket, mkRocket],
  [WeaponType.Disc, mkDisc],
  [WeaponType.GrenadeLauncher, mkGrenadeLauncher],
  [WeaponType.Flak, mkFlak],
  [WeaponType.Mortar, mkMortar],
  [WeaponType.PlasmaCannon, mkPlasmaCannon],
  [WeaponType.PlasmaGun, mkPlasmaGun],
  [WeaponType.Sprinkler, mkPlasmaGun], // same receiver, different bolt payload
  [WeaponType.Railgun, mkRailgun],
  [WeaponType.Lightning, mkLightningGun],
  [WeaponType.Shotgun, mkShotgun],
  [WeaponType.Cannon, mkCannon],
  [WeaponType.RocketLauncher, mkRpg],
  [WeaponType.Pistol, mkPistol],
  [WeaponType.Revolver, mkRevolver],
  [WeaponType.Sticky, mkSticky],
];

export function buildWeaponMeshes(parent: THREE.Group, muzzleZ: Record<number, number>): WeaponMeshes {
  const weapons = new Map<number, THREE.Group>();
  const muzzleNodes = new Map<number, THREE.Object3D>();
  // Chaingun needs its barrels group back; DiscPull reuses the Disc group —
  // neither can live in the plain builder table.
  const chain = mkChaingun();
  const models: [number, THREE.Group][] = MODEL_BUILDERS.map(([wt, mk]) => [wt, mk()]);
  models.push([WeaponType.Chaingun, chain.g]);
  for (const [wt, g] of models) {
    weapons.set(wt, g);
    parent.add(g);
    const mz = new THREE.Object3D();
    mz.position.z = muzzleZ[wt] ?? -0.35;
    g.add(mz);
    muzzleNodes.set(wt, mz);
  }
  weapons.set(WeaponType.DiscPull, weapons.get(WeaponType.Disc)!);
  const pullMz = new THREE.Object3D();
  pullMz.position.z = muzzleZ[WeaponType.DiscPull] ?? -0.35;
  weapons.get(WeaponType.Disc)!.add(pullMz);
  muzzleNodes.set(WeaponType.DiscPull, pullMz);
  return { weapons, muzzleNodes, chainBarrels: chain.barrels };
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
