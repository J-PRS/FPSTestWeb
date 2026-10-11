import * as THREE from 'three';
import { bodyMat, darkMat, mkTube } from './weaponKit.js';

// Sidearm + tool builders — compact silhouettes so the hold-out swap
// reads instantly. Split from weaponsGeo.ts; builders return invisible
// groups keyed into MODEL_BUILDERS there.

// Pistol: chunky combat autopistol — squarish slide over a railed dust
// cover, beavertail grip, light rail under the muzzle. The read is a
// USP/M&P silhouette: slide slab on top, everything else low.
export function mkPistol(): THREE.Group {
const pistol = new THREE.Group();
const BORE_Y = 0.045;
// Barrel — only a hint past the slide's muzzle face.
const pBarrel = mkTube(0.022, 0.022, 0.06, -0.16, darkMat);
pBarrel.position.y = BORE_Y;
pistol.add(pBarrel);
const pBore = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 8), darkMat);
pBore.rotation.x = Math.PI / 2;
pBore.position.set(0, BORE_Y, -0.192);
pistol.add(pBore);
// Slide — the big slab. Chamfered edges so it reads machined; detail
// parts stay sharp — chamfered serrations/rails just look melted.
const slide = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.26), bodyMat);
slide.position.set(0, 0.055, -0.06);
pistol.add(slide);
const spine = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.24), darkMat);
spine.position.set(0, 0.088, -0.06);
pistol.add(spine);
// Front + rear slide serrations.
for (const base of [-0.16, 0.05]) {
  for (let i = 0; i < 4; i += 1) {
    const serr = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.04, 0.01), darkMat);
    serr.position.set(0, 0.055, base + i * 0.016);
    pistol.add(serr);
  }
}
// Frame — lower body under the slide; chamfered like the slide.
const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.22), darkMat);
pFrame.position.set(0, 0, -0.03);
pistol.add(pFrame);
// Accessory rail under the muzzle — the two-slot Picatinny stub.
const railP = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.09), darkMat);
railP.position.set(0, -0.033, -0.12);
pistol.add(railP);
for (let i = 0; i < 2; i += 1) {
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.022, 0.008), darkMat);
  slot.position.set(0, -0.033, -0.14 + i * 0.035);
  pistol.add(slot);
}
// Trigger guard — real bow: front strap + bottom rail + rear corner.
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
// Grip — autopistol rake: straighter than a revolver, ~15° back.
// Extruded profile again: flat front strap, convex backstrap, squared butt.
const gripMat = new THREE.MeshLambertMaterial({ color: 0x33_36_2F, emissive: 0x0B_0C_0A });
const gs = new THREE.Shape();
gs.moveTo(0, 0);
gs.lineTo(-0.005, -0.11);                        // front strap — near vertical
gs.quadraticCurveTo(0.005, -0.135, 0.03, -0.14); // front butt corner
gs.lineTo(0.065, -0.14);                         // butt flat
gs.quadraticCurveTo(0.075, -0.13, 0.07, -0.09);  // rear butt corner
gs.lineTo(0.05, -0.005);                         // backstrap — the raked edge
gs.lineTo(0, 0);
const gripGeo = new THREE.ExtrudeGeometry(gs, { depth: 0.055, steps: 3, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2 });
const pGrip = new THREE.Mesh(gripGeo, gripMat);
pGrip.rotation.y = -Math.PI / 2;
pGrip.position.set(0.028, -0.02, 0.08);
pistol.add(pGrip);
// Sights — front blade + rear notch block.
const pSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.014), darkMat);
pSight.position.set(0, 0.1, -0.165);
pistol.add(pSight);
const pRear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.02), darkMat);
pRear.position.set(0, 0.098, 0.055);
pistol.add(pRear);
pistol.visible = false;
return pistol;
}

