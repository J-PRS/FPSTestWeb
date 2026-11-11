import * as THREE from 'three';
import { bodyMat, darkMat, boreMat, shellMat, brassMat, mkTube, mkBore, mkLoft, mkAnnulus, mkRod, radialRepeat, profCircle, profOct, rotRing, tubePath } from './weaponKit.js';

// Ballistic weapon geometry - the launchers and throwers built from
// primitives (rocket, disc, chaingun, mortar, GL, sticky, flak, shotgun,
// cannon, RPG). Energy and sidearm builders have their own files; this
// is the powder-actuated family. Every builder returns a Group whose
// children are positioned in viewmodel space; a child named 'barrels'
// is the chaingun spin group.

// Groove liners - unlit body-color-darkened. MeshBasicMaterial keeps
// them OUT of the vertexAO bake (lit materials get raycast AO, and a
// liner deep in a narrow channel bakes to permanent darkness that also
// varies per rebuild via the shared material's wearTex).
const linerMat = new THREE.MeshBasicMaterial({ color: 0x2E_32_36 });

// Weapon 0 - bolt launcher, T:A-style military crossbow: a skeletal
// receiver split top/bottom like the disc's slit trick, the chambered
// bolt glowing inside the channel. Twin mechanical arms sweep forward
// off a hex hub, cam wheels at the tips, string drawn back to the bolt
// tail. Under-slung bolt drum feeds the channel - the "auto" read.
export function mkBolt(): THREE.Group {
const bow = new THREE.Group();
// Lower receiver - tapered skeletal body, fat at the breech, narrow at
// the arm hub. The slit trick: this carries the channel's FLOOR while
// the top rail floats above, bolt living in the gap.
bow.add(mkLoft([
  { z: 0.26, ring: profOct(0.17, 0.15, 0.02) },
  { z: 0.1, ring: profOct(0.16, 0.13, 0.02) },
  { z: -0.06, ring: profOct(0.12, 0.1, 0.02) },
], bodyMat));
// Channel floor - the bolt's runway, recessed so the glowing bolt in
// the slit shadows its sides correctly under the AO bake.
const chanFloor = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.44), darkMat);
chanFloor.position.set(0, 0.02, -0.06);
bow.add(chanFloor);
// Top rail - floats over the channel on two cheek pylons; the gap
// between rail and floor IS the slit the bolt shows through.
bow.add(mkLoft([
  { z: 0.18, ring: profOct(0.1, 0.05, 0.012), dy: 0.095 },
  { z: -0.14, ring: profOct(0.08, 0.045, 0.012), dy: 0.095 },
], bodyMat));
// Rail risers - the top rail can't float on air: side webs tie its
// underside to the channel floor, flanking the bolt slit.
for (const side of [-1, 1]) {
  for (const z of [-0.1, 0.15]) {
    const riser = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.04), darkMat);
    riser.position.set(side * 0.035, 0.0625, z);
    bow.add(riser);
  }
}
for (const side of [-1, 1]) {
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.06), darkMat);
  cheek.position.set(side * 0.05, 0.07, -0.24);
  bow.add(cheek);
}
// Scope block on the rail tail - T:A's stubby electronic sight.
// Octagonal cross-section: the chamfered top edge comes free from the
// profile, no bevel pass needed.
const scope = mkLoft([
  { z: 0.06, ring: profOct(0.07, 0.05, 0.012) },
  { z: -0.06, ring: profOct(0.07, 0.05, 0.012) },
], darkMat);
scope.position.set(0, 0.14, 0.08);
bow.add(scope);
// Flat cap plate over the loft's fan cap - the vertex-AO bake paints
// each fan vertex differently and the star shows through as noise.
// Removed: JP's call - bake like the rail, not cover plates.
// Hex arm hub - the boss the limbs rotate on, split across the nose.
// ARM_Z pushes the whole bow ahead of the rail nose: at ~100° cant the
// crossbar sits level with the eye plane and vanishes edge-on; forward
// placement gives it silhouette separation from the receiver.
const ARM_Z = -0.24;
// Rail continuing the receiver out to the hub - the arms were pushed
// forward for first-person readability, leaving the boss to hover.
const neckRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.3), bodyMat);
neckRail.position.set(0, 0, -0.1);
bow.add(neckRail);
const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.15, 6), darkMat);
hub.rotation.z = Math.PI / 2;
hub.position.set(0, 0, ARM_Z);
bow.add(hub);
// Bow arms - one group per side, pivoted at the hub so firing can flex
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
  // for outward-swept tips - the limbs crossed the gun's own body.
  arm.userData.baseRot = -side * ARM_SWEEP;
  arm.rotation.y = -side * ARM_SWEEP;
  arm.position.set(side * 0.07, 0, ARM_Z);
  // Limb - leaf-spring plates, not bars: thin vertically, wide
  // laterally, bowed TOWARD the bolt path mid-span (recurve bows the
  // belly forward, not the spine). Tip knob carries the cam wheel.
  const limb = mkLoft([
    { z: 0, ring: profOct(0.075, 0.018, 0.008) },
    { z: -0.2, ring: profOct(0.06, 0.014, 0.006), dx: -side * 0.03 },
    { z: -0.38, ring: profOct(0.048, 0.013, 0.006) },
    { z: -ARM_LEN, ring: profOct(0.055, 0.024, 0.008) },
  ], bodyMat);
  arm.add(limb);
  // Tension cable riding the limb's OUTER face, hub → cam - a guard
  // rail with a mid joint at the limb's recurve kink (z=-0.20 bows
  // -side*0.03), not a straight bar floating off the bent plate.
  arm.add(tubePath([
    [0, 0.02, 0, 0.008],
    [-side * 0.03, 0.02, -0.2, 0.008],
    [0, 0.02, -ARM_LEN - 0.02, 0.008],
  ], 0.008, darkMat, 4));
  // Cam wheel at the tip - the compound-bow read, oversized like T:A's.
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
  // Cable anchor bolt on the cam's outer face - the guard rail must
  // read as fastened to the wheel it tensions, not a floating line.
  const anchorNut = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.012, 6), brassMat);
  anchorNut.position.set(0, 0.021, -ARM_LEN - 0.02);
  arm.add(anchorNut);
  bow.add(arm);
}
// String - DYNAMIC legs, not a baked tubePath: the arms rotate on fire
// so a static string detaches from the cams. Two thin cylinders get
// re-stretched cam→latch every frame by ViewModel.tickBow. The knot at
// the vertex rides bowString's z (drawn-back at rest, snapped to the
// cam line when fired).
const CAM_R = 0.065;
const strutMat = new THREE.MeshBasicMaterial({ color: 0x18_1A_1C });
const stringG = new THREE.Group();
stringG.name = 'bowString';
const knot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), darkMat);
knot.position.set(0, 0.03, 0.16);
stringG.add(knot);
bow.add(stringG);
for (const side of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 5), strutMat);
  leg.name = side < 0 ? 'strLegL' : 'strLegR';
  // Bake the DRAWN pose into the geometry - tickBow re-solves it per frame
  // in first person, but third-person mounts and gunlab never tick, so an
  // unposed leg stays a vertical placeholder cylinder forever.
  // Cam center in bow space: arm at (±0.07, 0, ARM_Z) rotated baseRot
  // about Y; the leg meets the cam's breech-side rim (JP's O_ ruling).
  const theta = -side * ARM_SWEEP;
  const camX = side * 0.07 - (ARM_LEN + 0.02) * Math.sin(theta);
  const camZ = ARM_Z - (ARM_LEN + 0.02) * Math.cos(theta);
  const latch = { x: 0, y: 0.03, z: 0.16 };
  const dx = latch.x - camX, dy = Number(latch.y), dz = latch.z - camZ;
  const len = Math.hypot(dx, dy, dz);
  const rimT = 1 - CAM_R / len;
  const end = { x: camX + dx * rimT, y: dy * rimT, z: camZ + dz * rimT };
  leg.position.set((end.x + latch.x) / 2, (end.y + latch.y) / 2, (end.z + latch.z) / 2);
  leg.scale.y = len * rimT;
  leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(latch.x - end.x, latch.y - end.y, latch.z - end.z).normalize());
  bow.add(leg);
}
// Geometry constants the tick needs to re-solve the string pose without
// importing the builder module.
bow.userData.bowGeom = {
  armZ: ARM_Z, camDist: ARM_LEN + 0.02, camR: CAM_R,
  latchZ: 0.16, latchY: 0.03, firedZ: 0.16 - 0.27,
};
// Chambered bolt inside the channel - the loaded read. Glowing warhead
// tip (amber like the muzzle flash), thin shaft back to the latch.
// Named group: the fire envelope ejects it forward and re-chambers.
const boltG = new THREE.Group();
boltG.name = 'bowBolt';
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6), darkMat);
shaft.rotation.x = Math.PI / 2;
shaft.position.set(0, 0.035, 0.04);
boltG.add(shaft);
const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 6),
  new THREE.MeshBasicMaterial({ color: 0xFF_C8_66 }));
