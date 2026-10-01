import * as THREE from 'three';
import { bodyMat, darkMat, boreMat, shellMat, brassMat, mkTube, mkBore } from './weaponKit.js';

// Ballistic weapon geometry — the launchers and throwers built from
// primitives (rocket, disc, chaingun, mortar, GL, sticky, flak, shotgun,
// cannon, RPG). Energy and sidearm builders have their own files; this
// is the powder-actuated family. Every builder returns a Group whose
// children are positioned in viewmodel space; a child named 'barrels'
// is the chaingun spin group.

// Weapon 0 — bolt/rocket launcher: chunky faceted slab-sided body like
// JP's Unity ref — straight octagonal block, stepped muzzle shroud, top
// rail split by a notch, boxy rear receiver. Not tapered; the wedge in
// the ref is perspective.
export function mkBolt(): THREE.Group {
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
export function mkDisc(): THREE.Group {
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
export function mkChaingun(): { g: THREE.Group; barrels: THREE.Group } {
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
export function mkMortar(): THREE.Group {
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
export function mkGrenadeLauncher(): THREE.Group {
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
export function mkSticky(): THREE.Group {
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
export function mkFlak(): THREE.Group {
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

// Weapon 9 — shotgun: heavy pumpgun. Fat bore over a full-length shell
// tube, chunky receiver, big ribbed pump — reads "combat shotgun" the
// instant you see the paired under-barrel stack.
export function mkShotgun(): THREE.Group {
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
export function mkCannon(): THREE.Group {
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
export function mkRpg(): THREE.Group {
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

// Weapon 28 — MRV launcher: the mortar's counterpart, so it should read
// "many shells" not "one bore". A fat ROTARY DRUM (revolver cylinder —
// the volley tell) with GLOWING shell noses in the chamber windows,
// perforated barrel shroud, slotted muzzle brake, skeletal stock.
// Shoulder-fired crew ordnance — beefier than the GL, meaner than the
// mortar since it never asks you to work for the punch.
export function mkMrv(): THREE.Group {
const mrv = new THREE.Group();
// Barrel core — short, fat; the shroud does the visual work
mrv.add(mkTube(0.115, 0.105, 0.36, -0.2, bodyMat));
mrv.add(mkBore(0.095, -0.386));
// Perforated shroud — three ring bands over a vented body: the "swiss
// cheese" launcher read JP keeps coming back to
for (const z of [-0.34, -0.22, -0.1]) {
  mrv.add(mkTube(0.148, 0.148, 0.045, z, darkMat));
}
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.3), darkMat);
  rib.position.set(Math.cos(a) * 0.135, Math.sin(a) * 0.135, -0.22);
  rib.rotation.z = a + Math.PI / 2;
  mrv.add(rib);
}
// Slotted muzzle brake — three fat ports per side, directional vents
const brake = mkTube(0.155, 0.14, 0.09, -0.4, darkMat);
mrv.add(brake);
for (const side of [-1, 1]) {
  for (let i = 0; i < 3; i++) {
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.02), boreMat);
    port.position.set(side * 0.13, 0.01 - i * 0.045, -0.4);
    port.rotation.z = side * 0.3;
    mrv.add(port);
  }
}
// Rotary drum — the cluster-shell magazine IS the silhouette
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.2, 12), darkMat);
drum.rotation.x = Math.PI / 2;
drum.position.set(0, -0.05, 0.08);
mrv.add(drum);
// Drum face rings — machined flange detail front and back
for (const z of [-0.02, 0.18]) {
  const flange = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.015, 8, 16), bodyMat);
  flange.position.set(0, -0.05, z);
  mrv.add(flange);
}
// Chamber windows + glowing shell noses — the volley is visibly LOADED
const shellTipMat = new THREE.MeshLambertMaterial({ color: 0xff5518, emissive: 0x992200 });
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  const cx = Math.cos(a) * 0.1, cy = -0.05 + Math.sin(a) * 0.1;
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.205, 8), boreMat);
  hole.rotation.x = Math.PI / 2;
  hole.position.set(cx, cy, 0.08);
  mrv.add(hole);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), shellTipMat);
  tip.position.set(cx, cy, -0.01);
  mrv.add(tip);
}
// Rear receiver + skeletal stock — twin rails to a slim butt pad
mrv.add(mkTube(0.1, 0.12, 0.16, 0.26, bodyMat));
for (const side of [-1, 1]) {
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.2), darkMat);
  strut.position.set(side * 0.05, -0.03, 0.4);
  mrv.add(strut);
}
const pad = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.03), darkMat);
pad.position.set(0, -0.02, 0.51);
mrv.add(pad);
// Grip + trigger guard
const mrvGrip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.07), darkMat);
mrvGrip.position.set(0, -0.17, 0.24);
mrvGrip.rotation.x = 0.3;
mrv.add(mrvGrip);
const guard = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 10, Math.PI), darkMat);
guard.position.set(0, -0.12, 0.17);
guard.rotation.x = Math.PI / 2;
guard.rotation.z = Math.PI;
mrv.add(guard);

// Drum cannon should read BIG in the hand — it's the heaviest tube in
// the kit; every other launcher is built to ~1x and this reads thin.
mrv.scale.setScalar(1.25);
mrv.visible = false;
return mrv;
}

// Map is keyed by WeaponType, never positionally — Grenade/Slam/Melee
// have no gun model (belt throw / fist), so they map to nothing.
