import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GNAT_RADIUS, GNAT_HEALTH, GNAT_SPEED, GNAT_DART_SPEED,
  GNAT_ORBIT_R, GNAT_NIP_DIST, GNAT_NIP_CD, GNAT_FLOCK_CD,
  GNAT_STUN, MELEE_FAVOR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import type { SimFlyer } from '../../../shared/creatureSim.js';
import { bindNetFlyer, applyNetEdgeFlyer, updateNetFlyer, claimDamageMelee } from '../game/netMelee.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
// Shared per-cloud anchor — set by the species tick before each update so
// every gnat reads the same cloud center without a per-gnat allocation.
const _cloudCenter = new THREE.Vector3();

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
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true,
  });
  if (!_wingMat) _wingMat = new THREE.MeshLambertMaterial({
    color: 0x9a8a6a, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });
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
  color = new THREE.Color(0x6a5a3a); // dun-brown chitin
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  scale: number;
  scoreless = true;  // fodder kills don't pump the kill counter — too trivial
  lootless = true;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  yaw = 0; // net replay writes this — drives the body part orientation
  private flash = 0;
  private nipCd = Math.random() * GNAT_NIP_CD; // desync the cloud's darts
  private stunTimer = 0;

  private state: 'cloud' | 'dart' = 'cloud';
  private dartT = 0;
  private dartTarget = new THREE.Vector3();
  private orbitPhase = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private orbitR = GNAT_ORBIT_R * (0.6 + Math.random() * 0.7);
  private altOff = (Math.random() - 0.5) * 3;

  onNip?: (gnat: Gnat) => void;

  /** netDriven = server-authoritative replay — same contract as Rakk. */
  netDriven = false;
  netId = 0;
  sim: SimFlyer | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(id: number, seed: number, pos: THREE.Vector3, vel: { x: number; y: number; z: number }, _state: SimFlyer['state'], uber: boolean, species = 'gnat'): void {
    this.netDriven = true;
    this.netId = id;
    this.id = 0x50000000 + id;
    bindNetFlyer(this, id, seed, species, pos, vel, _state, uber);
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeFlyer(this, m);
    if (m.kind === 'pounce') this.state = 'dart';
  }

  private updateNet(dt: number, terrain: Terrain): void {
    updateNetFlyer(this, dt, terrain);
    this.animT += dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.vel.lengthSq() > 1) this.yaw = Math.atan2(this.vel.x, this.vel.z);
    this.writeInstances();
  }

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = the cloud's queen: three times the body, actually tanky, and
    // her darts carry a real sting. She shares the cloud — the swarm orbits HER.
    this.uber = uber;
    this.health = this.maxHealth = uber ? GNAT_HEALTH * 4 : GNAT_HEALTH;
    this.radius = uber ? GNAT_RADIUS * 2.4 : GNAT_RADIUS;
    this.scale = uber ? 0.8 : 0.3;
    this.scoreless = !uber; // a queen kill counts
    if (uber) {
      this.color.set(0x8a6a1a); // wasp queen amber
      this.orbitR *= 1.6;
      this.dartT = 0;
    }
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('gnat', this);
    if (!this.hasSlots) this.dead = true;
  }

  /** Cloud members share one object — set by joinCloud after construction. */
  joinCloud(cloud: { center: THREE.Vector3; nipGate: number }): void { this.cloud = cloud; }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.netDriven && this.sim) { this.updateNet(dt, terrain); return; }
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.nipCd > 0) this.nipCd -= dt;
    if (this.cloud.nipGate > 0) this.cloud.nipGate -= dt;
    this.animT += dt;

    if (this.state === 'dart') {
      // Committed nip — a straight dart at the locked target, hit or miss
      this.dartT -= dt;
      _dir.copy(this.dartTarget).sub(this.pos);
      const d = _dir.length() || 0.001;
      _dir.multiplyScalar(1 / d);
      this.vel.copy(_dir).multiplyScalar(GNAT_DART_SPEED);
      const nipD = (this.uber ? GNAT_NIP_DIST * 2.2 : GNAT_NIP_DIST) * MELEE_FAVOR;
      if (this.pos.distanceToSquared(playerPos) < nipD * nipD) {
        this.onNip?.(this);
        this.endDart();
      } else if (this.dartT <= 0 || d < 1.0) {
        this.endDart();
      }
    } else {
      // Cloud life: orbit a ring around the moving center + noise jitter.
      // The center itself chases the player loosely (entities moves it).
      this.orbitPhase += dt * (GNAT_SPEED / this.orbitR) * this.orbitDir;
      _cloudCenter.copy(this.cloud.center);
      _dir.set(
        _cloudCenter.x + Math.cos(this.orbitPhase) * this.orbitR,
        _cloudCenter.y + this.altOff + Math.sin(this.animT * 1.9) * 0.8,
        _cloudCenter.z + Math.sin(this.orbitPhase) * this.orbitR,
      );
      // Spring toward the orbit point + a buzz jitter — gnats never glide
      _scratch.subVectors(_dir, this.pos).multiplyScalar(6);
      _scratch.x += Math.sin(this.animT * 13.7) * 4;
      _scratch.y += Math.sin(this.animT * 17.3) * 3;
      _scratch.z += Math.cos(this.animT * 11.1) * 4;
      this.vel.lerp(_scratch, Math.min(1, dt * 4));
      // Clamp to gnat speed — the spring can spike when the center teleports
      const s = this.vel.length();
      if (s > GNAT_SPEED * 2) this.vel.multiplyScalar(GNAT_SPEED * 2 / s);

      // The nip urge — own cooldown AND a cloud-wide gate so the swarm
      // doesn't dump eight darts in the same second
      if (this.nipCd <= 0 && this.cloud.nipGate <= 0
          && this.pos.distanceToSquared(playerPos) < 30 * 30) {
        this.state = 'dart';
        this.dartT = this.uber ? 1.4 : 0.8; // queen commits longer — still capped, never a pursuit
        this.dartTarget.copy(playerPos); // locked on commit — juking works
        this.dartTarget.y += 1.2;
        this.nipCd = GNAT_NIP_CD * (0.8 + Math.random() * 0.5);
        this.cloud.nipGate = GNAT_FLOCK_CD;
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gy + 0.8) this.pos.y = gy + 0.8;

    if (this.vel.lengthSq() > 1) {
      this.yaw = Math.atan2(this.vel.x, this.vel.z);
    }
    this.writeInstances();
  }

  private endDart(): void {
    this.state = 'cloud';
    // Zip back out — a fast exit vector away from the target so the nip
    // reads hit-and-run, not hover-in-your-face
    _scratch.copy(this.pos).sub(this.dartTarget).normalize();
    this.vel.copy(_scratch).multiplyScalar(GNAT_SPEED * 1.5);
  }

  writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('gnat');
    if (!swarm) return;
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
    for (let i = 0; i < WINGS_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _e.set(0, 0, side * (0.4 + buzz));
      _q.setFromEuler(_e);
      _local.compose(_p.set(side * 0.5, 0.3, -0.1), _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_WING, slot * WINGS_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.5, 0.2);
  }

  takeDamage(damage: number): boolean {
    if (this.netDriven) return claimDamageMelee(this, damage, Gnat.hitClaim);
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force * 2.0); // flies away like a fly
    this.stunTimer = GNAT_STUN;
    if (this.state === 'dart') this.endDart();
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force * 2.0);
    this.stunTimer = GNAT_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('gnat', this);
      this.hasSlots = false;
    }
  }
}