tip.rotation.x = -Math.PI / 2;
tip.position.set(0, 0.035, -0.11);
boltG.add(tip);
// Fletching fins at the tail - thin plates spread radially around the
// shaft axis so the silhouette reads arrowed from the side too.
for (let i = 0; i < 3; i += 1) {
  const a = (i / 3) * Math.PI * 2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.03, 0.05), bodyMat);
  fin.position.set(Math.cos(a) * 0.028, 0.035 + Math.sin(a) * 0.028, 0.16);
  fin.rotation.z = a;
  boltG.add(fin);
}
bow.add(boltG);
// Bolt drum under the receiver - axis across the gun, bolt shafts
// visible ringed on the face like the GL's chambers. 'bowDrum' indexes
// one station per shot.
const drumG = new THREE.Group();
drumG.name = 'bowDrum';
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.11, 8), darkMat);
drum.rotation.z = Math.PI / 2;
drumG.add(drum);
for (let i = 0; i < 8; i += 1) {
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
// Skeletal stock + grip - the crossbow's gun reads
const stockL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.2), bodyMat);
stockL.position.set(0, 0.02, 0.36);
bow.add(stockL);
const stockB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.05), bodyMat);
stockB.position.set(0, -0.02, 0.44);
bow.add(stockB);
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, 0.05), bodyMat);
grip.position.set(0, -0.14, 0.08);
grip.rotation.x = 0.3;
bow.add(grip);
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.08), darkMat);
guard.position.set(0, -0.11, 0.02);
bow.add(guard);
bow.visible = false;
return bow;
}

// Weapon 1 - disc launcher (T1/T2/Ascend spinfusor DNA, not a copy): a
// Quake-RL hex tube with a horizontal slit cut clean through its front
// half. The flat chambered disc rides in the slit, cyan rim glowing
// through the gap - the slit IS the "fires discs" read.
const DISC_HEX_R = 0.12; // slimmer slab - disc rim (r=0.115) stays proud of the apothem (0.104)
const DISC_SLIT_HALF = 0.019; // hug the 0.028-thick disc - a wide gap reads hollow, not chambered

// Sutherland-Hodgman against one horizontal line: keeps the hexagon's
// part above (side=1) or below (side=-1) the slit edge. This is the
// "negative volume" - the slit is removed from the cross-section before
// extrusion, so its walls are real faceted geometry.
function hexHalf(side: 1 | -1): THREE.Shape {
  const hex: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k += 1) {
    const a = (k * Math.PI) / 3 + Math.PI / 6; // flat flanks, ridge top/bottom - the slit cuts the flat sides
    hex.push(new THREE.Vector2(Math.cos(a) * DISC_HEX_R, Math.sin(a) * DISC_HEX_R));
  }
  const inside = (p: THREE.Vector2): boolean => side * p.y >= DISC_SLIT_HALF;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < hex.length; i += 1) {
    const cur = hex[i]!;
    const nxt = hex[(i + 1) % hex.length]!;
    if (inside(cur)) {out.push(cur);}
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
// Solid hex breech behind the slit - same profile, no cut
const fullHex = new THREE.Shape();
for (let k = 0; k <= 6; k += 1) {
  const a = (k * Math.PI) / 3 + Math.PI / 6;
  const x = Math.cos(a) * DISC_HEX_R, y = Math.sin(a) * DISC_HEX_R;
  if (k === 0) {fullHex.moveTo(x, y);} else {fullHex.lineTo(x, y);}
}
// Breech overlaps the slit section AND steps IN - the valley where the
// proud slit-section overhangs lands on the breech's verts, so AO grime
// shadows the back, not the front half. (A same-size overlap is coplanar
// side walls = z-fight; a flush start is coplanar caps = z-fight.)
const breech = extrudeAt(fullHex, zFront + slitLen - 0.006, 0.186, bodyMat);
breech.scale.set(0.97, 0.97, 1);
disc.add(breech);
// Groove ring where the slit ends - recessed, so it reads as a machined
// channel and the AO valley-darkening lands INSIDE it (where it belongs)
// instead of dirtying either neighbor's face.
// (add() returns the GROUP, not the mesh - scale must be set on the
// extrude itself or the whole weapon gets scaled and nothing changes.)
const collar = extrudeAt(fullHex, zFront + slitLen - 0.012, 0.024, darkMat);
collar.scale.set(0.94, 0.94, 1);
disc.add(collar);
// Chambered disc lying flat in the slit - the spinfusor's whole read.
// Dark body, hot rim: T2's loaded disc glows at the EDGE, not the face.
// Both ride a named group so the fire envelope can slide the NEXT disc
// out of the breech into the slit (the "it really fires discs" sell).
const ammo = new THREE.Group();
ammo.name = 'discAmmo';
const loadedMat = new THREE.MeshLambertMaterial({ color: 0x3A_3F_45, emissive: 0x14_16_1A });
const loaded = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.028, 24), loadedMat);
loaded.position.set(0, 0, -0.15);
ammo.add(loaded);
const rim = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.011, 6, 32),
  new THREE.MeshBasicMaterial({ color: 0x77_E8_FF }));
