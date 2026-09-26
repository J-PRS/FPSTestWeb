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
import { getGlowTexture } from '../effects/glowTexture.js';
import { BlobShadow } from '../effects/blobShadow.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

// Shared geometries — glider body, big flat wings, hooked beak
let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function getBodyGeo(): THREE.IcosahedronGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    _bodyGeo.scale(0.5, 0.4, 1.4); // long low fuselage
  }
  return _bodyGeo;
}
let _wingGeo: THREE.BoxGeometry | null = null;
function getWingGeo(): THREE.BoxGeometry {
  if (!_wingGeo) _wingGeo = new THREE.BoxGeometry(2.6, 0.05, 0.7);
  return _wingGeo;
}
let _beakGeo: THREE.ConeGeometry | null = null;
function getBeakGeo(): THREE.ConeGeometry {
  if (!_beakGeo) _beakGeo = new THREE.ConeGeometry(0.14, 0.8, 4);
  return _beakGeo;
}
let _tailGeo: THREE.BoxGeometry | null = null;
function getTailGeo(): THREE.BoxGeometry {
  if (!_tailGeo) _tailGeo = new THREE.BoxGeometry(0.9, 0.04, 0.5);
  return _tailGeo;
}

/**
 * Rakk — the cliff-racer. Soars in lazy circles high overhead, then picks a
 * moment to fold its wings and swoop a long gliding pass through the player:
 * the dive is telegraphed by the wing-tuck + the audible-silhouette change,
 * and the slow straight climb afterward is the shoot-it window. Flies in a
 * flock — only one dives at a time (the attack token keeps it readable).
 */
export class Rakk implements Targetable {
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

  private mesh: THREE.Group;
  private mat: THREE.MeshLambertMaterial;
  private wingMat: THREE.MeshLambertMaterial;
  private wingL: THREE.Mesh;
  private wingR: THREE.Mesh;
  private eyeMat: THREE.SpriteMaterial;
  private scene: THREE.Scene;
  private shadow: BlobShadow;
  private animT = Math.random() * 10;

  private state: 'orbit' | 'dive' | 'climb' = 'orbit';
  private stateTimer = RAKK_DIVE_CD_MIN + Math.random() * (RAKK_DIVE_CD_MAX - RAKK_DIVE_CD_MIN);
  private orbitPhase = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private diveTarget = new THREE.Vector3();
  private stunTimer = 0;
  private flashTimer = 0;

