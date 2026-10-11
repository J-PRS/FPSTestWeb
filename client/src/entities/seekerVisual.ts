import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const PART_BODY = 0;
const PART_WING = 1;    // 2 per seeker
const PART_STINGER = 2;
const PART_JAW = 3;     // 2 per seeker
const PART_EYE = 4;     // single cyclops eye quad
const WINGS_PER = 6; // 3 pairs per side — abomination, not bee
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
    _bodyGeo.scale(0.62, 0.55, 1);
  }
  return _bodyGeo;
}
// Wing: bee teardrop with the root at the origin so the flap euler is a
// real hinge, forewing + a smaller hindwing swept further back. Left
// wing is the same shape yawed π — no negative-scale mirror.
const _wingGeo = ((): THREE.BufferGeometry<THREE.NormalBufferAttributes, THREE.BufferGeometryEventMap> => {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.5, 0.34, 1.3, 0.42, 1.65, 0.08);
  shape.bezierCurveTo(1.72, -0.02, 1.55, -0.16, 1.15, -0.2);
  shape.bezierCurveTo(0.6, -0.26, 0.15, -0.14, 0, 0);
  const fore = new THREE.ShapeGeometry(shape, 6);
  const hind = fore.clone();
  hind.scale(0.62, 0.62, 1);
  // Tuck the hindwing inboard-and-back. Translates mirror cleanly under
  // the left wing's yaw flip — an in-plane rotation would flip its
  // sweep direction and read asymmetric.
  hind.translate(-0.1, -0.25, 0);
  const geo = mergeGeometries([fore, hind])!;
  geo.rotateX(-Math.PI / 2); // lie flat, +X out along the wing
  // No baked yaw: sweep-back lives in the pose so each side can mirror
  // it — a geometry-level rotateY would flip to a forward sweep on the
  // π-rotated left wing.
  return geo;
})();
const _stingerGeo = new THREE.ConeGeometry(0.17, 0.95, 5);
const _jawGeo = new THREE.ConeGeometry(0.12, 0.6, 4);
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function seekerParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF });}
  // Opaque chitin wing — the transparent membrane was blending against
  // the viewmodel/scene in the composer buffer.
  if (!_wingMat) {_wingMat = new THREE.MeshLambertMaterial({ color: 0x8A_7A_5F, side: THREE.DoubleSide });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xFF_CC_44, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
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
  if (!s.hasSlots) {return;}
  const swarm = getSwarm('seeker');
  if (!swarm) {return;}
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
  // Stinger kept dark — the threat end should read as a different
  // material than the fuzzy thorax at silhouette distance.
  swarm.setColor(PART_STINGER, slot, cr * 0.45, cg * 0.4, cb * 0.4);
  swarm.setColor(PART_EYE, slot, 1, 1, 1);

  // Stinger trails back-down at rest, but curls forward under the belly
  // as the telegraph winds up (glow ramps 0→0.7 with it) — the wasp
  // strike pose IS the tell, and the dart releases from full curl.
  // The cone pivots around its BASE, pinned at the tail anchor — sliding
  // the center would walk the stinger off the body mid-curl.
  const curl = Math.min(1, s.glow / 0.7);
  // Negative sweep: the tip arcs down and under the belly — positive
  // rotation would swing it up through the tail.
  const theta = -1.9 - curl * 2.3;
  _e.set(theta, 0, 0);
  _q.setFromEuler(_e);
  _local.compose(
    _p.set(0, -0.2 + 0.475 * Math.cos(theta), -0.95 + 0.475 * Math.sin(theta)),
    _q, _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_STINGER, slot, _world);

  // Mandibles angle forward-in like grasping fangs, not drooping cones
  for (let i = 0; i < JAWS_PER; i += 1) {
    const side = i === 0 ? -1 : 1;
    _e.set(2.4, side * -0.35, 0);
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.24, -0.3, 0.62), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_JAW, slot * JAWS_PER + i, _world);
    swarm.setColor(PART_JAW, slot * JAWS_PER + i, cr, cg, cb);
  }

  // Wings flap around the root (geometry origin). Left wing yaws π so
  // one geometry serves both sides — the roll sign stays shared, which
  // keeps the flap mirrored (avoids the negative-scale one-up/one-down
  // trap).
  const flapRate = s.state === 'telegraph' ? 4 : 22;
  const amp = s.state === 'dart' ? 0.9 : 0.6;
  // Three pairs marching down the thorax, shrinking and phase-offset so
  // the wings read as a blurred fan, not two discrete paddles.
  for (let i = 0; i < WINGS_PER; i += 1) {
    const side = (i & 1) === 0 ? -1 : 1;
    const pair = i >> 1; // 0 fore, 1 mid, 2 rear
    const wingA = Math.sin(s.animT * flapRate - pair * 0.9) * amp;
    // Left yaw π−sweep mirrors right yaw +sweep: both tips trail
    // backward AND flap upward together.
    _e.set(0, side < 0 ? Math.PI - 0.3 : 0.3, 0.15 + wingA, 'YXZ');
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.3, 0.4 - pair * 0.08, 0.15 - pair * 0.35),
      _q, _s.setScalar(1 - pair * 0.25));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
  }

  // Cyclops eye — additive quad riding the face
  _local.compose(_p.set(0, 0.15, 0.75), _q.identity(), _s.setScalar(s.eyeScale * 0.9));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_EYE, slot, _world);

  getShadows()?.set(s as never, s.pos, r * 1.2, 0.3);
}
