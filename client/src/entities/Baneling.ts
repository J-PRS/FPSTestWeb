import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  BANELING_RADIUS, BANELING_HEALTH,
  BANELING_ACCEL, BANELING_TOPSPEED,
  BANELING_FUSE_DIST, BANELING_LIFE, BANELING_BLAST_RADIUS,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import type { SimBaneling } from '../../../shared/creatureSim.js';
import { bindNetBaneling, applyNetEdgeBaneling, updateNetBaneling, claimDamageMelee } from '../game/netMelee.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

const PART_BODY = 0;
const PART_GLOW = 1; // sac glow — the whole threat read

const _geo = new THREE.IcosahedronGeometry(1, 1); // lumpier facets than the boulder
const _glowGeo = new THREE.PlaneGeometry(1, 1);

let _mat: THREE.MeshLambertMaterial | null = null;
let _glowMat: THREE.MeshBasicMaterial | null = null;

export function banelingParts(): SwarmPart[] {
  if (!_mat) _mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_glowMat) _glowMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x66ff44, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: _geo, material: _mat, castShadow: true },
    { geometry: _glowGeo, material: _glowMat },
  ];
}

/**
 * Baneling — Zerg-style rolling bomb birthed by the Overlord. Homes in,
 * glows harder as it closes, and detonates on proximity or when shot.
 * Shares the Roller's roll/chase chassis minus its contact-hit: the pop
 * IS the attack.
 */
