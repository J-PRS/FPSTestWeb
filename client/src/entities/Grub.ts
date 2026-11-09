import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRUB_RADIUS, GRUB_HEALTH, GRUB_SPEED,
  GRUB_AGGRO_DIST, GRUB_BITE_DIST, GRUB_BITE_CD, GRUB_STUN,
  EMERGE_DUR, MELEE_FAVOR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner, SpeciesSwarm } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _dir = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _pt = { x: 0, z: 0 };   // trail sample scratch
const _ahead = { x: 0, z: 0 };
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

// Part indices into the grub swarm - order must match grubParts().
const PART_SEG = 0;   // six instances per grub: slot*6+i — segments animate independently
const PART_EYE = 1;   // two per grub — tiny dark eyes on the head capsule
const PART_LEG = 2;   // six per grub — 3 pairs of thoracic stubs behind the head
const SEGS_PER = 6;
const EYES_PER = 2;
const LEGS_PER = 6;

// One shared lobe — instanced 5× per grub. The scarab-larva silhouette
// (fat blunt rear, small dark head capsule) comes from per-instance scale
// in writeInstances, not the geometry. Detail-1 icosphere: the lobes must
// read ROUND and juicy, not faceted like the snake's diamond plates.
let _segGeo: THREE.IcosahedronGeometry | null = null;
function segGeo(): THREE.BufferGeometry {
  if (!_segGeo) {
    _segGeo = new THREE.IcosahedronGeometry(0.6, 1);
    _segGeo.scale(1, 0.88, 1.18); // plump, a little longer than wide
  }
  return _segGeo;
}
const _eyeGeo = new THREE.PlaneGeometry(1, 1);
// Thoracic leg stub — scarab grubs carry 3 pairs of short jointed legs
// right behind the head capsule. A fat toe pointing down-forward is the
// whole read at this scale.
let _legGeo: THREE.ConeGeometry | null = null;
function legGeo(): THREE.BufferGeometry {
  if (!_legGeo) {
    _legGeo = new THREE.ConeGeometry(0.09, 0.3, 5);
    _legGeo.rotateX(Math.PI * 0.75); // apex down-forward — a stubby toe
  }
  return _legGeo;
}

