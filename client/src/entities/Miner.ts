import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  MINER_RADIUS, MINER_HEALTH,
  MINER_SPEED, MINER_ALTITUDE, MINER_LOITER_DIST, MINER_ACCEL,
  MINER_DROP_INTERVAL, MINER_DROP_RANGE, MINER_STUN,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { BlobShadow } from '../effects/blobShadow.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

// Shared geometries — a fat gasbag hull, gondola underneath, tail fins
let _hullGeo: THREE.IcosahedronGeometry | null = null;
function getHullGeo(): THREE.IcosahedronGeometry {
  if (!_hullGeo) {
    _hullGeo = new THREE.IcosahedronGeometry(1, 1);
    _hullGeo.scale(1.0, 0.75, 1.6); // blimp proportions
  }
  return _hullGeo;
}
let _gondGeo: THREE.BoxGeometry | null = null;
function getGondGeo(): THREE.BoxGeometry {
  if (!_gondGeo) _gondGeo = new THREE.BoxGeometry(0.7, 0.5, 1.2);
  return _gondGeo;
}
let _finGeo: THREE.BoxGeometry | null = null;
function getFinGeo(): THREE.BoxGeometry {
  if (!_finGeo) _finGeo = new THREE.BoxGeometry(0.08, 0.9, 0.7);
  return _finGeo;
}

/**
 * Miner — the flying dredge. A big, slow, always-visible gasbag that drifts
 * toward the player and sows mines across the dunes. The antithesis of a
 * burrower: huge hitbox, high health, ponderous — a PRIORITY target you
 * choose to shoot down, while its mine trail punishes anyone who ignores it.
 * The mines it drops are the real weapon; the body is just slow and fat.
 */
export class Miner implements Targetable {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = MINER_HEALTH;
  maxHealth = MINER_HEALTH;
  radius = MINER_RADIUS;
  // Hull is a 7m-long fuselage — capsule along heading, not a sphere, so
  // nose/tail shots count. Updated per-frame from mesh yaw.
  readonly capsuleEnd = new THREE.Vector3(0, 0, 1.3);
  color = new THREE.Color(0x8a5a2a); // rusty canvas gasbag
  scale = 2.2; // big — big nugget payout, big debris

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private finMat: THREE.MeshLambertMaterial;
  private eyeMatL: THREE.SpriteMaterial;
  private eyeMatR: THREE.SpriteMaterial;
  private scene: THREE.Scene;
  private shadow: BlobShadow;
  private animT = Math.random() * 10;

  private dropTimer = MINER_DROP_INTERVAL * 0.5; // first mine comes quick — announce the payload
  private stunTimer = 0;
  private flashTimer = 0;
  private dropGlow = 0; // belly-flash decay on each mine drop
  private strafeDir = Math.random() < 0.5 ? 1 : -1; // circling direction while loitering

