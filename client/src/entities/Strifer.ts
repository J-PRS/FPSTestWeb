import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  STRIFER_RADIUS, STRIFER_HEALTH,
  STRIFER_ORBIT_ALT, STRIFER_ORBIT_R, STRIFER_SPEED, STRIFER_ACCEL,
  STRIFER_REFIRE_MIN, STRIFER_REFIRE_MAX,
  STRIFER_BOLT_SPEED, STRIFER_BOLT_LIFE, STRIFER_BOLT_DIST,
  STRIFER_HOVER_T, STRIFER_STUN,
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
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

const PART_BODY = 0;
const PART_WING = 1; // 2 per — thin blade fins, not membrane sails
type StriferState = 'orbit' | 'hover';
interface StriferCtx { dt: number; terrain: Terrain; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }

const PART_EYE = 2;  // 1 per — the gun-muzzle glow that telegraphs a shot
const WINGS_PER = 2;
const EYES_PER = 1;

let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.OctahedronGeometry(1, 0);
    _bodyGeo.scale(0.5, 0.35, 1.4); // dart fuselage — reads as a drone, not a beast
  }
  return _bodyGeo;
}
const _wingGeo = new THREE.BoxGeometry(2.2, 0.06, 0.5); // swept blade fins
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function striferParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_wingMat) _wingMat = new THREE.MeshLambertMaterial({ color: 0x2e3a4a, side: THREE.DoubleSide });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xff8844, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

interface StriferBolt { pos: THREE.Vector3; vel: THREE.Vector3; age: number; }

/**
 * Strifer — the standoff strafing drone. Orbits the player just outside
 * melee reach, periodically breaks into a hover, fires a bolt volley at
 * the player's position, then slides back onto the orbit. The gap between
 * volleys and the low health is the counterplay — it's a sniper that
 * relocates, not a turret that camps.
 *
 * Renders into the shared strifer swarm — owns no meshes.
 */
