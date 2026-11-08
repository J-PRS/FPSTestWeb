import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../../core/config.js';
import { bodyMat, darkMat, boreMat, brassMat, mkTube, mkBore, mkLoft, mkAnnulus, profCircle, profOct, scaleRing, rotRing, resampleRing, notchRing } from './weaponKit.js';

// Energy-weapon builders — plasma, railgun, lightning. Split from
// weaponsGeo.ts; every builder returns an invisible group keyed into
// MODEL_BUILDERS there.

// Weapon 6 — plasma cannon: a fat energy projector, not a tube — heavy
// finned emitter head up front, glowing core slats behind it, capacitor
// bottle under the receiver. T2's plasma gun reads BULKY — the emitter
// dish is the widest thing on the model.
export function mkPlasmaCannon(): THREE.Group {
const plasma = new THREE.Group();
// Main body — shorter and much fatter than the old slim tube
plasma.add(mkTube(0.115, 0.13, 0.3, 0, bodyMat));
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
  new THREE.MeshBasicMaterial({ color: 0x33_FF_AA })
);
plasmaGlow.rotation.x = Math.PI / 2;
plasmaGlow.position.z = -0.332;
plasma.add(plasmaGlow);
// Cooling fins — four flat blades radiating off the emitter head, the
// silhouette detail that separates "energy projector" from "tube"
for (let i = 0; i < 4; i += 1) {
  const a = (i / 4) * Math.PI * 2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.14), darkMat);
  fin.position.set(Math.cos(a) * 0.115, Math.sin(a) * 0.115, -0.15);
  fin.rotation.z = a;
  plasma.add(fin);
}
// Core slats — green glow strips along the body so the energy read
// isn't only at the muzzle
for (let i = 0; i < 4; i += 1) {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  const slat = new THREE.Mesh(
    new THREE.BoxGeometry(0.015, 0.015, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x22_CC_88 })
  );
  slat.position.set(Math.cos(a) * 0.125, Math.sin(a) * 0.125, 0);
  plasma.add(slat);
}
// Capacitor bottle under the receiver — a fat cell slung low, same
// trick as the GL drum / sticky magazine: ammo you can see
const plasmaCell = mkTube(0.07, 0.07, 0.22, 0.05, darkMat);
plasmaCell.position.y = -0.13;
plasma.add(plasmaCell);
const plasmaCellGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.045, 0.045, 0.015, 10),
  new THREE.MeshBasicMaterial({ color: 0x33_FF_AA })
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

// Weapon — plasma gun v2 (Quake-style rapid bolts): a machined repeater.
// Chamfered lofted receiver feeding an open emitter cage — the blue core
// glows *inside* a dark cage, so the glow reads as depth, not a sticker.
export function mkPlasmaGun(): THREE.Group {
const pg = new THREE.Group();
const glowMat = new THREE.MeshBasicMaterial({ color: 0x44_BB_FF });
// Receiver — chamfered-rectangle loft, slight rear taper. The chamfers
// catch the rim light where the old tube read flat.
// Grooves are NOTCHED INTO the receiver profile — real machined channels
// that follow the taper, not strips laid on top.
let recv = profOct(0.2, 0.2, 0.04);
// Descending edge order — each notch grows the ring, so high edges first.
recv = notchRing(recv, 5, [[0.3, 0.4], [0.6, 0.7]], 0.008, 0.35); // left flank ×2
recv = notchRing(recv, 3, [[0.15, 0.25], [0.45, 0.55], [0.75, 0.85]], 0.008, 0.35); // top face ×3
recv = notchRing(recv, 1, [[0.3, 0.4], [0.6, 0.7]], 0.008, 0.35); // right flank ×2
pg.add(mkLoft([
  { z: 0.14, ring: scaleRing(recv, 0.9) },
  { z: -0.02, ring: recv },
  { z: -0.14, ring: scaleRing(recv, 0.85) },
], bodyMat));
// Emitter cage — three chamfered rails reach forward from the receiver
// face, carrying the collar. The hot core sits INSIDE the cage.
// Six prongs — one per hex-collar vertex. They start well inside the
// receiver (z=-0.06 < front cap -0.14) so every one seats into the body.
for (let i = 0; i < 6; i += 1) {
  const a = (i / 6) * Math.PI * 2;
  const dx = Math.cos(a) * 0.085, dy = Math.sin(a) * 0.085;
  const railP = profOct(0.026, 0.026, 0.006);
  pg.add(mkLoft([
    { z: -0.06, ring: railP, dx, dy },
    { z: -0.272, ring: railP, dx, dy },
    { z: -0.279, ring: scaleRing(railP, 1.5), dx, dy }, // ~45° flare, boss sits proud of the collar face
  ], darkMat));
  // Clamp rings — repair-tool hose ribs. Two per prong, sleeved over
  // the slim mid-run so they read as fasteners, not geometry noise.
  for (const rz of [-0.19, -0.25]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 4, 8), darkMat);
    rib.scale.z = 2.5; // fat band along the prong axis, same diameter
    rib.position.set(dx, dy, rz);
    pg.add(rib);
  }
}
// Collar — mkAnnulus hex ring with a real bore tunnel (no ExtrudeGeo,
// no texture weirdness). Emitter centered on the body axis — the slim
// prongs tuck inside the receiver silhouette without needing a drop.
pg.add(mkAnnulus(resampleRing(profCircle(0.115, 6), 12), profCircle(0.06, 12), -0.28, -0.32, darkMat));
// Core — the glow is recessed behind the collar so the cage silhouettes
// against it; a thin rod carries the "contained bolt" read.
const core = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12), glowMat);
core.rotation.x = Math.PI / 2;
core.position.set(0, 0, -0.145); // seated on the receiver face — the cage's lit backplane
pg.add(core);
// Grip — tapered hex handle like the flak, slight rake, under the
// receiver rear.
const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.028, 0.11, 6), darkMat);
grip.position.set(0, -0.135, 0.08);
grip.rotation.x = 0.3;
pg.add(grip);
// Butt pommel — squashed dome at the grip heel, parented so it inherits
// the rake (same trick as the flak handle).
const butt = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), darkMat);
butt.scale.y = 0.55;
butt.position.y = -0.058;
grip.add(butt);
// Underslung capacitor cell — the "repeater" read: visible charge
// storage feeding the emitter.
const cell = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.14), darkMat);
cell.position.set(0, -0.1, -0.06);
pg.add(cell);
const cellGlow = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.052, 0.02), glowMat);
cellGlow.position.set(0, -0.1, -0.06);
pg.add(cellGlow);
pg.scale.setScalar(1.4); // repeater read was too dainty — bulk it up
pg.visible = false;
return pg;
}

