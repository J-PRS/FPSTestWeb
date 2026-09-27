import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  ROLLER_RADIUS, ROLLER_HEALTH,
  ROLLER_ACCEL, ROLLER_TOPSPEED,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

const _geo = new THREE.IcosahedronGeometry(1, 2); // faceted boulder — roll reads clearly

let _mat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — one rigid boulder per roller. */
export function rollerParts(): SwarmPart[] {
  if (!_mat) _mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return [{ geometry: _geo, material: _mat, castShadow: true }];
}

/**
 * Roller — a big ball that just rolls toward the player. Terrain-following
 * homing boulder: steers on XZ, rides the heightmap, speeds up downhill.
 * Renders into the shared roller swarm — owns no meshes.
 */
export class Roller implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = ROLLER_HEALTH;
  maxHealth = ROLLER_HEALTH;
  radius = ROLLER_RADIUS;
  color = new THREE.Color(0x6b5a44); // dusty rock
  scale = 1.6; // big debris on death

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  // Roll rotation is accumulated — instancing has no scene node to mutate
  private rollQuat = new THREE.Quaternion();
  private flash = 0;
  private hitCooldown = 0; // brief invuln so contact doesn't multi-tick
  private airborne = false;

  onHit?: (roller: Roller) => void;
  onLanded?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    void scene;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('roller', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.flash > 0) this.flash -= dt;
    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    const gy = terrain.getHeight(this.pos.x, this.pos.z);

    if (this.airborne) {
      this.vel.y += GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y - this.radius <= gy) {
        this.pos.y = gy + this.radius;
        this.airborne = false;
        this.vel.x *= 0.4; this.vel.z *= 0.4;
        this.vel.y = 0;
        this.onLanded?.(this.pos);
      }
    } else {
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
      const newGy = terrain.getHeight(this.pos.x, this.pos.z);
      this.pos.y = newGy + this.radius;
      const drop = prevY - this.pos.y;
      if (drop > 0 && hSpeed > 0.1) {
        const g = -drop / (dt || 1);
        this.vel.x += _dir.x * Math.min(g * 0.02, 4) * dt;
        this.vel.z += _dir.z * Math.min(g * 0.02, 4) * dt;
      }

      if (this.hitCooldown <= 0 && dist < this.radius + 1.0) {
        this.hitCooldown = 0.6;
        this.onHit?.(this);
      }
    }

    // Roll rotation: axis = up × velocity, rate = speed / radius
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }

    if (this.hasSlots) {
      const swarm = getSwarm('roller');
      if (swarm) {
        _s.setScalar(this.radius);
        _m.compose(this.pos, this.rollQuat, _s);
        swarm.setMatrix(0, this.swarmSlot, _m);
        const fr = this.flash > 0 ? 4 : 1;
        swarm.setColor(0, this.swarmSlot, this.color.r * fr, this.color.g * fr, this.color.b * fr);
      }
      getShadows()?.set(this, this.pos, this.radius * 1.05, 0.4);
    }
  }

  takeDamage(): boolean {
    this.health--;
    this.flash = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 0.8); // heavy — blasts shove, not launch
    if (this.vel.y > 3) this.airborne = true;    // ...unless it's a big one
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 0.8);
    if (this.vel.y > 3) this.airborne = true;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('roller', this);
      this.hasSlots = false;
    }
  }
}
