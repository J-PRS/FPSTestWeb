import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  ROLLER_RADIUS, ROLLER_HEALTH,
  ROLLER_ACCEL, ROLLER_TOPSPEED,
  EMERGE_DUR, MELEE_FAVOR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { writeRollerInstances } from './rollerVisual.js';
export { rollerParts } from './rollerVisual.js';
import { type SimRoller, makeSimRoller, stepRoller } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();

/**
 * Roller — a big ball that just rolls toward the player. Terrain-following
 * homing boulder: steers on XZ, rides the heightmap, speeds up downhill.
 * Renders into the shared roller swarm — owns no meshes.
 */
export class Roller implements Targetable, SwarmSlotOwner {
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x6B5A44); // dusty rock
  scale = 1.6; // big debris on death

  swarmSlot = -1;
  shadowSlot = -1;
  // Public flat fields — rollerVisual's RollerVisHost reads them.
  hasSlots = false;

  // Roll rotation is accumulated — instancing has no scene node to mutate
  rollQuat = new THREE.Quaternion();
  tint = 0.8 + Math.random() * 0.4; // per-roller rock shade variance
  flash = 0;
  private hitCooldown = 0; // brief invuln so contact doesn't multi-tick
  private airborne = false;
  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onHit?: (roller: Roller) => void;
  onLanded?: (pos: THREE.Vector3) => void;

  /** netDriven = server-authoritative replay — same contract as Crawler. */
  netDriven = false;
  netId = 0;
  sim: SimRoller | null = null;
  netAcc = 0;
  yaw = 0; // net replay writes this; display rolls on rollQuat instead
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    this.netDriven = true;
    this.netId = b.id;
    this.id = 0x50_00_00_00 + b.id;
    bindNetSim(this, makeSimRoller, b);
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
  }

  private updateNet(dt: number, terrain: Terrain): void {
    updateNetSim(this, dt, terrain, stepRoller);
    if (this.flash > 0) {this.flash -= dt;}
    // Roll rotation is client dressing — the sim carries pos/vel only.
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }
  }

  writeInstances(terrain?: Terrain): void {
    writeRollerInstances(this, terrain);
  }

  get disposed(): boolean { return this.dead; }

  constructor(_scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    // Uber = "avalanche": double the boulder, triple the tank, and mass
    // enough that blasts cannot stop it — you dodge it or you die.
    this.uber = uber;
    this.health = this.maxHealth = uber ? ROLLER_HEALTH * 3 : ROLLER_HEALTH;
    this.radius = uber ? ROLLER_RADIUS * 2 : ROLLER_RADIUS;
    if (uber) {this.color.set(0x4a3a52);} // dark basalt — reads heavy
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('roller', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain);
      this.writeInstances(terrain);
      return;
    }
    if (this.flash > 0) {this.flash -= dt;}
    if (this.hitCooldown > 0) {this.hitCooldown -= dt;}

    const gy = terrain.getHeight(this.pos.x, this.pos.z);

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — no rolling until surfaced
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = gy + this.radius - this.emergeDepth * (1 - k * k);
      this.vel.set(0, 0, 0);
    } else if (this.airborne) {
      this.tickAir(dt, terrain, gy);
    } else {
      this.tickGround(dt, terrain, playerPos);
    }

    // Roll rotation: axis = up × velocity, rate = speed / radius
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }

    this.writeInstances();
  }

  private tickAir(dt: number, terrain: Terrain, gy: number): void {
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y - this.radius <= gy) {
      this.pos.y = gy + this.radius;
      this.airborne = false;
      this.vel.x *= 0.4; this.vel.z *= 0.4;
      this.vel.y = 0;
      this.onLanded?.(this.pos);
    }
  }

  // Surface steering: home on the player with a top-speed clamp, let
  // downhill grade feed speed, and ram only on true 3D contact — `dist`
  // is horizontal (steering); a boulder under a flying player used to
  // connect through the air.
  private tickGround(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    _dir.set(playerPos.x - this.pos.x, 0, playerPos.z - this.pos.z);
    const dist = _dir.length();
    if (dist > 0.01) {
      _dir.divideScalar(dist);
      this.vel.x += _dir.x * ROLLER_ACCEL * dt;
      this.vel.z += _dir.z * ROLLER_ACCEL * dt;
    }
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > ROLLER_TOPSPEED) {
      const s = ROLLER_TOPSPEED / hSpeed;
      this.vel.x *= s; this.vel.z *= s;
    }

    const prevY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius;
    const drop = prevY - this.pos.y;
    if (drop > 0 && hSpeed > 0.1) {
      const g = -drop / (dt || 1);
      this.vel.x += _dir.x * Math.min(g * 0.02, 4) * dt;
      this.vel.z += _dir.z * Math.min(g * 0.02, 4) * dt;
    }

    if (this.hitCooldown <= 0 && this.pos.distanceTo(playerPos) < this.radius + 1 * MELEE_FAVOR) {
      this.hitCooldown = 0.6;
      this.onHit?.(this);
    }
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {return claimDamageMelee(this, damage, Roller.hitClaim, opts?.serverPaid);}
    this.health -= damage;
    this.flash = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (this.uber) {return;} // avalanche — unstoppable mass, that's the whole point
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 0.8); // heavy — blasts shove, not launch
    if (this.vel.y > 3) {this.airborne = true;}    // ...unless it's a big one
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.uber) {return;}
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 0.8);
    if (this.vel.y > 3) {this.airborne = true;}
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('roller', this);
      this.hasSlots = false;
    }
  }
}