// Weapon 25 — Sprinkler: a chem douser, not a gun — pressurized goo
// tank feeding a sprinkler head. The silhouette is industrial garden
// hardware: fat reservoir up top, pump stub under the muzzle, and a
// perforated spray face weeping green.
export function mkSprinkler(): THREE.Group {
const sp = new THREE.Group();
const gooMat = new THREE.MeshBasicMaterial({ color: 0xAA_FF_66 });
// Reservoir tank — one fat cylinder muzzle-to-breech, domed rear cap.
// No necking: the douser reads as a pressurized can the whole way.
sp.add(mkTube(0.12, 0.13, 0.4, -0.04, bodyMat, 6));
const dome = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), bodyMat);
dome.scale.z = 0.45;
dome.position.z = 0.16;
sp.add(dome);
// Fill gauge — a dark bezel channel with the goo strip recessed inside,
// so it reads as a glassed-in sight gauge, not a glowing sticker.
const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.024, 0.24), brassMat);
bezel.position.set(0, 0.124, 0);
sp.add(bezel);
const gauge = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.014, 0.2), gooMat);
gauge.position.set(0, 0.13, 0);
sp.add(gauge);
// Side pods — two goo cells bulging left/right; in first person the
// silhouette edges are where detail lives.
for (const side of [-1, 1]) {
  const pod = mkTube(0.05, 0.05, 0.18, -0.02, darkMat);
  pod.position.x = side * 0.135;
  sp.add(pod);
  const podGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.02, 8), gooMat);
  podGlow.rotation.x = Math.PI / 2;
  podGlow.position.set(side * 0.135, 0, 0.075);
  sp.add(podGlow);
}
// Pressure dial — chunky analog gauge beside the sight glass, the
// pressurized-can tell. Brass housing, goo face.
const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.02, 10), brassMat);
dial.position.set(-0.06, 0.12, 0.12);
sp.add(dial);
const dialFace = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 10), gooMat);
dialFace.position.set(-0.06, 0.131, 0.12);
sp.add(dialFace);
// Rear iron notch only — brass to match the plumbing hardware. In
// first person this is what your eye lines up on.
const rearL = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), brassMat);
rearL.position.set(-0.025, 0.145, 0.14);
sp.add(rearL);
const rearR = rearL.clone();
rearR.position.x = 0.025;
sp.add(rearR);
// No front post — it's an area hose, not a precision weapon. The rear
// notch alone still gives the eye an anchor.
// Spray face — the tank's front end IS the sprinkler: a perforated
// plate across the full bore, goo glowing behind the holes. The fat
// brass rim collar frames it and silhouettes at the screen edge.
sp.add(mkTube(0.135, 0.135, 0.03, -0.235, brassMat));
sp.add(mkBore(0.11, -0.243));
const holeGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.09, 0.09, 0.015, 14),
  gooMat
);
holeGlow.rotation.x = Math.PI / 2;
holeGlow.position.z = -0.244;
sp.add(holeGlow);
for (let i = 0; i < 8; i += 1) {
  const a = (i / 8) * Math.PI * 2;
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.02, 6), boreMat);
  hole.rotation.x = Math.PI / 2;
  hole.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, -0.25);
  sp.add(hole);
}
// Heavier center nozzle — the plate reads as drilled hardware, not a
// uniform ring of vents.
const centerHole = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.02, 6), boreMat);
centerHole.rotation.x = Math.PI / 2;
centerHole.position.z = -0.25;
sp.add(centerHole);
// Pump stub slung under the tank — a small pressurizer cylinder.
const pump = mkTube(0.045, 0.045, 0.16, -0.05, darkMat);
pump.position.y = -0.14;
sp.add(pump);
const pumpGlow = new THREE.Mesh(
  new THREE.CylinderGeometry(0.03, 0.03, 0.015, 8),
  gooMat
);
pumpGlow.rotation.x = Math.PI / 2;
pumpGlow.position.set(0, -0.14, -0.135);
sp.add(pumpGlow);
// Grip tucked under the tank rear.
const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.05), darkMat);
grip.position.set(0, -0.13, 0.14);
grip.rotation.x = 0.25;
sp.add(grip);
sp.visible = false;
return sp;
}

