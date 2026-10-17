import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GNAT_RADIUS,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { type SimFlyer, makeSimFlyer, stepFlyer, applyFlyerDamage, commitTarget } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';

const _scratch = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Part indices into the gnat swarm — order must match gnatParts().
const PART_BODY = 0;
const PART_WING = 1;  // two per gnat
const WINGS_PER = 2;

let _bodyGeo: THREE.IcosahedronGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    _bodyGeo = new THREE.IcosahedronGeometry(1, 0);
    _bodyGeo.scale(0.5, 0.45, 1.2); // skinny thorax+abdomen dart shape
  }
  return _bodyGeo;
}
const _wingGeo = new THREE.BoxGeometry(0.9, 0.02, 0.35);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _wingMat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function gnatParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({
    color: 0xFF_FF_FF, flatShading: true,
  });}
  if (!_wingMat) {_wingMat = new THREE.MeshLambertMaterial({
    color: 0x9A_8A_6A, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });}
  return [
    { geometry: bodyGeo(), material: _bodyMat },
    { geometry: _wingGeo, material: _wingMat, per: WINGS_PER },
  ];
}

/**
 * Gnat — boid-cloud harasser. The flock owns a shared cloud center that
 * chases the player; each gnat orbits a personal ring inside it with
 * noise jitter, and on its own cooldown darts in for a nip and zips back.
 * It never commits to a divebomb — harassment, not a bombing run.
 * Renders into the shared gnat swarm — owns no meshes.
 */
export class Gnat implements Targetable, SwarmSlotOwner {
  // Cloud ownership: each spawn call makes one cloud; members share the
  // SAME object so the swarm drifts as a unit and the nip gate spaces out
  // darts across the whole flock, not per gnat.
  cloud: { center: THREE.Vector3; nipGate: number } = {
    center: new THREE.Vector3(), nipGate: 0,
  };

  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x6A_5A_3A); // dun-brown chitin
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  readonly ichor = 0x54_C0_B0; // teal-cyan gnat juice
  scale: number;
  scoreless = true;  // fodder kills don't pump the kill counter — too trivial
  lootless = true;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  yaw = 0; // net replay writes this — drives the body part orientation
  private flash = 0;

  onNip?: (gnat: Gnat) => void;

  /** netDriven = server-authoritative replay — same contract as Rakk. */
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
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
  }

  private updateNet(dt: number, terrain: Terrain): void {
    updateNetSim(this, dt, terrain, stepFlyer);
    this.animT += dt;
    if (this.flash > 0) {this.flash -= dt;}
    if (this.vel.lengthSq() > 1) {this.yaw = Math.atan2(this.vel.x, this.vel.z);}
    this.writeInstances();
  }

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    // Uber = the cloud's queen: three times the body, actually tanky, and
    // her darts carry a real sting. She shares the cloud — the swarm orbits HER.
    this.uber = uber;
    this.radius = uber ? GNAT_RADIUS * 2.4 : GNAT_RADIUS;
    this.scale = uber ? 0.8 : 0.3;
    this.scoreless = !uber; // a queen kill counts
    if (uber) {this.color.set(0x8A_6A_1A);} // wasp queen amber
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    // Local authority: the same shared sim the wire replays — orbit anchor,
    // seeded dart cooldown, dart geometry all live there. bindNet
    // overwrites it when a server creature owns the id instead.
    this.sim = makeSimFlyer(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'gnat');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;
    this.hasSlots = allocSlots('gnat', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  /** Cloud members share one object — set by joinCloud after construction. */
  joinCloud(cloud: { center: THREE.Vector3; nipGate: number }): void { this.cloud = cloud; }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) { this.updateNet(dt, terrain); return; }
    if (this.flash > 0) {this.flash -= dt;}
    this.animT += dt;
    const s = this.sim;

    if (s) {
      commitTarget(s, 'local', playerPos);
      const ev = updateLocalSim(this, dt, terrain, stepFlyer, playerPos);
      if (ev === 'bite') {this.onNip?.(this);}
      if (s.dead) {this.dead = true; return;}
      if (this.vel.lengthSq() > 1) {
        this.yaw = Math.atan2(this.vel.x, this.vel.z);
      }
    }
    this.writeInstances();
  }

  writeInstances(): void {
    if (!this.hasSlots) {return;}
    const swarm = getSwarm('gnat');
    if (!swarm) {return;}
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(0, this.yaw, 0);
    _q.setFromEuler(_e);
    _s.setScalar(r);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    const fr = this.flash > 0 ? 4 : 1;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, this.color.r * fr, this.color.g * fr, this.color.b * fr);

    // Wings buzz at insect frequency — nearly a blur, correct for a gnat
    const buzz = Math.sin(this.animT * 55) * 0.7;
    for (let i = 0; i < WINGS_PER; i += 1) {
      const side = i === 0 ? -1 : 1;
      _e.set(0, 0, side * (0.4 + buzz));
      _q.setFromEuler(_e);
      _local.compose(_p.set(side * 0.5, 0.3, -0.1), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.5, 0.2);
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {return claimDamageMelee(this, damage, Gnat.hitClaim, opts?.serverPaid);}
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
      s.vx += _scratch.x * force * 2; s.vy += _scratch.y * force * 2; s.vz += _scratch.z * force * 2;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_scratch, force * 2);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _scratch.copy(to).sub(this.pos).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _scratch.x * force * 2; s.vy += _scratch.y * force * 2; s.vz += _scratch.z * force * 2;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_scratch, force * 2);
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('gnat', this);
      this.hasSlots = false;
    }
  }
}