rim.rotation.x = Math.PI / 2;
rim.position.set(0, 0, -0.15);
ammo.add(rim);
disc.add(ammo);
// (No spindle - an interior cylinder nobody sees; the disc carries the
// "chambered" read on its own.)
// Forend under the slit section - grip/trigger dropped like the fast disc's
const forend = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.24), darkMat);
forend.position.set(0, -0.13, -0.13);
disc.add(forend);
disc.visible = false;
return disc;
}

/** Fast Disc Launcher - the spinfusor's flat-track sibling. Same hex
 *  body + chambered disc vocabulary, but elongated forward with a
 *  tapered muzzle collar and hotter rim glow - reads "velocity tuned". */
export function mkFastDisc(): THREE.Group {
const fd = new THREE.Group();
const zFront = -0.42;                    // stretched forward vs the 0.3 disc
const slitLen = 0.42;
// Speed grooves - plasma-style: a V-notch CUT INTO the hex profile at
// each roof-edge midpoint, so the channel is part of the silhouette
// (extruded free for the slit length), not geometry laid on top.
const hexHalfGrooved = (side: 1 | -1): THREE.Shape => {
  const base = (hexHalf(side) as THREE.Shape).getPoints();
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < base.length; i += 1) {
    const cur = base[i]!; const nxt = base[(i + 1) % base.length]!;
    out.push(cur);
    // Notch only real roof edges (both ends above slit height and a
    // real hex edge length) - the clip baseline isn't a face.
    if (cur.y > DISC_SLIT_HALF && nxt.y > DISC_SLIT_HALF && Math.abs(cur.x - nxt.x) > DISC_HEX_R * 0.5) {
      // Narrow U-channel recessed along the FACE NORMAL - the groove
      // cuts perpendicular into the slope, not inward horizontally.
      const lerp = (t: number): THREE.Vector2 => new THREE.Vector2(cur.x + (nxt.x - cur.x) * t, cur.y + (nxt.y - cur.y) * t);
      const a = lerp(0.42), b = lerp(0.58);
      const ex = nxt.x - cur.x, ey = nxt.y - cur.y, el = Math.hypot(ex, ey) || 1;
      let nx = ey / el, ny = -ex / el;                    // edge's right normal
      const mx = (cur.x + nxt.x) / 2, my = (cur.y + nxt.y) / 2;
      if (mx * nx + my * ny > 0) {nx = -nx; ny = -ny;}    // flip to point inward
      const depth = DISC_HEX_R * 0.18;                 // doubled - the black liner reclaims half of it
      out.push(a);
      out.push(new THREE.Vector2(a.x + nx * depth, a.y + ny * depth));
      out.push(new THREE.Vector2(b.x + nx * depth, b.y + ny * depth));
      out.push(b);
    }
  }
  return new THREE.Shape(out);
};
fd.add(extrudeAt(hexHalfGrooved(1), zFront, slitLen, bodyMat));
fd.add(extrudeAt(hexHalfGrooved(-1), zFront, slitLen, bodyMat));
// Groove shadow liners - each speed channel gets a dark insert sunk to
// the bottom HALF of the (now double-deep) cut, so the remaining visible
// channel depth matches the pre-liner groove. linerMat is bodyMat
// darkened - shaded like the body, just deeper in the channel.
const grooveLiners = (side: 1 | -1): void => {
  const base = (hexHalf(side) as THREE.Shape).getPoints();
  for (let i = 0; i < base.length; i += 1) {
    const cur = base[i]!; const nxt = base[(i + 1) % base.length]!;
    if (!(cur.y > DISC_SLIT_HALF && nxt.y > DISC_SLIT_HALF && Math.abs(cur.x - nxt.x) > DISC_HEX_R * 0.5)) {continue;}
    const lerp = (t: number): THREE.Vector2 => new THREE.Vector2(cur.x + (nxt.x - cur.x) * t, cur.y + (nxt.y - cur.y) * t);
    const a = lerp(0.42), b = lerp(0.58);
    const ex = nxt.x - cur.x, ey = nxt.y - cur.y, el = Math.hypot(ex, ey) || 1;
    let nx = ey / el, ny = -ex / el;
    const mx = (cur.x + nxt.x) / 2, my = (cur.y + nxt.y) / 2;
    if (mx * nx + my * ny > 0) {nx = -nx; ny = -ny;}
    const top = DISC_HEX_R * 0.09;                     // liner mouth sunk to old groove depth
    const depth = DISC_HEX_R * 0.18 * 0.96;            // floor just off the new double-deep floor
    const liner = new THREE.Shape([
      new THREE.Vector2(a.x + nx * top, a.y + ny * top),
      new THREE.Vector2(a.x + nx * depth, a.y + ny * depth),
      new THREE.Vector2(b.x + nx * depth, b.y + ny * depth),
      new THREE.Vector2(b.x + nx * top, b.y + ny * top),
    ]);
    const lm = extrudeAt(liner, zFront, slitLen, linerMat);
    lm.name = 'liner'; // export tag - vmdump keeps named basics, hides glow
    fd.add(lm);
  }
};
grooveLiners(1);
grooveLiners(-1);
const fullHex2 = new THREE.Shape();
for (let k = 0; k <= 6; k += 1) {
  const a = (k * Math.PI) / 3 + Math.PI / 6;
  fullHex2[k === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * DISC_HEX_R, Math.sin(a) * DISC_HEX_R);
}
// Longer breech - the velocity sell is a stretched silhouette.
const breech = extrudeAt(fullHex2, zFront + slitLen - 0.006, 0.24, bodyMat);
breech.scale.set(0.95, 0.95, 1);
fd.add(breech);
// Twin groove rings - speed lines machined into the body.
for (const off of [-0.012, 0.09]) {
  const collar = extrudeAt(fullHex2, zFront + slitLen + off, 0.02, darkMat);
  collar.scale.set(0.93, 0.93, 1);
  fd.add(collar);
}
// Chambered disc - same language, hotter rim (white-cyan = the fast one).
const ammo = new THREE.Group();
ammo.name = 'discAmmo';
const loaded = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.028, 24),
  new THREE.MeshLambertMaterial({ color: 0x3A_3F_45, emissive: 0x14_16_1A }));