// Weapon 7 — railgun: Q3's fat coil-cannon. Thick central bore, a stack
// of fat accelerator coils ribbing the barrel, glowing muzzle ring.
// The silhouette reads "industrial capacitor bank", not sniper rifle.
export function mkRailgun(): THREE.Group {
const rail = new THREE.Group();
// Q2 ref's read, round-first: a FAT CYLINDER receiver with a sunken top
// channel of glowing coils, then two tall prong blades off the front
// housing. The mass is tubular; only blades/cheeks are plates.

// Receiver — one fat tube, the gun's mass.
rail.add(mkTube(0.095, 0.1, 0.17, 0.035, bodyMat)); // half-length — front face still lands at -0.05
// Mid-body ring cut — the lathed crown collar read as a floating band.
// Rear drum + band cut — the drum read as a tail and the band (r 0.082)
// sat INSIDE the receiver skin, z-fighting through the surface.

// Trench cut — the cheek rails + glow slats sat proud on the crown and
// read as clutter against the fat-tube silhouette. Gone.

// Nose housing — fat ring the blades hang off; cylindrical like the
// body, taller feel from the blade height.
rail.add(mkTube(0.105, 0.115, 0.09, -0.12, darkMat));
// Brass spindle bridging nose↔receiver — slimmer than both so the gap
// still reads as a gap; it's the axle the nose hangs off, not a filler.
rail.add(mkTube(0.075, 0.075, 0.05, -0.055, brassMat));
// Three prongs around the bore — tapered hex-section tines on a 120°
// spread, the railgun's unmistakable read. Faceted cylinders give
// machined facets; flat slab blades read as planks.
const PRONG_R = 0.065; // chord ≈ 0.113 — head-on the brass caps read as three separate hexes
for (let i = 0; i < 3; i += 1) {
  const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
  const px = Math.cos(a) * PRONG_R, py = Math.sin(a) * PRONG_R; // cluster centered on the bore — no lift, bases kiss the nose face
  // Sized so the three hexes nearly kiss at the tips — chord between
  // centers ≈ 0.095 vs prong diameter 0.084: a tight cluster, not
  // scattered barrels.
  // Loft instead of cone: full 0.066 through the FRONT half, the taper
  // lives only in the back half — fat tip, slim root.
  // Bases bury into the nose ring face (-0.165) — floating prongs read
  // as glued-on.
  // Ring clocked by the prong's own angle so the hex vertex points
  // radially outward — same orientation CylinderGeometry used to land on.
  // Lengthwise groove down each flat face — profile notches, so the
  // channel runs the full blade including through the taper. Descending
  // edge order (each notch grows the ring).
  let hex = rotRing(profCircle(0.066, 6), a);
  for (let e = 5; e >= 0; e -= 1) {hex = notchRing(hex, e, [[0.35, 0.65]], 0.006, 0.3);}
  rail.add(mkLoft([
    { z: -0.165, ring: scaleRing(hex, 0.042 / 0.066), dx: px, dy: py },
    { z: -0.345, ring: hex, dx: px, dy: py },
    { z: -0.525, ring: hex, dx: px, dy: py },          // tip still fat
  ], bodyMat, false)); // uncapped — the throat opens INTO the blade; the root cap is buried in the nose anyway
  // Brass insulator cap — hex annulus, 6-sided bore at half radius.
  // The hole makes each tine read as a coil throat, not a brass plug.
  const tip = mkAnnulus(
    rotRing(profCircle(0.068, 6), a), rotRing(profCircle(0.034, 6), a),
    -0.525, -0.56, brassMat); // deep throat — the inner WALL is the tunnel read
  tip.position.set(px, py, 0);
  rail.add(tip);
  // Back-plate the throat — black hex disc at the tunnel's end, so the
  // bore reads as depth fading to shadow, not a flat black sticker.
  const plug = mkBore(0.034, -0.555);
  plug.rotation.y = Math.PI; // disc faces the muzzle (-Z)
  plug.position.x = px; plug.position.y = py;
  rail.add(plug);
}
// Emitter core cut — the floating glow rod read as a stray stick inside
// the prong cage; the brass tips carry the emitter read alone.
// Side cables cut — floating bent tubes read as loose sticks, not
// conduit. The receiver + nose carry the mass without them.
rail.scale.setScalar(1.44); // whole-gun +44% — reads as the heavy ordnance it is
rail.position.z = 0.12;    // scale pushed the muzzle forward; reclaim the gap
rail.visible = false;
return rail;
}

