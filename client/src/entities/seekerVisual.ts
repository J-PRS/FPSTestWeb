import * as THREE from 'three';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const PART_BODY = 0;
const PART_WING = 1;    // 2 per seeker
const PART_STINGER = 2;
const PART_JAW = 3;     // 2 per seeker
const PART_EYE = 4;     // single cyclops eye quad
const WINGS_PER = 2;
const JAWS_PER = 2;

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Shared geometries — skull is an elongated icosahedron, wings are thin
// membrane planes, stinger a small rear cone.
let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    _bodyGeo.scale(0.62, 0.55, 1.0);
  }
  return _bodyGeo;
}
const _wingGeo = new THREE.BoxGeometry(1.5, 0.04, 0.55);
const _stingerGeo = new THREE.ConeGeometry(0.12, 0.7, 5);
const _jawGeo = new THREE.ConeGeometry(0.1, 0.5, 4);
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function seekerParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_wingMat) _wingMat = new THREE.MeshLambertMaterial({ color: 0x776655, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xffcc44, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
    { geometry: _stingerGeo, material: _bodyMat },
    { geometry: _jawGeo, material: _bodyMat, per: JAWS_PER },
    { geometry: _eyeGeo, material: _eyeMat },
  ];
}

/** Flat fields the swarm write reads — Seeker keeps them public. */
export interface SeekerVisHost {
  hasSlots: boolean;
  swarmSlot: number;
  radius: number;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  eyeScale: number;
  glow: number;
  flash: number;
  animT: number;
  state: 'patrol' | 'chase' | 'telegraph' | 'dart' | 'recover';
  color: THREE.Color;
}

export function writeSeekerInstances(s: SeekerVisHost): void {
  if (!s.hasSlots) return;
  const swarm = getSwarm('seeker');
  if (!swarm) return;
  const slot = s.swarmSlot;
  const r = s.radius;

  _e.set(s.pitch, s.yaw, s.roll, 'YXZ');
  _q.setFromEuler(_e);
  _s.setScalar(r);
  _p.copy(s.pos);
  _root.compose(_p, _q, _s);

  const fr = s.flash > 0 ? 4 : 1;
  const g = s.glow;
  const cr = s.color.r * fr + g * 0.9;
  const cg = s.color.g * fr + g * 0.45;
  const cb = s.color.b * fr;
  swarm.setMatrix(PART_BODY, slot, _root);
  swarm.setColor(PART_BODY, slot, cr, cg, cb);
  swarm.setColor(PART_STINGER, slot, cr, cg, cb);
  swarm.setColor(PART_EYE, slot, 1, 1, 1);

  // Stinger trails back-down
  _e.set(-1.9, 0, 0);
  _q.setFromEuler(_e);
  _local.compose(_p.set(0, -0.15, -1.05), _q, _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_STINGER, slot, _world);

  // Jaw fangs point down
  for (let i = 0; i < JAWS_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _e.set(Math.PI, 0, 0);
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.22, -0.35, 0.55), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_JAW, slot * JAWS_PER + i, _world);
    swarm.setColor(PART_JAW, slot * JAWS_PER + i, cr, cg, cb);
  }

  // Wings flap — fast buzz, tuck during telegraph rear-back
  const flapRate = s.state === 'telegraph' ? 4 : 22;
  const wingA = Math.sin(s.animT * flapRate) * (s.state === 'dart' ? 0.9 : 0.6);
  for (let i = 0; i < WINGS_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _e.set(0, 0, side * (0.15 + wingA));
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.85, 0.35, -0.1), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
  }

  // Cyclops eye — additive quad riding the face
  _local.compose(_p.set(0, 0.15, 0.75), _q.identity(), _s.setScalar(s.eyeScale * 0.9));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_EYE, slot, _world);

  getShadows()?.set(s as never, s.pos, r * 1.2, 0.3);
}
