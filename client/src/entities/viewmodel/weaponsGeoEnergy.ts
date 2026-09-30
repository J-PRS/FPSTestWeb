import * as THREE from 'three';
import { bodyMat, darkMat, mkTube, mkBore } from './weaponKit.js';

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
export function mkPlasmaGun(): THREE.Group {
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
export function mkRailgun(): THREE.Group {
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
export function mkLightningGun(): THREE.Group {
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