export class Strifer implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x4a5a6e); // gunmetal blue-gray
  readonly debrisKind = 'rock' as const;
  scale = 0.9;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private flash = 0;

  private state: StriferState = 'orbit';
  private stateTimer = STRIFER_REFIRE_MIN + Math.random() * (STRIFER_REFIRE_MAX - STRIFER_REFIRE_MIN);
  private orbitPhase = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private stunTimer = 0;
  private volleyLeft = 0;   // bolts left in the current hover burst
  private volleyGap = 0;    // gap timer between volley shots

  readonly bolts: StriferBolt[] = [];

  onBoltHit?: (strifer: Strifer) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
  onFire?: (strifer: Strifer) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? STRIFER_HEALTH * 3 : STRIFER_HEALTH;
    this.radius = uber ? STRIFER_RADIUS * 1.8 : STRIFER_RADIUS;
    if (uber) this.color.set(0x3a2a4a);
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + STRIFER_ORBIT_ALT;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('strifer', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    this.animT += dt;
    this.stateTimer -= dt;

    this.updateBolts(dt, terrain, playerPos);

    if (this.stunTimer > 0) {
      // staggered — drift, no maneuvering
      this.capSpeed(STRIFER_SPEED * 0.3);
    } else {
      const ctx = Strifer._ctx;
      ctx.dt = dt; ctx.terrain = terrain; ctx.playerPos = playerPos; ctx.playerVel = playerVel;
      Strifer.STATES[this.state](this, ctx);
    }

    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 1.2) this.pos.y = gy + 1.2;

    if (this.vel.lengthSq() > 1) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 4 * dt);
      this.roll = -dy * 0.4;
      this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.05, -0.6, 0.5);
    } else if (this.state === 'hover') {
      // face the target while gunning — the fuselage must track the player
      const targetYaw = Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, 6 * dt);
      this.roll *= 0.9;
    }

    this.writeInstances();
    getShadows()?.set(this, this.pos, this.radius, 0.35);
  }

  // Static state table + shared scratch ctx — see Seeker for the pattern.
  private static readonly _ctx: StriferCtx = { dt: 0, terrain: null as never, playerPos: null as never };
  private static readonly STATES: Record<StriferState, (s: Strifer, c: StriferCtx) => void> = {
    orbit(s, c) {
      s.orbitPhase += c.dt * (STRIFER_SPEED / STRIFER_ORBIT_R) * s.orbitDir;
      _dir.set(
        c.playerPos.x + Math.cos(s.orbitPhase) * STRIFER_ORBIT_R,
        c.terrain.getHeight(c.playerPos.x, c.playerPos.z) + STRIFER_ORBIT_ALT + Math.sin(s.animT * 1.1) * 2,
        c.playerPos.z + Math.sin(s.orbitPhase) * STRIFER_ORBIT_R,
      );
      s.steerToward(_dir, STRIFER_SPEED, c.dt);
      if (Math.random() < c.dt * 0.12) s.orbitDir *= -1;

      if (s.stateTimer <= 0) {
        s.state = 'hover';
        s.stateTimer = STRIFER_HOVER_T;
        s.volleyLeft = s.uber ? 5 : 3;
        s.volleyGap = 0.25; // small settle so the burst reads as aimed
        s.vel.multiplyScalar(0.4);
      }
    },
    // brake hard and bleed off the volley
    hover(s, c) {
      s.vel.multiplyScalar(Math.max(0, 1 - 4 * c.dt));
      s.volleyGap -= c.dt;
      if (s.volleyLeft > 0 && s.volleyGap <= 0) {
        s.volleyGap = 0.5;
        s.volleyLeft--;
        s.fireBolt(c.playerPos, c.playerVel);
      }
      if (s.stateTimer <= 0 && s.volleyLeft <= 0) {
        s.state = 'orbit';
        s.stateTimer = STRIFER_REFIRE_MIN + Math.random() * (STRIFER_REFIRE_MAX - STRIFER_REFIRE_MIN);
      }
    },
  };

  private fireBolt(playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    _dir.copy(playerPos);
    _dir.y += 1.0; // chest height
    if (playerVel) _dir.addScaledVector(playerVel, 0.15); // light lead
    _dir.sub(this.pos).normalize();
    this.bolts.push({ pos: this.pos.clone(), vel: _dir.clone().multiplyScalar(STRIFER_BOLT_SPEED), age: 0 });
    this.onFire?.(this);
  }

  private updateBolts(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]!;
      b.age += dt;
      b.pos.addScaledVector(b.vel, dt);
      const hitPlayer = b.pos.distanceToSquared(playerPos) < STRIFER_BOLT_DIST * STRIFER_BOLT_DIST;
      if (hitPlayer) this.onBoltHit?.(this);
      if (hitPlayer || b.age > STRIFER_BOLT_LIFE || b.pos.y < terrain.getHeight(b.pos.x, b.pos.z)) {
        if (!hitPlayer) this.onBoltLand?.(b.pos);
        this.bolts.splice(i, 1);
      }
    }
  }

  private writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('strifer');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s.setScalar(r));

    const fr = this.flash > 0 ? 4 : 1;
    const cr = this.color.r * fr, cg = this.color.g * fr, cb = this.color.b * fr;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, cr, cg, cb);

    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      // fins dip while hovering — reads as the drone planting itself to fire
      const dip = this.state === 'hover' ? 0.25 : 0;
      _local.compose(_v.set(side * 0.55, 0.05, -0.15), _q.identity(), _s.setScalar(1));
      _world.multiplyMatrices(_root, _local);
      _e.set(0, 0, side * dip, 'XYZ');
      _q.setFromEuler(_e);
      _local.compose(_p.set(0, 0, 0), _q, _s.set(1, 1, 1));
      _world.multiply(_local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
      swarm.setColor(PART_WING, slot * WINGS_PER + i, cr * 0.8, cg * 0.8, cb * 0.8);
    }

    // muzzle glow: bright while hovering (charging a bolt), dim on orbit
    const hot = this.state === 'hover' ? 2.2 : 0.8;
    _local.compose(_v.set(0, 0.05, 1.35), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot, _world);
    swarm.setColor(PART_EYE, slot, hot, hot * 0.55, hot * 0.25);
  }

  private steerToward(target: THREE.Vector3, speed: number, dt: number): void {
    _scratch.subVectors(target, this.pos);
    const d = _scratch.length() || 0.001;
    _scratch.multiplyScalar(1 / d);
    this.vel.addScaledVector(_scratch, STRIFER_ACCEL * dt);
    this.capSpeed(speed);
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
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = STRIFER_STUN;
    if (this.state === 'hover') {
      // a blast knocks the drone out of its firing hover — counterplay
      this.state = 'orbit';
      this.stateTimer = STRIFER_REFIRE_MIN;
      this.volleyLeft = 0;
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = STRIFER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('strifer', this);
      this.hasSlots = false;
    }
  }
}
