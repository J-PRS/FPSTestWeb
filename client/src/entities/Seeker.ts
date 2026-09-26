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
import { BlobShadow } from '../effects/blobShadow.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

// Shared geometries — skull is an elongated icosahedron, wings are thin
// membrane planes, stinger a small rear cone. All shared across seekers.
let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function getBodyGeo(): THREE.IcosahedronGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 1);
    _bodyGeo.scale(0.62, 0.55, 1.0); // narrow skull, long snout
  }
  return _bodyGeo;
}
let _wingGeo: THREE.BoxGeometry | null = null;
function getWingGeo(): THREE.BoxGeometry {
  if (!_wingGeo) _wingGeo = new THREE.BoxGeometry(1.5, 0.04, 0.55);
  return _wingGeo;
}
let _stingerGeo: THREE.ConeGeometry | null = null;
function getStingerGeo(): THREE.ConeGeometry {
  if (!_stingerGeo) _stingerGeo = new THREE.ConeGeometry(0.12, 0.7, 5); // points +y; pitch back
  return _stingerGeo;
}
let _jawGeo: THREE.ConeGeometry | null = null;
function getJawGeo(): THREE.ConeGeometry {
  if (!_jawGeo) _jawGeo = new THREE.ConeGeometry(0.1, 0.5, 4);
  return _jawGeo;
}

/**
 * Airborne sting enemy — the anti-"fly in a straight line" teacher. Ignores
 * terrain while cruising ~SEEKER_HOVER meters up, drifts toward the player,
 * then commits to a straight-line dart (telegraphed by a rear-back pause +
 * eye flare) that's very dodgeable sideways. Stings on contact, then drifts
 * off to recover before the next pass.
 */
export class Seeker implements Targetable {
  readonly id: number;
  readonly variant = 0; // Targetable surface — demo treats it like a small ball

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = SEEKER_HEALTH;
  maxHealth = SEEKER_HEALTH;
  radius = SEEKER_RADIUS;
  color = new THREE.Color(0xcfc39a); // bone-pale chitin
  scale = 0.3; // nugget count + debris size on death

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private wingMatL: THREE.MeshLambertMaterial;
  private wingMatR: THREE.MeshLambertMaterial;
  private wingL: THREE.Mesh;
  private wingR: THREE.Mesh;
  private eye: THREE.Sprite;
  private eyeMat: THREE.SpriteMaterial;
  private scene: THREE.Scene;
  private shadow: BlobShadow;
  private animT = Math.random() * 10; // desync wing flap between seekers

  private state: 'patrol' | 'chase' | 'telegraph' | 'dart' | 'recover' = 'patrol';
  private telegraphTimer = 0;
  private dartTimer = 0;
  private recoverTimer = 0;
  private stunTimer = 0;
  private flashTimer = 0;
  private dartDir = new THREE.Vector3();
  private bobPhase = Math.random() * Math.PI * 2;

  /** Sting connected — wire the damage/shove in entities.ts. */
  onSting?: (seeker: Seeker) => void;