loaded.position.set(0, 0, -0.2);
ammo.add(loaded);
// HDR push past the 1.3 bloom gate - the rim reads as a charged cell.
const rim = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.011, 6, 32),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0xC8_F4_FF).multiplyScalar(1.6) }));
rim.rotation.x = Math.PI / 2;
rim.position.set(0, 0, -0.2);
ammo.add(rim);
fd.add(ammo);
// Forend as a hex bar - grippable machined stock, not a sharp slab.
const forend = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 6), darkMat);
forend.rotation.x = Math.PI / 2;
forend.position.set(0, -0.11, -0.2);
fd.add(forend);
fd.visible = false;
return fd;
}

// Weapon 2 - chaingun, UT/Serious Sam language: the barrels ARE the
// gun. Three fat pipes spinning on an exposed cluster, short stubby
// breech behind, ammo drum slung low. No shroud - a full casing hid
// the cluster and read as a rocket tube.
export function mkChaingun(): { g: THREE.Group; barrels: THREE.Group } {
const chain = new THREE.Group();
const chainBarrels = new THREE.Group();
// The bake pipeline treats "barrels" as a kept-separate node - it's the
// only viewmodel part that animates, so it can't fold into the merged mesh.
chainBarrels.name = 'barrels';
const CHAIN_BARRELS = 3;
const CLUSTER_R = 0.088;
for (let i = 0; i < CHAIN_BARRELS; i += 1) {
  const a = (i / CHAIN_BARRELS) * Math.PI * 2;
  const dx = Math.cos(a) * CLUSTER_R, dy = Math.sin(a) * CLUSTER_R;
  // FAT barrels - the cluster fills the FPS view; chunky 8-seg with a
  // slight swell at the breech root, tapering to the muzzle.
  const barrel = mkLoft([
    { z: -0.12, ring: rotRing(profCircle(0.072, 8), a), dx, dy },
    { z: -0.3, ring: rotRing(profCircle(0.066, 8), a), dx, dy },
    { z: -0.78, ring: rotRing(profCircle(0.06, 8), a), dx, dy },
  ], bodyMat, false); // open ends - throat + breech collar cap both
  // Per-barrel fire recoil - kick() knocks the TOP barrel back a beat.
  // baseZ restores it; `barrel` tag skips the collar/studs sharing the group.
  barrel.userData.barrel = true;
  barrel.userData.baseZ = barrel.position.z;
  chainBarrels.add(barrel);
  // Brass muzzle collar + recessed bore - the UT fat-pipe read.
  const throat = mkAnnulus(rotRing(profCircle(0.068, 8), a), rotRing(profCircle(0.038, 8), a), -0.78, -0.81, brassMat);
  throat.position.set(dx, dy, 0);
  chainBarrels.add(throat);
  const plug = mkBore(0.038, -0.805);
  plug.rotation.y = Math.PI;
  plug.position.x = dx; plug.position.y = dy;
  chainBarrels.add(plug);
}
chain.add(chainBarrels);
// Breech bearing - the big collar the cluster seats into, VISIBLE and
// spinning with the barrels. The machine tell.
const chainCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.175, 0.09, 12), darkMat);
chainCollar.rotation.x = Math.PI / 2;
chainCollar.position.z = -0.11;
chainBarrels.add(chainCollar);
for (let i = 0; i < CHAIN_BARRELS * 2; i += 1) {
  const a = (i / (CHAIN_BARRELS * 2)) * Math.PI * 2;
  const stud = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), bodyMat);
  stud.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, -0.14);
  chainBarrels.add(stud);
}
// Brass center axle - the rotor shaft; spins WITH the cluster (it's
// in chainBarrels), visible between the barrels through the gaps.
chainBarrels.add(mkTube(0.07, 0.07, 0.55, -0.4, brassMat));
// Dark mouth behind the cluster between the barrels.
chain.add(mkBore(CLUSTER_R + 0.075, -0.155));
// No muzzle clamp - a ring mid-run read as clutter against the three
// fat pipes; the barrels and their brass throats carry the spin alone.
// Breech housing - SHORT stubby body, the body exists to feed the
// cluster, not to be a rifle. Round loft so the tail reads as a turned
// receiver, not a box.
chain.add(mkLoft([
  { z: 0.15, ring: profCircle(0.11, 12) },
  { z: 0.05, ring: profCircle(0.14, 12) },
  { z: -0.09, ring: profCircle(0.145, 12) },
], bodyMat));
// Flank vents removed - floater boxes outside the tapered body, and
// behind the breech where FPS never sees them anyway.
// No rail - pure tail clutter, invisible in FPS anyway.
// Pull the whole gun back toward the shoulder - the breech sits close
// to the eye and reads huge next to the barrels; letting the rear slip
// out of frame leaves the cluster owning the view.
chain.position.z = 0.15;
chain.visible = false;
return { g: chain, barrels: chainBarrels };
}

// Weapon 3 - mortar: mkMortar_v1 restored verbatim (see
// weaponsGeoArchive.ts) - every redesign iteration baked worse than it.
export function mkMortar(): THREE.Group {
const mortar = new THREE.Group();
mortar.add(mkTube(0.19, 0.16, 0.42, -0.02, darkMat)); // main bore tube
mortar.add(mkTube(0.22, 0.2, 0.1, -0.22, bodyMat)); // flared muzzle
// Step ring behind the flare - eases the muzzle-to-body transition.
mortar.add(mkTube(0.2, 0.2, 0.04, -0.16, bodyMat));
mortar.add(mkBore(0.17, -0.271));
// Cooling pipes - a thin hex rod at each facet's middle, running the
// tube's length and butting into the muzzle ring. Sinks into the fat
// rear taper, stands proud at the thin front - reads welded.
for (const pipe of radialRepeat(8, 0.163, 0, () => mkRod(0.014, 0.36, darkMat))) {mortar.add(pipe);}



mortar.visible = false;
return mortar;
}

