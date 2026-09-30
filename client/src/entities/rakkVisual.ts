import * as THREE from 'three';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const PART_BODY = 0;
const PART_EAR = 1;  // 2 per rakk — big pointed bat ears
const PART_WING = 2; // 2 per rakk — membrane wings
const PART_MEMB = 3; // rear membrane between the legs
const PART_EYE = 4;  // 2 per rakk — glow quads
const WINGS_PER = 2;
const EARS_PER = 2;
const EYES_PER = 2;

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    _bodyGeo.scale(0.75, 0.6, 1.0); // stocky furry torso, not a bird fuselage
  }
  return _bodyGeo;
}
// Membrane wing — wide chord, swept back; a bat's wing is skin stretched
// on fingers, so it reads as a big flat sail, not a feathered plank.
const _wingGeo = new THREE.BoxGeometry(2.4, 0.04, 1.1);
const _earGeo = new THREE.ConeGeometry(0.14, 0.7, 4);
const _membGeo = new THREE.BoxGeometry(0.9, 0.03, 0.7); // uropatagium — rear skin flap
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function rakkParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_wingMat) _wingMat = new THREE.MeshLambertMaterial({ color: 0x4a2f3a, side: THREE.DoubleSide });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xffe066, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _earGeo, material: _bodyMat, per: EARS_PER },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
    { geometry: _membGeo, material: _wingMat },
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
  const flapAmp = dive ? 0.12 : r.state === 'climb' ? 1.0 : 0.55;
  const flapRate = dive ? 3 : r.state === 'climb' ? 13 : 6;
  return Math.sin(r.animT * flapRate) * flapAmp;
}

export function writeRakkInstances(r: RakkVisHost): void {
  if (!r.hasSlots) return;
  const swarm = getSwarm('rakk');
  if (!swarm) return;
  const slot = r.swarmSlot;
  const radius = r.radius;

  _e.set(r.pitch, r.yaw, r.roll, 'YXZ');
  _q.setFromEuler(_e);
  _s.setScalar(radius);
  _p.copy(r.pos);
  _root.compose(_p, _q, _s);

  const fr = r.flash > 0 ? 4 : 1;
  const cr = r.color.r * fr, cg = r.color.g * fr, cb = r.color.b * fr;
  swarm.setMatrix(PART_BODY, slot, _root);
  swarm.setColor(PART_BODY, slot, cr, cg, cb);

  // Ears — the bat tell: two pointy horns up top, splayed outward
  for (let i = 0; i < EARS_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _e.set(-0.2, 0, side * 0.35);
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.28, 0.55, 0.55), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EAR, slot * EARS_PER + i, _world);
    swarm.setColor(PART_EAR, slot * EARS_PER + i, cr, cg, cb);
  }

  const flap = wingbeat(r);
  // Membrane wings — attached at the flank, swept back. Orbit flap is a
  // deep rowing beat (bats row, birds flap); dive folds them into a dart.
  const fold = r.state === 'dive' ? 0.9 : 0;
  for (let i = 0; i < WINGS_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _e.set(0, -side * (0.45 + fold * 0.5), side * (0.15 + flap + fold));
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 1.1, 0.15, -0.15), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
  }

  // Rear membrane — the leg-to-leg skin flap, tilts with the wingbeat
  _e.set(-0.3 - flap * 0.4, 0, 0);
  _q.setFromEuler(_e);
  _local.compose(_p.set(0, -0.1, -1.1), _q, _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_MEMB, slot, _world);

  // Eyes — paired glow quads low on the snout
  for (let i = 0; i < EYES_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _local.compose(_p.set(side * 0.18, 0.25, 0.85), _q.identity(), _s.setScalar(0.25));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
  }

  getShadows()?.set(r as never, r.pos, radius * 1.6, 0.28);
}