// Weapon 8 — lightning gun: a tesla fork, not a tube-with-prongs. The
// read that survives first person: a fat ceramic body ending in a brass
// crown, three tapered electrodes splaying out around a hot emitter
// node, and glow slits down the body so the weapon reads "charged"
// before it ever arcs.
export function mkLightningGun(): THREE.Group {
const lg = new THREE.Group();
const lgHotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xCF_EF_FF).multiplyScalar(EMIT_GAIN) });

// Insulated body — slimmer than before so the crown reads wider.
lg.add(mkTube(0.1, 0.12, 0.4, 0.06, bodyMat));
// Tesla coil stack wrapped on the rear half — brass winding between
// ceramic ribs is the "this gun stores charge" tell.
for (let i = 0; i < 4; i += 1) {
  lg.add(mkTube(0.125, 0.125, 0.014, 0 + i * 0.07, brassMat));
  lg.add(mkTube(0.122, 0.122, 0.03, 0.028 + i * 0.07, darkMat));
}
// Crown collar where the electrodes seat — barely wider than the
// insulator ring; the first-pass flare hid half the prongs in FPS view.
lg.add(mkTube(0.115, 0.105, 0.04, -0.15, darkMat));
lg.add(mkTube(0.12, 0.12, 0.016, -0.172, brassMat));

// Three electrodes splaying around the bore — base seated flush on the
// crown face, tips converging on the emitter node. The lean is solved
// numerically (RB base radius → RT tip radius over TILT) rather than by
// eyeballing a mid-air rotation, so every part actually touches.
const LEN = 0.26, TILT = 0.12;
const RB = 0.105, RT = RB - Math.sin(TILT) * LEN;      // radial: base → tip
const ZB = -0.175, ZT = ZB - Math.cos(TILT) * LEN;     // axial: base → tip
const ZMID = (ZB + ZT) / 2, RMID = (RB + RT) / 2;
for (let i = 0; i < 3; i += 1) {
  const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
  const fork = new THREE.Group();
  fork.rotation.z = a - Math.PI / 2; // local +y = radial outward
  // Ceramic insulator socket the rod grows out of
  const ins = mkTube(0.035, 0.042, 0.06, ZB + 0.01, darkMat);
  ins.position.y = RB;
  fork.add(ins);
  const rod = mkTube(0.018, 0.01, LEN, 0, brassMat);
  rod.position.set(0, RMID, ZMID);
  // mkTube already lays the cylinder along Z via rotation.x=π/2 — the
  // lean composes ON TOP of that or the rod snaps back upright.
  rod.rotation.x = Math.PI / 2 - TILT;
  fork.add(rod);
  // Metal tip ball — the electrode cap, not a charge node. The only
  // electric glow is the emitter core between the prongs.
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), brassMat);
  tip.position.set(0, RT, ZT);
  fork.add(tip);
  lg.add(fork);
}
const EMITTER_Z = ZT - 0.01;
// Emitter node — small hot core plus a fainter corona so the muzzle
// glows without a fat opaque ball swallowing the prong tips.
const core = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), lgHotMat);
core.position.z = EMITTER_Z;
core.layers.enable(BLOOM_LAYER);
lg.add(core);
const corona = new THREE.Mesh(
  new THREE.SphereGeometry(0.045, 12, 10),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0x66_C8_FF).multiplyScalar(EMIT_GAIN), transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
);
corona.position.z = EMITTER_Z;
corona.layers.enable(BLOOM_LAYER);
lg.add(corona);
// Side glow slits removed — read as floating shards flanking the body.
lg.visible = false;
return lg;
}