let _bodyMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;
let _legMat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — registered once in swarms.initSwarms. */
export function grubParts(): SwarmPart[] {
  if (!_bodyMat) {_bodyMat = new THREE.MeshLambertMaterial({
    color: 0xFF_FF_FF, // smooth — a grub is soft tissue, facets read as rock
  });}
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0x33_22_11, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });}
  if (!_legMat) {_legMat = new THREE.MeshLambertMaterial({ color: 0x8A_6F_4D, flatShading: true });}
  return [
    { geometry: segGeo(), material: _bodyMat, castShadow: true, per: SEGS_PER },
    { geometry: _eyeGeo, material: _eyeMat, per: EYES_PER },
    { geometry: legGeo(), material: _legMat, per: LEGS_PER },
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
  color = new THREE.Color(0xDE_D4_B4); // waxy cream — real white grubs are brighter than khaki
  readonly debrisKind = 'goo' as const; // pops into pulp — deeply satisfying
  readonly dieCue = 'splat' as const;
  readonly ichor = 0x7F_B4_E8; // pale blue grub juice
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;

  private animT = Math.random() * 10;
  private yaw = 0;
  private flash = 0;
  private biteCd = 0;
  private stunTimer = 0;

  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  // Spine trail — flat [x,z,...] newest-first, same model as the snake:
  // the head leads pos and the body physically follows the path, so a
  // turn bends through the segments instead of rotating the whole blob.
  trail: number[] = [];

  onBite?: (grub: Grub) => void;
  // Uber = "bloatgrub": it doesn't die, it BIRTHES — pops into live grubs
  onDeath?: (t: Targetable) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    this.uber = uber;
    this.maxHealth = uber ? GRUB_HEALTH * 4 : GRUB_HEALTH;
    this.health = this.maxHealth;
    this.radius = uber ? GRUB_RADIUS * 2.2 : GRUB_RADIUS;
    this.scale = uber ? 3 : 0.75; // scale 3 → 3 nuggets — the fat piñata pays out
    if (uber) {this.color.set(0xD8_A8_60);} // bloated amber — reads pregnant
    this.pos = pos.clone();
    const sg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(sg)) {this.pos.y = sg + this.radius;}
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('grub', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.stunTimer > 0) {this.stunTimer -= dt;}
    if (this.flash > 0) {this.flash -= dt;}
    if (this.biteCd > 0) {this.biteCd -= dt;}
    this.animT += dt;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;
    // Bite = actual contact: distSq is horizontal (steering); a grub can't
    // reach a player hovering above it no matter how close the shadow is.
    const dy = playerPos.y - this.pos.y;
    const biteSq = distSq + dy * dy;

    if (this.tickEmerge(dt, terrain)) {return;}

    this.steer(dt, dx, dz, distSq);
    this.vel.y = 0;
    this.pos.addScaledVector(this.vel, dt);
    // Glued to the dirt — a maggot doesn't hop
    const tg = terrain.getHeight(this.pos.x, this.pos.z);
    if (Number.isFinite(tg)) {this.groundY = tg;}
    this.pos.y = this.groundY + this.radius;

    const biteD = GRUB_BITE_DIST * MELEE_FAVOR;
    if (biteSq < biteD * biteD && this.biteCd <= 0) {
      this.biteCd = GRUB_BITE_CD;
      this.onBite?.(this);
    }

    if (this.vel.lengthSq() > 0.1) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      let dyaw = want - this.yaw;
      while (dyaw > Math.PI) {dyaw -= Math.PI * 2;}
      while (dyaw < -Math.PI) {dyaw += Math.PI * 2;}
      this.yaw += dyaw * Math.min(1, 3 * dt); // sluggish turn — it oozes around
    }
    this.pushTrail();
    this.writeInstances(terrain);
  }

  // Aggro chase inside radius, else oozing deceleration.
  private steer(dt: number, dx: number, dz: number, distSq: number): void {
    if (this.stunTimer <= 0 && distSq < GRUB_AGGRO_DIST * GRUB_AGGRO_DIST) {
      const d = Math.sqrt(distSq) || 0.001;
      this.vel.x = (dx / d) * GRUB_SPEED;
      this.vel.z = (dz / d) * GRUB_SPEED;
    } else {
      this.vel.x *= Math.max(0, 1 - 4 * dt);
      this.vel.z *= Math.max(0, 1 - 4 * dt);
    }
  }

  // Burrow emerge: rises out of the ground on an ease-out curve. True
  // while emerging — caller skips the rest of update.
  private tickEmerge(dt: number, terrain: Terrain): boolean {
    if (this.emergeT <= 0) {return false;}
    this.emergeT -= dt;
    const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
    const eg = terrain.getHeight(this.pos.x, this.pos.z);
    if (Number.isFinite(eg)) {this.groundY = eg;}
    this.pos.y = this.groundY + this.radius - this.emergeDepth * (1 - k * k);
    this.writeInstances(terrain);
    return true;
  }

  // Record the head's traveled path — flat [x,z,...], newest first.
  // The head rides ~1.05r ahead of pos; segments sit at fixed arc-lengths
  // behind it, so the body traces the curve the head actually took.
  private static BODY_LEN = 2.1;   // radius units, tail→head
  private static STEP = 0.14;      // breadcrumb spacing, radius units
  private pushTrail(): void {
    const r = this.radius;
    const hx = this.pos.x + Math.sin(this.yaw) * 1.05 * r;
    const hz = this.pos.z + Math.cos(this.yaw) * 1.05 * r;
    const tr = this.trail;
    const step = Grub.STEP * r;
    if (tr.length >= 2) {
      const dx = hx - tr[0]!, dz = hz - tr[1]!;
      if (dx * dx + dz * dz < step * step) {return;}
    }
    tr.unshift(hx, hz);
    const maxPts = Math.ceil(Grub.BODY_LEN * 1.6 / Grub.STEP) * 2;
    if (tr.length > maxPts) {tr.length = maxPts;}
  }

  // Walk the trail to a point `dist` (radius units) behind the head.
  // Short trails stretch straight back along -yaw so a fresh spawn
  // reads as a straight grub.
  private sampleTrail(dist: number, out: { x: number; z: number }): void {
    const r = this.radius;
    const tr = this.trail;
    const d = dist * r;
    if (tr.length < 2) {
      out.x = this.pos.x + Math.sin(this.yaw) * (1.05 * r - d);
      out.z = this.pos.z + Math.cos(this.yaw) * (1.05 * r - d);
      return;
    }
    let acc = 0;
    for (let i = 0; i + 3 < tr.length; i += 2) {
      const dx = tr[i + 2]! - tr[i]!, dz = tr[i + 3]! - tr[i + 1]!;
      const seg = Math.hypot(dx, dz);
      if (acc + seg >= d && seg > 1e-6) {
        const k = (d - acc) / seg;
        out.x = tr[i]! + dx * k;
        out.z = tr[i + 1]! + dz * k;
        return;
      }
      acc += seg;
    }
    const n = tr.length;
    const bx = tr[n - 2]!, bz = tr[n - 1]!;
    const px = n >= 4 ? bx - tr[n - 4]! : Math.sin(this.yaw);
    const pz = n >= 4 ? bz - tr[n - 3]! : Math.cos(this.yaw);
    const pl = Math.hypot(px, pz) || 1;
    out.x = bx + (px / pl) * (d - acc);
    out.z = bz + (pz / pl) * (d - acc);
  }

  private groundY = 0; // terrain height at center — segment heights are deltas from this

  private writeInstances(terrain: Terrain): void {
    if (!this.hasSlots) {return;}
    const swarm = getSwarm('grub');
    if (!swarm) {return;}
    const slot = this.swarmSlot;
    const r = this.radius;

    // Peristaltic crawl — a scarab grub doesn't slither, it TELESCOPES:
    // a radial squeeze + forward stretch travels rear→front, each lobe
    // narrowing while it slides ahead then swelling fat again. The body
    // shape itself comes from the trail: the head leads, each lobe sits
    // at a fixed arc-length behind it along the recorded path, and
    // samples its own ground height — a turn physically curls the body.
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const crawl = Math.min(1, spd / GRUB_SPEED); // wave freezes when still
    const fr = this.flash > 0 ? 4 : 1;
    // Larva profile, tail→head: blunt rounded rear, fattest just past
    // middle, then a quick taper into the small dark head capsule. Six
    // overlapping lobes read as the folded annuli real grubs have.
    const PROFILE = [0.55, 0.97, 1.06, 0.95, 0.72, 0.5];
    const segX: number[] = []; const segY: number[] = [];
    const segZ: number[] = []; const segR: number[] = [];
    for (let i = 0; i < SEGS_PER; i += 1) {
      const t = i / (SEGS_PER - 1); // 0 tail → 1 head
      const phase = this.animT * 5 * crawl - i * 1.05;
      // Peristalsis: squeeze radially while telescoping forward
      const sq = Math.sin(phase);
      const radial = 1 - 0.16 * sq * crawl;
      const telesc = 0.11 * Math.cos(phase) * crawl;
      const lift = Math.max(0, Math.sin(phase + 0.6)) * 0.1 * crawl;
      // Slight lateral weave — a wet body wobbles, it doesn't snake
      const lat = Math.sin(this.animT * 3.5 * crawl - i * 0.8) * 0.05 * crawl;
      // Spine position: arc-length behind the head along the trail.
      // Peristaltic offsets then apply in the segment's OWN tangent frame.
      const dist = Grub.BODY_LEN - t * 2.05 - telesc;
      this.sampleTrail(Math.max(0, dist), _pt);
      this.sampleTrail(Math.max(0, dist - 0.35), _ahead);
      const tx = _pt.x - _ahead.x, tz = _pt.z - _ahead.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl; // left normal of the spine
      const wx = _pt.x + lat * nx * r, wz = _pt.z + lat * nz * r;
      const segGround = terrain.getHeight(wx, wz);
      // The scarab C: dorsal hump mid-body, head end rears slightly while
      // the tail end stays planted and tucks under.
      const hump = Math.sin(t * Math.PI) * 0.14;
      const rearing = t * t * 0.16;
      const wr = PROFILE[i]! * radial; // world scale of the lobe
      segX[i] = wx; segZ[i] = wz;
      segR[i] = 0.6 * wr * r;
      // Belly seat: lobe y-radius is 0.6·0.88·P·r ≈ 0.53·P·r — this
      // offset puts the underside ~1–2cm into the dirt (contact, not
      // float): fatter lobes sit higher AND deeper at once.
      const ly = segGround + r * (0.2 + 0.26 * PROFILE[i]!) + r * (hump + lift + rearing);
      segY[i] = ly;
      _e.set(0, Math.atan2(tx, tz), 0);
      _q.setFromEuler(_e);
      _local.compose(_p.set(wx, ly, wz), _q, _s.setScalar(wr * r));
      swarm.setMatrix(PART_SEG, slot * SEGS_PER + i, _local);
      // Three-tone grub: ORANGE-brown chitin head capsule, pale juicy
      // thorax/abdomen, and a dusky rear lobe — the translucent tail
      // showing gut contents that real white grubs wear.
      const headCap = t > 0.99 ? 0.62 : 1;
      const gutDark = t < 0.01 ? 0.68 : 1;
      const shad = (0.92 + t * 0.08) * headCap * gutDark;
      swarm.setColor(PART_SEG, slot * SEGS_PER + i,
        this.color.r * fr * shad,
        this.color.g * fr * shad * (headCap < 1 ? 0.72 : 1),
        this.color.b * fr * shad * (headCap < 1 ? 0.45 : 1));
    }

    // Two dark bead eyes on the head capsule — ride the head lobe's own
    // tangent frame so they stay put while the body bends.
    {
      const hx = segX[SEGS_PER - 1]!, hy = segY[SEGS_PER - 1]!, hz = segZ[SEGS_PER - 1]!;
      const fx = hx - segX[SEGS_PER - 2]!, fz = hz - segZ[SEGS_PER - 2]!;
      const fl = Math.hypot(fx, fz) || 1;
      const ux = fx / fl, uz = fz / fl;
      const lx = -uz, lz = ux; // head's left normal
      for (let i = 0; i < EYES_PER; i += 1) {
        const side = i === 0 ? -1 : 1;
        _local.compose(
          _p.set(hx + ux * 0.45 * r + lx * side * 0.22 * r,
                 hy + segR[SEGS_PER - 1]! * 0.45,
                 hz + uz * 0.45 * r + lz * side * 0.22 * r),
          _q.identity(), _s.setScalar(0.15 * r),
        );
        swarm.setMatrix(PART_EYE, slot * EYES_PER + i, _local);
      }
    }

    this.writeLegs(swarm, slot, { x: segX, y: segY, z: segZ, r: segR }, crawl, r);

    getShadows()?.set(this, this.pos, r * 1.2, 0.3);
  }

  // Three pairs of stub legs under the thorax — interpolated along the
  // two lobes behind the head capsule so they ride the same wave the
  // body does. Base stays buried inside the lobe, the rolled cone tip
  // is the only part that clears the silhouette. Side = the spine's
  // left normal here, so legs stay under the body through a bend.
  private writeLegs(swarm: SpeciesSwarm, slot: number, seg: { x: number[]; y: number[]; z: number[]; r: number[] }, crawl: number, r: number): void {
    const HOST_A = 3, HOST_B = 4;             // thorax lobes
    const LEG_U = [1.2, 0.5, -0.2];           // pair offsets along A→B
    const ax = seg.x[HOST_A]!, az = seg.z[HOST_A]!;
    const bx = seg.x[HOST_B]!, bz = seg.z[HOST_B]!;
    const bt = Math.hypot(bx - ax, bz - az) || 1;
    const lnx = -(bz - az) / bt, lnz = (bx - ax) / bt; // spine left normal
    for (let i = 0; i < LEGS_PER; i += 1) {
      const pair = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const u = LEG_U[pair]!;
      const hx = ax + (bx - ax) * u;
      const hy = seg.y[HOST_A]! + (seg.y[HOST_B]! - seg.y[HOST_A]!) * u;
      const hz = az + (bz - az) * u;
      const hr = seg.r[HOST_A]! + (seg.r[HOST_B]! - seg.r[HOST_A]!) * u;
      const phase = this.animT * 5 * crawl - (SEGS_PER - 2 - pair) * 1.05;
      const paddle = Math.sin(phase) * 0.06 * crawl * r;
      _e.set(0, Math.atan2(bx - ax, bz - az), side * 0.55, 'YXZ');
      _q.setFromEuler(_e);
      _local.compose(
        _p.set(hx + lnx * side * hr * 0.55, hy - hr * 0.72 + paddle, hz + lnz * side * hr * 0.55),
        _q,
        _s.setScalar(0.85 * r),
      );
      swarm.setMatrix(PART_LEG, slot * LEGS_PER + i, _local);
    }
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
