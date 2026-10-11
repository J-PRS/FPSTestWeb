import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SNAKE_RADIUS, SNAKE_HEALTH, SNAKE_SPEED,
  SNAKE_AGGRO_DIST, SNAKE_STRIKE_DIST, SNAKE_STRIKE_CD,
  SNAKE_WINDUP, SNAKE_LUNGE_SPEED, SNAKE_BITE_DIST,
  SNAKE_LEAP_GRAV, SNAKE_LEAP_OVERSHOOT,
  EMERGE_DUR, MELEE_FAVOR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { writeInstances, pushTrail } from './snakePose.js';
import { type SimSlither, makeSimSlither, stepSlither } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';

const _dir = new THREE.Vector3();

// Part indices into the snake swarm — order must match snakeParts().
const SEGS_PER = 22; // continuous tube — lobes must overlap, not bead
const EYES_PER = 2;

// One shared lobe — instanced SEGS_PER× per snake. Head mass and tail
// taper come entirely from per-instance scale in writeInstances.
let _segGeo: THREE.IcosahedronGeometry | null = null;
function segGeo(): THREE.BufferGeometry {
  if (!_segGeo) {
    _segGeo = new THREE.IcosahedronGeometry(0.6, 1);
    _segGeo.scale(0.85, 0.7, 1); // slightly flattened belly, longer than tall
  }
  return _segGeo;
}
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function snakeParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({
    color: 0xFF_FF_FF, // smooth — scales read in color bands, not facets
  });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x22_22_06, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
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
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x6D_7A_3A); // dusty olive — desert viper
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  readonly ichor = 0xD8_A0_4A; // amber — desert viper blood
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  hasSlots = false;

  animT = Math.random() * 10;
  yaw = 0; // net replay writes this — drives the segment wave orientation
  flash = 0;
  private strikeCd = 0;
  private stunTimer = 0;
  private struck = false; // the leap already spent its one pass-through bite

  // Strike state machine: 0 = cruising, >0 windup timer, lunging bool
  windup = 0;
  lunge = 0;

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onStrike?: (snake: Snake) => void;

  /** netDriven = server-authoritative replay — same contract as Crawler. */
  netDriven = false;
  netId = 0;
  sim: SimSlither | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    this.netDriven = true;
    this.netId = b.id;
    this.id = 0x50_00_00_00 + b.id;
    bindNetSim(this, makeSimSlither, b);
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
    if (m.kind === 'bite') {this.onStrike?.(this);}
  }

  private updateNet(dt: number, terrain: Terrain): void {
    const s = this.sim;
    if (!s) {return;}
    // Mirror the sim's strike states into the render-pose fields FIRST —
    // updateNetSlither's writeInstances reads them for the S-wave/coil.
    this.windup = s.state === 'windup' ? 1 : 0;
    this.lunge = s.state === 'lunge' ? 1 : 0;
    this.animT += dt; // wave phase — free-running like the sim's
    // True ground under the anchor — during a leap pos.y is airborne and
    // the pose needs real terrain to measure the clearance.
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.flash > 0) {this.flash -= dt;}
    updateNetSim(this, dt, terrain, stepSlither);
  }

  get disposed(): boolean { return this.dead; }

  constructor(_scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    this.uber = uber;
    this.maxHealth = uber ? SNAKE_HEALTH * 4 : SNAKE_HEALTH;
    this.health = this.maxHealth;
    this.radius = uber ? SNAKE_RADIUS * 2.4 : SNAKE_RADIUS;
    this.scale = uber ? 3 : 1;
    if (uber) {this.color.set(0x8A_6A_2A);} // bronze king serpent
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('snake', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) { this.updateNet(dt, terrain); return; }
    if (this.stunTimer > 0) {this.stunTimer -= dt;}
    if (this.flash > 0) {this.flash -= dt;}
    if (this.strikeCd > 0) {this.strikeCd -= dt;}
    this.animT += dt;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;
    const dy = playerPos.y - this.pos.y;
    const hitSq = distSq + dy * dy; // true 3D — a viper can't lunge UP at a flyer

    if (this.emergeT > 0) { this.tickEmerge(dt, terrain); return; }
    this.steer(dt, dx, dz, dy, distSq, hitSq);

    if (this.lunge > 0) {this.tickLeap(dt, terrain, playerPos);}
    else {
      this.pos.addScaledVector(this.vel, dt);
      this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
      this.pos.y = this.groundY + this.radius;
    }

    if (this.vel.lengthSq() > 0.1) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let dyy = want - this.yaw;
      while (dyy > Math.PI) {dyy -= Math.PI * 2;}
      while (dyy < -Math.PI) {dyy += Math.PI * 2;}
      this.yaw += dyy * Math.min(1, 6 * dt); // quick turn — it's a predator
    }

    this.writeInstances(terrain);
  }

  /** Leap leg — ballistic arc; no terrain pin until touchdown. The one
   *  pass-through bite fires mid-flight and the snake keeps going. */
  private tickLeap(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    this.vel.y += SNAKE_LEAP_GRAV * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);

    const biteD = SNAKE_BITE_DIST * MELEE_FAVOR;
    const bdx = playerPos.x - this.pos.x, bdz = playerPos.z - this.pos.z, bdy = playerPos.y - this.pos.y;
    if (!this.struck && bdx * bdx + bdz * bdz + bdy * bdy < biteD * biteD) {
      this.struck = true;
      this.onStrike?.(this);
    }

    if (this.pos.y <= this.groundY + this.radius || this.lunge <= 0) {
      this.pos.y = this.groundY + this.radius;
      this.vel.set(0, 0, 0);
      this.lunge = 0;
      this.strikeCd = SNAKE_STRIKE_CD;
    }
  }

  private tickEmerge(dt: number, terrain: Terrain): void {
    this.emergeT -= dt;
    const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
    this.pos.y = this.groundY + this.radius - this.emergeDepth * (1 - k * k);
    this.writeInstances(terrain);
  }

  // Locomotion states: coil telegraph → committed lunge → serpentine
  // approach → idle decay. The committed lunge is the whole design: once
  // it fires, dodge means MOVE, not sidestep-a-curve.
  private steer(dt: number, dx: number, dz: number, dy: number, distSq: number, hitSq: number): void {
    if (this.windup > 0) {
      // Coil: nearly stationary, rearing — the telegraph. Cancel nothing;
      // if you run INTO a coiled snake you deserve the bite.
      this.windup -= dt;
      this.vel.set(0, 0, 0);
      if (this.windup <= 0 && this.stunTimer <= 0) {
        // Leap THROUGH the target — aim point overshoots, vy solved so
        // the arc passes at the prey's own height (mirrors stepCoil).
        const d = Math.sqrt(distSq) || 0.001;
        const t = Math.max(0.2, (d + SNAKE_LEAP_OVERSHOOT) / SNAKE_LUNGE_SPEED);
        this.vel.set((dx / d) * SNAKE_LUNGE_SPEED,
          (dy + 0.5 * Math.abs(SNAKE_LEAP_GRAV) * t * t) / t,
          (dz / d) * SNAKE_LUNGE_SPEED);
        this.lunge = t + 0.4;
        this.struck = false;
      }
      return;
    }
    if (this.lunge > 0) { this.lunge -= dt; return; }
    if (this.stunTimer <= 0 && distSq < SNAKE_AGGRO_DIST * SNAKE_AGGRO_DIST) {
      // Serpentine approach — heading weaves around the target line; the
      // render lays segments along the S so the whole body side-winds.
      const wy = Math.atan2(dx, dz) + Math.sin(this.animT * 7) * 0.5;
      this.vel.set(Math.sin(wy) * SNAKE_SPEED, 0, Math.cos(wy) * SNAKE_SPEED);
      if (hitSq < SNAKE_STRIKE_DIST * SNAKE_STRIKE_DIST && this.strikeCd <= 0) {
        this.windup = SNAKE_WINDUP;
      }
      return;
    }
    this.vel.x *= Math.max(0, 1 - 4 * dt);
    this.vel.z *= Math.max(0, 1 - 4 * dt);
  }

  groundY = 0; // terrain height at center — segment heights are deltas

  // Head breadcrumbs — flat [x,z,...] newest-first. The spine is laid
  // along this path, so the body follows where the head actually went.
  trail: number[] = [];

  writeInstances(terrain: Terrain): void {
    pushTrail(this);
    writeInstances(this, terrain);
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {return claimDamageMelee(this, damage, Snake.hitClaim, opts?.serverPaid);}
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) {
      this.dead = true;
      return true;
    }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 1.2); // light body — blasts send it
    this.stunTimer = 0.8;
    this.windup = 0; this.lunge = 0; // a hit breaks the strike
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _dir.copy(to).sub(this.pos).normalize();
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
