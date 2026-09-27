import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SEEKER_RADIUS, SEEKER_HEALTH,
  SEEKER_AGGRO_DIST, SEEKER_HOVER, SEEKER_SPEED, SEEKER_ACCEL,
  SEEKER_DART_RANGE, SEEKER_DART_SPEED, SEEKER_DART_TELEGRAPH, SEEKER_DART_MAX,
  SEEKER_STING_DIST, SEEKER_RECOVER, SEEKER_STUN,
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
const PART_WING = 1;    // 2 per seeker
const PART_STINGER = 2;
const PART_JAW = 3;     // 2 per seeker
const PART_EYE = 4;     // single cyclops eye quad
const WINGS_PER = 2;
const JAWS_PER = 2;

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
    color: 0xffcc44, transparent: true, blending: THREE.AdditiveBlending,
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

/**
 * Airborne sting enemy — the anti-"fly in a straight line" teacher.
 * Renders into the shared seeker swarm — owns no meshes.
 */
export class Seeker implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = SEEKER_HEALTH;
  maxHealth = SEEKER_HEALTH;
  radius = SEEKER_RADIUS;
  color = new THREE.Color(0xcfc39a); // bone-pale chitin
  scale = 0.3;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private eyeScale = 0.55;
  private glow = 0;
  private flash = 0;

  private state: 'patrol' | 'chase' | 'telegraph' | 'dart' | 'recover' = 'patrol';
  private telegraphTimer = 0;
  private dartTimer = 0;
  private recoverTimer = 0;
  private stunTimer = 0;
  private dartDir = new THREE.Vector3();
  private bobPhase = Math.random() * Math.PI * 2;

  onSting?: (seeker: Seeker) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    void scene;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + SEEKER_HOVER;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('seeker', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;

    this.animT += dt;
    const distSq = this.pos.distanceToSquared(playerPos);

    switch (this.state) {
      case 'patrol': {
        _dir.subVectors(playerPos, this.pos);
        const d = _dir.length() || 0.001;
        _dir.multiplyScalar(1 / d);
        const hold = SEEKER_AGGRO_DIST * 0.8;
        const pull = Math.max(-1, Math.min(1, (d - hold) / hold));
        this.vel.addScaledVector(_dir, pull * SEEKER_ACCEL * 0.4 * dt);
        this.capSpeed(SEEKER_SPEED * 0.4);
        if (distSq < SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST) this.state = 'chase';
        this.glow = 0;
        break;
      }
      case 'chase': {
        if (distSq > SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST * 1.4) { this.state = 'patrol'; break; }
        _dir.subVectors(playerPos, this.pos);
        const d = _dir.length() || 0.001;
        _dir.multiplyScalar(1 / d);
        this.vel.addScaledVector(_dir, SEEKER_ACCEL * dt);
        this.capSpeed(SEEKER_SPEED);
        this.glow = 0.2;
        if (d < SEEKER_DART_RANGE && this.stunTimer <= 0) {
          this.state = 'telegraph';
          this.telegraphTimer = SEEKER_DART_TELEGRAPH;
          this.dartDir.copy(_dir);
        }
        break;
      }
      case 'telegraph': {
        this.telegraphTimer -= dt;
        this.vel.multiplyScalar(1 - 4 * dt);
        _dir.subVectors(playerPos, this.pos).normalize();
        this.dartDir.lerp(_dir, 6 * dt).normalize();
        const t = 1 - this.telegraphTimer / SEEKER_DART_TELEGRAPH;
        this.glow = 0.7 * t;
        this.eyeScale = 0.9 + t * 0.8;
        this.vel.addScaledVector(this.dartDir, -6 * dt);
        if (this.telegraphTimer <= 0) {
          this.state = 'dart';
          this.dartTimer = SEEKER_DART_MAX;
          this.vel.copy(this.dartDir).multiplyScalar(SEEKER_DART_SPEED);
          this.glow = 0.8;
        }
        break;
      }
      case 'dart': {
        this.dartTimer -= dt;
        if (this.dartTimer <= 0) this.beginRecover();
        break;
      }
      case 'recover': {
        this.recoverTimer -= dt;
        _dir.subVectors(this.pos, playerPos);
        _dir.y = 0.8;
        this.vel.addScaledVector(_dir.normalize(), SEEKER_ACCEL * 0.5 * dt);
        this.capSpeed(SEEKER_SPEED * 0.6);
        this.glow = 0;
        if (this.recoverTimer <= 0) this.state = 'chase';
        break;
      }
    }

    if ((this.state === 'dart' || this.state === 'chase') && distSq < SEEKER_STING_DIST * SEEKER_STING_DIST) {
      this.onSting?.(this);
      this.beginRecover();
    }

    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    const bob = Math.sin(this.animT * 3 + this.bobPhase) * 0.6;
    const minY = gy + (this.state === 'dart' ? 0.8 : 1.2);
    if (this.pos.y < minY) { this.pos.y = minY; if (this.vel.y < 0) this.vel.y = 0; }
    if (this.state === 'patrol') {
      const targetY = gy + SEEKER_HOVER + bob;
      this.pos.y += (targetY - this.pos.y) * Math.min(1, 2 * dt);
    }

    // Face travel direction, bank into turns
    if (this.vel.lengthSq() > 1) {
      this.yaw = Math.atan2(this.vel.x, this.vel.z);
      this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.04, -0.6, 0.6);
      this.roll = THREE.MathUtils.clamp(
        -(this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) * 0.03, -0.5, 0.5);
    }

    if (this.state !== 'telegraph' && this.state !== 'dart') {
      this.eyeScale = (this.state === 'chase' ? 0.75 : 0.55) + 0.15 * Math.sin(this.animT * 5);
    }

    this.writeInstances();
  }

  private writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('seeker');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _s.setScalar(r);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    const fr = this.flash > 0 ? 4 : 1;
    const g = this.glow;
    const cr = this.color.r * fr + g * 0.9;
    const cg = this.color.g * fr + g * 0.45;
    const cb = this.color.b * fr;
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
    const flapRate = this.state === 'telegraph' ? 4 : 22;
    const wingA = Math.sin(this.animT * flapRate) * (this.state === 'dart' ? 0.9 : 0.6);
    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _e.set(0, 0, side * (0.15 + wingA));
      _q.setFromEuler(_e);
      _local.compose(_p.set(side * 0.85, 0.35, -0.1), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
    }

    // Cyclops eye — additive quad riding the face
    _local.compose(_p.set(0, 0.15, 0.75), _q.identity(), _s.setScalar(this.eyeScale * 0.9));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot, _world);

    getShadows()?.set(this, this.pos, r * 1.2, 0.3);
  }

  private beginRecover(): void {
    this.state = 'recover';
    this.recoverTimer = SEEKER_RECOVER;
    this.glow = 0;
    this.vel.y += 6; // sting momentum carries through, not a dead stop
  }

  private capSpeed(max: number): void {
    const s = this.vel.length();
    if (s > max) this.vel.multiplyScalar(max / s);
  }

  takeDamage(): boolean {
    this.health--;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force * 1.5); // light body — blasts send it tumbling
    this.stunTimer = SEEKER_STUN;
    if (this.state === 'telegraph' || this.state === 'dart') {
      this.beginRecover(); // a blast interrupts the attack
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force * 1.5);
    this.stunTimer = SEEKER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('seeker', this);
      this.hasSlots = false;
    }
  }
}
