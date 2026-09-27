import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  RAKK_RADIUS, RAKK_HEALTH,
  RAKK_ORBIT_ALT, RAKK_ORBIT_R, RAKK_SPEED, RAKK_ACCEL,
  RAKK_DIVE_CD_MIN, RAKK_DIVE_CD_MAX, RAKK_DIVE_SPEED,
  RAKK_CLAW_DIST, RAKK_CLIMB_T, RAKK_STUN,
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

const PART_BODY = 0;
const PART_BEAK = 1;
const PART_WING = 2; // 2 per rakk
const PART_TAIL = 3;
const PART_EYE = 4;  // 2 per rakk — glow quads
const WINGS_PER = 2;
const EYES_PER = 2;

let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    _bodyGeo.scale(0.5, 0.4, 1.4); // long low fuselage
  }
  return _bodyGeo;
}
const _wingGeo = new THREE.BoxGeometry(2.6, 0.05, 0.7);
const _beakGeo = new THREE.ConeGeometry(0.14, 0.8, 4);
const _tailGeo = new THREE.BoxGeometry(0.9, 0.04, 0.5);
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function rakkParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_wingMat) _wingMat = new THREE.MeshLambertMaterial({ color: 0x8a4526, side: THREE.DoubleSide });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    color: 0xffe066, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _beakGeo, material: _bodyMat },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
    { geometry: _tailGeo, material: _wingMat },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Rakk — the cliff-racer. Orbits overhead, folds into a telegraphed dive,
 * slow climb after = the shoot-it window. One diver at a time via the
 * flock attack token. Renders into the shared rakk swarm — owns no meshes.
 */
export class Rakk implements Targetable, SwarmSlotOwner {
  static attackHeldBy: number | null = null; // flock attack token — one diver at a time
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = RAKK_HEALTH;
  maxHealth = RAKK_HEALTH;
  radius = RAKK_RADIUS;
  color = new THREE.Color(0xa8572e); // dusty rust-orange bird
  scale = 0.8;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private flash = 0;

  private state: 'orbit' | 'dive' | 'climb' = 'orbit';
  private stateTimer = RAKK_DIVE_CD_MIN + Math.random() * (RAKK_DIVE_CD_MAX - RAKK_DIVE_CD_MIN);
  private orbitPhase = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private diveTarget = new THREE.Vector3();
  private stunTimer = 0;

