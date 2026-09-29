import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRUB_RADIUS, GRUB_HEALTH, GRUB_SPEED,
  GRUB_AGGRO_DIST, GRUB_BITE_DIST, GRUB_BITE_CD, GRUB_STUN,
  EMERGE_DUR, MELEE_FAVOR,
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

// Part indices into the grub swarm — order must match grubParts().
const PART_SEG = 0;   // four instances per grub: slot*4+i — segments animate independently
const PART_EYE = 1;   // two per grub — tiny dark eyes on the head segment
const SEGS_PER = 4;
const EYES_PER = 2;

// One shared lobe — instanced 4× per grub. Tail→head taper comes from
// per-instance scale in writeInstances, not the geometry.
let _segGeo: THREE.IcosahedronGeometry | null = null;
function segGeo(): THREE.BufferGeometry {
  if (!_segGeo) {
    _segGeo = new THREE.IcosahedronGeometry(0.62, 0);
    _segGeo.scale(0.9, 0.75, 0.85);
  }
  return _segGeo;
}
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function grubParts(): SwarmPart[] {
  if (!_bodyMat) _bodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true,
  });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x332211, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: segGeo(), material: _bodyMat, castShadow: true, per: SEGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
  ];
}

/**
 * Grub — the most mundane thing alive. A fat pale maggot that inches
 * toward you and pops. Exists to be shot; the nuggets are the point.
 * Renders into the shared grub swarm — owns no meshes.
 */
export class Grub implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0xc9b98a); // pale maggot cream
  readonly debrisKind = 'goo' as const; // pops into pulp — deeply satisfying
  readonly dieCue = 'splat' as const;
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private yawVel = 0; // residual turn error — trailing segments lag into a bend
  private flash = 0;
  private biteCd = 0;
  private stunTimer = 0;

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  onBite?: (grub: Grub) => void;
  // Uber = "bloatgrub": it doesn't die, it BIRTHES — pops into live grubs
  onDeath?: (t: Targetable) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? GRUB_HEALTH * 4 : GRUB_HEALTH;
    this.radius = uber ? GRUB_RADIUS * 2.2 : GRUB_RADIUS;
    this.scale = uber ? 3.0 : 0.6; // scale 3 → 3 nuggets — the fat piñata pays out
    if (uber) this.color.set(0xd8a860); // bloated amber — reads pregnant
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('grub', this);
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
    // Bite = actual contact: distSq is horizontal (steering); a grub can't
    // reach a player hovering above it no matter how close the shadow is.
    const dy = playerPos.y - this.pos.y;
    const biteSq = distSq + dy * dy;

    if (this.emergeT > 0) {
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
      this.pos.y = this.groundY + this.radius - this.emergeDepth * (1 - k * k);
      this.writeInstances(terrain);
      return;
    }

    if (this.stunTimer <= 0 && distSq < GRUB_AGGRO_DIST * GRUB_AGGRO_DIST) {
      const d = Math.sqrt(distSq) || 0.001;
      this.vel.x = (dx / d) * GRUB_SPEED;
      this.vel.z = (dz / d) * GRUB_SPEED;
    } else {
      this.vel.x *= Math.max(0, 1 - 4 * dt);
      this.vel.z *= Math.max(0, 1 - 4 * dt);
    }
    this.vel.y = 0;
    this.pos.addScaledVector(this.vel, dt);
    // Glued to the dirt — a maggot doesn't hop
    this.groundY = terrain.getHeight(this.pos.x, this.pos.z);
    this.pos.y = this.groundY + this.radius;

    const biteD = GRUB_BITE_DIST * MELEE_FAVOR;
    if (biteSq < biteD * biteD && this.biteCd <= 0) {
      this.biteCd = GRUB_BITE_CD;
      this.onBite?.(this);
    }

    if (this.vel.lengthSq() > 0.1) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let dyaw = want - this.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      this.yaw += dyaw * Math.min(1, 3 * dt); // sluggish turn — it oozes around
      this.yawVel += (dyaw - this.yawVel) * Math.min(1, 4 * dt);
    } else {
      this.yawVel *= Math.max(0, 1 - 4 * dt); // straighten out when still
    }
    this.writeInstances(terrain);
  }

  private groundY = 0; // terrain height at center — segment heights are deltas from this

  private writeInstances(terrain: Terrain): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('grub');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _e.set(0, this.yaw, 0);
    _q.setFromEuler(_e);
    _root.compose(this.pos, _q, _s.setScalar(r));

    // Segmented crawl — each lobe gets its own phase: a lift wave travels
    // tail→head (peristalsis) while a lateral wave slithers the body into
    // an S-curve. Turning also bends the body — trailing segments lag the
    // head's yaw via a per-segment yaw offset.
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const crawl = Math.min(1, spd / GRUB_SPEED); // wave freezes when still
    const fr = this.flash > 0 ? 4 : 1;
    for (let i = 0; i < SEGS_PER; i++) {
      const t = i / (SEGS_PER - 1); // 0 tail → 1 head
      const phase = this.animT * 6 * crawl - i * 1.1;
      // Peristaltic lift + squash ripple, traveling rear→front
      const lift = Math.max(0, Math.sin(phase)) * 0.12 * crawl;
      const pulse = 1 + Math.sin(phase) * 0.12 * crawl;
      // Slither: lateral S-curve — tail swings opposite the head
      const lat = Math.sin(this.animT * 4.5 * crawl - i * 0.9) * 0.14 * crawl;
      // Bend: segments are inside the root's yaw, so lag is a NEGATIVE
      // offset growing toward the tail (t=0 trails the most, head leads)
      const segYaw = -this.yawVel * (1 - t) * 0.9;
      const lz = -0.9 + t * 1.8 - lat * Math.sin(segYaw);
      const lx = lat * Math.cos(segYaw);
      // Terrain conform: each segment rests on ITS OWN ground point —
      // rotate the local offset by yaw, sample height there, express the
      // delta in root space (root sits at center ground + radius).
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const wx = this.pos.x + lx * cy + lz * sy;
      const wz = this.pos.z - lx * sy + lz * cy;
      const segGround = terrain.getHeight(wx, wz) - this.groundY;
      _e.set(0, segYaw, 0);
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(lx, segGround - this.radius + 0.3 + lift, lz),
        _q,
        _s.setScalar(0.55 + t * 0.35).multiplyScalar(pulse),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_SEG, slot * SEGS_PER + i, _world);
      swarm.setColor(PART_SEG, slot * SEGS_PER + i,
        this.color.r * fr * (0.85 + t * 0.15), // head slightly lighter
        this.color.g * fr * (0.85 + t * 0.15),
        this.color.b * fr * (0.85 + t * 0.15));
    }

    // Two dark bead eyes on the head segment (leading lobe)
    for (let i = 0; i < EYES_PER; i++) {
      const side = i === 0 ? -1 : 1;
      _local.compose(
        _p.set(side * 0.2, 0.45, 1.05), _q.identity(), _s.setScalar(0.18),
      );
      _world.multiplyMatrices(_root, _local);
      swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _world);
    }

    getShadows()?.set(this, this.pos, r * 1.2, 0.3);
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) {
      this.dead = true;
      this.onDeath?.(this); // bloatgrub births on pop — wired in entities
      return true;
    }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * 0.8); // squishy mass — slides, doesn't fly
    this.stunTimer = GRUB_STUN;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * 0.8);
    this.stunTimer = GRUB_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('grub', this);
      this.hasSlots = false;
    }
  }
}
