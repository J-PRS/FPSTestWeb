import * as THREE from 'three';
import { bodyMat, darkMat, mkTube } from './weaponKit.js';

// Sidearm + tool builders — compact silhouettes so the hold-out swap
// reads instantly. Split from weaponsGeo.ts; builders return invisible
// groups keyed into MODEL_BUILDERS there.

// Pistol: slide + stubby barrel + raked grip.
export function mkPistol(): THREE.Group {
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
export function mkRevolver(): THREE.Group {
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

// Repair tool — a field welder, not a firearm. No barrel, no bore: the
// read is a chunky insulated handpiece, a ceramic cone nozzle with a
// hot green emitter tip, focusing claws, and a gas canister slung
// underneath. The beam color (0x7dffb8) is the only glow it needs.
export function mkRepair(): THREE.Group {
const rep = new THREE.Group();
const weldGlow = new THREE.MeshBasicMaterial({ color: 0x7dffb8 }); // matches the repair beam
const cableMat = new THREE.MeshLambertMaterial({ color: 0xcc6a1a, emissive: 0x2a1204 });
// T:A repair tool language: an industrial BRICK, not a gun — two boxy
// housings bridged by exposed orange cabling, dark octagonal emitter
// face plate up front, green guts visible in the gap. The silhouette
// reads "handheld scanner/welder", nothing barrel-shaped anywhere.
const front = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.14), bodyMat);
front.position.set(0, 0.03, -0.09);
rep.add(front);
const rear = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.14), bodyMat);
rear.position.set(0, 0.03, 0.1);
rep.add(rear);
// Octagonal emitter plate — the front face of the tool, wider than the
// housing like the T:A dish. Beam springs from its center.
const face = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 8), darkMat);
face.rotation.x = Math.PI / 2;
face.position.set(0, 0.03, -0.175);
rep.add(face);
const faceGlow = new THREE.Mesh(new THREE.CircleGeometry(0.045, 8), weldGlow);
faceGlow.rotation.y = Math.PI;
faceGlow.position.set(0, 0.03, -0.192);
rep.add(faceGlow);
const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.025, 6), weldGlow);
tip.rotation.x = Math.PI / 2;
tip.position.set(0, 0.03, -0.2);
rep.add(tip);
// Green guts in the gap between housings — the internals show where
// the body splits, like the ref's green bay between the plates.
const bay = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.06),
  new THREE.MeshLambertMaterial({ color: 0x1a3a28, emissive: 0x0a2a14 }));
bay.position.set(0, 0.03, 0.0);
rep.add(bay);
// Exposed orange cabling bridging front↔rear — THE detail that kills
// the gun read. Ribbed: two strands along each flank.
for (const side of [-1, 1]) {
  for (const yOff of [0.0, 0.06]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.16, 6), cableMat);
    cable.rotation.x = Math.PI / 2;
    cable.position.set(side * 0.045, 0.03 + yOff, 0.0);
    rep.add(cable);
    // cable ribs — tiny rings, the corrugated-hose look
    for (let i = 0; i < 4; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.013, 0.004, 4, 8), darkMat);
      rib.position.set(side * 0.045, 0.03 + yOff, -0.06 + i * 0.04);
      rep.add(rib);
    }
  }
}
// Top vent grid — the ref's perforated panel: short dark slats along
// the front housing's top face.
for (let i = 0; i < 3; i++) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.09), darkMat);
  vent.position.set(-0.035 + i * 0.035, 0.108, -0.09);
  rep.add(vent);
}
// Grip under the rear housing — steep rake, drill-style; the tool
// overhangs it forward like a scanner.
const repGrip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.075), darkMat);
repGrip.position.set(0, -0.06, 0.1);
repGrip.rotation.x = 0.3;
rep.add(repGrip);
const repGuard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.07), darkMat);
repGuard.position.set(0, -0.045, 0.0);
rep.add(repGuard);
rep.visible = false;
return rep;
}
