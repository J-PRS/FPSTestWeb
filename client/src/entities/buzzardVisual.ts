import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';

const PART_BODY = 0;
const PART_WING = 1;  // 2 per buzzard - one flattened membrane per side
const PART_TAIL = 2;  // fan tail - the buzzard silhouette
const WINGS_PER = 2;

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Body = plump torso + small head + hooked beak, fused into one part.
// Buzzards read as dark heavy birds - bigger chest than a rakk, shorter
// tail, broad wings.
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    const torso = new THREE.IcosahedronGeometry(1, 1);
    torso.scale(0.5, 0.42, 0.95);
    const head = new THREE.IcosahedronGeometry(0.3, 1);
    head.scale(0.8, 0.75, 0.9);
    head.translate(0, 0.22, 0.75);
    const beak = new THREE.ConeGeometry(0.09, 0.4, 4);
    beak.rotateX(Math.PI / 2);
    beak.scale(0.8, 0.5, 1);
    beak.translate(0, 0.18, 1.15);
    _bodyGeo = mergeGeometries([torso, head.toNonIndexed(), beak.toNonIndexed()])!;
  }
  return _bodyGeo;
}

// Wing - one broad flat membrane per side, pivot at the shoulder. Simpler
// than the rakk's two-joint arm+fan: a buzzard's wing is a single sail.
const _wingGeo = new THREE.BoxGeometry(1.6, 0.03, 0.55);
{
  const pos = _wingGeo.attributes.position!;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i); // 0 at root → 1.6 at tip (geometry centered)
    const t = Math.min(1, Math.max(0, (x + 0.8) / 1.6));
    pos.setZ(i, pos.getZ(i) * (1 - t * 0.5));  // taper toward tip
    pos.setY(i, pos.getY(i) * (1 - t * 0.3));
  }
  _wingGeo.computeVertexNormals();
  _wingGeo.translate(0.8, 0, 0); // pivot at the shoulder
}

// Tail - short fan, flattened cone swept back.
const _tailGeo = new THREE.ConeGeometry(0.34, 0.9, 4);
{
  _tailGeo.scale(1.6, 0.4, 1);
  _tailGeo.rotateX(-Math.PI / 2);
  _tailGeo.translate(0, 0, -0.75);
}

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;

export function buzzardParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF });}
  // Dark leather membrane - lighter than the hide so the wing reads
  // against a dark sky, same trick as the rakk wing.
  if (!_wingMat) {_wingMat = new THREE.MeshLambertMaterial({ color: 0x4A_3A_2A, side: THREE.DoubleSide });}
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
    { geometry: _tailGeo, material: _bodyMat },
  ];
}

/** Flat fields the swarm write reads - Buzzard keeps them public. */
export interface BuzzardVisHost {
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

// Soaring buzzards hold a shallow dihedral and flap in bursts; the dive
// folds the wings into a teardrop.
function flap(r: BuzzardVisHost): number {
  const burst = 0.5 + 0.5 * Math.sin(r.animT * 0.9); // flap-burst envelope
  const amp = r.state === 'dive' ? 0.08 : 0.5 * burst;
  const rate = r.state === 'dive' ? 4 : 7;
  return Math.sin(r.animT * rate) * amp;
}

export function writeBuzzardInstances(b: BuzzardVisHost): void {
  if (!b.hasSlots) {return;}
  const swarm = getSwarm('buzzard');
  if (!swarm) {return;}
  const slot = b.swarmSlot;
  const {radius} = b;

  _e.set(b.pitch, b.yaw, b.roll, 'YXZ');
  _q.setFromEuler(_e);
  _s.setScalar(radius);
  _p.copy(b.pos);
  _root.compose(_p, _q, _s);

  const fr = b.flash > 0 ? 4 : 1;
  const cr = b.color.r * fr, cg = b.color.g * fr, cb = b.color.b * fr;
  swarm.setMatrix(PART_BODY, slot, _root);
  swarm.setColor(PART_BODY, slot, cr, cg, cb);
  swarm.setMatrix(PART_TAIL, slot, _root);
  swarm.setColor(PART_TAIL, slot, cr * 0.85, cg * 0.85, cb * 0.85);

  const f = flap(b);
  const fold = b.state === 'dive' ? 1 : 0;
  for (let i = 0; i < WINGS_PER; i += 1) {
    const side = i === 0 ? -1 : 1;
    // Dihedral at rest, flap around the shoulder, sweep back on the dive.
    _e.set(0, side * (0.15 + f * 0.5 - fold * 0.5), side * (f * 0.4 + fold * 0.6), 'YXZ');
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.3, 0.15, 0.1), _q, _s.set(side, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
    swarm.setColor(PART_WING, slot * WINGS_PER + i, cr * 0.8 + 0.2, cg * 0.8 + 0.15, cb * 0.8 + 0.12);
  }

  getShadows()?.set(b as never, b.pos, radius * 1.7, 0.3);
}
