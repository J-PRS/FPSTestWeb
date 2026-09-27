import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  CRAWLER_RADIUS, CRAWLER_HEALTH,
  CRAWLER_AGGRO_DIST, CRAWLER_POUNCE_DIST, CRAWLER_WINDUP,
  CRAWLER_HOP_SPEED, CRAWLER_HOP_UP, CRAWLER_POUNCE_SPEED,
  CRAWLER_STUN,
  EMERGE_DUR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _dir = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _tiltQ = new THREE.Quaternion(); // ground-normal alignment while grounded
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Part indices into the crawler swarm — order must match crawlerParts().
const PART_BODY = 0;
const PART_HEAD = 1;
const PART_LEG = 2;   // eight instances per crawler: slot*8+i
const PART_FANG = 3;  // two per crawler
const PART_EYE = 4;   // two per crawler — additive glow quads
const LEGS_PER = 8;   // spiders have eight
const FANGS_PER = 2;
const EYES_PER = 2;

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
    thorax.scale(1.0, 0.8, 0.9);
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
    const lower = new THREE.ConeGeometry(0.05, 0.9, 4);
    // +Y tip toward (0.5,-0.9): rotateZ(atan2(-dx, dy))
    lower.rotateZ(Math.atan2(-0.5, -0.9));
    lower.translate(0.7, 0.1, 0); // knee(0.45,0.55) → midpoint to foot(0.95,-0.35)
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
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, emissive: 0x000000,
    flatShading: true, // hard facets — the facets ARE the art direction
  });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xff3311, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
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
export const CRAWLER_SUBPARTS = { legs: LEGS_PER, fangs: FANGS_PER, eyes: EYES_PER };

/**
 * Ground-hugging target: hops along the terrain in short ballistic arcs,
 * wanders until the player is close, then chases and pounces.
 * Renders into the shared crawler swarm — owns no meshes.
 */
