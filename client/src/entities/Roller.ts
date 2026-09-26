import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  ROLLER_RADIUS, ROLLER_HEALTH,
  ROLLER_ACCEL, ROLLER_TOPSPEED,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { BlobShadow } from '../effects/blobShadow.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();

let _geo: THREE.IcosahedronGeometry | null = null;
function getGeo(): THREE.IcosahedronGeometry {
  if (!_geo) _geo = new THREE.IcosahedronGeometry(1, 2); // faceted boulder — roll reads clearly
  return _geo;
}

/**
 * Roller — a big ball that just rolls toward the player. Terrain-following
 * homing boulder: steers on XZ, rides the heightmap, speeds up downhill.
 * No dodge moves — the hitbox is the whole threat. Shoot it or juke it.
 */
export class Roller implements Targetable {
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

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private scene: THREE.Scene;
  private shadow: BlobShadow;
  private flashTimer = 0;
  private hitCooldown = 0; // brief invuln so contact doesn't multi-tick
  private airborne = false;

  /** Contact with the player — wire damage + knockback in main. */
  onHit?: (roller: Roller) => void;
  /** Dust when it lands after being launched airborne. */
  onLanded?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x0a0705 });
    this.mesh = new THREE.Mesh(getGeo(), this.mat);
    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.shadow = new BlobShadow(scene, this.radius * 1.05, 0.4);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }
    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    const gy = terrain.getHeight(this.pos.x, this.pos.z);

    if (this.airborne) {
      // Launched by an explosion — ballistic until it lands
      this.vel.y += GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y - this.radius <= gy) {
        this.pos.y = gy + this.radius;
        this.airborne = false;
        this.vel.x *= 0.4; this.vel.z *= 0.4; // bleed the launch
        this.vel.y = 0;
        this.onLanded?.(this.pos);
      }
    } else {
      // Grounded: steer toward the player on XZ, ride the heightmap.
      _dir.set(playerPos.x - this.pos.x, 0, playerPos.z - this.pos.z);
      const dist = _dir.length();
      if (dist > 0.01) {
        _dir.divideScalar(dist);
        this.vel.x += _dir.x * ROLLER_ACCEL * dt;
        this.vel.z += _dir.z * ROLLER_ACCEL * dt;
      }
      // Cap steering speed — downhill momentum can exceed it (gravity does
      // the work via the slope drop below)
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
      // Rolling downhill gains real speed: convert the drop into forward gas
      const drop = prevY - this.pos.y;
      if (drop > 0 && hSpeed > 0.1) {
        const g = -drop / (dt || 1); // fall rate → a touch of accel
        this.vel.x += _dir.x * Math.min(g * 0.02, 4) * dt;
        this.vel.z += _dir.z * Math.min(g * 0.02, 4) * dt;
      }

      // Contact — the boulder's whole job
      if (this.hitCooldown <= 0 && dist < this.radius + 1.0) {
        this.hitCooldown = 0.6;
        this.onHit?.(this);
      }
    }

    // Roll rotation: axis = up × velocity, rate = speed / radius
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      this.mesh.rotateOnWorldAxis(_axis, (hSpeed * dt) / this.radius);
    }
    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
  }

  takeDamage(): boolean {
    this.health--;
    this.flashTimer = 0.12;
    this.mat.color.set(0xffffff);
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
    this.shadow.dispose();
    this.scene.remove(this.mesh);
    this.mat.dispose();
    // geometry is shared — never dispose
  }
}