// Weapon 4 - grenade launcher: MGL-style revolver - fat drum slung
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
// Six chamber bores ringed around the drum face - the revolver read.
// Solid drum looked like a wheel; dark mouths with brass rims sell
// "six 40mm chambers" at viewmodel distance.
const chamberRimMat = new THREE.MeshLambertMaterial({ color: 0x8A_7A_4A, emissive: 0x1A_14_08 });
for (let i = 0; i < 6; i += 1) {
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

// Sticky launcher: T2's bomb mortar - a fat launch tube feeding from a
// horizontal bomb drum under the breech, latching spike at the muzzle.
// The "sticky" read is a row of live ordnance in the drum window, not a
// bubble on top - the old glowing pink ball looked like a toy hopper.
export function mkSticky(): THREE.Group {
const sticky = new THREE.Group();
sticky.add(mkTube(0.125, 0.135, 0.34, -0.14, bodyMat)); // launch tube - longer, heavier
sticky.add(mkTube(0.15, 0.145, 0.07, -0.34, darkMat)); // muzzle collar
sticky.add(mkBore(0.105, -0.376));
// Latching spike protruding past the bore - the glue tip the bombs get
// skewered on. THE silhouette detail that separates it from a GL clone.
const spike = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.1, 6), darkMat);
spike.rotation.x = -Math.PI / 2;
spike.position.set(0, 0.1, -0.4);
sticky.add(spike);
const spikeBase = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.06), darkMat);
spikeBase.position.set(0, 0.1, -0.35);
sticky.add(spikeBase);
// Bomb drum under the barrel - axis across the gun, half-buried in the
// receiver like the GL drum but set LOW so it reads slung, not fat.
const stickyDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 10), darkMat);
stickyDrum.rotation.z = Math.PI / 2;
stickyDrum.position.set(0, -0.11, -0.06);
sticky.add(stickyDrum);
// Chambered bombs peeking through the drum's front face - five dark
// shells ringed around the hub, each with a fuse nub. Visible ordnance =
// the "sticky bombs loaded" read at viewmodel distance.
const bombMat = new THREE.MeshLambertMaterial({ color: 0x1E_22_26, emissive: 0x0A_0C_0E });
const fuseMat = new THREE.MeshBasicMaterial({ color: 0xFF_AA_22 }); // amber fuse glow - hazard, not candy
for (let i = 0; i < 5; i += 1) {
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
// Receiver - taller slab behind the drum, carries the launcher's bulk
const stickyRecv = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.2), bodyMat);
stickyRecv.position.set(0, -0.01, 0.14);
sticky.add(stickyRecv);
// Warning stripe across the receiver flank - ordnance hardware marking,
// not decoration. Same trick as the shotgun's red shells.
const warnMat = new THREE.MeshLambertMaterial({ color: 0xCC_88_18, emissive: 0x30_1F_04 });
const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.152, 0.03, 0.14), warnMat);
stripe.position.set(0, 0.03, 0.14);
sticky.add(stripe);
// Rear stock plate + grip - matches the GL's stance so the family reads
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

// Weapon 5 - flak cannon: UT's chunky front-loader. Wide ribbed barrel
// with a DEEP flared bore, breech box with the top grill, and the tell
// UT players know: a break-open loading slot with shells in a clip.
export function mkFlak(): THREE.Group {
const flak = new THREE.Group();
flak.add(mkTube(0.17, 0.15, 0.3, -0.08, bodyMat));
// Ribbed barrel - two pinch ribs along the tube, not just the ring
for (let i = 0; i < 2; i += 1) {
  flak.add(mkTube(0.175, 0.175, 0.025, -0.14 + i * 0.09, darkMat));
}
flak.add(mkTube(0.19, 0.19, 0.06, -0.24, darkMat)); // muzzle ring
// Deep flared bore - flak throws a shell, not a slug: the muzzle is a
// bell with a visible dark throat, wider than the old flat disc read
flak.add(mkBore(0.155, -0.271));
const flakThroat = mkTube(0.155, 0.12, 0.05, -0.24, boreMat);
flak.add(flakThroat);
// Receiver - hexagonal drum instead of a raw cube; reads machined.
const flakBox = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.3, 6), darkMat);
flakBox.rotation.x = Math.PI / 2;
flakBox.position.set(0, 0, 0.16);
flak.add(flakBox);
// Top vents - the UT flak "grill". Hex rods across the drum top match
// the new hexagonal receiver better than raw slabs.
for (let i = 0; i < 3; i += 1) {
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
// Grip pommel - the extrude-and-scale trick: a short butt section
// slightly narrower, gives the handle a shaped heel instead of a
// cylinder ending on a flat cut. Child of the grip so it inherits the
// rake - offset is just down the grip's local axis.
const flakButt = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.026, 0.035, 6), darkMat);
flakButt.position.y = -0.0775; // half grip len + half butt len
flakGrip.add(flakButt);
flak.visible = false;
return flak;
}

// Weapon 9 - shotgun: heavy pumpgun. Fat bore over a full-length shell
// tube, chunky receiver, big ribbed pump - reads "combat shotgun" the
// instant you see the paired under-barrel stack.
export function mkShotgun(): THREE.Group {
const sg = new THREE.Group();
sg.add(mkTube(0.115, 0.115, 0.6, -0.08, bodyMat));  // THICK barrel - bore sells it
sg.add(mkTube(0.135, 0.135, 0.09, -0.36, darkMat)); // heavy muzzle collar
sg.add(mkBore(0.095, -0.406));
// Shell tube - parallel under the barrel for its full length, THE
// pumpgun silhouette read (barrel-over-mag = shotgun, not rifle)
const magTube = mkTube(0.068, 0.068, 0.52, -0.02, darkMat);
magTube.position.y = -0.15;
sg.add(magTube);
// Receiver - oversized block, wider than tall, between barrel and stock
const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.18, 0.24), bodyMat);
receiver.position.set(0, -0.01, 0.2);
sg.add(receiver);
// Side-saddle shells - three red hulls on the receiver flank. THE
// shotgun read: nothing else in the arsenal carries colored shells.
// (shellMat/brassMat hoisted to module scope - the RPG warhead shares them.)
for (let i = 0; i < 3; i += 1) {
  const hull = mkTube(0.022, 0.022, 0.07, 0, shellMat);
  hull.position.set(-0.085, 0.03, 0.09 + i * 0.08); // a row along the flank
  sg.add(hull);
  const brass = mkTube(0.024, 0.024, 0.018, 0, brassMat);
  brass.position.copy(hull.position);
  brass.position.z += 0.044; // brass cup at the hull's rear
  sg.add(brass);
}
// Ejection port - dark notch on the receiver's right side
const port = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.11), darkMat);
port.position.set(0.098, 0.03, 0.16);
sg.add(port);
// Pump grip - fat ribbed slide under the fore-end, wide as the hand
const pump = mkTube(0.085, 0.085, 0.19, -0.13, darkMat);
pump.position.y = -0.15;
sg.add(pump);
for (let i = 0; i < 4; i += 1) {
  const rib = mkTube(0.092, 0.092, 0.02, -0.2 + i * 0.05, bodyMat);
  rib.position.y = -0.15;
  sg.add(rib);
}
// Heat-shield vents along the barrel top - rows of holes read at scale
for (let i = 0; i < 4; i += 1) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.045), darkMat);
  vent.position.set(0, 0.12, -0.24 + i * 0.1);
  sg.add(vent);
}
// Bead sight on the muzzle collar - tiny nub, classic pumpgun read
const bead = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), darkMat);
bead.position.set(0, 0.15, -0.38);
sg.add(bead);
// Stock - dropped buttstock with a visible grip wedge
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

