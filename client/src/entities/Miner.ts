import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  MINER_RADIUS, MINER_HEALTH,
  MINER_SPEED, MINER_ALTITUDE, MINER_LOITER_DIST, MINER_ACCEL,
  MINER_DROP_INTERVAL, MINER_DROP_RANGE, MINER_STUN,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';

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
const PART_GONDOLA = 1;
const PART_FIN = 2;  // 3 per miner
const PART_EYE = 3;  // 2 per miner — dim orange workhorse eyes
const FINS_PER = 3;
const EYES_PER = 2;

let _hullGeo: THREE.IcosahedronGeometry | null = null;
function hullGeo(): THREE.BufferGeometry {
  if (!_hullGeo) {
    _hullGeo = new THREE.IcosahedronGeometry(1, 1);
    _hullGeo.scale(1.0, 0.75, 1.6); // blimp proportions
  }
  return _hullGeo;
}
const _gondGeo = new THREE.BoxGeometry(0.7, 0.5, 1.2);
const _finGeo = new THREE.BoxGeometry(0.08, 0.9, 0.7);
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

const FIN_OFFSETS = [[0, -1.5, 0], [-0.9, -1.35, 0.5], [0.9, -1.35, -0.5]] as const;

let _hullMat: THREE.MeshLambertMaterial | null = null;
let _finMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function minerParts(): SwarmPart[] {
  if (!_hullMat) _hullMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_finMat) _finMat = new THREE.MeshLambertMaterial({ color: 0x6b4420 });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    color: 0xffaa33, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: hullGeo(), material: _hullMat, castShadow: true },
    { geometry: _gondGeo, material: _hullMat },
    { geometry: _finGeo, material: _finMat, per: FINS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Miner — the flying dredge. Slow gasbag that sows mines; a PRIORITY target
 * you choose to shoot down. Renders into the shared miner swarm.
 */
export class Miner implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = MINER_HEALTH;
  maxHealth = MINER_HEALTH;
  radius = MINER_RADIUS;
  // Hull is a 7m-long fuselage — capsule along heading, not a sphere, so
  // nose/tail shots count. Updated per-frame from yaw.
  readonly capsuleEnd = new THREE.Vector3(0, 0, 1.3);
  color = new THREE.Color(0x8a5a2a); // rusty canvas gasbag
  scale = 2.2;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private roll = 0;
  private flash = 0;
  private dropGlow = 0;

  private dropTimer = MINER_DROP_INTERVAL * 0.5; // first mine comes quick — announce the payload
  private stunTimer = 0;
  private strafeDir = Math.random() < 0.5 ? 1 : -1;

  onMineDrop?: (miner: Miner) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    void scene;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + MINER_ALTITUDE;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('miner', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.dropGlow > 0) this.dropGlow -= dt;
    this.animT += dt;

    // Steering: hold a wide loiter ring around the player — close enough that
    // mines land in their play space, far enough that orbiting it is a choice.
    _dir.subVectors(playerPos, this.pos);
    _dir.y = 0;
    const d = _dir.length() || 0.001;
    _dir.multiplyScalar(1 / d);
    const ringErr = d - MINER_LOITER_DIST;
    _scratch.set(-_dir.z * this.strafeDir, 0, _dir.x * this.strafeDir);
    if (this.stunTimer <= 0) {
      this.vel.x += (_dir.x * ringErr * 0.15 + _scratch.x * MINER_SPEED * 0.7) * MINER_ACCEL * dt * 0.1;
      this.vel.z += (_dir.z * ringErr * 0.15 + _scratch.z * MINER_SPEED * 0.7) * MINER_ACCEL * dt * 0.1;
    }
    const targetY = terrain.getHeight(this.pos.x, this.pos.z) + MINER_ALTITUDE + Math.sin(this.animT * 0.9) * 1.2;
    this.vel.y += (targetY - this.pos.y) * 1.5 * dt;
    this.vel.multiplyScalar(1 - Math.min(1, 1.8 * dt)); // heavy drag — ponderous
    const spd = Math.hypot(this.vel.x, this.vel.z);
    if (spd > MINER_SPEED) { this.vel.x *= MINER_SPEED / spd; this.vel.z *= MINER_SPEED / spd; }
    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 2) this.pos.y = gy + 2;

    if (Math.random() < dt * 0.1) this.strafeDir *= -1;

    this.dropTimer -= dt;
    const distToPlayer = this.pos.distanceTo(playerPos);
    if (this.dropTimer <= 0 && distToPlayer < MINER_DROP_RANGE) {
      this.dropTimer = MINER_DROP_INTERVAL;
      this.onMineDrop?.(this);
      this.dropGlow = 0.35; // belly flash tells the drop happened
    }

    // Face drift direction, bank slightly into the turn
    if (Math.hypot(this.vel.x, this.vel.z) > 0.5) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 2 * dt);
      this.roll = -dy * 0.3;
      // Hitbox capsule follows the actual visual heading
      this.capsuleEnd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(1.3);
    }

    this.writeInstances();
  }

  private writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('miner');
    if (!swarm) return;
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

    // Gondola slung under the hull
    _local.compose(_p.set(0, -0.85, 0.1), _q.identity(), _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_GONDOLA, slot, _world);
    swarm.setColor(PART_GONDOLA, slot, cr, cg, cb);

    // Tail fins — cruciform stabilizers
    for (let i = 0; i < FINS_PER; i++) {
      const [px, pz, rz] = FIN_OFFSETS[i]!;
      _e.set(0, 0, rz);
      _q.setFromEuler(_e);
      _local.compose(_p.set(px, 0.1, pz), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_FIN, slot * FINS_PER + i, _world);
    }

    // Eyes on the front of the gondola
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(_p.set(side * 0.22, -0.6, 1.35), _q.identity(), _s.setScalar(0.35));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.4, 0.35);
  }

  takeDamage(): boolean {
    this.health--;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force * 0.4); // heavy — blasts push it slowly
    this.stunTimer = MINER_STUN;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force * 0.4);
    this.stunTimer = MINER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('miner', this);
      this.hasSlots = false;
    }
  }
}