// Revolver: the Samaritan — Hellboy's thumper. Everything oversized:
// a fat octagonal barrel shroud, a dinner-plate cylinder, slab-sided
// frame, big curled hammer. Reads as a hand mortar, not a cowboy gun.
export function mkRevolver(): THREE.Group {
const revolver = new THREE.Group();
// Bore line rides at the TOP of the cylinder (12-o'clock chamber), not
// through its center — the barrel sits up on the frame. Samaritan is a
// STEPPED ROUND barrel — ring sections shrinking toward the muzzle —
// under a long squared top rib, not a faceted shroud.
const BORE_Y = 0.055;
// hseg=3 on the long sections — one-ring tubes bake flat-black when a
// rim ring occludes them (AO resolves per-vertex along the length).
const bseg = (r1: number, r2: number, len: number, z: number): void => {
  const t = mkTube(r1, r2, len, z, bodyMat, 3);
  t.position.y = BORE_Y;
  revolver.add(t);
};
bseg(0.06, 0.056, 0.09, -0.055);  // chamber-end section, fattest
bseg(0.056, 0.056, 0.012, -0.105);// step ring
bseg(0.052, 0.052, 0.08, -0.15);  // mid section
bseg(0.056, 0.056, 0.012, -0.196);// step ring
bseg(0.048, 0.048, 0.08, -0.24);  // muzzle section
// Top rib — the long squared rail that gives the prop its slab top.
const rib = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.022, 0.26), bodyMat);
rib.position.set(0, BORE_Y + 0.058, -0.145);
revolver.add(rib);
// Forcing cone — the barrel's breech necks down where it meets the
// cylinder face, leaving the visible cylinder gap.
const cone = mkTube(0.048, 0.04, 0.035, -0.005, bodyMat);
cone.position.y = BORE_Y;
revolver.add(cone);
// Muzzle crown + dark bore.
const crown = mkTube(0.056, 0.056, 0.012, -0.286, darkMat);
crown.position.y = BORE_Y;
revolver.add(crown);
const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 10), darkMat);
bore.rotation.x = Math.PI / 2;
bore.position.set(0, BORE_Y, -0.293);
revolver.add(bore);
// Underlug + ejector rod — the rib under the barrel, rides the frame
// line not the bore axis.
const lug = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.24), darkMat);
lug.position.set(0, BORE_Y - 0.065, -0.145);
revolver.add(lug);
const rod = mkTube(0.012, 0.012, 0.2, -0.145, bodyMat);
rod.position.y = BORE_Y - 0.065;
revolver.add(rod);
// Massive cylinder — top chamber dead on the bore line; frame webs
// bridge the gap between drum and barrel underlug.
const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.075, 10), bodyMat);
cyl.rotation.x = Math.PI / 2; // drum axis runs fore-aft, not sideways
cyl.position.set(0, 0.008, 0.045);
revolver.add(cyl);
// Flutes — fore-aft grooves ringing the drum in the XY plane (drum
// axis is Z, so the grooves radiate around it, each rotated to face out).
for (let i = 0; i < 8; i += 1) {
  const a = (i / 8) * Math.PI * 2;
  const flute = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.08), darkMat);
  flute.position.set(Math.cos(a) * 0.058, 0.008 + Math.sin(a) * 0.058, 0.045);
  flute.rotation.z = -a;
  revolver.add(flute);
}
// Slab frame — topstrap bridges over the cylinder into the barrel root,
// plus a front web tying the underlug back to the cylinder face so the
// barrel assembly doesn't read as floating above the drum.
const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.028, 0.14), bodyMat);
strap.position.set(0, 0.062, 0.045);
revolver.add(strap);
const web = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.075, 0.03), bodyMat);
web.position.set(0, -0.02, -0.005);
revolver.add(web);
const frame = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.065, 0.12), bodyMat);
frame.position.set(0, 0, 0.1);
revolver.add(frame);
// Trigger guard bow + trigger.
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.014, 0.07), darkMat);
guard.position.set(0, -0.055, 0.075); // under the frame, ahead of the grip tang
revolver.add(guard);
const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.03, 0.015), darkMat);
trigger.position.set(0, -0.045, 0.085);
trigger.rotation.x = 0.3;
revolver.add(trigger);
// Big curled hammer — the silhouette's rear spike.
const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.03), darkMat);
hammer.position.set(0, 0.075, 0.15);
hammer.rotation.x = -0.4;
revolver.add(hammer);
const spur = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.03, 0.045), darkMat);
spur.position.set(0, 0.1, 0.165);
spur.rotation.x = -0.9;
revolver.add(spur);
// Grip — a real plowhandle profile, extruded. Schofield-pattern grips
// are a smooth convex sweep (narrow at the frame junction, swelling at
// the palm, rounding into the butt) — stacked rotated boxes will never
// read as a grip; the silhouette curve is the whole trick. Drawn in
// the YZ plane (x = backward along +Z, y = down is -Y), extruded thick.
const gripMat = new THREE.MeshLambertMaterial({ color: 0x5A_3D_28, emissive: 0x14_0C_06 });
const gripShape = new THREE.Shape();
// Shape x = backward (+Z after the Y-rotation below), y = down (-Y).
gripShape.moveTo(0, 0);                                       // top front at frame junction
gripShape.quadraticCurveTo(-0.01, -0.06, 0.005, -0.1);       // front strap falls, sweeps back
gripShape.quadraticCurveTo(-0.01, -0.125, 0.035, -0.14);      // round the front butt corner
gripShape.quadraticCurveTo(0.07, -0.145, 0.085, -0.115);      // butt bottom rounds up
gripShape.quadraticCurveTo(0.1, -0.07, 0.065, -0.01);        // long convex backstrap sweep
gripShape.lineTo(0, 0);                                       // close along the frame seat
const gripGeo = new THREE.ExtrudeGeometry(gripShape, { depth: 0.055, steps: 3, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 });
const rGrip = new THREE.Mesh(gripGeo, gripMat);
rGrip.rotation.y = -Math.PI / 2; // shape-x → world +Z (backward), extrusion → -X
rGrip.position.set(0.0315, -0.025, 0.12); // centered on the bore axis, seated under the frame rear
revolver.add(rGrip);
// Tall front sight blade — the Samaritan runs a prominent ramp sight.
const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.035, 0.02), darkMat);
rSight.position.set(0, 0.135, -0.245); // atop the barrel rib
revolver.add(rSight);
const rRear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.028, 0.02), darkMat);
rRear.position.set(0, 0.089, 0.06); // seated on the topstrap — was floating 5mm over it
revolver.add(rRear);
revolver.visible = false;
return revolver;
}

