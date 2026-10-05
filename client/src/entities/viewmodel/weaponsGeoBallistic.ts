import * as THREE from 'three';
import { bodyMat, darkMat, boreMat, shellMat, brassMat, mkTube, mkBore, mkLoft, mkAnnulus, profCircle, profOct, rotRing, tubePath } from './weaponKit.js';

// Ballistic weapon geometry — the launchers and throwers built from
// primitives (rocket, disc, chaingun, mortar, GL, sticky, flak, shotgun,
// cannon, RPG). Energy and sidearm builders have their own files; this
// is the powder-actuated family. Every builder returns a Group whose
// children are positioned in viewmodel space; a child named 'barrels'
// is the chaingun spin group.

// Weapon 0 — bolt launcher, T:A-style military crossbow: a skeletal
// receiver split top/bottom like the disc's slit trick, the chambered
// bolt glowing inside the channel. Twin mechanical arms sweep forward
// off a hex hub, cam wheels at the tips, string drawn back to the bolt
// tail. Under-slung bolt drum feeds the channel — the "auto" read.
export function mkBolt(): THREE.Group {
const bow = new THREE.Group();
// Lower receiver — tapered skeletal body, fat at the breech, narrow at
// the arm hub. The slit trick: this carries the channel's FLOOR while
// the top rail floats above, bolt living in the gap.
bow.add(mkLoft([
  { z: 0.26, ring: profOct(0.17, 0.15, 0.02) },
  { z: 0.10, ring: profOct(0.16, 0.13, 0.02) },
  { z: -0.06, ring: profOct(0.12, 0.10, 0.02) },
], bodyMat));
// Channel floor — the bolt's runway, recessed so the glowing bolt in
// the slit shadows its sides correctly under the AO bake.
const chanFloor = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.44), darkMat);
chanFloor.position.set(0, 0.02, -0.06);
bow.add(chanFloor);
// Top rail — floats over the channel on two cheek pylons; the gap
// between rail and floor IS the slit the bolt shows through.
bow.add(mkLoft([
  { z: 0.18, ring: profOct(0.10, 0.05, 0.012), dy: 0.095 },
  { z: -0.14, ring: profOct(0.08, 0.045, 0.012), dy: 0.095 },
], bodyMat));
for (const side of [-1, 1]) {
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.06), darkMat);
  cheek.position.set(side * 0.05, 0.07, -0.24);
  bow.add(cheek);
}
// Scope block on the rail tail — T:A's stubby electronic sight
const scope = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.12), darkMat);
scope.position.set(0, 0.14, 0.08);
bow.add(scope);
const scopeLens = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 10),
  new THREE.MeshBasicMaterial({ color: 0x66d9ff }));
