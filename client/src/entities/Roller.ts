import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  ROLLER_RADIUS, ROLLER_HEALTH,
  ROLLER_ACCEL, ROLLER_TOPSPEED,
  EMERGE_DUR, MELEE_FAVOR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import type { SimRoller } from '../../../shared/creatureSim.js';
import { bindNetRoller, applyNetEdgeRoller, updateNetRoller, claimDamageMelee } from '../game/netMelee.js';

const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

// Faceted boulder — vertex-jittered so the silhouette is lumpy rock, not a
// beach ball. Displacement is a position-hash: shared verts displace
// identically, so no cracks open, and every roller uses the same seed so
// the swarm instances stay identical.
let _geo: THREE.BufferGeometry | null = null;
function rollerGeo(): THREE.BufferGeometry {
  if (!_geo) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const n = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719) * 43758.5453;
      const j = 0.8 + (n - Math.floor(n)) * 0.4; // 0.8..1.2 radial bulge
      v.multiplyScalar(j);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals(); // re-light after the deform — lumps get shading
    _geo = g;
  }
  return _geo;
}

let _mat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — one rigid boulder per roller. */
export function rollerParts(): SwarmPart[] {
  if (!_mat) _mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return [{ geometry: rollerGeo(), material: _mat, castShadow: true }];
}

/**
 * Roller — a big ball that just rolls toward the player. Terrain-following
 * homing boulder: steers on XZ, rides the heightmap, speeds up downhill.
 * Renders into the shared roller swarm — owns no meshes.
 */
export class Roller implements Targetable, SwarmSlotOwner {
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x6b5a44); // dusty rock
  scale = 1.6; // big debris on death

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  // Roll rotation is accumulated — instancing has no scene node to mutate
  private rollQuat = new THREE.Quaternion();
  private tint = 0.8 + Math.random() * 0.4; // per-roller rock shade variance
  private flash = 0;
  private hitCooldown = 0; // brief invuln so contact doesn't multi-tick
  private airborne = false;
  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onHit?: (roller: Roller) => void;
  onLanded?: (pos: THREE.Vector3) => void;

  /** netDriven = server-authoritative replay — same contract as Crawler. */
  netDriven = false;
  netId = 0;
  sim: SimRoller | null = null;
  netAcc = 0;
  yaw = 0; // net replay writes this; display rolls on rollQuat instead
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  bindNet(id: number, seed: number, pos: THREE.Vector3, vel: { x: number; y: number; z: number }, _state: string, uber: boolean, species = 'roller'): void {
    this.netDriven = true;
    this.netId = id;
    this.id = 0x50000000 + id;
    bindNetRoller(this, id, seed, species, pos, vel, _state, uber);
  }

  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeRoller(this, m);
  }

  private updateNet(dt: number, terrain: Terrain): void {
    updateNetRoller(this, dt, terrain);
    if (this.flash > 0) this.flash -= dt;
    // Roll rotation is client dressing — the sim carries pos/vel only.
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }
  }

  writeInstances(_terrain?: Terrain): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('roller');
    if (swarm) {
      _s.setScalar(this.radius);
      _m.compose(this.pos, this.rollQuat, _s);
      swarm.setMatrix(0, this.swarmSlot, _m);
      const fr = this.flash > 0 ? 4 : 1;
      swarm.setColor(0, this.swarmSlot, this.color.r * fr * this.tint, this.color.g * fr * this.tint, this.color.b * fr * this.tint);
    }
    getShadows()?.set(this, this.pos, this.radius * 1.05, 0.4);
  }

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "avalanche": double the boulder, triple the tank, and mass
    // enough that blasts cannot stop it — you dodge it or you die.
    this.uber = uber;
    this.health = this.maxHealth = uber ? ROLLER_HEALTH * 3 : ROLLER_HEALTH;
    this.radius = uber ? ROLLER_RADIUS * 2 : ROLLER_RADIUS;
    if (uber) this.color.set(0x4a3a52); // dark basalt — reads heavy
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('roller', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain);
      this.writeInstances(terrain);
      return;
    }
    if (this.flash > 0) this.flash -= dt;
    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    const gy = terrain.getHeight(this.pos.x, this.pos.z);

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — no rolling until surfaced
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = gy + this.radius - this.emergeDepth * (1 - k * k);
      this.vel.set(0, 0, 0);
    } else if (this.airborne) {
      this.tickAir(dt, terrain, gy);
    } else {
      this.tickGround(dt, terrain, playerPos);
    }

    // Roll rotation: axis = up × velocity, rate = speed / radius
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.1) {
      _axis.set(this.vel.z, 0, -this.vel.x).normalize();
      _dq.setFromAxisAngle(_axis, (hSpeed * dt) / this.radius);
      this.rollQuat.premultiply(_dq);
    }

    this.writeInstances();
  }

  private tickAir(dt: number, terrain: Terrain, gy: number): void {
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y - this.radius <= gy) {
      this.pos.y = gy + this.radius;
      this.airborne = false;
      this.vel.x *= 0.4; this.vel.z *= 0.4;
      this.vel.y = 0;
      this.onLanded?.(this.pos);
    }
  }

  // Surface steering: home on the player with a top-speed clamp, let
  // downhill grade feed speed, and ram only on true 3D contact — `dist`
  // is horizontal (steering); a boulder under a flying player used to
  // connect through the air.
  private tickGround(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    _dir.set(playerPos.x - this.pos.x, 0, playerPos.z - this.pos.z);
    const dist = _dir.length();
    if (dist > 0.01) {
      _dir.divideScalar(dist);
      this.vel.x += _dir.x * ROLLER_ACCEL * dt;
      this.vel.z += _dir.z * ROLLER_ACCEL * dt;
    }
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > ROLLER_TOPSPEED) {
      const s = ROLLER_TOPSPEED / hSpeed;
      this.vel.x *= s; this.vel.z *= s;
    }

    const prevY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius;
    const drop = prevY - this.pos.y;
    if (drop > 0 && hSpeed > 0.1) {
      const g = -drop / (dt || 1);
      this.vel.x += _dir.x * Math.min(g * 0.02, 4) * dt;
      this.vel.z += _dir.z * Math.min(g * 0.02, 4) * dt;
    }

    if (this.hitCooldown <= 0 && this.pos.distanceTo(playerPos) < this.radius + 1.0 * MELEE_FAVOR) {
      this.hitCooldown = 0.6;
      this.onHit?.(this);
    }
  }

  takeDamage(damage: number): boolean {
    if (this.netDriven) return claimDamageMelee(this, damage, Roller.hitClaim);
    this.health -= damage;
    this.flash = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (this.uber) return; // avalanche — unstoppable mass, that's the whole point
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 0.8); // heavy — blasts shove, not launch
    if (this.vel.y > 3) this.airborne = true;    // ...unless it's a big one
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.uber) return;
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 0.8);
    if (this.vel.y > 3) this.airborne = true;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('roller', this);
      this.hasSlots = false;
    }
  }
}