// Repair tool — a field welder, not a firearm. No barrel, no bore: the
// read is a chunky insulated handpiece, a ceramic cone nozzle with a
// hot green emitter tip, focusing claws, and a gas canister slung
// underneath. The beam color (0x7dffb8) is the only glow it needs.
export function mkRepair(): THREE.Group {
const rep = new THREE.Group();
const weldGlow = new THREE.MeshBasicMaterial({ color: 0x7D_FF_B8 }); // matches the repair beam
const cableMat = new THREE.MeshLambertMaterial({ color: 0xCC_6A_1A, emissive: 0x2A_12_04 });
// T:A repair tool language: an industrial handpiece, not a gun — two
// octagonal housings (same faceting as the emitter plate) bridged by
// exposed orange cabling, green guts visible in the gap. Cylinders
// standing on Z kill the shoebox read the old BoxGeometry pair had.
const front = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.14, 8), bodyMat);
front.rotation.x = Math.PI / 2;
front.position.set(0, 0.03, -0.09);
rep.add(front);
const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.14, 8), bodyMat);
rear.rotation.x = Math.PI / 2;
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
  new THREE.MeshLambertMaterial({ color: 0x1A_3A_28, emissive: 0x0A_2A_14 }));
bay.position.set(0, 0.03, 0);
rep.add(bay);
// Exposed orange cabling bridging front↔rear — THE detail that kills
// the gun read. Ribbed: two strands along each flank.
for (const side of [-1, 1]) {
  for (const yOff of [0, 0.06]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.16, 6), cableMat);
    cable.rotation.x = Math.PI / 2;
    cable.position.set(side * 0.045, 0.03 + yOff, 0);
    rep.add(cable);
    // cable ribs — tiny rings, the corrugated-hose look
    for (let i = 0; i < 4; i += 1) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.013, 0.004, 4, 8), darkMat);
      rib.position.set(side * 0.045, 0.03 + yOff, -0.06 + i * 0.04);
      rep.add(rib);
    }
  }
}
// Top vent grid — the ref's perforated panel: short dark slats along
// the front housing's top face.
for (let i = 0; i < 3; i += 1) {
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.09), darkMat);
  vent.position.set(-0.035 + i * 0.035, 0.104, -0.09);
  rep.add(vent);
}
// Grip under the rear housing — steep rake, drill-style; the tool
// overhangs it forward like a scanner.
const repGrip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.075), darkMat);
repGrip.position.set(0, -0.06, 0.1);
repGrip.rotation.x = 0.3;
rep.add(repGrip);
const repGuard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.07), darkMat);
repGuard.position.set(0, -0.045, 0);
rep.add(repGuard);
rep.visible = false;
return rep;
}