scopeLens.rotation.x = Math.PI / 2;
scopeLens.position.set(0, 0.14, 0.018);
bow.add(scopeLens);
// Hex arm hub — the boss the limbs rotate on, split across the nose.
// ARM_Z pushes the whole bow ahead of the rail nose: at ~100° cant the
// crossbar sits level with the eye plane and vanishes edge-on; forward
// placement gives it silhouette separation from the receiver.
const ARM_Z = -0.24;
// Rail continuing the receiver out to the hub — the arms were pushed
// forward for first-person readability, leaving the boss to hover.
const neckRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.3), bodyMat);
neckRail.position.set(0, 0.01, -0.1);
bow.add(neckRail);
const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.15, 6), darkMat);
hub.rotation.z = Math.PI / 2;
hub.position.set(0, 0, ARM_Z);
bow.add(hub);
// Bow arms — one group per side, pivoted at the hub so firing can flex
// them. A crossbow reads T, not Y: ~100° cant puts the limb tips level
// with the breech (slightly back-swept like the T:A prod). Cam wheel
// at the tip carries the string.
const ARM_SWEEP = 1.9, ARM_LEN = 0.45;
for (const side of [-1, 1]) {
  const arm = new THREE.Group();
  arm.name = side < 0 ? 'armL' : 'armR';
  // Sweep sign: -side angles the -z limb AWAY from the body axis
  // (rotation.y maps -z -> (-sin,-cos)); +side pointed each arm
  // inward across the receiver while the string legs were computed
  // for outward-swept tips — the limbs crossed the gun's own body.
  arm.userData.baseRot = -side * ARM_SWEEP;
  arm.rotation.y = -side * ARM_SWEEP;
  arm.position.set(side * 0.07, 0, ARM_Z);
  // Limb — leaf-spring plates, not bars: thin vertically, wide
  // laterally, bowed TOWARD the bolt path mid-span (recurve bows the
  // belly forward, not the spine). Tip knob carries the cam wheel.
  const limb = mkLoft([
    { z: 0.0, ring: profOct(0.075, 0.018, 0.008) },
    { z: -0.20, ring: profOct(0.060, 0.014, 0.006), dx: -side * 0.03 },
    { z: -0.38, ring: profOct(0.048, 0.013, 0.006) },
    { z: -ARM_LEN, ring: profOct(0.055, 0.024, 0.008) },
  ], bodyMat);
  arm.add(limb);
  // Tension cable riding the limb's OUTER face, hub → cam — a guard
  // rail with a mid joint at the limb's recurve kink (z=-0.20 bows
  // -side*0.03), not a straight bar floating off the bent plate.
  arm.add(tubePath([
    [0, 0.02, 0, 0.008],
    [-side * 0.03, 0.02, -0.20, 0.008],
    [0, 0.02, -ARM_LEN - 0.02, 0.008],
  ], 0.008, darkMat, 4));
  // Cam wheel at the tip — the compound-bow read, oversized like T:A's.
  // Flat (horizontal) wheels: the string wraps their edge in-plane.
  const cam = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.032, 10), darkMat);
  cam.position.set(0, 0, -ARM_LEN - 0.02);
  arm.add(cam);
  const camRing = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.01, 6, 12), brassMat);
  camRing.rotation.x = Math.PI / 2;
  camRing.position.set(0, 0, -ARM_LEN - 0.02);
  arm.add(camRing);
  const camHub = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.045, 8), brassMat);
  camHub.position.set(0, 0, -ARM_LEN - 0.02);
  arm.add(camHub);
  // Cable anchor bolt on the cam's outer face — the guard rail must
  // read as fastened to the wheel it tensions, not a floating line.
  const anchorNut = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.025, 6), brassMat);
  anchorNut.position.set(0, 0.028, -ARM_LEN - 0.02);
  arm.add(anchorNut);
  bow.add(arm);
}
// String — DYNAMIC legs, not a baked tubePath: the arms rotate on fire
// so a static string detaches from the cams. Two thin cylinders get
// re-stretched cam→latch every frame by ViewModel.tickBow. The knot at
// the vertex rides bowString's z (drawn-back at rest, snapped to the
// cam line when fired).
const CAM_R = 0.065;
const strutMat = new THREE.MeshBasicMaterial({ color: 0x181a1c });
const stringG = new THREE.Group();
stringG.name = 'bowString';
const knot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), darkMat);
knot.position.set(0, 0.03, 0.16);
stringG.add(knot);
bow.add(stringG);
for (const side of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 5), strutMat);
  leg.name = side < 0 ? 'strLegL' : 'strLegR';
  bow.add(leg);
}
// Geometry constants the tick needs to re-solve the string pose without
// importing the builder module.
bow.userData.bowGeom = {
  armZ: ARM_Z, camDist: ARM_LEN + 0.02, camR: CAM_R,
  latchZ: 0.16, latchY: 0.03, firedZ: 0.16 - 0.27,
};
// Chambered bolt inside the channel — the loaded read. Glowing warhead
// tip (amber like the muzzle flash), thin shaft back to the latch.
// Named group: the fire envelope ejects it forward and re-chambers.
const boltG = new THREE.Group();
boltG.name = 'bowBolt';
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6), darkMat);
shaft.rotation.x = Math.PI / 2;
shaft.position.set(0, 0.035, 0.04);
boltG.add(shaft);
const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 6),
  new THREE.MeshBasicMaterial({ color: 0xffc866 }));