// Weapon 10 - cannon: Serious Sam naval gun rebuilt per JP's Blender
// ref - stacked bulged barrel sections separated by pinch rings, huge
// bore, rounded breech ball.
export function mkCannon(): THREE.Group {
const cn = new THREE.Group();
let cz = 0; // running z, barrel extends toward -Z from breech
const cnSeg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  cn.add(mkTube(r1, r2, len, cz - len / 2, mat));
  cz -= len;
};
// Bombard silhouette: gently TAPERING barrel (fat at the breech, slim
// at the muzzle) with thin reinforcing hoops only ~15% proud of the
// tube. The old version swelled each band to ~1.6x the tube radius -
// stacked donuts instead of one machined barrel.
// Crowned hoop - /\ profile instead of a flat band; sits only ~7mm
// proud of the tube so it reads as a shrunk-on ring, not a collar.
const cnHoop = (r: number): void => {
  cnSeg(r, r + 0.006, 0.012, darkMat);
  cnSeg(r + 0.006, r, 0.012, darkMat);
};
cnSeg(0.125, 0.13, 0.03, bodyMat);  // breech cap
cnSeg(0.13, 0.12, 0.12, bodyMat);   // tube taper 1
cnHoop(0.127);                      // hoop 1
cnSeg(0.12, 0.11, 0.12, bodyMat);   // tube taper 2
cnHoop(0.117);                      // hoop 2
cnSeg(0.11, 0.1, 0.1, bodyMat);   // chase - slimmest stretch
cnHoop(0.107);                      // hoop 3
cnSeg(0.1, 0.125, 0.035, bodyMat); // muzzle flare (trumpet lip)
cnHoop(0.128);                      // muzzle ring
// cz ends ≈ -0.46; muzzle ring's own capped face serves as the dark bore.
// Cascabel - the breech knob, proper: a slim neck off the cap widening
// into a small ball half the barrel's radius. Centered on axis (the old
// one hung 0.02 low and read as a random sphere stuck to the back).
const cnNeck = mkTube(0.05, 0.035, 0.035, 0.017, bodyMat); // flares into the ball (+Z end is r1)
cn.add(cnNeck);
const cnBall = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), bodyMat);
cnBall.position.set(0, 0, 0.05);
cn.add(cnBall);
// A cannon reads by mass - scale up and pull the whole group back so
// the fat breech sits closer instead of poking a long thin tube forward.
cn.scale.setScalar(1.2);
cn.position.z += 0.08;
cn.visible = false;
return cn;
}

// Weapon 35 - Bombard: the cannon's siege brother. The SILHOUETTE is the
// whole read - a mortar-wide bore on a shortened barrel: fat at the
// breech, fat at the lip, no long slim chase. Reads "ship's gun dragged
// ashore", not "big rifle".
export function mkBombard(): THREE.Group {
const bb = new THREE.Group();
let bz = 0;
const bbSeg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  bb.add(mkTube(r1, r2, len, bz - len / 2, mat));
  bz -= len;
};
const bbHoop = (r: number): void => {
  bbSeg(r, r + 0.008, 0.016, darkMat);
  bbSeg(r + 0.008, r, 0.016, darkMat);
};
bbSeg(0.19, 0.2, 0.04, bodyMat);   // breech cap - already wider than the whole cannon
bbSeg(0.2, 0.175, 0.14, bodyMat);  // chamber taper - the powder room
bbHoop(0.183);                     // hoop 1
bbSeg(0.175, 0.16, 0.12, bodyMat); // tube taper
bbHoop(0.168);                     // hoop 2
bbSeg(0.16, 0.21, 0.05, bodyMat);  // muzzle bell - a flared lip wider than the breech
bbHoop(0.215);                     // muzzle ring - the widest point on the gun
// Cascabel - same knob trick as the cannon but scaled to the mass: a
// ball nearly the barrel's own width reads as counterweight, not finial.
const bbNeck = mkTube(0.07, 0.05, 0.04, 0.02, bodyMat);
bb.add(bbNeck);
const bbBall = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), bodyMat);
bbBall.position.set(0, 0, 0.06);
bb.add(bbBall);
bb.scale.setScalar(1.15);
bb.position.z += 0.08;
bb.visible = false;
return bb;
}

// Weapon 42 - Gonne: the light frame's arc gun. The silhouette is a
// wrought-iron handgonne (medieval hand-cannon ref): a SHORT slim tube
// ringed by shrunk-on hoops - reads "forged", not "cast" - with a
// hint of muzzle lip and a small cascabel knob. Compact, not a bore.
export function mkGonne(): THREE.Group {
const cv = new THREE.Group();
let cz = 0;
const cvSeg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  cv.add(mkTube(r1, r2, len, cz - len / 2, mat));
  cz -= len;
};
const cvHoop = (r: number): void => {
  cvSeg(r, r + 0.005, 0.01, darkMat);
  cvSeg(r + 0.005, r, 0.01, darkMat);
};
cvSeg(0.098, 0.1, 0.03, bodyMat);    // breech cap
cvSeg(0.1, 0.094, 0.1, bodyMat);     // chamber stretch - the tube IS the gun
cvHoop(0.098);
cvSeg(0.094, 0.09, 0.1, bodyMat);    // taper 1
cvHoop(0.093);
cvSeg(0.09, 0.084, 0.09, bodyMat);   // chase - slimmest stretch
cvHoop(0.087);
cvSeg(0.084, 0.092, 0.03, bodyMat);  // muzzle flare - a hint of lip, not a bell
cvHoop(0.095);                        // muzzle ring
// cz ends ≈ -0.37 - hand-cannon proportions, not a flagpole.
// Small cascabel - same knob trick as the cannon, undersized to match
// the slimmer breech.
const cvNeck = mkTube(0.04, 0.028, 0.03, 0.015, bodyMat);
cv.add(cvNeck);
const cvBall = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), bodyMat);
cvBall.position.set(0, 0, 0.04);
cv.add(cvBall);
// ~20% bigger overall - a handgonne reads as a small CANNON on the
// shoulder, not a fat pistol.
cv.scale.setScalar(1.2);
cv.visible = false;
return cv;
}