  /** Drop moment — entities.ts spawns the Mine under the belly. */
  onMineDrop?: (miner: Miner) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + MINER_ALTITUDE;
    this.vel = new THREE.Vector3();

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x120a04 });
    this.mesh = new THREE.Mesh(getHullGeo(), this.mat);
    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Gondola — the mine-bay slung under the hull
    const gondola = new THREE.Mesh(getGondGeo(), this.mat);
    gondola.position.set(0, -0.85, 0.1);
    this.mesh.add(gondola);

    // Tail fins — cruciform stabilizers, sell "dirigible"
    this.finMat = new THREE.MeshLambertMaterial({ color: 0x6b4420 });
    for (const [px, pz, rz] of [[0, -1.5, 0], [-0.9, -1.35, 0.5], [0.9, -1.35, -0.5]] as const) {
      const fin = new THREE.Mesh(getFinGeo(), this.finMat);
      fin.position.set(px, 0.1, pz);
      fin.rotation.z = rz;
      this.mesh.add(fin);
    }

    // Eyes on the front of the gondola — small, forward; it's a workhorse,
    // not a looker. Dim orange.
    const tex = getEyeTex();
    this.eyeMatL = new THREE.SpriteMaterial({ map: tex, color: 0xffaa33, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.eyeMatR = this.eyeMatL.clone();
    const eL = new THREE.Sprite(this.eyeMatL);
    const eR = new THREE.Sprite(this.eyeMatR);
    const s = this.radius * 0.35;
    eL.scale.setScalar(s);
    eR.scale.setScalar(s);
    eL.position.set(-0.22, -0.6, 1.35);
    eR.position.set(0.22, -0.6, 1.35);
    this.mesh.add(eL, eR);

    this.shadow = new BlobShadow(scene, this.radius * 1.4, 0.35);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }
    this.animT += dt;

    // Steering: hold a wide loiter ring around the player — close enough that
    // mines land in their play space, far enough that orbiting it is a choice.
    _dir.subVectors(playerPos, this.pos);
    _dir.y = 0;
    const d = _dir.length() || 0.001;
    _dir.multiplyScalar(1 / d);
    const ringErr = d - MINER_LOITER_DIST;
    // Tangential drift while near the ring — circles the player instead of
    // hovering dead still (keeps the mine trail drawing loops, not a pile)
    _scratch.set(-_dir.z * this.strafeDir, 0, _dir.x * this.strafeDir);
    if (this.stunTimer <= 0) {
      this.vel.x += (_dir.x * ringErr * 0.15 + _scratch.x * MINER_SPEED * 0.7) * MINER_ACCEL * dt * 0.1;
      this.vel.z += (_dir.z * ringErr * 0.15 + _scratch.z * MINER_SPEED * 0.7) * MINER_ACCEL * dt * 0.1;
    }
    // Altitude hold — gentle bob on top of the altitude anchor
    const targetY = terrain.getHeight(this.pos.x, this.pos.z) + MINER_ALTITUDE + Math.sin(this.animT * 0.9) * 1.2;
    this.vel.y += (targetY - this.pos.y) * 1.5 * dt;
    this.vel.multiplyScalar(1 - Math.min(1, 1.8 * dt)); // heavy drag — ponderous
    const spd = Math.hypot(this.vel.x, this.vel.z);
    if (spd > MINER_SPEED) { this.vel.x *= MINER_SPEED / spd; this.vel.z *= MINER_SPEED / spd; }
    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 2) this.pos.y = gy + 2; // never drag the belly

    // Flip orbit direction occasionally — keeps the pattern from being a ring
    if (Math.random() < dt * 0.1) this.strafeDir *= -1;

    // Sow mines while in the player's play space
    this.dropTimer -= dt;
    const distToPlayer = this.pos.distanceTo(playerPos);
    if (this.dropTimer <= 0 && distToPlayer < MINER_DROP_RANGE) {
      this.dropTimer = MINER_DROP_INTERVAL;
      this.onMineDrop?.(this);
      this.dropGlow = 0.35; // belly flash tells the drop happened
      this.mat.emissive.setRGB(0.3, 0.18, 0.05);
    }
    if (this.dropGlow > 0) {
      this.dropGlow -= dt;
      if (this.dropGlow <= 0) this.mat.emissive.setHex(0x120a04);
    }

    // Face drift direction, bank slightly into the turn
    if (Math.hypot(this.vel.x, this.vel.z) > 0.5) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let dy = targetYaw - this.mesh.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.mesh.rotation.y += dy * Math.min(1, 2 * dt);
      this.mesh.rotation.z = -dy * 0.3;
      // Hitbox capsule follows the actual visual heading
      this.capsuleEnd.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y)).multiplyScalar(1.3);
    }

    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
  }

  takeDamage(): boolean {
    this.health--;
    this.flashTimer = 0.15;
    this.mat.color.set(0xffffff);
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
    this.shadow.dispose();
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.finMat.dispose();
    this.eyeMatL.dispose();
    this.eyeMatR.dispose();
    // geometry is shared — never dispose
  }
}

let _eyeTex: THREE.Texture | null = null;
function getEyeTex(): THREE.Texture {
  if (!_eyeTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    _eyeTex = new THREE.CanvasTexture(c);
  }
  return _eyeTex;
}
