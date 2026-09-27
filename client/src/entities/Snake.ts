import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SNAKE_RADIUS, SNAKE_HEALTH, SNAKE_SPEED,
  SNAKE_AGGRO_DIST, SNAKE_STRIKE_DIST, SNAKE_STRIKE_CD,
  SNAKE_WINDUP, SNAKE_LUNGE_TIME, SNAKE_LUNGE_SPEED, SNAKE_BITE_DIST,
  EMERGE_DUR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _dir = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Part indices into the snake swarm — order must match snakeParts().
const PART_SEG = 0;   // SEGS_PER per snake — the body chain IS the animal
const PART_EYE = 1;   // two per snake — set wide on the big head lobe
const SEGS_PER = 8;
const EYES_PER = 2;

// One shared lobe — instanced SEGS_PER× per snake. Head mass and tail
// taper come entirely from per-instance scale in writeInstances.
let _segGeo: THREE.IcosahedronGeometry | null = null;
function segGeo(): THREE.BufferGeometry {
  if (!_segGeo) {
    _segGeo = new THREE.IcosahedronGeometry(0.6, 0);
    _segGeo.scale(0.85, 0.7, 1.0); // slightly flattened, longer than tall
  }
  return _segGeo;
}
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function snakeParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true,
  });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x222206, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: segGeo(), material: _bodyMat, castShadow: true, per: SEGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Snake — a sand viper. Weaves toward you in a real S-curve, coils back
 * for a beat, then lunges. The strike is the whole personality: you get a
 * readable wind-up and then it's on you fast — juking the lunge IS the
 * counterplay. Renders into the shared snake swarm — owns no meshes.
 */