// Weapon 43 - Basilisk: the heavy frame's arc gun. The silhouette is a
// cast BRONZE giant (the real basilisks were 50-pdr monsters, cast in
// bronze not iron - so it's brass, not the bombard's dark iron): FAT
// long barrel, fewer THICK reinforcing bands instead of the gonne's
// many slim hoops, deep bell mouth, heavy cascabel ball. The material
// is half the identity: warm cast metal vs every other gun's cold iron.
export function mkBasilisk(): THREE.Group {
const bk = new THREE.Group();
let cz = 0;
const bkSeg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  bk.add(mkTube(r1, r2, len, cz - len / 2, mat));
  cz -= len;
};
// Thick cast band - wider and taller than the cannon's crown hoops:
// bronze guns wore their strength visibly.
const bkBand = (r: number): void => {
  bkSeg(r, r + 0.014, 0.014, darkMat);
  bkSeg(r + 0.014, r + 0.014, 0.02, darkMat);
  bkSeg(r + 0.014, r, 0.014, darkMat);
};
bkSeg(0.165, 0.17, 0.04, brassMat);   // breech cap - already wider than the whole gonne
bkSeg(0.17, 0.16, 0.1, brassMat);     // chamber - the powder room
bkBand(0.167);
bkSeg(0.16, 0.15, 0.1, brassMat);     // first reinforce
bkBand(0.157);
bkSeg(0.15, 0.14, 0.1, brassMat);     // second reinforce
bkBand(0.147);
bkSeg(0.14, 0.13, 0.09, brassMat);    // chase - still fatter than the cannon's breech
bkSeg(0.13, 0.17, 0.04, brassMat);    // bell mouth - the bronze flare
bkBand(0.173);                        // muzzle astragal - the widest band on the gun
// cz ends ≈ -0.51 - fat and compact, not a flagpole.
// Heavy cascabel - a ball nearly the breech's width, counterweight mass.
const bkNeck = mkTube(0.065, 0.045, 0.04, 0.02, brassMat);
bk.add(bkNeck);
const bkBall = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), brassMat);
bkBall.position.set(0, 0, 0.055);
bk.add(bkBall);
bk.visible = false;
return bk;
}

// Weapon 11 - rocket launcher: classic RPG profile. Long launch tube,
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

// Weapon 44 - universal flat rocket: the every-class accelerator. The
// silhouette is ONE fat tube: at viewmodel distance a launcher reads by
// how much barrel it puts on screen, so thickness carries the weapon and
// the details only break it up. Still no protruding warhead - nose-out-
// of-the-tube is the RPG's tell (type 15), and these two share a slot in
// loadouts, so the distinction has to survive at a glance.
export function mkRocketLauncher(): THREE.Group {
const g = new THREE.Group();
// Barrel - stacked frustum sections, same idiom as the cannon. The kit's
// surface detail IS edge wear: bright worn metal only appears on sharp
// dihedral edges. One long smooth taper bakes edges at its two ends only,
// so its middle renders as flat dark albedo - the "black pipe" look. A
// cross-ring of edges every ~0.18m (the radius step at each section seam,
// plus the crowned hoops) is what makes a barrel read as machined metal.
// Still ONE fat tube: every section is within 7mm of its neighbour.
let bz = 0.28;
const seg = (r1: number, r2: number, len: number, mat: THREE.Material): void => {
  g.add(mkTube(r1, r2, len, bz - len / 2, mat));
  bz -= len;
};
// Crowned hoop - /\ profile, not a flat band: two short frustums meeting
// at a proud peak. The peak is a real dihedral edge, so it wears bright
// and the ring reads as shrunk-on steel rather than a painted stripe.
const hoop = (r: number): void => {
  seg(r, r + 0.011, 0.016, darkMat);
  seg(r + 0.011, r, 0.016, darkMat);
};
seg(0.098, 0.104, 0.03, bodyMat);   // breech cap - the widest point
seg(0.104, 0.1, 0.17, bodyMat);     // chamber
hoop(0.102);                        // ring 1
seg(0.1, 0.0975, 0.17, bodyMat);    // taper
hoop(0.0995);                       // ring 2
seg(0.0975, 0.095, 0.17, bodyMat);  // chase
hoop(0.097);                        // ring 3
seg(0.095, 0.099, 0.086, bodyMat);  // muzzle flare into the brake
// Breech collar - a RING at the back, not a body. Anything that swells
// here competes with the tube and reads as a different weapon entirely.
// Its caps sit off every barrel seam plane: coincident same-facing caps
// from two meshes z-fight (the collar's +Z cap landing exactly on the
// breech section's -Z seam was 33 coplanar pairs).
g.add(mkTube(0.132, 0.132, 0.085, 0.19, darkMat, 6));
// Muzzle brake - one fat sleeve that chokes the bore. The step IS the
// read; cut ports and side boxes muddied the silhouette.
g.add(mkTube(0.128, 0.12, 0.07, -0.435, darkMat, 6));
// Brass lip, with the bore disc parked just AHEAD of its cap - that is
// how a muzzle reads as a hole in this kit (the cap is solid geometry).
g.add(mkTube(0.112, 0.108, 0.014, -0.478, brassMat, 6));
const bore = mkBore(0.098, -0.487);
bore.rotation.y = Math.PI;
g.add(bore);
// Venturi tail - a real exhaust bell, not a flared cap: an outer shell
// that widens to the rim, then a DARK inner cone you look into. A bell
// closed by its own flat annular cap reads as a plate on the back of the
// gun; the converging throat is what sells "open nozzle".
g.add(mkTube(0.152, 0.118, 0.085, 0.3125, darkMat, 4));   // outer flare
g.add(mkTube(0.142, 0.085, 0.05, 0.328, darkMat, 3));     // throat, converging inward
// Throat cap, black: without it you see through the cone to the breech
// face behind. 2mm proud of the cone's inner end (coplanar caps z-fight).
g.add(mkBore(0.082, 0.3005));
// Pistol grip - longer than a rifle's because the whole weapon's mass
// hangs off it, and raked so the wrist does not look broken.
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.19, 0.1), darkMat);
grip.position.set(0, -0.19, 0.1);
grip.rotation.x = 0.26;
g.add(grip);
// Trigger guard - a vertical half-hoop whose top is buried in the tube,
// so it welds to the body instead of floating under it.
const guard = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 10, Math.PI), darkMat);
guard.position.set(0, -0.115, 0.03);
guard.rotation.set(0, Math.PI / 2, Math.PI);
g.add(guard);
// Support hand - the tube is long enough to need one, and the pad stops
// it from looking like it floats off the grip.
const fore = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.06, 0.14), darkMat);
fore.position.set(0, -0.115, -0.18);
g.add(fore);
// Top rail + a low flip sight. No tall optic: this is the point-and-fire
// universal, and a big scope would put it in the cannon's silhouette.
// Both sit ON the octagon's 0.10 flat - a rail floating above it reads as
// a separate object, not a mount.
const rail = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.018, 0.2), darkMat);
rail.position.set(0, 0.105, 0);
g.add(rail);
const sight = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.045, 0.02), darkMat);
sight.position.set(0, 0.128, -0.07);
g.add(sight);
g.visible = false;
return g;
}

