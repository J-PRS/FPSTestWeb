import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SCARAB_RADIUS, SCARAB_BITE_CD,
  EMERGE_DUR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { writeInstances } from './scarabPose.js';
import { type SimCrawler, makeSimCrawler, stepCrawler, applyCrawlerDamage, commitTarget } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';

const _dir = new THREE.Vector3();

// Part indices into the scarab swarm — order must match scarabParts().
const LEGS_PER = 6;   // beetle, not spider — six legs
const EYES_PER = 2;

// Dome carapace + small head lobe merged into one instanced draw.
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    const shell = new THREE.IcosahedronGeometry(1, 0);
    shell.scale(0.8, 0.55, 1); // hard dome — the beetle silhouette
    shell.translate(0, 0.25, -0.1);
    const head = new THREE.IcosahedronGeometry(0.35, 0);
    head.scale(1, 0.6, 0.8);
    head.translate(0, 0.12, 0.85);
    _bodyGeo = mergeGeometries([shell, head])!;
  }
  return _bodyGeo;
}
// Stubby scythe leg — a single angled cone, cheap per instance
let _legGeo: THREE.BufferGeometry | null = null;
function legGeo(): THREE.BufferGeometry {
  if (!_legGeo) {
    _legGeo = new THREE.ConeGeometry(0.05, 0.7, 4);
    // Short scuttle stubs again — but REACHING now: the root seats 0.55r
    // low so ground is only −0.45 local; tip lands right on it.
    _legGeo.rotateZ(Math.atan2(-0.35, -0.55)); // tip down-out
    _legGeo.translate(0.2, -0.28, 0);
  }
  return _legGeo;
}

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;
let _eyeGeo: THREE.PlaneGeometry | undefined = undefined;

/** Swarm part table — registered once in swarms.initSwarms. */
export function scarabParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({
    color: 0xFF_FF_FF, flatShading: true,
  });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xFF_CC_44, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  _eyeGeo ??= new THREE.PlaneGeometry(1, 1);
  return [
    { geometry: bodyGeo(), material: _bodyMat, castShadow: true },
    { geometry: legGeo(), material: _bodyMat, per: LEGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Scarab — cannon fodder. Spawns in packs, skitters at you fast with a
 * lateral zigzag, and nibbles on contact. Dies to anything; dangerous
 * only as a crowd. Renders into the shared scarab swarm — owns no meshes.
 */
export class Scarab implements Targetable, SwarmSlotOwner {
  readonly species: string = 'scarab';
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x4A_35_24); // dark chitin
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  readonly ichor = 0x3F_C9_B0; // teal hemolymph under the dark shell
  scale: number;
  // Uber = "dreadbeetle": bigger, harder to pop — the shared sim carries
  // its motion; entities reads these for the hit funnel.
  biteDamage: number;
  biteForce: number;

  swarmSlot = -1;
  shadowSlot = -1;
  hasSlots = false;

  animT = Math.random() * 10;
  yaw = 0; // net replay writes this from the sim
  flash = 0;
  private biteCd = 0; // contact-hit throttle — the server gates its own funnel the same way

  /** netDriven = server-authoritative replay (shared hop sim) — see
   *  Crawler.bindNet; offline instances leave it false. */
  netDriven = false;
  netId = 0;
  sim: SimCrawler | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(b: NetBindArgs): void {
    this.netDriven = true;
    this.netId = b.id;
    this.id = 0x50_00_00_00 + b.id;
    bindNetSim(this, makeSimCrawler, b);
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
  }

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onBite?: (scarab: Scarab) => void;
  onLanded?: (pos: THREE.Vector3) => void;
  airborne = false; // net replay writes this from the sim

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    this.uber = uber;
    this.radius = uber ? SCARAB_RADIUS * 1.7 : SCARAB_RADIUS;
    this.scale = uber ? 1.1 : 0.45;
    this.biteDamage = uber ? 12 : 0; // entities reads these — normal uses the shared consts
    this.biteForce = uber ? 14 : 0;
    if (uber) {this.color.set(0x6A_4A_20);} // bronze shell — reads "the big one"
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    // Local authority: the same shared sim the wire replays. bindNet
    // overwrites it when a server creature owns the id instead.
    this.sim = makeSimCrawler(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'scarab');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;
    this.hasSlots = allocSlots('scarab', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) {
      updateNetSim(this, dt, terrain, stepCrawler, { grounded: true });
      if (this.flash > 0) {this.flash -= dt;}
      this.animT += dt;
      return;
    }
    this.flash = Math.max(0, this.flash - dt);
    this.biteCd = Math.max(0, this.biteCd - dt);
    this.animT += dt;
    const s = this.sim;

    if (this.tickEmerge(dt, terrain)) {return;}
    if (this.tickLocal(dt, terrain, playerPos, s)) {return;}
    this.writeInstances(terrain);
  }

  // Local-sim leg: events map to callbacks, death skips the instance
  // write. True when the sim reported dead.
  private tickLocal(dt: number, terrain: Terrain, playerPos: THREE.Vector3, s: SimCrawler | null): boolean {
    if (s) {
      commitTarget(s, 'local', playerPos);
      const wasAir = this.airborne;
      const ev = updateLocalSim(this, dt, terrain, stepCrawler, playerPos, { grounded: true });
      if (wasAir && !this.airborne) {this.onLanded?.(this.pos);}
      if (ev === 'bite' && this.biteCd <= 0) {
        this.biteCd = SCARAB_BITE_CD;
        this.onBite?.(this);
      }
      if (s.dead) {this.dead = true; return true;}
    }
    if (this.vel.lengthSq() > 1) {this.yaw = Math.atan2(this.vel.x, this.vel.z);}
    return false;
  }

  writeInstances(terrain: Terrain): void { writeInstances(this, terrain); }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {
      this.flash = 0.15;
      return claimDamageMelee(this, damage, Scarab.hitClaim, opts?.serverPaid);
    }
    this.flash = 0.15;
    const s = this.sim;
    if (s) { if (applyCrawlerDamage(s, damage)) { this.dead = true; return true; } }
    else if ((this.health -= damage) <= 0) { this.dead = true; return true; }
    return false;
  }

  // Burrow emerge: rises out of the ground on an ease-out curve, keeping
  // the replica sim's xyz in step. True while emerging.
  private tickEmerge(dt: number, terrain: Terrain): boolean {
    if (this.emergeT <= 0) {return false;}
    this.emergeT -= dt;
    const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
    this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius - this.emergeDepth * (1 - k * k);
    const s = this.sim;
    if (s) {s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;}
    this.writeInstances(terrain);
    return true;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _dir.copy(this.pos).sub(from).normalize();
    // Featherweight — blasts LAUNCH fodder, that's the fun
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force * 1.8; s.vy += _dir.y * force * 1.8 + force * 0.6; s.vz += _dir.z * force * 1.8;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_dir, force * 1.8);
    this.vel.y += force * 0.6;
    this.airborne = true;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _dir.copy(to).sub(this.pos).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force * 1.8; s.vy += _dir.y * force * 1.8; s.vz += _dir.z * force * 1.8;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_dir, force * 1.8);
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('scarab', this);
      this.hasSlots = false;
    }
  }
}