tip.rotation.x = -Math.PI / 2;
tip.position.set(0, 0.035, -0.11);
boltG.add(tip);
// Fletching fins at the tail — thin plates spread radially around the
// shaft axis so the silhouette reads arrowed from the side too.
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.03, 0.05), bodyMat);
  fin.position.set(Math.cos(a) * 0.028, 0.035 + Math.sin(a) * 0.028, 0.16);
  fin.rotation.z = a;
  boltG.add(fin);
}
bow.add(boltG);
// Bolt drum under the receiver — axis across the gun, bolt shafts
// visible ringed on the face like the GL's chambers. 'bowDrum' indexes
// one station per shot.
const drumG = new THREE.Group();
drumG.name = 'bowDrum';
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.11, 8), darkMat);
drum.rotation.z = Math.PI / 2;
drumG.add(drum);
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.018, 6), boreMat);
  mouth.position.set(0.056, Math.sin(a) * 0.058, Math.cos(a) * 0.058);
  mouth.rotation.y = Math.PI / 2;
  drumG.add(mouth);
}
const drumHub = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.13, 8), brassMat);
drumHub.rotation.z = Math.PI / 2;
drumG.add(drumHub);
drumG.position.set(0, -0.1, -0.02);
bow.add(drumG);
// Skeletal stock + grip — the crossbow's gun reads
const stockL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.2), darkMat);
stockL.position.set(0, 0.02, 0.36);
bow.add(stockL);
const stockB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.05), darkMat);
stockB.position.set(0, -0.02, 0.44);
bow.add(stockB);
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, 0.05), darkMat);
grip.position.set(0, -0.14, 0.08);
grip.rotation.x = 0.3;
bow.add(grip);
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.08), darkMat);
guard.position.set(0, -0.11, 0.02);
bow.add(guard);
bow.visible = false;
return bow;
}

// Weapon 1 — disc launcher (T1/T2/Ascend spinfusor DNA, not a copy): a
// Quake-RL hex tube with a horizontal slit cut clean through its front
// half. The flat chambered disc rides in the slit, cyan rim glowing
// through the gap — the slit IS the "fires discs" read.
const DISC_HEX_R = 0.12; // slimmer slab — disc rim (r=0.115) stays proud of the apothem (0.104)
const DISC_SLIT_HALF = 0.019; // hug the 0.028-thick disc — a wide gap reads hollow, not chambered

// Sutherland-Hodgman against one horizontal line: keeps the hexagon's
// part above (side=1) or below (side=-1) the slit edge. This is the
// "negative volume" — the slit is removed from the cross-section before
// extrusion, so its walls are real faceted geometry.
function hexHalf(side: 1 | -1): THREE.Shape {
  const hex: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 6; // flat flanks, ridge top/bottom — the slit cuts the flat sides
    hex.push(new THREE.Vector2(Math.cos(a) * DISC_HEX_R, Math.sin(a) * DISC_HEX_R));
  }
  const inside = (p: THREE.Vector2) => side * p.y >= DISC_SLIT_HALF;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < hex.length; i++) {
    const cur = hex[i]!;
    const nxt = hex[(i + 1) % hex.length]!;
    if (inside(cur)) out.push(cur);
    if (inside(cur) !== inside(nxt)) {
      const t = (side * DISC_SLIT_HALF - cur.y) / (nxt.y - cur.y);
      out.push(new THREE.Vector2(cur.x + (nxt.x - cur.x) * t, side * DISC_SLIT_HALF));
    }
  }
  return new THREE.Shape(out);
}

function extrudeAt(shape: THREE.Shape, zFront: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), mat);
  m.position.z = zFront;
  return m;
}

export function mkDisc(): THREE.Group {
const disc = new THREE.Group();
const zFront = -0.3;
const slitLen = 0.34;
disc.add(extrudeAt(hexHalf(1), zFront, slitLen, bodyMat));
disc.add(extrudeAt(hexHalf(-1), zFront, slitLen, bodyMat));
// Solid hex breech behind the slit — same profile, no cut
const fullHex = new THREE.Shape();
for (let k = 0; k <= 6; k++) {
  const a = (k * Math.PI) / 3 + Math.PI / 6;
  const x = Math.cos(a) * DISC_HEX_R, y = Math.sin(a) * DISC_HEX_R;
  if (k === 0) fullHex.moveTo(x, y); else fullHex.lineTo(x, y);
}
// Breech overlaps the slit section AND steps IN — the valley where the
// proud slit-section overhangs lands on the breech's verts, so AO grime
// shadows the back, not the front half. (A same-size overlap is coplanar
// side walls = z-fight; a flush start is coplanar caps = z-fight.)
const breech = extrudeAt(fullHex, zFront + slitLen - 0.006, 0.186, bodyMat);
breech.scale.set(0.97, 0.97, 1);
disc.add(breech);
// Groove ring where the slit ends — recessed, so it reads as a machined
// channel and the AO valley-darkening lands INSIDE it (where it belongs)
// instead of dirtying either neighbor's face.
// (add() returns the GROUP, not the mesh — scale must be set on the
// extrude itself or the whole weapon gets scaled and nothing changes.)
const collar = extrudeAt(fullHex, zFront + slitLen - 0.012, 0.024, darkMat);
collar.scale.set(0.94, 0.94, 1);
disc.add(collar);
// Chambered disc lying flat in the slit — the spinfusor's whole read.
// Dark body, hot rim: T2's loaded disc glows at the EDGE, not the face.
// Both ride a named group so the fire envelope can slide the NEXT disc
// out of the breech into the slit (the "it really fires discs" sell).
const ammo = new THREE.Group();
ammo.name = 'discAmmo';
const loadedMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45, emissive: 0x14161a });
const loaded = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.028, 24), loadedMat);
loaded.position.set(0, 0, -0.15);
ammo.add(loaded);
const rim = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.011, 6, 32),
  new THREE.MeshBasicMaterial({ color: 0x77e8ff }));
