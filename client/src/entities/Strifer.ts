import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  STRIFER_RADIUS, STRIFER_HEALTH,
  STRIFER_ORBIT_ALT, STRIFER_ORBIT_R, STRIFER_SPEED, STRIFER_ACCEL,
  STRIFER_REFIRE_MIN, STRIFER_REFIRE_MAX,
  STRIFER_BOLT_SPEED, STRIFER_BOLT_LIFE, STRIFER_BOLT_DIST,
  STRIFER_HOVER_T, STRIFER_STUN, MELEE_FAVOR,
} from '../core/config.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { writeInstances } from './striferPose.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

type StriferState = 'orbit' | 'hover';
interface StriferCtx { dt: number; terrain: Terrain; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }

const WINGS_PER = 2;
const EYES_PER = 1;

// v2: votive shard / forgotten gun-platform. The hull is a 4-sided
// tapered spire (same obelisk family as the totem) with a ceremonial
// collar ring, a swept brow crest and a chin spike — carved relic
// proportions, not aerodynamics. Blade vanes and an ember core sell
// "artifact that happens to shoot" instead of "toy plane".
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    // Keel — diamond-cross-section spire lying nose-forward (+z).
    const keel = new THREE.CylinderGeometry(0.14, 0.5, 2.2, 4);
    keel.rotateX(Math.PI / 2);
    // Brow crest — blade swept back off the top, worn sentinel horn.
    const crest = new THREE.ConeGeometry(0.16, 0.95, 4);
    crest.scale(1.7, 1, 0.35);
    crest.rotateX(-Math.PI / 2.3);
    crest.translate(0, 0.38, -0.42);
    // Dorsal ridge — stepped plates rising off the keel spine. The bare
    // spire's top was one flat facet; a carved ridge gives the side
    // profile a crown-line and reads "shrine ornament" at range.
    const ridge: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const plate = new THREE.ConeGeometry(0.1, 0.5, 4);
      plate.scale(1.4, 1, 0.3); // thin blade cross-section
      plate.rotateX(-0.35 - i * 0.18); // tips lean progressively aft
      plate.translate(0, 0.26 + i * 0.06, 0.55 - i * 0.5); // march down the spine
      ridge.push(plate);
    }
    // Chin spike under the nose — the shard's dangling point.
    const chin = new THREE.ConeGeometry(0.11, 0.7, 4);
    chin.rotateX(Math.PI * 0.75);
    chin.translate(0, -0.32, 0.6);
    // Collar — square ring around the tail, the "mounted relic" read.
    const collar = new THREE.TorusGeometry(0.44, 0.06, 4, 4);
    collar.rotateX(0.78); // tilted like a bronze hoop, not a jet ring
    collar.translate(0, 0, -0.72);
    _bodyGeo = mergeGeometries([keel, crest, ...ridge, chin, collar])!;
  }
  return _bodyGeo;
}

// Blade vane — swept-back crescent, flat in plan. Shape space: x = span
// out, y = fore(+)/aft(−). One geometry instanced per side; the left
// mirror is handled by a negative-X scale in the pose writer.
let _wingGeo: THREE.BufferGeometry | null = null;
function wingGeo(): THREE.BufferGeometry {
  if (!_wingGeo) {
    const s = new THREE.Shape();
    s.moveTo(0, 0.25);                                    // root front
    s.lineTo(0.55, 0.32);                                 // leading edge out
    s.quadraticCurveTo(1.5, 0.12, 1.72, -0.72);           // outer arc sweeps to a rear tip
    s.quadraticCurveTo(1.05, -0.38, 0.45, -0.16);         // inner arc returns
    s.lineTo(0, -0.1);                                    // root rear
    s.closePath();
    _wingGeo = new THREE.ShapeGeometry(s, 8);
    _wingGeo.rotateX(Math.PI / 2); // +y → +z, flat horizontal
  }
  return _wingGeo;
}

const _eyeGeo = new THREE.PlaneGeometry(1, 1); // glyph slit, scaled in pose

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

export function striferParts(): SwarmPart[] {
  // Same grunge/wear convention as the turretter — carved metal that
  // catches the sun, not bare plastic.
  if (!_bodyMat) { _bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0a0d12 }); _bodyMat.userData.__wearInt = 2.2; }
  if (!_wingMat) { _wingMat = new THREE.MeshLambertMaterial({ color: 0xb8c2cf, side: THREE.DoubleSide, emissive: 0x0a0d12 }); _wingMat.userData.__wearInt = 2.2; }
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xff8844, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: wingGeo(), material: _wingMat, per: WINGS_PER },
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
  hasSlots = false;

  private animT = Math.random() * 10;
  yaw = 0;
  pitch = 0;
  roll = 0;
  flash = 0;

  state: StriferState = 'orbit';
  private stateTimer = STRIFER_REFIRE_MIN + Math.random() * (STRIFER_REFIRE_MAX - STRIFER_REFIRE_MIN);
  private orbitPhase = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private stunTimer = 0;
  private volleyLeft = 0;   // bolts left in the current hover burst
  private volleyGap = 0;    // gap timer between volley shots

  readonly bolts: StriferBolt[] = [];

  /** pos = bolt impact point — the strafing run may carry the bolt a
   *  long way from the drone's current position. */
  onBoltHit?: (strifer: Strifer, pos: THREE.Vector3) => void;
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
      const boltD = STRIFER_BOLT_DIST * MELEE_FAVOR;
      const hitPlayer = b.pos.distanceToSquared(playerPos) < boltD * boltD;
      if (hitPlayer) this.onBoltHit?.(this, b.pos);
      if (hitPlayer || b.age > STRIFER_BOLT_LIFE || b.pos.y < terrain.getHeight(b.pos.x, b.pos.z)) {
        if (!hitPlayer) this.onBoltLand?.(b.pos);
        this.bolts.splice(i, 1);
      }
    }
  }

  private writeInstances(): void { writeInstances(this); }

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