  /** Claw pass connected — wire env damage + shove in entities.ts. */
  onClawHit?: (rakk: Rakk) => void;
  /** Dive start — screech/silhouette cue hook. */
  onDive?: (rakk: Rakk) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + RAKK_ORBIT_ALT;
    this.vel = new THREE.Vector3();

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x0d0603 });
    this.mesh = new THREE.Group();
    const body = new THREE.Mesh(getBodyGeo(), this.mat);
    body.castShadow = true;
    this.mesh.add(body);

    // Beak + eyes — the head reads predatory at silhouette scale
    const beak = new THREE.Mesh(getBeakGeo(), this.mat);
    beak.position.set(0, -0.05, 1.6);
    beak.rotation.x = Math.PI / 2;
    this.mesh.add(beak);
    const tex = getGlowTexture();
    this.eyeMat = new THREE.SpriteMaterial({ map: tex, color: 0xffe066, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const side of [-1, 1]) {
      const eye = new THREE.Sprite(this.eyeMat);
      eye.scale.setScalar(this.radius * 0.3);
      eye.position.set(side * 0.2, 0.15, 1.1);
      this.mesh.add(eye);
    }

    // Wings — long flat planes, flap slow (soaring) or fold (dive)
    this.wingMat = new THREE.MeshLambertMaterial({ color: 0x8a4526, side: THREE.DoubleSide });
    this.wingL = new THREE.Mesh(getWingGeo(), this.wingMat);
    this.wingR = new THREE.Mesh(getWingGeo(), this.wingMat);
    this.wingL.position.set(-1.5, 0.1, -0.1);
    this.wingR.position.set(1.5, 0.1, -0.1);
    this.mesh.add(this.wingL, this.wingR);

    // Tail fan
    const tail = new THREE.Mesh(getTailGeo(), this.wingMat);
    tail.position.set(0, 0.05, -1.5);
    this.mesh.add(tail);

    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
    this.shadow = new BlobShadow(scene, this.radius * 1.6, 0.28);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }
    this.animT += dt;
    this.stateTimer -= dt;

    switch (this.state) {
      case 'orbit': {
        // Soar a wide circle around the player, altitude anchored with bob
        this.orbitPhase += dt * (RAKK_SPEED / RAKK_ORBIT_R) * this.orbitDir;
        _dir.set(
          playerPos.x + Math.cos(this.orbitPhase) * RAKK_ORBIT_R,
          terrain.getHeight(playerPos.x, playerPos.z) + RAKK_ORBIT_ALT + Math.sin(this.animT * 0.8) * 2,
          playerPos.z + Math.sin(this.orbitPhase) * RAKK_ORBIT_R,
        );
        this.steerToward(_dir, RAKK_SPEED, dt);
        // Occasionally flip orbit direction — patterns shouldn't be clockwork
        if (Math.random() < dt * 0.08) this.orbitDir *= -1;

        // Dive trigger: cooldown expired, no other rakk is diving
        if (this.stateTimer <= 0 && Rakk.attackHeldBy === null) {
          Rakk.attackHeldBy = this.id;
          this.state = 'dive';
          this.stateTimer = 1.5; // max dive duration — bail to climb if we miss
          this.diveTarget.copy(playerPos); // commit — lead is shallow so it overshoots predictably
          this.onDive?.(this);
        }
        break;
      }
      case 'dive': {
        // Wings folded, steep fast glide through the committed point —
        // moving perpendicular dodges it
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
        // Slow straight climb back to orbit altitude — THE shoot-it window
        const targetY = terrain.getHeight(this.pos.x, this.pos.z) + RAKK_ORBIT_ALT;
        this.vel.y += ((targetY - this.pos.y) * 2.5 - this.vel.y) * Math.min(1, 3 * dt);
        this.capSpeed(RAKK_SPEED * 0.6); // climbing is slow and honest
        if (this.stateTimer <= 0) {
          this.state = 'orbit';
          this.stateTimer = RAKK_DIVE_CD_MIN + Math.random() * (RAKK_DIVE_CD_MAX - RAKK_DIVE_CD_MIN);
        }
        break;
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 1.0) this.pos.y = gy + 1.0; // skims the dirt on dives but never clips

    // Facing + banking
    if (this.vel.lengthSq() > 1) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let dy = targetYaw - this.mesh.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.mesh.rotation.y += dy * Math.min(1, 4 * dt);
      this.mesh.rotation.z = -dy * 0.5; // banks into turns
      this.mesh.rotation.x = THREE.MathUtils.clamp(-this.vel.y * 0.05, -0.7, 0.5);
    }

    // Wing flap — slow soar, tucked hard in the dive, flailing climb
    const dive = this.state === 'dive';
    const flapAmp = dive ? 0.15 : this.state === 'climb' ? 0.9 : 0.35;
    const flapRate = dive ? 4 : this.state === 'climb' ? 14 : 5;
    const flap = Math.sin(this.animT * flapRate) * flapAmp;
    const fold = dive ? 0.7 : 0; // wings tuck back against the body
    this.wingL.rotation.z = -0.1 - flap - fold;
    this.wingR.rotation.z = 0.1 + flap + fold;
    this.wingL.rotation.y = fold * 0.6;
    this.wingR.rotation.y = -fold * 0.6;

    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
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
    this.vel.multiplyScalar(0.4); // bleed the dive speed
    this.vel.y = Math.abs(this.vel.y) * 0.5 + 6; // pitch up
  }

  private releaseToken(): void {
    if (Rakk.attackHeldBy === this.id) Rakk.attackHeldBy = null;
  }

  takeDamage(): boolean {
    this.health--;
    this.flashTimer = 0.15;
    this.mat.color.set(0xffffff);
    if (this.health <= 0) { this.dead = true; this.releaseToken(); return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = RAKK_STUN;
    if (this.state === 'dive') { this.releaseToken(); this.beginClimb(); } // blast breaks the dive
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force);
    this.stunTimer = RAKK_STUN;
  }

  dispose(): void {
    this.releaseToken();
    this.shadow.dispose();
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.wingMat.dispose();
    this.eyeMat.dispose();
    // geometry is shared — never dispose
  }
}