export class Baneling implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;
  /** Blast envelope — entities reads this so a goliath pops bigger. */
  readonly blastRadius: number;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw = 0; // heading — visual facing, sim-driven when netDriven
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x4a8a2a); // swollen green sac
  readonly debrisKind = 'goo' as const; // pops into splat blobs, not shards
  scale = 0.9; // small gibs — it's a sac of goo, not a body

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  /** netDriven = server-authoritative replay — same contract as Roller. */
  netDriven = false;
  netAcc = 0;
  netId = 0;
  sim: SimBaneling | null = null;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(id: number, seed: number, pos: THREE.Vector3, vel: { x: number; y: number; z: number }, _state: string, uber: boolean, species = 'baneling'): void {
    this.netDriven = true;
    this.netId = id;
    bindNetBaneling(this, id, seed, species, pos, vel, _state, uber);
    (this as { blastRadius: number }).blastRadius = this.sim!.blastRadius;
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeBaneling(this, m);
  }

  private updateNet(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    updateNetBaneling(this, dt, terrain);
    const s = this.sim!;
    // Dressing mirrors the local path: roll spin from velocity, glow from
    // urgency — measured to the committed snapshot, not the live player,
    // so the tell matches what the authority is fusing on.
    const hSpeed = Math.hypot(s.vx, s.vz);
    if (hSpeed > 0.1) {
      _axis.set(s.vz, 0, -s.vx).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }
    const dist = s.tgtValid
      ? Math.hypot(s.tx - s.x, s.ty - s.y, s.tz - s.z)
      : this.pos.distanceTo(playerPos);
    const urgency = 1 - Math.min(1, dist / (BANELING_FUSE_DIST * 6));
    const p = (Math.sin(s.age * 10) + 1) / 2;
    this.glowPulse = 0.4 + p * (0.3 + urgency * 0.5) + urgency * 0.3;
  }

  private rollQuat = new THREE.Quaternion();
  private flash = 0;
  private age = 0;
  private airborne = false;
  private glowPulse = 0;

  onDetonate?: (baneling: Baneling) => void;
  onLanded?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "goliath": a wobbling bomb-sack — bigger pop, harder to pop.
    this.uber = uber;
    this.health = this.maxHealth = uber ? BANELING_HEALTH * 4 : BANELING_HEALTH;
    this.radius = uber ? BANELING_RADIUS * 1.7 : BANELING_RADIUS;
    this.blastRadius = uber ? BANELING_BLAST_RADIUS * 1.7 : BANELING_BLAST_RADIUS;
    if (uber) this.color.set(0x8a6a1a); // overripe amber — visibly worse
    this.pos = pos.clone();
    const gy = terrain.getHeight(pos.x, pos.z);
    if (this.pos.y < gy + this.radius) this.pos.y = gy + this.radius;
    this.airborne = this.pos.y > gy + this.radius + 0.5; // dropped from the overlord's belly
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('baneling', this);
    if (!this.hasSlots) this.dead = true;
  }

  private detonate(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDetonate?.(this);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain, playerPos);
      return;
    }
    if (this.flash > 0) this.flash -= dt;
    this.age += dt;

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    let dist = Infinity;

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
      dist = _dir.length();
      if (dist > 0.01) {
        _dir.divideScalar(dist);
        this.vel.x += _dir.x * BANELING_ACCEL * dt;
        this.vel.z += _dir.z * BANELING_ACCEL * dt;
      }
      const hSpeed = Math.hypot(this.vel.x, this.vel.z);
      if (hSpeed > BANELING_TOPSPEED) {
        const s = BANELING_TOPSPEED / hSpeed;
        this.vel.x *= s; this.vel.z *= s;
      }
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius;

      // Fuse is 3D — `dist` is horizontal (steering); hovering overhead
      // shouldn't pop the sac, you have to actually be in the blast.
      if (this.pos.distanceTo(playerPos) < BANELING_FUSE_DIST) { this.detonate(); return; }
    }

    if (this.age > BANELING_LIFE) { this.detonate(); return; }

    // Sac swells and glows harder the closer it gets — the tell you shoot
    const urgency = 1 - Math.min(1, dist / (BANELING_FUSE_DIST * 6));
    const p = (Math.sin(this.age * 10) + 1) / 2;
    this.glowPulse = 0.4 + p * (0.3 + urgency * 0.5) + urgency * 0.3;

    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }

    if (!this.hasSlots) return;
    this.writeInstances(terrain);
  }

  /** Instance + shadow writes — extracted so the netDriven replay path
   *  (which drives pos/vel from the shared sim) shares one render path. */
  writeInstances(_terrain: Terrain): void {
    const swarm = getSwarm('baneling');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;
    const swell = Math.max(0, this.glowPulse - 0.4) * 0.15; // urgency folded into the pulse

    _s.setScalar(r * (1 + swell)); // subtle swell on approach
    _m.compose(this.pos, this.rollQuat, _s);
    swarm.setMatrix(PART_BODY, slot, _m);
    const fr = this.flash > 0 ? 4 : 1;
    swarm.setColor(PART_BODY, slot,
      this.color.r * fr + this.glowPulse * 0.3,
      this.color.g * fr + this.glowPulse,
      this.color.b * fr + this.glowPulse * 0.2);

    // Glow quad riding the sac top
    const gs = 0.9 + this.glowPulse * 0.5;
    _local.compose(_p.set(0, 0.6, 0), _q.identity(), _s.setScalar(gs));
    _world.multiplyMatrices(_m, _local);
    swarm.setMatrix(PART_GLOW, slot, _world);
    swarm.setColor(PART_GLOW, slot, this.glowPulse, this.glowPulse, this.glowPulse);

    getShadows()?.set(this, this.pos, r * 1.05, 0.4);
  }

  takeDamage(damage = 1): boolean {
    // netDriven is a claim, never a pop — the authority's detonate edge
    // + crawlDie decide, so a client can't fake-explode a sac.
    if (this.netDriven) return claimDamageMelee(this, damage, Baneling.hitClaim);
    // Shooting it pops it — that IS the counterplay
    this.detonate();
    return true;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 1.2); // light sac — blasts punt it
    if (this.vel.y > 2) this.airborne = true;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 1.2);
    if (this.vel.y > 2) this.airborne = true;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('baneling', this);
      this.hasSlots = false;
    }
  }
}
