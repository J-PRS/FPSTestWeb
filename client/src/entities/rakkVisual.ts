import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const PART_BODY = 0;
const PART_CREST = 1;   // bony plate along the flat head — the bright accent
const PART_WING_IN = 2; // 2 per rakk — arm segment (shoulder→wrist)
const PART_WING_OUT = 3;// 2 per rakk — hand fan: ragged membrane + struts
const PART_TAIL = 4;    // whip tail + talon hook — THE rakk signature
const PART_EYE = 5;     // 2 per rakk — glow quads
const WINGS_PER = 2;
const EYES_PER = 2;

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _inner = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Body = lean torso + flat wedge head + long pointed snout fused into ONE
// part. A rakk reads as a coatl/pterosaur — small slender body, snaky —
// not a blob. The snout IS the face: flat fleshy head tapering to a point.
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    const torso = new THREE.IcosahedronGeometry(1, 1);
    torso.scale(0.42, 0.34, 1.15); // skinny barrel — rakks are lean
    const head = new THREE.IcosahedronGeometry(0.42, 1);
    head.scale(0.66, 0.3, 0.9);  // flat, wide head plate
    head.translate(0, 0.14, 1);
    const snout = new THREE.ConeGeometry(0.2, 0.9, 4);
    snout.rotateX(Math.PI / 2);
    snout.scale(1.6, 0.55, 1);   // flattened wedge, not a round beak
    snout.translate(0, 0.1, 1.55);
    // Tail-base taper — the whip roots INTO this so there's no gap
    // between torso rear and the tail part.
    const rump = new THREE.ConeGeometry(0.18, 0.8, 5);
    rump.rotateX(-Math.PI / 2);
    rump.translate(0, -0.02, -1.4);
    // Icosahedra are non-indexed, cones are indexed — mergeGeometries
    // refuses the mix (returned null → swarm mesh with no geometry).
    _bodyGeo = mergeGeometries([torso, head, snout.toNonIndexed(), rump.toNonIndexed()])!;
  }
  return _bodyGeo;
}

// Crest — bony plate ridge on the flat head, swept back. Brighter than
// the hide; it's the color flash that reads at distance.
const _crestGeo = new THREE.ConeGeometry(0.16, 0.7, 4);
{
  _crestGeo.scale(0.7, 1, 0.25); // blade-thin
  _crestGeo.rotateX(-Math.PI / 2.4); // swept back off the brow
  _crestGeo.translate(0, 0.32, 0.9);
}

// Wing inner segment — the arm: narrow, thick enough to catch light,
// wide at the shoulder so it overlaps the torso (no floating wing gap),
// tapering spanwise toward the wrist like a real arm bone.
const _wingInGeo = new THREE.BoxGeometry(1.1, 0.06, 0.9);
{
  const pos = _wingInGeo.attributes.position!;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i), z = pos.getZ(i);
    const t = Math.min(1, Math.max(0, x + 0.55)); // 0 at root → 1 at wrist
    if (z < 0) {pos.setZ(i, z * (1 - t * 0.45));} // trailing edge shortens
    pos.setY(i, pos.getY(i) * (1 - t * 0.4));   // arm thins toward wrist
  }
  _wingInGeo.computeVertexNormals();
  _wingInGeo.translate(0.55, 0, 0); // pivot at the shoulder
}