  get disposed(): boolean { return this.dead; } // gone instantly — pop handled by combat debris

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + SEEKER_HOVER;
    this.vel = new THREE.Vector3();

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x0a0803 });
    this.mesh = new THREE.Mesh(getBodyGeo(), this.mat);
    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Cyclops eye — single big glow sprite in the face, the "it sees you" cue
    this.eyeMat = new THREE.SpriteMaterial({ map: getEyeTex(), color: 0xffcc44, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.eye = new THREE.Sprite(this.eyeMat);
    this.eye.scale.setScalar(this.radius * 0.9);
    this.eye.position.set(0, 0.15, 0.75);
    this.mesh.add(this.eye);

    // Membrane wings — thin translucent planes, flap fast
    this.wingMatL = new THREE.MeshLambertMaterial({ color: 0x776655, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    this.wingMatR = this.wingMatL.clone();
    this.wingL = new THREE.Mesh(getWingGeo(), this.wingMatL);
    this.wingR = new THREE.Mesh(getWingGeo(), this.wingMatR);
    this.wingL.position.set(-0.85, 0.35, -0.1);
    this.wingR.position.set(0.85, 0.35, -0.1);
    this.mesh.add(this.wingL, this.wingR);

    // Stinger + jaw fangs — profile reads "wasp skull"
    const stinger = new THREE.Mesh(getStingerGeo(), this.mat);
    stinger.position.set(0, -0.15, -1.05);
    stinger.rotation.x = -1.9; // trails back-down
    this.mesh.add(stinger);
    for (const side of [-1, 1]) {
      const jaw = new THREE.Mesh(getJawGeo(), this.mat);
      jaw.position.set(side * 0.22, -0.35, 0.55);
      jaw.rotation.x = Math.PI; // points down
      this.mesh.add(jaw);
    }

    this.shadow = new BlobShadow(scene, this.radius * 1.2, 0.3);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }

    this.animT += dt;
    const distSq = this.pos.distanceToSquared(playerPos);

    switch (this.state) {
      case 'patrol': {
        // Lazy drift toward a hover point offset from the player — keeps them
        // orbiting in play range without committing to an attack
        _dir.subVectors(playerPos, this.pos);
        const d = _dir.length() || 0.001;
        _dir.multiplyScalar(1 / d);
        const hold = SEEKER_AGGRO_DIST * 0.8;
        const pull = Math.max(-1, Math.min(1, (d - hold) / hold)); // ring-hold: orbit at ~0.8×aggro
        this.vel.addScaledVector(_dir, pull * SEEKER_ACCEL * 0.4 * dt);
        this.capSpeed(SEEKER_SPEED * 0.4);
        if (distSq < SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST) this.state = 'chase';
        break;
      }
      case 'chase': {
        if (distSq > SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST * 1.4) { this.state = 'patrol'; break; }
        _dir.subVectors(playerPos, this.pos);
        const d = _dir.length() || 0.001;
        _dir.multiplyScalar(1 / d);
        this.vel.addScaledVector(_dir, SEEKER_ACCEL * dt);
        this.capSpeed(SEEKER_SPEED);
        if (d < SEEKER_DART_RANGE && this.stunTimer <= 0) {
          this.state = 'telegraph';
          this.telegraphTimer = SEEKER_DART_TELEGRAPH;
          this.dartDir.copy(_dir);
        }
        break;
      }
      case 'telegraph': {
        // Rear back and flare the eye — committed dart incoming. The pause
        // IS the dodge window: sidestep/jet and it whiffs past.
        this.telegraphTimer -= dt;
        this.vel.multiplyScalar(1 - 4 * dt); // hard brake
        _dir.subVectors(playerPos, this.pos).normalize();
        this.dartDir.lerp(_dir, 6 * dt).normalize(); // track until launch
        const t = 1 - this.telegraphTimer / SEEKER_DART_TELEGRAPH;
        this.mat.emissive.setRGB(0.7 * t, 0.35 * t, 0);
        this.eye.scale.setScalar(this.radius * (0.9 + t * 0.8));
        this.vel.addScaledVector(this.dartDir, -6 * dt); // visible rear-back
        if (this.telegraphTimer <= 0) {
          this.state = 'dart';
          this.dartTimer = SEEKER_DART_MAX;
          this.vel.copy(this.dartDir).multiplyScalar(SEEKER_DART_SPEED);
          this.mat.emissive.setRGB(0.8, 0.4, 0);
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
        // Drift away+up — disengaged and vulnerable for a beat
        _dir.subVectors(this.pos, playerPos);
        _dir.y = 0.8;
        this.vel.addScaledVector(_dir.normalize(), SEEKER_ACCEL * 0.5 * dt);
        this.capSpeed(SEEKER_SPEED * 0.6);
        if (this.recoverTimer <= 0) this.state = 'chase';
        break;
      }
    }

    // Sting check — darting or close contact while aggressive
    if ((this.state === 'dart' || this.state === 'chase') && distSq < SEEKER_STING_DIST * SEEKER_STING_DIST) {
      this.onSting?.(this);
      this.beginRecover();
    }

    this.pos.addScaledVector(this.vel, dt);

    // Terrain floor — swoop low but never clip through the dune surface.
    // Hover cruise adds the signature bob.
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
      this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
      this.mesh.rotation.x = THREE.MathUtils.clamp(-this.vel.y * 0.04, -0.6, 0.6);
      this.mesh.rotation.z = THREE.MathUtils.clamp(-(this.vel.x * Math.cos(this.mesh.rotation.y) - this.vel.z * Math.sin(this.mesh.rotation.y)) * 0.03, -0.5, 0.5);
    }

    // Wing flap — fast buzz, tuck during telegraph rear-back
    const flap = this.state === 'telegraph' ? 4 : 22;
    const wingA = Math.sin(this.animT * flap) * (this.state === 'dart' ? 0.9 : 0.6);
    this.wingL.rotation.z = -0.15 - wingA;
    this.wingR.rotation.z = 0.15 + wingA;

    if (this.state !== 'telegraph' && this.state !== 'dart') {
      this.eye.scale.setScalar(this.radius * (this.state === 'chase' ? 0.75 : 0.55) + 0.15 * Math.sin(this.animT * 5));
      if (this.flashTimer <= 0) this.mat.emissive.setRGB(this.state === 'chase' ? 0.2 : 0, 0.05, 0);
    }

    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
  }

  private beginRecover(): void {
    this.state = 'recover';
    this.recoverTimer = SEEKER_RECOVER;
    this.mat.emissive.setHex(0x0a0803);
    // Deflect upward-off — sting momentum carries through, not a dead stop
    this.vel.y += 6;
  }

  private capSpeed(max: number): void {
    const s = this.vel.length();
    if (s > max) this.vel.multiplyScalar(max / s);
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
    this.shadow.dispose();
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.wingMatL.dispose();
    this.wingMatR.dispose();
    this.eyeMat.dispose();
    // geometry is shared — never dispose
  }
}

// Shared eye glow texture
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