export class Crawler implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x8a2f22);
  readonly debrisKind = 'goo' as const; // chitin splat, not rock chunks
  readonly dieCue = 'splat' as const;
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private squash = 1; // 1 = normal, <1 crouched (windup telegraph)
  private glow = 0;   // emissive heat 0..1 — instanceColor >1 fakes the ramp
  private flash = 0;  // damage white-flash decay

  private state: 'wander' | 'chase' | 'windup' = 'wander';
  private hopTimer = 0;
  private windupTimer = 0;
  private stunTimer = 0;
  private wanderYaw = Math.random() * Math.PI * 2;
  private airborne = true;
  private pounceAirborne = false;
  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onPounceHit?: (crawler: Crawler) => void;
  onLanded?: (pos: THREE.Vector3) => void;
  // Uber = matriarch: births a scarab every few seconds while she lives —
  // killing her fast IS the counterplay to an infinite brood.
  onBrood?: (crawler: Crawler) => void;
  private broodTimer = 4; // first birth comes quick — announces she's a spawner

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene; // swarm renders through the shared scene — kept in signature
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? CRAWLER_HEALTH * 4 : CRAWLER_HEALTH;
    this.radius = uber ? CRAWLER_RADIUS * 2.2 : CRAWLER_RADIUS;
    this.scale = uber ? 1.3 : 0.5;
    if (uber) this.color.set(0x5a1a3a); // brood-purple — the queen reads different
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('crawler', this);
    if (!this.hasSlots) this.dead = true; // swarm full — refuse to exist
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.glow > 0 && this.state !== 'windup') this.glow -= dt * 2.5;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — AI stays asleep until surfaced
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius - this.emergeDepth * (1 - k * k);
      this.animT += dt;
      this.writeInstances(terrain);
      return;
    }

    // Matriarch brood: a scarab crawls out every few seconds while she's
    // alive and on the ground — airtime (knockback) pauses the womb.
    if (this.uber && !this.airborne) {
      this.broodTimer -= dt;
      if (this.broodTimer <= 0) {
        this.broodTimer = 6 + Math.random() * 2;
        this.onBrood?.(this);
      }
    }

    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    const onGround = this.pos.y - this.radius <= gy;
    if (onGround) {
      this.pos.y = gy + this.radius;
      if (this.airborne) this.onLanded?.(this.pos);
      this.airborne = false;
      this.vel.set(0, 0, 0);
      if (this.pounceAirborne) {
        this.pounceAirborne = false;
        if (this.pos.distanceToSquared(playerPos) < 6.25) this.onPounceHit?.(this);
      }
      this.groundThink(dt, terrain, playerPos, distSq);
    } else {
      this.airborne = true;
      if (this.pounceAirborne && this.pos.distanceToSquared(playerPos) < 4) {
        this.pounceAirborne = false;
        this.onPounceHit?.(this);
      }
    }

    if (this.state === 'windup' && distSq > 0.01) {
      this.yaw = Math.atan2(dx, dz);
    } else if (this.vel.lengthSq() > 1) {
      this.yaw = Math.atan2(this.vel.x, this.vel.z);
    }

    this.animT += dt;
    this.writeInstances(terrain);
  }

  private writeInstances(terrain: Terrain): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('crawler');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    // Root: position + facing + windup squash. When grounded the body
    // also tilts onto the terrain normal — a crawler on a hillside hugs
    // the slope (legs mask it partially, but the body was piercing).
    _e.set(0, this.yaw, 0);
    _q.setFromEuler(_e);
    if (!this.airborne) {
      _tiltQ.setFromUnitVectors(_UP, terrain.getNormal(this.pos.x, this.pos.z));
      _q.premultiply(_tiltQ); // yaw first, then tip onto the slope
    }
    const sy = r * this.squash;
    _s.set(r * (2 - this.squash), sy, r * (2 - this.squash)); // widen as it squashes
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    // Tint: base color, white flash on hit, emissive heat faked via >1 color
    const heat = this.glow;
    const fr = this.flash > 0 ? 4 : 1;
    swarm.setColor(PART_BODY, slot,
      this.color.r * fr + heat * 0.6, this.color.g * fr + heat * 0.08, this.color.b * fr);
    swarm.setMatrix(PART_BODY, slot, _root);

    // Head rides the front of the thorax, low — it's a jaw, not a beach ball
    _local.compose(_p.set(0, 0.05, 1.05), _q.identity(), _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_HEAD, slot, _world);
    swarm.setColor(PART_HEAD, slot, this.color.r * 0.8 * fr, this.color.g * 0.8 * fr + heat * 0.08, this.color.b * 0.8 * fr);

    // Eight legs, 4 pairs fanned thorax→abdomen. The leg geo is already
    // bent (hip→knee→foot); instance yaw fans fore legs forward, rear legs
    // back, and mirrors the left side. Wiggle = scuttle.
    const amp = this.airborne ? 0.08 : (this.state === 'wander' ? 0.25 : 0.55);
    for (let i = 0; i < LEGS_PER; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const k = Math.floor(i / 2); // pair 0..3, front→back
      const fan = (k - 1.5) * 0.4;
      const wiggle = Math.sin(this.animT * 16 + i * 1.31) * amp;
      _e.set(0, side < 0 ? Math.PI - fan + wiggle : fan + wiggle, 0);
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(side * 0.5, 0.1 + Math.abs(Math.sin(this.animT * 16 + i * 1.31)) * amp * 0.15, (k - 1.5) * 0.55),
        _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_LEG, slot * LEGS_PER + i, _world);
      // Legs darker than carapace — silhouette reads jointed, not blobbed
      swarm.setColor(PART_LEG, slot * LEGS_PER + i, this.color.r * 0.45, this.color.g * 0.45, this.color.b * 0.45);
    }

    // Fangs: two forward-curved tusks framing the head
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

    // Eyes: two additive quads on the head plate — widen during windup
    const eyeS = (this.state === 'wander' ? 0.55 : this.state === 'windup' ? 0.9 : 0.75) * 0.55;
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.16, 0.28, 1.15), _q.identity(), _s.setScalar(eyeS),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.1, 0.35);
  }

  private groundThink(dt: number, terrain: Terrain, playerPos: THREE.Vector3, distSq: number): void {
    if (this.stunTimer > 0) return;

    if (this.state === 'windup') {
      this.windupTimer -= dt;
      const t = 1 - this.windupTimer / CRAWLER_WINDUP;
      this.squash = 1 - t * 0.4;
      this.glow = t * 0.6;
      if (this.windupTimer <= 0) {
        this.squash = 1;
        this.pounce(playerPos);
      }
      return;
    }

    if (distSq < CRAWLER_POUNCE_DIST * CRAWLER_POUNCE_DIST) {
      this.state = 'windup';
      this.windupTimer = CRAWLER_WINDUP;
      return;
    }

    this.hopTimer -= dt;
    if (this.hopTimer > 0) return;
    this.hopTimer = 0.25 + Math.random() * 0.3;

    if (distSq < CRAWLER_AGGRO_DIST * CRAWLER_AGGRO_DIST) {
      this.state = 'chase';
      const d = Math.sqrt(distSq) || 0.001;
      this.vel.set(
        ((playerPos.x - this.pos.x) / d) * CRAWLER_HOP_SPEED,
        CRAWLER_HOP_UP,
        ((playerPos.z - this.pos.z) / d) * CRAWLER_HOP_SPEED,
      );
    } else {
      this.state = 'wander';
      if (Math.random() < 0.4) this.wanderYaw += (Math.random() - 0.5) * 2;
      this.vel.set(
        Math.sin(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
        CRAWLER_HOP_UP * 0.8,
        Math.cos(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
      );
    }
  }

  private pounce(playerPos: THREE.Vector3): void {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const pd = Math.sqrt(dx * dx + dz * dz) || 0.001;
    const hSpeed = CRAWLER_POUNCE_SPEED;
    const t = Math.max(0.15, pd / hSpeed);
    const vy = (playerPos.y - this.pos.y + 0.5 * Math.abs(GRAVITY) * t * t) / t;
    this.vel.set((dx / pd) * hSpeed, vy, (dz / pd) * hSpeed);
    this.airborne = true;
    this.pounceAirborne = true;
    this.state = 'chase';
    this.glow = 0.6;
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN;
    if (this.state === 'windup') {
      this.state = 'chase';
      this.squash = 1;
      this.glow = 0;
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('crawler', this);
      this.hasSlots = false;
    }
  }
}
