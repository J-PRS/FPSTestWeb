import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  SCARAB_RADIUS, SCARAB_HEALTH, SCARAB_SPEED, SCARAB_ZIGZAG,
  SCARAB_AGGRO_DIST, SCARAB_BITE_DIST, SCARAB_BITE_CD, SCARAB_STUN,
  EMERGE_DUR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _dir = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _tiltQ = new THREE.Quaternion(); // ground-normal alignment while grounded
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Part indices into the scarab swarm — order must match scarabParts().
const PART_BODY = 0;
const PART_LEG = 1;   // six instances per scarab: slot*6+i
const PART_EYE = 2;   // two per scarab — additive glow quads
const LEGS_PER = 6;   // beetle, not spider — six legs
const EYES_PER = 2;

// Dome carapace + small head lobe merged into one instanced draw.
let _bodyGeo: THREE.BufferGeometry | null = null;
function bodyGeo(): THREE.BufferGeometry {
  if (!_bodyGeo) {
    const shell = new THREE.IcosahedronGeometry(1, 0);
    shell.scale(0.8, 0.55, 1.0); // hard dome — the beetle silhouette
    shell.translate(0, 0.25, -0.1);
    const head = new THREE.IcosahedronGeometry(0.35, 0);
    head.scale(1.0, 0.6, 0.8);
    head.translate(0, 0.12, 0.85);
    _bodyGeo = mergeGeometries([shell, head])!;
  }
  return _bodyGeo;
}
// Stubby scythe leg — a single angled cone, cheap per instance
let _legGeo: THREE.BufferGeometry | null = null;
function legGeo(): THREE.BufferGeometry {
  if (!_legGeo) {
    _legGeo = new THREE.ConeGeometry(0.05, 0.55, 4);
    _legGeo.rotateZ(Math.atan2(-0.55, -0.35)); // tip down-out
    _legGeo.translate(0.27, -0.05, 0);
  }
  return _legGeo;
}
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function scarabParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true,
  });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xffcc44, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
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
  readonly id: number;
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x4a3524); // dark chitin
  readonly debrisKind = 'goo' as const;
  readonly dieCue = 'splat' as const;
  scale: number;
  // Uber = "dreadbeetle": telegraphed charge dash — a straight-line ram
  // that reads as a bull rush, not the zigzag skitter.
  biteDamage: number;
  biteForce: number;
  private dashCd = 3 + Math.random() * 2;
  private dashT = 0;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private flash = 0;
  private biteCd = 0;
  private stunTimer = 0;
  private zigPhase = Math.random() * Math.PI * 2;

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onBite?: (scarab: Scarab) => void;
  onLanded?: (pos: THREE.Vector3) => void;
  private airborne = false;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? SCARAB_HEALTH * 3 : SCARAB_HEALTH;
    this.radius = uber ? SCARAB_RADIUS * 1.7 : SCARAB_RADIUS;
    this.scale = uber ? 1.1 : 0.45;
    this.biteDamage = uber ? 12 : 0; // entities reads these — normal uses the shared consts
    this.biteForce = uber ? 14 : 0;
    if (uber) this.color.set(0x6a4a20); // bronze shell — reads "the big one"
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('scarab', this);
    if (!this.hasSlots) this.dead = true;
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.biteCd > 0) this.biteCd -= dt;
    this.animT += dt;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;
    // Bite must be REAL contact — horizontal distSq is for steering; a
    // jetpacking player 30m overhead isn't "close" no matter the xz.
    const dy = playerPos.y - this.pos.y;
    const biteSq = distSq + dy * dy;

    if (this.emergeT > 0) {
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius - this.emergeDepth * (1 - k * k);
      this.writeInstances(terrain);
      return;
    }

    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    const onGround = this.pos.y - this.radius <= gy;
    if (onGround) {
      this.pos.y = gy + this.radius;
      if (this.airborne) this.onLanded?.(this.pos);
      this.airborne = false;
      this.vel.y = 0;

      if (this.stunTimer <= 0) {
        // Dreadbeetle dash: every few seconds it locks a straight line and
        // RAMS — no weave, just speed. The un-zigzagged charge IS the tell.
        if (this.uber) {
          this.dashCd -= dt;
          if (this.dashT > 0) this.dashT -= dt;
          else if (this.dashCd <= 0 && distSq < 45 * 45) {
            this.dashT = 0.45;
            this.dashCd = 3.5 + Math.random() * 1.5;
          }
        }
        if (this.dashT > 0) {
          const d = Math.sqrt(distSq) || 0.001;
          this.vel.x = (dx / d) * SCARAB_SPEED * 2.6;
          this.vel.z = (dz / d) * SCARAB_SPEED * 2.6;
        } else if (distSq < SCARAB_AGGRO_DIST * SCARAB_AGGRO_DIST) {
          // Beeline + zigzag — fast and erratic, the fodder dance
          this.zigPhase += dt * 7;
          const d = Math.sqrt(distSq) || 0.001;
          const nx = dx / d, nz = dz / d;
          const zig = Math.sin(this.zigPhase) * SCARAB_ZIGZAG;
          this.vel.x = nx * SCARAB_SPEED - nz * zig;
          this.vel.z = nz * SCARAB_SPEED + nx * zig;
        } else {
          // Idle scuttle — mill around slowly
          this.vel.x *= Math.max(0, 1 - 3 * dt);
          this.vel.z *= Math.max(0, 1 - 3 * dt);
        }
      }

      if (biteSq < SCARAB_BITE_DIST * SCARAB_BITE_DIST && this.biteCd <= 0) {
        this.biteCd = SCARAB_BITE_CD;
        this.onBite?.(this);
      }
    } else {
      this.airborne = true;
    }

    if (this.vel.lengthSq() > 1) this.yaw = Math.atan2(this.vel.x, this.vel.z);
    this.writeInstances(terrain);
  }

  private writeInstances(terrain: Terrain): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('scarab');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(0, this.yaw, 0);
    _q.setFromEuler(_e);
    // Grounded scarabs hug the slope — a skittering pack crossing a hill
    // reads flat-footed instead of piercing the dirt.
    if (!this.airborne) {
      _tiltQ.setFromUnitVectors(_UP, terrain.getNormal(this.pos.x, this.pos.z));
      _q.premultiply(_tiltQ);
    }
    _s.setScalar(r);
    _p.copy(this.pos);
    _root.compose(_p, _q, _s);

    const fr = this.flash > 0 ? 4 : 1;
    swarm.setMatrix(PART_BODY, slot, _root);
    swarm.setColor(PART_BODY, slot, this.color.r * fr, this.color.g * fr, this.color.b * fr);

    // Six legs, 3 per side — frantic alternating scuttle, way faster than
    // the crawler's: scarabs are all legs and panic.
    const amp = this.airborne ? 0.06 : (this.vel.lengthSq() > 4 ? 0.6 : 0.2);
    for (let i = 0; i < LEGS_PER; i++) {
      const side = i < 3 ? -1 : 1;
      const k = i % 3; // 0 front → 2 rear
      const wiggle = Math.sin(this.animT * 24 + i * 2.1) * amp;
      _e.set(0, side < 0 ? Math.PI - (k - 1) * 0.5 + wiggle : (k - 1) * 0.5 + wiggle, 0);
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(side * 0.55, 0.15, (k - 1) * 0.6),
        _q, _s.set(1, 1, 1));
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_LEG, slot * LEGS_PER + i, _world);
      swarm.setColor(PART_LEG, slot * LEGS_PER + i, this.color.r * 0.5, this.color.g * 0.5, this.color.b * 0.5);
    }

    // Two amber eyes on the head lobe
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.14, 0.25, 0.9), _q.identity(), _s.setScalar(0.3),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.1, 0.3);
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    // Featherweight — blasts LAUNCH fodder, that's the fun
    this.vel.addScaledVector(_dir, force * 1.8);
    this.vel.y += force * 0.6;
    this.airborne = true;
    this.stunTimer = SCARAB_STUN;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 1.8);
    this.stunTimer = SCARAB_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('scarab', this);
      this.hasSlots = false;
    }
  }
}