// Wing outer — the hand fan: ragged membrane outline with finger struts
// baked in. Rakks/coatl wings are long and pointed with torn trailing
// edges — deeper scallops and a swept tip, less uniform than a bat's.
let _wingOutGeo: THREE.BufferGeometry | null = null;
function wingOutGeo(): THREE.BufferGeometry {
  if (!_wingOutGeo) {
    const s = new THREE.Shape();
    // Shape XY: x = spanwise out, y = chord (+y = leading/front edge)
    s.moveTo(0, 0.45);                     // leading edge at the wrist
    // Curved leading edge — a slight bow out to the tip reads organic;
    // a straight edge reads like a plank.
    s.quadraticCurveTo(0.9, 0.62, 1.9, 0.3);
    // Ragged trailing edge — deep tears between finger anchors
    s.quadraticCurveTo(1.7, -0.25, 1.25, -0.35);  // tear behind the tip
    s.quadraticCurveTo(0.95, -0.02, 0.6, -0.55);  // deep scallop finger 2
    s.quadraticCurveTo(0.38, -0.18, 0.12, -0.6);  // deep scallop finger 1
    s.lineTo(0, -0.55);                    // trailing edge meets the wrist
    s.closePath();
    const memb = new THREE.ShapeGeometry(s, 6);
    // Finger struts — thin quads fanning from the wrist to each scallop
    // point; merged in so they share the part's material and instance.
    const fingers: [number, number][] = [[1.9, 0.3], [1.25, -0.35], [0.6, -0.55]];
    const struts = fingers.map(([fx, fy]) => {
      const len = Math.hypot(fx - 0.05, fy - 0.35);
      const g = new THREE.BoxGeometry(len, 0.05, 0.03);
      const a = Math.atan2(fy - 0.35, fx - 0.05);
      g.rotateZ(a);
      g.translate(0.05 + Math.cos(a) * len / 2, 0.35 + Math.sin(a) * len / 2, 0.01);
      return g;
    });
    _wingOutGeo = mergeGeometries([memb, ...struts])!;
    _wingOutGeo.rotateX(Math.PI / 2); // shape +y → +z (leading edge forward)
  }
  return _wingOutGeo;
}

// Tail = long whip + hooked talon — how a rakk clings to rock and what it
// lacerates you with on a pass. One part; the writer waves it.
let _tailGeo: THREE.BufferGeometry | null = null;
function tailGeo(): THREE.BufferGeometry {
  if (!_tailGeo) {
    const whip = new THREE.ConeGeometry(0.12, 1.7, 5);
    whip.rotateX(-Math.PI / 2); // point backward (-z)
    whip.translate(0, 0, -0.85);
    const talon = new THREE.ConeGeometry(0.09, 0.45, 4);
    talon.rotateX(Math.PI * 0.7); // hook curves up/forward at the tip
    talon.translate(0, 0.1, -1.75);
    _tailGeo = mergeGeometries([whip.toNonIndexed(), talon.toNonIndexed()])!;
  }
  return _tailGeo;
}

const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _crestMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function rakkParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF });}
  // Membrane runs LIGHTER than the hide — a dark wing on dark sky reads as
  // a void. Warm leather catches rim light and separates from the body.
  if (!_wingMat) {_wingMat = new THREE.MeshLambertMaterial({ color: 0x8A_5A_58, side: THREE.DoubleSide });}
  // Bone crest — fixed pale bone tone, deliberately not tinted by species
  // color so it stays a bright accent against the hide.
  if (!_crestMat) {_crestMat = new THREE.MeshLambertMaterial({ color: 0xD8_C9_A0, side: THREE.DoubleSide });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xFF_E0_66, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _crestGeo, material: _crestMat },
    { geometry: _wingInGeo, material: _wingMat, per: WINGS_PER },
    { geometry: wingOutGeo(), material: _wingMat, per: WINGS_PER },
    { geometry: tailGeo(), material: _bodyMat },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/** Flat fields the swarm write reads — Rakk keeps them public. */
export interface RakkVisHost {
  hasSlots: boolean;
  swarmSlot: number;
  radius: number;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  flash: number;
  animT: number;
  state: 'orbit' | 'dive' | 'climb';
  color: THREE.Color;
}

// Flap amplitude+rate by state — dive folds the wings, climb rows hard.
function wingbeat(r: RakkVisHost): number {
  const dive = r.state === 'dive';
  const flapAmp = dive ? 0.12 : r.state === 'climb' ? 1 : 0.55;
  const flapRate = dive ? 3 : r.state === 'climb' ? 13 : 6;
  return Math.sin(r.animT * flapRate) * flapAmp;
}

