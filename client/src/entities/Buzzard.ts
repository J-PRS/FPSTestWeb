import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  BUZZARD_RADIUS, BUZZARD_ORBIT_ALT,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { writeBuzzardInstances } from './buzzardVisual.js';
import { type SimFlyer, makeSimFlyer, stepFlyer, applyFlyerDamage, commitTarget } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
export { buzzardParts } from './buzzardVisual.js';

const _scratch = new THREE.Vector3();

/**
 * Buzzard - the ambient kettle made a real creature. Server-owned only:
 * map `creatures` pops mint it, the wire carries species 'buzzard' down
 * the shared fly-family edge stream, and takeDamage sends a hit claim
 * instead of trusting local health. No local spawn path - the ambient
 * AmbientBirds flock stays pure decoration.
 */
export class Buzzard implements Targetable, SwarmSlotOwner {
  readonly species: string = 'buzzard';
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x24_1C_14); // sooty black-brown plumage
  readonly debrisKind = 'brush' as const; // feathers, not rock
  readonly ichor = 0x3A_2E_1E;
  scale = 1;
  scoreless = true;  // wildlife fodder - kills don't pump the counter
  lootless = true;

  swarmSlot = -1;
  shadowSlot = -1;
  hasSlots = false;

  animT = Math.random() * 10;
  yaw = 0;
  pitch = 0;
  roll = 0;
  flash = 0;

  state: 'orbit' | 'dive' | 'climb' = 'orbit';

  onPeckHit?: (b: Buzzard) => void;
  onDive?: (b: Buzzard) => void;

  netDriven = false;
  netId = 0;
  sim: SimFlyer | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    this.netDriven = true;
    this.netId = b.id;
    this.id = 0x50_00_00_00 + b.id;
    bindNetSim(this, makeSimFlyer, b);
    this.state = 'climb';
    if (b.state === 'windup') {this.state = 'dive';}
    else if (b.state === 'orbit') {this.state = 'orbit';}
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
    if (!this.sim) {return;}
    const s = this.sim.state;
    this.state = s === 'windup' ? 'dive' : s;
    if (m.kind === 'pounce') {this.onDive?.(this);}
  }

  private updateNet(dt: number, terrain: Terrain): void {
    updateNetSim(this, dt, terrain, stepFlyer);
    if (this.flash > 0) {this.flash -= dt;}
    this.animT += dt;
    this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.05, -0.7, 0.5);
    this.roll = 0;
  }

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    this.uber = uber;
    this.radius = uber ? BUZZARD_RADIUS * 1.6 : BUZZARD_RADIUS;
    if (uber) {this.color.set(0x10_0C_08);} // elder - near-black silhouette
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + BUZZARD_ORBIT_ALT;
    this.vel = new THREE.Vector3();
    this.sim = makeSimFlyer(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'buzzard');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;
    this.hasSlots = allocSlots('buzzard', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain);
      return;
    }
    if (this.flash > 0) {this.flash -= dt;}
    this.animT += dt;
    const s = this.sim;

    if (s) {
      commitTarget(s, 'local', playerPos);
      const ev = updateLocalSim(this, dt, terrain, stepFlyer, playerPos);
      this.state = s.state === 'windup' ? 'dive' : s.state;
      if (ev === 'pounce') {this.onDive?.(this);}
      if (ev === 'bite') {this.onPeckHit?.(this);}
      if (s.dead) {this.dead = true; return;}
      this.faceVelocity(dt);
    }

    this.writeInstances();
  }

  private faceVelocity(dt: number): void {
    if (this.vel.lengthSq() <= 1) {return;}
    const targetYaw = Math.atan2(this.vel.x, this.vel.z);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) {dy -= Math.PI * 2;}
    while (dy < -Math.PI) {dy += Math.PI * 2;}
    this.yaw += dy * Math.min(1, 4 * dt);
    this.roll = -dy * 0.5;
    this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.05, -0.7, 0.5);
  }

  writeInstances(_terrain?: Terrain): void {
    writeBuzzardInstances(this);
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {return claimDamageMelee(this, damage, Buzzard.hitClaim, opts?.serverPaid);}
    this.flash = 0.15;
    const s = this.sim;
    if (s) { if (applyFlyerDamage(s, damage)) { this.dead = true; return true; } }
    else if ((this.health -= damage) <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _scratch.copy(this.pos).sub(from).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _scratch.x * force; s.vy += _scratch.y * force; s.vz += _scratch.z * force;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      if (s.state === 'dive' || s.state === 'windup') {s.state = 'climb'; this.state = 'climb';}
      return;
    }
    this.vel.addScaledVector(_scratch, force);
    this.state = 'climb';
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _scratch.copy(to).sub(this.pos).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _scratch.x * force; s.vy += _scratch.y * force; s.vz += _scratch.z * force;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_scratch, force);
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('buzzard', this);
      this.hasSlots = false;
    }
  }
}