export class Snake implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x6d7a3a); // dusty olive — desert viper
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private flash = 0;
  private strikeCd = 0;
  private stunTimer = 0;

  // Strike state machine: 0 = cruising, >0 windup timer, lunging bool
  private windup = 0;
  private lunge = 0;

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onStrike?: (snake: Snake) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? SNAKE_HEALTH * 4 : SNAKE_HEALTH;
    this.radius = uber ? SNAKE_RADIUS * 2.4 : SNAKE_RADIUS;
    this.scale = uber ? 3.0 : 0.7;
    if (uber) this.color.set(0x8a6a2a); // bronze king serpent
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('snake', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.strikeCd > 0) this.strikeCd -= dt;
    this.animT += dt;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;
    const dy = playerPos.y - this.pos.y;
    const hitSq = distSq + dy * dy; // true 3D — a viper can't lunge UP at a flyer

    if (this.emergeT > 0) {
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
      this.pos.y = this.groundY + this.radius - this.emergeDepth * (1 - k * k);
      this.writeInstances(terrain);
      return;
    }

    if (this.windup > 0) {
      // Coil: nearly stationary, rearing — the telegraph. Cancel nothing;
      // if you run INTO a coiled snake you deserve the bite.
      this.windup -= dt;
      this.vel.set(0, 0, 0);
      if (this.windup <= 0 && this.stunTimer <= 0) {
        // Lunge — straight at where you are NOW, committed. Dodge = move.
        const d = Math.sqrt(distSq) || 0.001;
        this.vel.set((dx / d) * SNAKE_LUNGE_SPEED, 0, (dz / d) * SNAKE_LUNGE_SPEED);
        this.lunge = SNAKE_LUNGE_TIME;
        this.strikeCd = SNAKE_STRIKE_CD;
      }
    } else if (this.lunge > 0) {
      this.lunge -= dt;
    } else if (this.stunTimer <= 0 && distSq < SNAKE_AGGRO_DIST * SNAKE_AGGRO_DIST) {
      // Serpentine approach — heading weaves around the target line; the
      // render lays segments along the S so the whole body side-winds.
      const wantYaw = Math.atan2(dx, dz);
      const weave = Math.sin(this.animT * 7) * 0.5; // ±~29° serpentine
      const wy = wantYaw + weave;
      this.vel.set(Math.sin(wy) * SNAKE_SPEED, 0, Math.cos(wy) * SNAKE_SPEED);
      // In strike range → coil and commit (only when facing roughly at you)
      if (hitSq < SNAKE_STRIKE_DIST * SNAKE_STRIKE_DIST && this.strikeCd <= 0) {
        this.windup = SNAKE_WINDUP;
      }
    } else {
      this.vel.x *= Math.max(0, 1 - 4 * dt);
      this.vel.z *= Math.max(0, 1 - 4 * dt);
    }

    this.pos.addScaledVector(this.vel, dt);
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
    this.pos.y = this.groundY + this.radius;

    // Bite connects only during the lunge, only on real 3D contact.
    if (this.lunge > 0 && hitSq < SNAKE_BITE_DIST * SNAKE_BITE_DIST) {
      this.lunge = 0; // one bite per lunge — it's a strike, not a grinder
      this.onStrike?.(this);
    }

    if (this.vel.lengthSq() > 0.1) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let dyy = want - this.yaw;
      while (dyy > Math.PI) dyy -= Math.PI * 2;
      while (dyy < -Math.PI) dyy += Math.PI * 2;
      this.yaw += dyy * Math.min(1, 6 * dt); // quick turn — it's a predator
    }

    this.writeInstances(terrain);
  }

  private groundY = 0; // terrain height at center — segment heights are deltas

  private writeInstances(terrain: Terrain): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('snake');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(0, this.yaw, 0);
    _q.setFromEuler(_e);
    _root.compose(this.pos, _q, _s.setScalar(r));

    const spd = Math.hypot(this.vel.x, this.vel.z);
    const crawl = Math.min(1, spd / SNAKE_SPEED);
    const fr = this.flash > 0 ? 4 : 1;
    // Windup pose: head segments lift and the body pulls into an S — read
    // instantly as "it's about to strike". Lunge straightens the wave.
    const coiling = this.windup > 0 ? 1 : 0;
    const lunging = this.lunge > 0 ? 1 : 0;
    const waveAmp = (0.34 * crawl + coiling * 0.5) * (1 - lunging * 0.7);
    const len = 3.2; // body length in radius units

    for (let i = 0; i < SEGS_PER; i++) {
      const t = i / (SEGS_PER - 1); // 0 tail → 1 head
      // Lateral S-wave travels tail→head — the signature snake read
      const lat = Math.sin(this.animT * 8 - i * 1.25) * waveAmp * (1 - t * 0.4);
      const lz = (t - 0.45) * len * (1 - coiling * 0.35); // coil shortens
      // Windup rears the head end up and back
      const rear = coiling * t * t * 1.6;
      // Terrain conform per segment — same trick as the grub
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const wx = this.pos.x + lat * cy + lz * sy;
      const wz = this.pos.z - lat * sy + lz * cy;
      const segGround = terrain.getHeight(wx, wz) - this.groundY;
      // Taper: head (t=1) is the big lobe, tail thins fast
      const taper = t < 0.3 ? 0.35 + t * 2 : 0.9 + (t - 0.9) * 1.2;
      _e.set(coiling * -0.5 * t, 0, 0); // head pitches up while coiling
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(lat, Math.max(0, segGround) + 0.15 + rear, lz - coiling * t * 0.4),
        _q,
        _s.setScalar(taper),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_SEG, slot * SEGS_PER + i, _world);
      // Banded viper pattern — alternating light/dark lobes down the spine
      const band = i % 2 === 0 ? 1.0 : 0.6;
      swarm.setColor(PART_SEG, slot * SEGS_PER + i,
        this.color.r * fr * band, this.color.g * fr * band, this.color.b * fr * band);
    }

    // Eyes set wide on the head lobe (last segment)
    const headZ = (1 - 0.45) * len * (1 - coiling * 0.35) - coiling * 0.4;
    const headRear = coiling * 1.6;
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.55, 0.5 + headRear, headZ + 0.35), _q.identity(), _s.setScalar(0.22),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 2.2, 0.35);
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) {
      this.dead = true;
      return true;
    }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 1.2); // light body — blasts send it
    this.stunTimer = 0.8;
    this.windup = 0; this.lunge = 0; // a hit breaks the strike
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 1.2);
    this.stunTimer = 0.8;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('snake', this);
      this.hasSlots = false;
    }
  }
}