rim.rotation.x = Math.PI / 2;
rim.position.set(0, 0, -0.15);
ammo.add(rim);
disc.add(ammo);
// Spindle cap through the disc's core — the "held in a launcher" tell
const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.07, 8), darkMat);
spindle.position.set(0, 0, -0.15);
disc.add(spindle);
// Forend under the slit section + raked grip under the breech
const forend = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.24), darkMat);
forend.position.set(0, -0.13, -0.13);
disc.add(forend);
const discGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), darkMat);
discGrip.position.set(0, -0.18, 0.16);
discGrip.rotation.x = 0.35;
disc.add(discGrip);
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.1), darkMat);
guard.position.set(0, -0.15, 0.09);
disc.add(guard);
disc.visible = false;
return disc;
}

// Weapon 2 — chaingun, UT/Serious Sam language: the barrels ARE the
// gun. Three fat pipes spinning on an exposed cluster, short stubby
// breech behind, ammo drum slung low. No shroud — a full casing hid
// the cluster and read as a rocket tube.
export function mkChaingun(): { g: THREE.Group; barrels: THREE.Group } {
const chain = new THREE.Group();
const chainBarrels = new THREE.Group();
// The bake pipeline treats "barrels" as a kept-separate node — it's the
// only viewmodel part that animates, so it can't fold into the merged mesh.
chainBarrels.name = 'barrels';
const CHAIN_BARRELS = 3;
const CLUSTER_R = 0.088;
for (let i = 0; i < CHAIN_BARRELS; i++) {
  const a = (i / CHAIN_BARRELS) * Math.PI * 2;
  const dx = Math.cos(a) * CLUSTER_R, dy = Math.sin(a) * CLUSTER_R;
  // FAT barrels — the cluster fills the FPS view; chunky 8-seg with a
  // slight swell at the breech root, tapering to the muzzle.
  const barrel = mkLoft([
    { z: -0.12, ring: rotRing(profCircle(0.072, 8), a), dx, dy },
    { z: -0.30, ring: rotRing(profCircle(0.066, 8), a), dx, dy },
    { z: -0.78, ring: rotRing(profCircle(0.06, 8), a), dx, dy },
  ], bodyMat, false); // open ends — throat + breech collar cap both
  // Per-barrel fire recoil — kick() knocks the TOP barrel back a beat.
  // baseZ restores it; `barrel` tag skips the collar/studs sharing the group.
  barrel.userData.barrel = true;
  barrel.userData.baseZ = barrel.position.z;
  chainBarrels.add(barrel);
  // Brass muzzle collar + recessed bore — the UT fat-pipe read.
  const throat = mkAnnulus(rotRing(profCircle(0.068, 8), a), rotRing(profCircle(0.038, 8), a), -0.78, -0.81, brassMat);
  throat.position.set(dx, dy, 0);
  chainBarrels.add(throat);
  const plug = mkBore(0.038, -0.805);
  plug.rotation.y = Math.PI;
  plug.position.x = dx; plug.position.y = dy;
  chainBarrels.add(plug);
}
chain.add(chainBarrels);
// Breech bearing — the big collar the cluster seats into, VISIBLE and
// spinning with the barrels. The machine tell.
const chainCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.175, 0.09, 12), darkMat);
chainCollar.rotation.x = Math.PI / 2;
chainCollar.position.z = -0.11;
chainBarrels.add(chainCollar);
for (let i = 0; i < CHAIN_BARRELS * 2; i++) {
  const a = (i / (CHAIN_BARRELS * 2)) * Math.PI * 2;
  const stud = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), bodyMat);
  stud.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, -0.14);
  chainBarrels.add(stud);
}
// Brass center axle — the rotor shaft; spins WITH the cluster (it's
// in chainBarrels), visible between the barrels through the gaps.
chainBarrels.add(mkTube(0.07, 0.07, 0.55, -0.4, brassMat));
// Dark mouth behind the cluster between the barrels.
chain.add(mkBore(CLUSTER_R + 0.075, -0.155));
// No muzzle clamp — a ring mid-run read as clutter against the three
// fat pipes; the barrels and their brass throats carry the spin alone.
// Breech housing — SHORT stubby body, the body exists to feed the
// cluster, not to be a rifle. Round loft so the tail reads as a turned
// receiver, not a box.
chain.add(mkLoft([
  { z: 0.15, ring: profCircle(0.11, 12) },
  { z: 0.05, ring: profCircle(0.14, 12) },
  { z: -0.09, ring: profCircle(0.145, 12) },
], bodyMat));
// Flank vents removed — floater boxes outside the tapered body, and
// behind the breech where FPS never sees them anyway.
// No rail — pure tail clutter, invisible in FPS anyway.
// Pull the whole gun back toward the shoulder — the breech sits close
// to the eye and reads huge next to the barrels; letting the rear slip
// out of frame leaves the cluster owning the view.
chain.position.z = 0.15;
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
// Receiver — hexagonal drum instead of a raw cube; reads machined.
const flakBox = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.3, 6), darkMat);
flakBox.rotation.x = Math.PI / 2;
flakBox.position.set(0, 0, 0.16);
flak.add(flakBox);
// Top vents — the UT flak "grill". Hex rods across the drum top match
// the new hexagonal receiver better than raw slabs.
for (let i = 0; i < 3; i++) {
  const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 6), bodyMat);
  vent.rotation.z = Math.PI / 2;
  vent.position.set(0, 0.1, 0.11 + i * 0.08);
  flak.add(vent);
}