  onClawHit?: (rakk: Rakk) => void;
  onDive?: (rakk: Rakk) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    void scene;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + RAKK_ORBIT_ALT;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('rakk', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    this.animT += dt;
    this.stateTimer -= dt;

    switch (this.state) {
      case 'orbit': {
        this.orbitPhase += dt * (RAKK_SPEED / RAKK_ORBIT_R) * this.orbitDir;
        _dir.set(
          playerPos.x + Math.cos(this.orbitPhase) * RAKK_ORBIT_R,
          terrain.getHeight(playerPos.x, playerPos.z) + RAKK_ORBIT_ALT + Math.sin(this.animT * 0.8) * 2,
          playerPos.z + Math.sin(this.orbitPhase) * RAKK_ORBIT_R,
        );
        this.steerToward(_dir, RAKK_SPEED, dt);
        if (Math.random() < dt * 0.08) this.orbitDir *= -1;

        if (this.stateTimer <= 0 && Rakk.attackHeldBy === null) {
          Rakk.attackHeldBy = this.id;
          this.state = 'dive';
          this.stateTimer = 1.5;
          this.diveTarget.copy(playerPos);
          this.onDive?.(this);
        }
        break;
      }
      case 'dive': {
        this.steerToward(this.diveTarget, RAKK_DIVE_SPEED, dt);
        const hit = this.pos.distanceToSquared(playerPos) < RAKK_CLAW_DIST * RAKK_CLAW_DIST;
        const passed = this.stateTimer <= 0 || this.pos.distanceToSquared(this.diveTarget) < 4;
        if (hit) {
          this.onClawHit?.(this);
          this.releaseToken();
          this.beginClimb();
        } else if (passed) {
          this.releaseToken();
          this.beginClimb();
        }
        break;
      }
      case 'climb': {
        const targetY = terrain.getHeight(this.pos.x, this.pos.z) + RAKK_ORBIT_ALT;
        this.vel.y += ((targetY - this.pos.y) * 2.5 - this.vel.y) * Math.min(1, 3 * dt);
        this.capSpeed(RAKK_SPEED * 0.6);
        if (this.stateTimer <= 0) {
          this.state = 'orbit';
          this.stateTimer = RAKK_DIVE_CD_MIN + Math.random() * (RAKK_DIVE_CD_MAX - RAKK_DIVE_CD_MIN);
        }
        break;
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 1.0) this.pos.y = gy + 1.0;

    if (this.vel.lengthSq() > 1) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 4 * dt);
      this.roll = -dy * 0.5;
      this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.05, -0.7, 0.5);
    }

    this.writeInstances();
  }

  private writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('rakk');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _s.setScalar(r);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    const fr = this.flash > 0 ? 4 : 1;
    const cr = this.color.r * fr, cg = this.color.g * fr, cb = this.color.b * fr;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, cr, cg, cb);
    swarm.setColor(PART_BEAK, slot, cr, cg, cb);

    // Beak — the head reads predatory at silhouette scale
    _e.set(Math.PI / 2, 0, 0);
    _q.setFromEuler(_e);
    _local.compose(_p.set(0, -0.05, 1.6), _q, _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_BEAK, slot, _world);

    // Wings — slow soar flap, hard tuck in the dive, flailing climb
    const dive = this.state === 'dive';
    const flapAmp = dive ? 0.15 : this.state === 'climb' ? 0.9 : 0.35;
    const flapRate = dive ? 4 : this.state === 'climb' ? 14 : 5;
    const flap = Math.sin(this.animT * flapRate) * flapAmp;
    const fold = dive ? 0.7 : 0;
    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _e.set(0, -side * fold * 0.6, side * (0.1 + flap + fold));
      _q.setFromEuler(_e);
      _local.compose(_p.set(side * 1.5, 0.1, -0.1), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
    }

    // Tail fan
    _local.compose(_p.set(0, 0.05, -1.5), _q.identity(), _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_TAIL, slot, _world);

    // Eyes — paired glow quads on the head
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(_p.set(side * 0.2, 0.15, 1.1), _q.identity(), _s.setScalar(0.3));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.6, 0.28);
  }

  private steerToward(target: THREE.Vector3, speed: number, dt: number): void {
    _scratch.subVectors(target, this.pos);
    const d = _scratch.length() || 0.001;
    _scratch.multiplyScalar(1 / d);
    this.vel.addScaledVector(_scratch, RAKK_ACCEL * dt);
    this.capSpeed(speed);
  }

  private capSpeed(max: number): void {
    const s = this.vel.length();
    if (s > max) this.vel.multiplyScalar(max / s);
  }

  private beginClimb(): void {
    this.state = 'climb';
    this.stateTimer = RAKK_CLIMB_T;
    this.vel.multiplyScalar(0.4);
    this.vel.y = Math.abs(this.vel.y) * 0.5 + 6;
  }

  private releaseToken(): void {
    if (Rakk.attackHeldBy === this.id) Rakk.attackHeldBy = null;
  }

  takeDamage(): boolean {
    this.health--;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; this.releaseToken(); return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = RAKK_STUN;
    if (this.state === 'dive') { this.releaseToken(); this.beginClimb(); }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = RAKK_STUN;
  }

  dispose(): void {
    this.releaseToken();
    if (this.hasSlots) {
      freeSlots('rakk', this);
      this.hasSlots = false;
    }
  }
}