// Weapon 28 - MRV launcher: the mortar's counterpart, so it should read
// "many shells" not "one bore". A fat ROTARY DRUM (revolver cylinder -
// the volley tell) with GLOWING shell noses in the chamber windows,
// perforated barrel shroud, slotted muzzle brake, skeletal stock.
// Shoulder-fired crew ordnance - beefier than the GL, meaner than the
// mortar since it never asks you to work for the punch.
export function mkMrv(): THREE.Group {
const mrv = new THREE.Group();
// Barrel core - short, fat; the shroud does the visual work
mrv.add(mkTube(0.115, 0.105, 0.36, -0.2, bodyMat));
mrv.add(mkBore(0.095, -0.386));
// Perforated shroud - three ring bands over a vented body: the "swiss
// cheese" launcher read JP keeps coming back to
for (const z of [-0.34, -0.22, -0.1]) {
  mrv.add(mkTube(0.148, 0.148, 0.045, z, darkMat));
}
for (let i = 0; i < 8; i += 1) {
  const a = (i / 8) * Math.PI * 2;
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.3), darkMat);
  rib.position.set(Math.cos(a) * 0.135, Math.sin(a) * 0.135, -0.22);
  rib.rotation.z = a + Math.PI / 2;
  mrv.add(rib);
}
// Slotted muzzle brake - three fat ports per side, directional vents
const brake = mkTube(0.155, 0.14, 0.09, -0.4, darkMat);
mrv.add(brake);
for (const side of [-1, 1]) {
  for (let i = 0; i < 3; i += 1) {
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.02), boreMat);
    port.position.set(side * 0.13, 0.01 - i * 0.045, -0.4);
    port.rotation.z = side * 0.3;
    mrv.add(port);
  }
}
// Rotary drum - the cluster-shell magazine IS the silhouette
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.2, 12), darkMat);
drum.rotation.x = Math.PI / 2;
drum.position.set(0, -0.05, 0.08);
mrv.add(drum);
// Drum face rings - machined flange detail front and back
for (const z of [-0.02, 0.18]) {
  const flange = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.015, 8, 16), bodyMat);
  flange.position.set(0, -0.05, z);
  mrv.add(flange);
}
// Chamber windows + glowing shell noses - the volley is visibly LOADED
const shellTipMat = new THREE.MeshLambertMaterial({ color: 0xFF_55_18, emissive: 0x99_22_00 });
for (let i = 0; i < 6; i += 1) {
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
// Rear receiver + skeletal stock - twin rails to a slim butt pad
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

// Drum cannon should read BIG in the hand - it's the heaviest tube in
// the kit; every other launcher is built to ~1x and this reads thin.
mrv.scale.setScalar(1.25);
mrv.visible = false;
return mrv;
}

// Map is keyed by WeaponType, never positionally - Grenade/Slam/Melee
// have no gun model (belt throw / fist), so they map to nothing.

// Weapon 45 - howitzer: siege mortar. Reads as field artillery shrunk
// to the shoulder - mortar-fat bore, a slotted brake that VENTS the
// recoil sideways (the kick is the whole point), a 5-shell charge drum
// under the receiver (ammoCap reads on the silhouette), folded bipod
// and a spade plate at the heel for the deploy-to-fire read.
export function mkHowitzer(): THREE.Group {
const hw = new THREE.Group();
// Sliding barrel - artillery recoil: the whole front tube rides back
// into the receiver on the shot and slowly re-extends for the next one.
// Narrower than the body so it visibly telescopes. ViewModel drives
// the 'slide' child by name (same envelope family as the chain barrels).
const slide = new THREE.Group();
slide.name = 'barrels'; // bake keeps 'barrels' as a separate animated node
slide.userData.baseZ = 0;
slide.add(mkTube(0.18, 0.155, 1.24, -0.43, bodyMat)); // barrel - fat but still nests in the 0.21 sleeve
slide.add(mkTube(0.215, 0.185, 0.11, -0.98, bodyMat)); // muzzle flare at the long tip
slide.add(mkBore(0.16, -1.041));
// Recoil brake riding the slide - the collar alone sells the shape;
// slot ports were sub-pixel noise nobody could see.
slide.add(mkTube(0.2, 0.175, 0.075, -0.85, darkMat));
hw.add(slide);
// Receiver sleeve the barrel slides into - wider, stays put.
hw.add(mkTube(0.21, 0.21, 0.3, 0.12, bodyMat));
// Reinforcing bands - the siege-gun ring stack aft of the sleeve.
hw.add(mkTube(0.225, 0.225, 0.035, -0.03, darkMat));
hw.add(mkTube(0.225, 0.225, 0.035, 0.26, darkMat));
// Charge drum - five glowing shell noses in the window (5-round pool).
const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 12), bodyMat);
drum.rotation.z = Math.PI / 2;
drum.position.set(0, -0.13, 0.1);
hw.add(drum);
const chargeTipMat = new THREE.MeshLambertMaterial({ color: 0xFF_88_22, emissive: 0xBB_44_00 });
for (let i = 0; i < 5; i += 1) {
  const a = (i / 5) * Math.PI * 2;
  const cy = -0.13 + Math.sin(a) * 0.1;
  const cz = 0.1 + Math.cos(a) * 0.1;
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.165, 8), boreMat);
  hole.rotation.z = Math.PI / 2;
  hole.position.set(0, cy, cz);
  hw.add(hole);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), chargeTipMat);
  tip.position.set(0.083, cy, cz);
  hw.add(tip);
}
// Bipod legs folded forward - deploy hardware at rest.
for (const side of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.22), darkMat);
  leg.position.set(side * 0.12, -0.16, -0.16);
  leg.rotation.x = -0.35;
  hw.add(leg);
}
// Spade plate - the rear-heel recoil anchor a howitzer digs in with.
const spade = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.025), darkMat);
spade.position.set(0, -0.2, 0.24);
spade.rotation.x = 0.5;
hw.add(spade);
const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.2), bodyMat);
stock.position.set(0, -0.05, 0.24);
hw.add(stock);
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.06), darkMat);
grip.position.set(0, -0.17, 0.18);
grip.rotation.x = 0.35;
hw.add(grip);
// Heavy but not screen-filling - the sliding barrel does the "huge"
// read, not raw size.
hw.scale.setScalar(1.12);
hw.visible = false;
return hw;
}