// Grip
const flakGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.12, 6), darkMat);
flakGrip.position.set(0, -0.15, 0.18);
flakGrip.rotation.x = 0.3;
flak.add(flakGrip);
// Grip pommel — the extrude-and-scale trick: a short butt section
// slightly narrower, gives the handle a shaped heel instead of a
// cylinder ending on a flat cut. Child of the grip so it inherits the
// rake — offset is just down the grip's local axis.
const flakButt = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.026, 0.035, 6), darkMat);
flakButt.position.y = -0.0775; // half grip len + half butt len
flakGrip.add(flakButt);
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
// Bombard silhouette: gently TAPERING barrel (fat at the breech, slim
// at the muzzle) with thin reinforcing hoops only ~15% proud of the
// tube. The old version swelled each band to ~1.6x the tube radius —
// stacked donuts instead of one machined barrel.
// Crowned hoop — /\ profile instead of a flat band; sits only ~7mm
// proud of the tube so it reads as a shrunk-on ring, not a collar.
const cnHoop = (r: number) => {
  cnSeg(r, r + 0.006, 0.012, darkMat);
  cnSeg(r + 0.006, r, 0.012, darkMat);
};
cnSeg(0.125, 0.13, 0.03, bodyMat);  // breech cap
cnSeg(0.13, 0.12, 0.12, bodyMat);   // tube taper 1
cnHoop(0.127);                      // hoop 1
cnSeg(0.12, 0.11, 0.12, bodyMat);   // tube taper 2
cnHoop(0.117);                      // hoop 2
cnSeg(0.11, 0.10, 0.10, bodyMat);   // chase — slimmest stretch
cnHoop(0.107);                      // hoop 3
cnSeg(0.10, 0.125, 0.035, bodyMat); // muzzle flare (trumpet lip)
cnHoop(0.128);                      // muzzle ring
// cz ends ≈ -0.46; muzzle ring's own capped face serves as the dark bore.
// Cascabel — the breech knob, proper: a slim neck off the cap widening
// into a small ball half the barrel's radius. Centered on axis (the old
// one hung 0.02 low and read as a random sphere stuck to the back).
const cnNeck = mkTube(0.05, 0.035, 0.035, 0.017, bodyMat); // flares into the ball (+Z end is r1)
cn.add(cnNeck);
const cnBall = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), bodyMat);
cnBall.position.set(0, 0, 0.05);
cn.add(cnBall);
// A cannon reads by mass — scale up and pull the whole group back so
// the fat breech sits closer instead of poking a long thin tube forward.
cn.scale.setScalar(1.2);
cn.position.z += 0.08;
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
