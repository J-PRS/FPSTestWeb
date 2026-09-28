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

type SeekerState = 'patrol' | 'chase' | 'telegraph' | 'dart' | 'recover';
interface SeekerCtx { dt: number; distSq: number; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }

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

/**
 * Airborne sting enemy — the anti-"fly in a straight line" teacher.
 * Renders into the shared seeker swarm — owns no meshes.
 */
export class Seeker implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0xcfc39a); // bone-pale chitin
  readonly debrisKind = 'goo' as const;
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

  private state: SeekerState = 'patrol';
  private telegraphTimer = 0;
  private dartTimer = 0;
  private recoverTimer = 0;
  private stunTimer = 0;
  private dartDir = new THREE.Vector3();
  private bobPhase = Math.random() * Math.PI * 2;

  onSting?: (seeker: Seeker) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "lancer": bigger, tankier, and it LEADS the dart — telegraph
    // locks onto pos + vel × flight time, so holding a strafe line into
    // the dart gets you stung. Juke during the telegraph.
    this.uber = uber;
    this.health = this.maxHealth = uber ? SEEKER_HEALTH * 3 : SEEKER_HEALTH;
    this.radius = uber ? SEEKER_RADIUS * 1.8 : SEEKER_RADIUS;
    if (uber) this.color.set(0x9a2a2a); // blood lancer
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + SEEKER_HOVER;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('seeker', this);
    if (!this.hasSlots) this.dead = true;
  }

  // State handlers live in a static table — each is a small (self, ctx)
  // function, so no per-instance closures or switch boilerplate. Adding a
  // behavior is a table entry, not another case in a 100-line update.
  // Reused scratch — update runs per frame per seeker, no allocation wanted
  private static readonly _ctx: SeekerCtx = { dt: 0, distSq: 0, playerPos: null as never };

  private static readonly STATES: Record<SeekerState, (s: Seeker, c: SeekerCtx) => void> = {
    patrol(s, c) {
      _dir.subVectors(c.playerPos, s.pos);
      const d = _dir.length() || 0.001;
      _dir.multiplyScalar(1 / d);
      const hold = SEEKER_AGGRO_DIST * 0.8;
      const pull = Math.max(-1, Math.min(1, (d - hold) / hold));
      s.vel.addScaledVector(_dir, pull * SEEKER_ACCEL * 0.4 * c.dt);
      s.capSpeed(SEEKER_SPEED * 0.4);
      if (c.distSq < SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST) s.state = 'chase';
      s.glow = 0;
    },
    chase(s, c) {
      if (c.distSq > SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST * 1.4) { s.state = 'patrol'; return; }
      _dir.subVectors(c.playerPos, s.pos);
      const d = _dir.length() || 0.001;
      _dir.multiplyScalar(1 / d);
      s.vel.addScaledVector(_dir, SEEKER_ACCEL * c.dt);
      s.capSpeed(SEEKER_SPEED);
      s.glow = 0.2;
      if (d < SEEKER_DART_RANGE && s.stunTimer <= 0) {
        s.state = 'telegraph';
        s.telegraphTimer = SEEKER_DART_TELEGRAPH;
        s.dartDir.copy(_dir);
      }
    },
    telegraph(s, c) {
      s.telegraphTimer -= c.dt;
      s.vel.multiplyScalar(1 - 4 * c.dt);
      _dir.subVectors(c.playerPos, s.pos);
      if (s.uber && c.playerVel) {
        // Predictive lock: aim where you'll BE when the dart lands —
        // flight ≈ dist / dartSpeed, capped so orbiters don't overshoot
        const d = _dir.length() || 0.001;
        _dir.addScaledVector(c.playerVel, Math.min(0.6, d / SEEKER_DART_SPEED));
      }
      _dir.normalize();
      s.dartDir.lerp(_dir, 6 * c.dt).normalize();
      const t = 1 - s.telegraphTimer / SEEKER_DART_TELEGRAPH;
      s.glow = 0.7 * t;
      s.eyeScale = 0.9 + t * 0.8;
      s.vel.addScaledVector(s.dartDir, -6 * c.dt);
      if (s.telegraphTimer <= 0) {
        s.state = 'dart';
        s.dartTimer = SEEKER_DART_MAX;
        s.vel.copy(s.dartDir).multiplyScalar(SEEKER_DART_SPEED);
        s.glow = 0.8;
      }
    },
    dart(s, c) {
      s.dartTimer -= c.dt;
      if (s.dartTimer <= 0) s.beginRecover();
    },
    recover(s, c) {
      s.recoverTimer -= c.dt;
      _dir.subVectors(s.pos, c.playerPos);
      _dir.y = 0.8;
      s.vel.addScaledVector(_dir.normalize(), SEEKER_ACCEL * 0.5 * c.dt);
      s.capSpeed(SEEKER_SPEED * 0.6);
      s.glow = 0;
      if (s.recoverTimer <= 0) s.state = 'chase';
    },
  };

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;

    this.animT += dt;
    const distSq = this.pos.distanceToSquared(playerPos);

    const ctx = Seeker._ctx;
    ctx.dt = dt; ctx.distSq = distSq; ctx.playerPos = playerPos; ctx.playerVel = playerVel;
    Seeker.STATES[this.state](this, ctx);

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

  takeDamage(damage: number): boolean {
    this.health -= damage;
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
