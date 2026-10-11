import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  OVERLORD_RADIUS, OVERLORD_HEALTH,
  OVERLORD_SPEED, OVERLORD_ALTITUDE, OVERLORD_LOITER_DIST, OVERLORD_ACCEL,
  OVERLORD_DROP_INTERVAL, OVERLORD_DROP_RANGE, OVERLORD_STUN,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

const PART_HULL = 0;
const PART_TENT = 1;  // 5 per overlord — dangling tentacle skirt
const PART_EYE = 2;   // 2 per overlord — dim orange workhorse eyes
const TENTS_PER = 5;
const EYES_PER = 2;

let _hullGeo: THREE.IcosahedronGeometry | null = null;
function hullGeo(): THREE.BufferGeometry {
  if (!_hullGeo) {
    _hullGeo = new THREE.IcosahedronGeometry(1, 1);
    // Zerg proportions: wide fleshy sac, taller than a blimp, blunt nose —
    // reads as a floating creature, not an airship.
    _hullGeo.scale(1.35, 1, 1.2);
  }
  return _hullGeo;
}
const _tentGeo = (() => {
  // Tapered tendril, tip pointing DOWN — hangs from the belly
  const g = new THREE.ConeGeometry(0.16, 1.9, 5);
  g.rotateX(Math.PI);
  return g;
})();
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

// Tentacle roots around the belly — [x, y, z, phase]
const TENT_OFFSETS = [
  [0.55, -0.75, 0.35, 0],
  [-0.55, -0.75, 0.35, 1.4],
  [0.75, -0.65, -0.35, 2.6],
  [-0.75, -0.65, -0.35, 3.9],
  [0, -0.85, -0.55, 5.1],
] as const;