export function writeRakkInstances(r: RakkVisHost): void {
  if (!r.hasSlots) {return;}
  const swarm = getSwarm('rakk');
  if (!swarm) {return;}
  const slot = r.swarmSlot;
  const {radius} = r;

  _e.set(r.pitch, r.yaw, r.roll, 'YXZ');
  _q.setFromEuler(_e);
  _s.setScalar(radius);
  _p.copy(r.pos);
  _root.compose(_p, _q, _s);

  const fr = r.flash > 0 ? 4 : 1;
  const cr = r.color.r * fr, cg = r.color.g * fr, cb = r.color.b * fr;
  swarm.setMatrix(PART_BODY, slot, _root);
  swarm.setColor(PART_BODY, slot, cr, cg, cb);
  swarm.setMatrix(PART_CREST, slot, _root);

  const flap = wingbeat(r);
  // Two-joint wing: the arm rolls with the beat, the hand fan folds
  // further — dive sweeps both back into a dart silhouette.
  const fold = r.state === 'dive' ? 1 : 0;
  for (let i = 0; i < WINGS_PER; i += 1) {
    const side = i === 0 ? -1 : 1;
    // Arm: rooted INSIDE the torso (wide root overlaps the hide — no gap),
    // slight forward rake + roll with the flap, sweeps back on the dive
    _e.set(-0.1, side * (0.12 - fold * 0.55), side * (flap * 0.55 + fold * 0.35), 'YXZ');
    _q.setFromEuler(_e);
    // side-scaled local matrix mirrors the right-wing geometry for the
    // left — negative-X scale flips winding but wingMat is DoubleSide.
    _local.compose(_p.set(side * 0.16, 0.12, 0.25), _q, _s.set(side, 1, 1));
    _inner.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_WING_IN, slot * WINGS_PER + i, _inner);
    swarm.setColor(PART_WING_IN, slot * WINGS_PER + i, cr * 0.9 + 0.1, cg * 0.9 + 0.08, cb * 0.9 + 0.09);

    // Hand fan: hangs off the arm tip (local x=1.1), folds harder than
    // the arm — the wrist break is what sells the wing mid-beat.
    // The arm's matrix already carries the -X mirror, so the fan euler
    // is IDENTICAL both sides (no side terms) — flipping again would
    // double-negate the wrist and flap the wings asymmetrically.
    _e.set(-0.15 - fold * 0.5, -(0.2 + fold * 0.4), flap * 0.9 + fold * 0.9, 'YXZ');
    _q.setFromEuler(_e);
    // Offset in the (mirrored) arm frame — the fan inherits the flip.
    _local.compose(_p.set(1.1, 0, 0), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_inner, _local);
    swarm.setMatrix(PART_WING_OUT, slot * WINGS_PER + i, _world);
    swarm.setColor(PART_WING_OUT, slot * WINGS_PER + i, cr * 0.85 + 0.15, cg * 0.85 + 0.12, cb * 0.85 + 0.13);
  }

  // Whip tail — trails behind, lazy S-wave; on a dive it streams straight
  // so the talon reads as a stinger rather than a rudder.
  const sway = Math.sin(r.animT * 2.2) * (1 - fold) * 0.25;
  _e.set(-0.08 + Math.sin(r.animT * 2.2 + 0.9) * 0.15, sway, 0);
  _q.setFromEuler(_e);
  _local.compose(_p.set(0, -0.02, -1.05), _q, _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_TAIL, slot, _world);
  swarm.setColor(PART_TAIL, slot, cr * 0.85, cg * 0.85, cb * 0.85);

  // Eyes — small glow quads on either side of the flat head
  for (let i = 0; i < EYES_PER; i += 1) {
    const side = i === 0 ? -1 : 1;
    _e.set(0, side * 0.55, 0);
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.24, 0.16, 1.15), _q, _s.setScalar(0.12));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
  }

  getShadows()?.set(r as never, r.pos, radius * 1.6, 0.28);
}