// Shocklance — the power spear. A hafted emitter-lance: wrapped charge
// coils up the grip, a socket collar, two VERTICAL electrodes swept 45°
// forward off the hub (up and down — they read as the source of the
// zap), and a real spearblade down the middle with a glow fuller.
export function mkShocklance(): THREE.Group {
const ln = new THREE.Group();
const lnHotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xB0_80_FF).multiplyScalar(EMIT_GAIN) });
const lnAmberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xFF_C0_50).multiplyScalar(EMIT_GAIN) });

// Haft — slimmer than a gun body, it reads as a spear shaft, not a bore.
// Reaches back under the socket collar — the short 0.55 shaft left the
// whole head assembly (collar/rods/blade) floating ~10cm off the grip.
ln.add(mkTube(0.045, 0.055, 0.75, 0, bodyMat));
// Charge coils — brass wraps stacked along the grip half: the "stored
// energy" tell shared with the LG's tesla stack.
for (let i = 0; i < 5; i += 1) {
  ln.add(mkTube(0.058, 0.058, 0.012, -0.02 + i * 0.055, brassMat));
}
// Charge slits — two hot grooves along the haft, violet.
for (const s of [-1, 1]) {
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.26), lnHotMat);
  slit.position.set(s * 0.053, 0, 0.12);
  ln.add(slit);
}
// Socket collar where the shaft meets the head — the flare a spear's
// blade seats into.
ln.add(mkTube(0.048, 0.034, 0.05, -0.3, brassMat));

// Emitter rods — the two electrodes that source the zap. Held like the
// pull-out reads it: VERTICAL — one rod up, one down, each swept ~45°
// off the bore so the head is a vertical forked emitter, amber cap
// nodes hot at the tips the bolt issues from.
for (const s of [-1, 1]) {
  const wing = new THREE.Group();
  wing.rotation.x = -s * Math.PI / 4;   // tip arcs forward toward the bore
  wing.position.z = -0.31;
  const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.036, 0.05, 8), darkMat);
  ins.position.y = s * 0.05;            // cylinder's own axis IS Y
  wing.add(ins);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.017, 0.17, 8), brassMat);
  if (s < 0) {rod.rotation.z = Math.PI;} // taper: fat root → thin tip out
  rod.position.y = s * 0.14;
  wing.add(rod);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), lnAmberMat);
  tip.position.y = s * 0.235;
  tip.layers.enable(BLOOM_LAYER);
  wing.add(tip);
  ln.add(wing);
}

// Central spearblade — a flattened diamond section lofted to a true
// point: the actual metal tip between the two rods — a vertical fork,
// blade flanked by electrodes.
const blade = profOct(0.1, 0.09, 0.01); // 3x the X width - the "thicker" read won on review
ln.add(mkLoft([
  { z: -0.38, ring: blade }, // seats past the haft end (-0.375) - the wide blade clipped into the shaft
  { z: -0.6, ring: scaleRing(blade, 0.85) },
  { z: -0.95, point: [0, 0] },
], bodyMat));
// Fuller glow slit up the blade's midrib — the charge lives in the
// metal too, not only in the emitter ball.
const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.016, 0.5), lnHotMat);
fuller.position.set(0, 0, -0.56);
ln.add(fuller);

// Emitter node — the plasma charge at the hub where blade meets guard:
// violet core + corona (the LG's ball recipe, recolored to the lance
// palette).
const EMITTER_Z = -0.34;
const core = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), lnHotMat);
core.position.z = EMITTER_Z;
core.layers.enable(BLOOM_LAYER);
ln.add(core);
const corona = new THREE.Mesh(
  new THREE.SphereGeometry(0.05, 12, 10),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8A_50_FF).multiplyScalar(EMIT_GAIN), transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
);
corona.position.z = EMITTER_Z;
corona.layers.enable(BLOOM_LAYER);
ln.add(corona);
// Pull-out melee reads bigger + closer — same FPS treatment as the
// blaster/pistol so the head isn't out of frame.
ln.scale.setScalar(1.15);
ln.position.z = -0.08;
ln.visible = false;
return ln;
}
