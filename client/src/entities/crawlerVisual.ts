import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getSwarm, getShadows } from './swarms.js';
import type { SwarmPart } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { Terrain } from '../world/terrain.js';

// Part indices into the crawler swarm — order must match crawlerParts().
const PART_BODY = 0;
const PART_HEAD = 1;
const PART_LEG = 2;   // eight instances per crawler: slot*8+i
const PART_FANG = 3;  // two per crawler
const PART_EYE = 4;   // two per crawler — additive glow quads
const LEGS_PER = 8;   // spiders have eight
const FANGS_PER = 2;
const EYES_PER = 2;

const _UP = new THREE.Vector3(0, 1, 0);
const _tiltQ = new THREE.Quaternion(); // ground-normal alignment while grounded
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Geometries are shared — instancing renders one geometry × N slots.
// Body: segmented bug, not a potato — swollen abdomen + thorax + head plate
// merged into one part so it stays a single instanced draw.
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    // detail 0 = bare 20-face icosahedra — chunky facets read as STYLE,
    // where detail-1 smooths them into "bad organic modelling"
    const abdomen = new THREE.IcosahedronGeometry(1, 0);
    abdomen.scale(0.95, 0.72, 1.05);
    abdomen.translate(0, 0.2, -0.5);
    const thorax = new THREE.IcosahedronGeometry(0.55, 0);
    thorax.scale(1, 0.8, 0.9);
    thorax.translate(0, 0.08, 0.45);
    const headPlate = new THREE.IcosahedronGeometry(0.32, 0);
    headPlate.scale(1.15, 0.65, 0.8);
    headPlate.translate(0, 0.05, 0.95);
    _bodyGeo = mergeGeometries([abdomen, thorax, headPlate])!;
  }
  return _bodyGeo;
}
// Head: small mandible lobe riding the front of the thorax
let _headGeo: THREE.BufferGeometry | null = null;
function headGeo(): THREE.BufferGeometry {
  if (!_headGeo) {
    _headGeo = new THREE.IcosahedronGeometry(0.3, 0);
    _headGeo.scale(1.1, 0.7, 0.85);
  }
  return _headGeo;
}
// Leg: BENT spider leg — hip → knee (out+up) → foot (down+out), one merged
// geometry so each leg is still a single instance slot. Extends +X local;
// instance yaw fans it fore/aft and mirrors it for the left side.
let _legGeo: THREE.BufferGeometry | null = null;
function legGeo(): THREE.BufferGeometry {
  if (!_legGeo) {
    const upper = new THREE.ConeGeometry(0.06, 0.85, 4);
    upper.rotateZ(-Math.atan2(0.45, 0.55)); // tip toward (0.45,0.55)
    upper.translate(0.225, 0.275, 0);
    const lower = new THREE.ConeGeometry(0.05, 1.68, 4);
    // +Y tip toward knee→foot (0.5,-1.6): rotateZ(atan2(-dx, dy)).
    // Foot tip lands at local −1.05 — pos.y is seat = ground + r, so the
    // toe PLANTS instead of the old -0.35 that left the spider hovering.
    lower.rotateZ(Math.atan2(-0.5, -1.6));
    lower.translate(0.7, -0.25, 0); // midpoint knee(0.45,0.55) → foot(0.95,-1.05)
    _legGeo = mergeGeometries([upper, lower])!;
  }
  return _legGeo;
}
const _fangGeo = new THREE.ConeGeometry(0.07, 0.5, 4);
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function crawlerParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({
    color: 0xFF_FF_FF, emissive: 0x00_00_00,
    flatShading: true, // hard facets — the facets ARE the art direction
  });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xFF_33_11, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: headGeo(), material: _bodyMat },
    { geometry: legGeo(), material: _bodyMat, per: LEGS_PER },
    { geometry: _fangGeo, material: _bodyMat, per: FANGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

// Sub-slot math: leg/fang/eye InstancedMeshes index by crawler.slot * N + i.
// Capacity is expressed in crawlers; sub-parts allocate N× the capacity via a
// wider InstancedMesh — see crawlerPartsCapacity in swarms.ts usage.

/** Flat fields the swarm write reads — Crawler keeps them public. */
export interface CrawlerVisHost {
  hasSlots: boolean;
  swarmSlot: number;
  radius: number;
  pos: THREE.Vector3;
  yaw: number;
  airborne: boolean;
  squash: number;
  glow: number;
  flash: number;
  animT: number;
  state: 'wander' | 'chase' | 'windup';
  color: THREE.Color;
}

export function writeCrawlerInstances(c: CrawlerVisHost, terrain: Terrain): void {
  if (!c.hasSlots) {return;}
  const swarm = getSwarm('crawler');
  if (!swarm) {return;}
  const slot = c.swarmSlot;
  const r = c.radius;

  // Root: position + facing + windup squash. When grounded the body
  // also tilts onto the terrain normal — a crawler on a hillside hugs
  // the slope (legs mask it partially, but the body was piercing).
  _e.set(0, c.yaw, 0);
  _q.setFromEuler(_e);
  if (!c.airborne) {
    _tiltQ.setFromUnitVectors(_UP, terrain.getNormal(c.pos.x, c.pos.z));
    _q.premultiply(_tiltQ); // yaw first, then tip onto the slope
  }
  const sy = r * c.squash;
  _s.set(r * (2 - c.squash), sy, r * (2 - c.squash)); // widen as it squashes
  _p.copy(c.pos);
  _root.compose(_p, _q, _s);

  // Tint: base color, white flash on hit, emissive heat faked via >1 color
  const heat = c.glow;
  const fr = c.flash > 0 ? 4 : 1;
  swarm.setColor(PART_BODY, slot,
    c.color.r * fr + heat * 0.6, c.color.g * fr + heat * 0.08, c.color.b * fr);
  swarm.setMatrix(PART_BODY, slot, _root);

  // Head rides the front of the thorax, low — it's a jaw, not a beach ball
  _local.compose(_p.set(0, 0.05, 1.05), _q.identity(), _s.set(1, 1, 1));
  _world.multiplyMatrices(_root, _local);
  swarm.setMatrix(PART_HEAD, slot, _world);
  swarm.setColor(PART_HEAD, slot, c.color.r * 0.8 * fr, c.color.g * 0.8 * fr + heat * 0.08, c.color.b * 0.8 * fr);

  writeLegs(c, swarm, slot);
  writeFangs(swarm, slot);
  writeEyes(c, swarm, slot);

  getShadows()?.set(c as never, c.pos, r * 1.1, 0.35);
}

// Eight legs, 4 pairs fanned thorax→abdomen. The leg geo is already
// bent (hip→knee→foot); instance yaw fans fore legs forward, rear legs
// back, and mirrors the left side. Wiggle = scuttle.
function writeLegs(c: CrawlerVisHost, swarm: NonNullable<ReturnType<typeof getSwarm>>, slot: number): void {
  const amp = c.airborne ? 0.08 : (c.state === 'wander' ? 0.25 : 0.55);
  for (let i = 0; i < LEGS_PER; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const k = Math.floor(i / 2); // pair 0..3, front→back
    const fan = (k - 1.5) * 0.4;
    const wiggle = Math.sin(c.animT * 16 + i * 1.31) * amp;
    _e.set(0, side < 0 ? Math.PI - fan + wiggle : fan + wiggle, 0);
    _q.setFromEuler(_e);
    _local.compose(
      _p.set(side * 0.5, 0 + Math.abs(Math.sin(c.animT * 16 + i * 1.31)) * amp * 0.15, (k - 1.5) * 0.55),
      _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_LEG, slot * LEGS_PER + i, _world);
    // Legs darker than carapace — silhouette reads jointed, not blobbed
    swarm.setColor(PART_LEG, slot * LEGS_PER + i, c.color.r * 0.45, c.color.g * 0.45, c.color.b * 0.45);
  }
}

// Fangs: two forward-curved tusks framing the head
function writeFangs(swarm: NonNullable<ReturnType<typeof getSwarm>>, slot: number): void {
  for (let i = 0; i < FANGS_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _e.set(2.4, 0, side * -0.25);
    _q.setFromEuler(_e);
    _local.compose(_p.set(side * 0.16, -0.02, 1.25), _q, _s.set(1, 1.3, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_FANG, slot * FANGS_PER + i, _world);
    // Pale chitin — mandibles should catch the eye, not blend in
    swarm.setColor(PART_FANG, slot * FANGS_PER + i, 0.9, 0.8, 0.6);
  }
}

// Eyes: two additive quads on the head plate — widen during windup
function writeEyes(c: CrawlerVisHost, swarm: NonNullable<ReturnType<typeof getSwarm>>, slot: number): void {
  const eyeS = (c.state === 'wander' ? 0.55 : c.state === 'windup' ? 0.9 : 0.75) * 0.55;
  for (let i = 0; i < EYES_PER; i++) {
    const side = i === 0 ? -1 : 1;
    _local.compose(
      _p.set(side * 0.16, 0.28, 1.15), _q.identity(), _s.setScalar(eyeS),
    );
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
  }
}