let _hullMat: THREE.MeshLambertMaterial | null = null;
let _tentMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function overlordParts(): SwarmPart[] {
  if (!_hullMat) {_hullMat = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF });}
  if (!_tentMat) {_tentMat = new THREE.MeshLambertMaterial({ color: 0x3D_2A_35 });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xFF_AA_33, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  return [
    { geometry: hullGeo(), material: _hullMat, castShadow: true },
    { geometry: _tentGeo, material: _tentMat, per: TENTS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Overlord — the flying dredge. Slow gasbag that sows mines; a PRIORITY target
 * you choose to shoot down. Renders into the shared overlord swarm.
 */
export class Overlord implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  dropInterval: number;
  // Hull is a 7m-long fuselage — capsule along heading, not a sphere, so
  // nose/tail shots count. Updated per-frame from yaw.
  readonly capsuleEnd = new THREE.Vector3(0, 0, 1.3);
  color = new THREE.Color(0x6E_44_60); // bruised zerg purple flesh
  readonly debrisKind = 'goo' as const; // gasbag pops into splat
  readonly ichor = 0xE0_8A_3C; // hot orange under the purple hide
  scale = 2.2;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private roll = 0;
  private flash = 0;
  private dropGlow = 0;

  private dropTimer: number; // first mine comes quick — announce the payload
  private stunTimer = 0;
  private strafeDir = Math.random() < 0.5 ? 1 : -1;

  onMineDrop?: (overlord: Overlord) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "broodmother": a bigger, meaner sac that sows banelings twice
    // as fast — and drops them in pairs (wired in entities).
    this.uber = uber;
    this.maxHealth = uber ? OVERLORD_HEALTH * 2.5 : OVERLORD_HEALTH;
    this.health = this.maxHealth;
    this.radius = uber ? OVERLORD_RADIUS * 1.4 : OVERLORD_RADIUS;
    this.dropInterval = uber ? OVERLORD_DROP_INTERVAL * 0.55 : OVERLORD_DROP_INTERVAL;
    this.dropTimer = this.dropInterval * 0.5;
    if (uber) {
      this.color.set(0x7A_2A_4A); // swollen crimson sac
      this.scale = 3.2; // bigger debris — and it pays out 3 nuggets
    }
    this.pos = pos.clone();
    // Spawn at ground level — steerLoiter's targetY pull lifts it to
    // cruise altitude over the first seconds, so it erupts out of the
    // dirt like the rest of the roster instead of popping in midair.
    this.pos.y = terrain.getHeight(pos.x, pos.z) + 2;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('overlord', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.stunTimer > 0) {this.stunTimer -= dt;}
    if (this.flash > 0) {this.flash -= dt;}
    if (this.dropGlow > 0) {this.dropGlow -= dt;}
    this.animT += dt;

    // Steering: hold a wide loiter ring around the player — close enough that
    // mines land in their play space, far enough that orbiting it is a choice.
    _dir.subVectors(playerPos, this.pos);
    _dir.y = 0;
    const d = _dir.length() || 0.001;
    _dir.multiplyScalar(1 / d);
    this.steerLoiter(dt, terrain, d);
    if (Math.random() < dt * 0.1) {this.strafeDir *= -1;}

    this.tickDrops(dt, playerPos);
    this.faceTarget(dt, playerPos, d);

    this.writeInstances();
  }

  private steerLoiter(dt: number, terrain: Terrain, d: number): void {
    const ringErr = d - OVERLORD_LOITER_DIST;
    _scratch.set(-_dir.z * this.strafeDir, 0, _dir.x * this.strafeDir);
    if (this.stunTimer <= 0) {
      this.vel.x += (_dir.x * ringErr * 0.15 + _scratch.x * OVERLORD_SPEED * 0.7) * OVERLORD_ACCEL * dt * 0.1;
      this.vel.z += (_dir.z * ringErr * 0.15 + _scratch.z * OVERLORD_SPEED * 0.7) * OVERLORD_ACCEL * dt * 0.1;
    }
    const targetY = terrain.getHeight(this.pos.x, this.pos.z) + OVERLORD_ALTITUDE + Math.sin(this.animT * 0.9) * 1.2;
    this.vel.y += (targetY - this.pos.y) * 1.5 * dt;
    this.vel.multiplyScalar(1 - Math.min(1, 1.8 * dt)); // heavy drag — ponderous
    const spd = Math.hypot(this.vel.x, this.vel.z);
    if (spd > OVERLORD_SPEED) { this.vel.x *= OVERLORD_SPEED / spd; this.vel.z *= OVERLORD_SPEED / spd; }
    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 2) {this.pos.y = gy + 2;}
  }

  private tickDrops(dt: number, playerPos: THREE.Vector3): void {
    this.dropTimer -= dt;
    if (this.dropTimer <= 0 && this.pos.distanceTo(playerPos) < OVERLORD_DROP_RANGE) {
      this.dropTimer = this.dropInterval;
      this.onMineDrop?.(this);
      this.dropGlow = 0.35; // belly flash tells the drop happened
    }
  }

  // Face the TARGET, not drift direction — it ring-strafes sideways, and
  // yawing to velocity put the eyes on its flanks. A gasbag looming at
  // you while sliding sideways is creepier anyway. Bank still follows
  // the turn so it doesn't look rail-mounted.
  private faceTarget(dt: number, playerPos: THREE.Vector3, d: number): void {
    if (d <= 0.5) {return;}
    const targetYaw = Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) {dy -= Math.PI * 2;}
    while (dy < -Math.PI) {dy += Math.PI * 2;}
    this.yaw += dy * Math.min(1, 2 * dt);
    this.roll = -dy * 0.3;
    // Hitbox capsule follows the actual visual heading
    this.capsuleEnd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(1.3);
  }

  private writeInstances(): void {
    if (!this.hasSlots) {return;}
    const swarm = getSwarm('overlord');
    if (!swarm) {return;}
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(0, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _s.setScalar(r);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    const fr = this.flash > 0 ? 4 : 1;
    const dg = this.dropGlow > 0 ? 0.3 : 0; // belly flash on drop
    const cr = this.color.r * fr + dg;
    const cg = this.color.g * fr + dg * 0.6;
    const cb = this.color.b * fr + dg * 0.15;
    swarm.setMatrix(PART_HULL, slot, _root);
    swarm.setColor(PART_HULL, slot, cr, cg, cb);

    // Tentacle skirt — each tendril dangles from the belly and sways on its
    // own phase; sway widens with airspeed so a drifting overlord reads
    // "dragged through the air," not static decoration.
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const swayAmp = 0.18 + Math.min(0.3, spd * 0.06);
    for (let i = 0; i < TENTS_PER; i += 1) {
      const [px, py, pz, ph] = TENT_OFFSETS[i]!;
      _e.set(
        Math.sin(this.animT * 1.6 + ph) * swayAmp,
        0,
        Math.cos(this.animT * 1.3 + ph) * swayAmp,
        'YXZ',
      );
      _q.setFromEuler(_e);
      _local.compose(_p.set(px, py, pz), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_TENT, slot * TENTS_PER + i, _world);
    }

    // Eyes on the face — low on the front of the sac, staring down at you
    for (let i = 0; i < EYES_PER; i += 1) {
      const side = i === 0 ? -1 : 1;
      _local.compose(_p.set(side * 0.3, -0.35, 1.15), _q.identity(), _s.setScalar(0.4));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.4, 0.35);
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force * 0.4); // heavy — blasts push it slowly
    this.stunTimer = OVERLORD_STUN;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force * 0.4);
    this.stunTimer = OVERLORD_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('overlord', this);
      this.hasSlots = false;
    }
  }
}
