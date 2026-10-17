import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SNAKE_RADIUS,
  EMERGE_DUR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { writeInstances, pushTrail } from './snakePose.js';
import { type SimSlither, makeSimSlither, stepSlither, applySlitherDamage, commitTarget } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';

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

  // Strike pose flags — mirrors of sim state for the renderer (coil/lunge
  // pose), not timers: the sim owns the countdowns.
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
    this.radius = uber ? SNAKE_RADIUS * 2.4 : SNAKE_RADIUS;
    this.scale = uber ? 3 : 1;
    if (uber) {this.color.set(0x8A_6A_2A);} // bronze king serpent
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    // Local authority: the same shared sim the wire replays. bindNet
    // overwrites it when a server creature owns the id instead.
    this.sim = makeSimSlither(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'snake');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;
    this.hasSlots = allocSlots('snake', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) { this.updateNet(dt, terrain); return; }
    if (this.flash > 0) {this.flash -= dt;}
    this.animT += dt;
    const s = this.sim;

    if (this.emergeT > 0) {
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
      this.pos.y = this.groundY + this.radius - this.emergeDepth * (1 - k * k);
      if (s) {s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;}
      this.writeInstances(terrain);
      return;
    }

    if (s) {
      commitTarget(s, 'local', playerPos);
      const ev = updateLocalSim(this, dt, terrain, stepSlither, playerPos);
      this.windup = s.state === 'windup' ? 1 : 0;
      this.lunge = s.state === 'lunge' ? 1 : 0;
      if (ev === 'bite') {this.onStrike?.(this);}
      if (s.dead) {this.dead = true; return;}
    }
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
    this.writeInstances(terrain);
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
    this.flash = 0.15;
    const s = this.sim;
    if (s) { if (applySlitherDamage(s, damage)) { this.dead = true; return true; } }
    else if ((this.health -= damage) <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _dir.copy(this.pos).sub(from).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force * 1.2; s.vy += _dir.y * force * 1.2; s.vz += _dir.z * force * 1.2;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      s.state = 'slither'; s.hopTimer = 0; // a hit breaks the strike
      this.windup = 0; this.lunge = 0;
      return;
    }
    this.vel.addScaledVector(_dir, force * 1.2);
    this.windup = 0; this.lunge = 0;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _dir.copy(to).sub(this.pos).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force * 1.2; s.vy += _dir.y * force * 1.2; s.vz += _dir.z * force * 1.2;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_dir, force * 1.2);
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('snake', this);
      this.hasSlots = false;
    }
  }
}
