import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  TOTEM_RADIUS, TOTEM_HEALTH,
  TOTEM_RANGE, TOTEM_MIN_RANGE, TOTEM_REFIRE,
  TOTEM_CHARGE, TOTEM_RELOCATE_HOPS,
  TOTEM_PEAK_RADIUS, TOTEM_PEAK_MIN_GAIN, TOTEM_MATERIALIZE,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm, getShadows } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { TerrainFoot } from '../effects/terrainFoot.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

const PART_SHAFT = 0;
const PART_CAP = 1;
const PART_EYE = 2;      // glow slit quad near the top
const PART_BEAM = 3;     // aim-beam quad — zero-scale when idle
const PART_SHIMMER = 4;  // blink-in arrival column — zero-scale when idle

const _shaftGeo = new THREE.CylinderGeometry(0.35, 0.7, 4.2, 4); // 4-sided obelisk
const _capGeo = new THREE.ConeGeometry(0.5, 1.0, 4);
// Aim beam — a thin quad stretched between totem and player during charge;
// origin at the totem end so scaling +z extends it downrange.
const _beamGeo = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateY(Math.PI / 2); // lies along +z
  g.translate(0, 0, 0.5);
  return g;
})();
const _eyeGeo = new THREE.PlaneGeometry(1, 1);

let _shaftMat: THREE.MeshLambertMaterial | null = null;
let _eyeMat: THREE.MeshBasicMaterial | null = null;
let _beamMat: THREE.MeshBasicMaterial | null = null;
let _shimmerMat: THREE.MeshBasicMaterial | null = null;

export function totemParts(): SwarmPart[] {
  if (!_shaftMat) _shaftMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    color: 0x66ddff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  if (!_beamMat) _beamMat = new THREE.MeshBasicMaterial({
    color: 0xff3344, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  if (!_shimmerMat) _shimmerMat = new THREE.MeshBasicMaterial({
    color: 0x8899ff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return [
    { geometry: _shaftGeo, material: _shaftMat, castShadow: true },
    { geometry: _capGeo, material: _shaftMat },
    { geometry: _eyeGeo, material: _eyeMat },
    { geometry: _beamGeo, material: _beamMat },
    { geometry: _shaftGeo, material: _shimmerMat },
  ];
}

/**
 * Sniper totem — the perpendicular-movement teacher. Blinks to high ground,
 * charges a visible aim-beam at the player, fires a fast flat bolt.
 * Renders into the shared totem swarm; the TerrainFoot stays per-instance —
 * it conforms to the local heightmap, which instancing can't express.
 */
export class Totem implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel = new THREE.Vector3(); // never ballistic — it blinks, not hops
  dead = false;
  health = TOTEM_HEALTH;
  maxHealth = TOTEM_HEALTH;
  radius = TOTEM_RADIUS;
  // Obelisk is ~6m tall — capsule hitbox covers the whole shaft, not a
  // 1m sphere at the feet (this was the "can't hit him" whiff zone).
  capsuleTop = 4.2 * 1.4;
  color = new THREE.Color(0x2a2438); // dark obsidian violet
  scale = 1.4;

  swarmSlot = -1;
  shadowSlot = -1;
  private hasSlots = false;
  private foot: TerrainFoot | null = null;
  private _terrain: Terrain;

  private bodyScale = 0.3;   // materialize grow-in / blinkOut shrink
  private eyeScale = 0.4;
  private eyeBright = 0;     // 0..1 charge heat — instanceColor on the eye quad
  private beamOn = false;
  private beamOpacity = 0;
  private beamWidth = 0.65;
  private shimmerOn = false;
  private shimmerPulse = 0;
  private flash = 0;
  private chargeGlow = 0;

  private state: 'materialize' | 'aim' | 'charge' | 'blinkOut' | 'blinkIn' = 'materialize';
  private stateTimer = TOTEM_MATERIALIZE;
  private chargeTimer = 0;
  private refire = TOTEM_REFIRE;
  private shotsFired = 0;
  private blinkTarget = new THREE.Vector3();
  private lockPoint = new THREE.Vector3(); // beam locks here — dodge by moving after lock
  private lockDir = new THREE.Vector3();   // locked firing direction
  private lockDist = TOTEM_RANGE;
  private beamFade = 0;                    // post-shot beam decay timer

  onBoltHit?: (t: Totem) => void;
  onBoltLand?: (pos: THREE.Vector3) => void;
  onBlink?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }
  private get intangible(): boolean { return this.state === 'blinkOut' || this.state === 'blinkIn'; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this._terrain = terrain;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z);

    this.hasSlots = allocSlots('totem', this);
    if (!this.hasSlots) this.dead = true;

    // Foundation foot — obelisk rim extruded into the dirt. Per-instance:
    // it conform-samples the heightmap, which an InstancedMesh can't express.
    this.foot = new TerrainFoot(scene, this.radius * 0.66);
    this.foot.conform(this.pos.x, this.pos.z, this.pos.y, terrain);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    void playerVel;
    if (this.dead) return;
    if (this.flash > 0) this.flash -= dt;

    this.stateTimer -= dt;
    const dist = this.pos.distanceTo(playerPos);

    switch (this.state) {
      case 'materialize': {
        const t = 1 - Math.max(0, this.stateTimer / TOTEM_MATERIALIZE);
        this.bodyScale = 0.3 + t * 0.7;
        this.eyeScale = 0.4 + t * 0.4;
        this.eyeBright = t * 0.5;
        if (this.stateTimer <= 0) {
          this.state = 'aim';
          this.bodyScale = 1;
          this.eyeBright = 0.8;
        }
        break;
      }
      case 'aim': {
        this.refire -= dt;
        this.eyeBright = 0.8;
        this.eyeScale = 1.1;
        if (dist < TOTEM_MIN_RANGE ||
            (this.shotsFired >= TOTEM_RELOCATE_HOPS) ||
            (this.refire <= 0 && !this.lineClear(playerPos))) {
          this.beginBlink(playerPos);
          break;
        }
        if (this.refire <= 0 && dist < TOTEM_RANGE) {
          this.state = 'charge';
          this.chargeTimer = TOTEM_CHARGE;
          this.lockPoint.copy(playerPos); // LOCK the line now — no more tracking
          this.solveBeam();
          this.beamOn = true;
        }
        break;
      }
      case 'charge': {
        this.chargeTimer -= dt;
        const t = 1 - Math.max(0, this.chargeTimer / TOTEM_CHARGE);
        this.beamWidth = 0.65 - t * 0.55;
        this.beamOpacity = 0.3 + t * 0.55;
        this.eyeBright = 0.8 + t * 0.2;
        this.eyeScale = 1.1 + t * 1.4;
        this.chargeGlow = t * 0.5; // violet charge bleed on the shaft
        if (this.chargeTimer <= 0) {
          this.fireBeam(playerPos);
          this.eyeScale = 1.1;
          this.chargeGlow = 0;
          this.state = 'aim';
          this.refire = TOTEM_REFIRE;
          this.shotsFired++;
        }
        break;
      }
      case 'blinkOut': {
        const t = Math.max(0, this.stateTimer / 0.25);
        this.bodyScale = t;
        if (this.stateTimer <= 0) {
          this.pos.copy(this.blinkTarget);
          this.pos.y = this._terrain.getHeight(this.pos.x, this.pos.z);
          this.bodyScale = 0;
          this.foot!.mesh.visible = false;
          this.state = 'blinkIn';
          this.stateTimer = 0.3;
        }
        break;
      }
      case 'blinkIn': {
        // Shimmer column stands at the arrival spot before the body appears
        this.shimmerOn = true;
        this.shimmerPulse = 0.7 * Math.abs(Math.sin(this.stateTimer * 20));
        if (this.stateTimer <= 0) {
          this.shimmerOn = false;
          this.bodyScale = 1;
          this.foot!.conform(this.pos.x, this.pos.z, this.pos.y, this._terrain);
          this.foot!.mesh.visible = true;
          this.state = 'materialize';
          this.stateTimer = TOTEM_MATERIALIZE;
          this.shotsFired = 0;
          this.onBlink?.(this.pos);
        }
        break;
      }
    }

    // Beam afterglow — the fired rail flash decays out
    if (this.beamFade > 0) {
      this.beamFade -= dt;
      this.beamOpacity = Math.max(0, this.beamFade / 0.3) * 0.95;
      if (this.beamFade <= 0) this.beamOn = false;
    }

    this.writeInstances();
    if (this.foot) getShadows()?.set(this, this.pos, this.radius * 0.9, 0.35);
  }

  private writeInstances(): void {
    if (!this.hasSlots) return;
    const swarm = getSwarm('totem');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;
    const visible = this.state !== 'blinkIn';
    const bs = visible ? this.bodyScale : 0;

    // Shaft + cap ride the body scale (materialize grow / blinkOut shrink)
    _q.identity();
    _root.compose(this.pos, _q, _s.setScalar(r * Math.max(0.0001, bs)));
    _local.compose(_p.set(0, 2.1, 0), _q.identity(), _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_SHAFT, slot, _world);

    const fr = this.flash > 0 ? 4 : 1;
    const cg = this.chargeGlow;
    const cr = this.color.r * fr + cg * 0.6;
    const cgg = this.color.g * fr + cg * 0.3;
    const cb = this.color.b * fr + cg;
    swarm.setColor(PART_SHAFT, slot, cr, cgg, cb);
    swarm.setColor(PART_CAP, slot, cr, cgg, cb);

    _local.compose(_p.set(0, 4.7, 0), _q.identity(), _s.set(1, 1, 1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_CAP, slot, _world);

    // Eye slit — charges blinding-white before the shot
    _local.compose(_p.set(0, 3.9, 0), _q.identity(), _s.setScalar(this.eyeScale * 0.8));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_EYE, slot, visible ? _world : zeroM(_world));
    const eb = this.eyeBright;
    swarm.setColor(PART_EYE, slot, 0.4 + eb, 0.85 + eb * 0.4, 1 + eb * 0.5);

    // Aim beam — stretched from eye height down the locked line
    if (this.beamOn || this.beamFade > 0) {
      _p.set(this.pos.x, this.pos.y + 3.9 * r, this.pos.z);
      _v2.copy(_p).addScaledVector(this.lockDir, this.lockDist);
      _root.lookAt(_p, _v2, _v.set(0, 1, 0));
      _q.setFromRotationMatrix(_root);
      _root.compose(_p, _q, _s.set(1, this.beamWidth, this.lockDist));
      swarm.setMatrix(PART_BEAM, slot, _root);
      const bo = this.beamOpacity;
      swarm.setColor(PART_BEAM, slot, bo, bo * (0.35 - this.beamWidth * 0.1), bo * 0.3);
    } else {
      swarm.setMatrix(PART_BEAM, slot, zeroM(_root));
    }

    // Arrival shimmer column during blinkIn
    if (this.shimmerOn) {
      _p.set(this.pos.x, this.pos.y + 2.4, this.pos.z);
      _local.compose(_p, _q.identity(), _s.set(r, 1.3, r));
      swarm.setMatrix(PART_SHIMMER, slot, _local);
      const sp = this.shimmerPulse;
      swarm.setColor(PART_SHIMMER, slot, sp, sp, sp);
    } else {
      swarm.setMatrix(PART_SHIMMER, slot, zeroM(_local));
    }
  }

  private beginBlink(playerPos: THREE.Vector3): void {
    // Peak-seek: sample a ring of terrain around the PLAYER'S general
    // bearing, pick the highest point that keeps firing range.
    let bestH = -Infinity;
    let found = false;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const r = 15 + Math.random() * TOTEM_PEAK_RADIUS;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const h = this._terrain.getHeight(x, z);
      const pd = Math.hypot(playerPos.x - x, playerPos.z - z);
      if (pd > TOTEM_RANGE * 0.9) continue;
      if (h > bestH) { bestH = h; this.blinkTarget.set(x, h, z); found = true; }
    }
    if (!found || bestH < this._terrain.getHeight(this.pos.x, this.pos.z) + TOTEM_PEAK_MIN_GAIN) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 20;
      this.blinkTarget.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
    }
    this.state = 'blinkOut';
    this.stateTimer = 0.25;
    this.beamOn = false;
    this.onBlink?.(this.pos);
  }

  // LOS check — sampled straight-ish line; totem fires nearly flat bolts
  // so terrain grazing matters more than arc clearance.
  private lineClear(target: THREE.Vector3): boolean {
    const sy = this.pos.y + 3.9 * this.radius;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      const x = this.pos.x + (target.x - this.pos.x) * t;
      const z = this.pos.z + (target.z - this.pos.z) * t;
      const y = sy + (target.y - sy) * t;
      if (y < this._terrain.getHeight(x, z) + 0.4) return false;
    }
    return true;
  }

  // Solve the locked beam once: direction at lockPoint, extended to its
  // full length — terrain hit or TOTEM_RANGE.
  private solveBeam(): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z); // eye
    this.lockDir.copy(this.lockPoint).sub(_v).normalize();
    this.lockDist = TOTEM_RANGE;
    for (let t = 1; t <= TOTEM_RANGE; t += 1) {
      const x = _v.x + this.lockDir.x * t,
            y = _v.y + this.lockDir.y * t,
            z = _v.z + this.lockDir.z * t;
      if (y < this._terrain.getHeight(x, z)) { this.lockDist = t; break; }
    }
  }

  // Railgun fire: instant hitscan along the LOCKED line. Sidestep during
  // charge and the locked line whiffs you entirely.
  private fireBeam(playerPos: THREE.Vector3): void {
    _v.set(this.pos.x, this.pos.y + 3.9 * this.radius, this.pos.z);
    _dir.copy(this.lockDir);
    const dist = this.lockDist;
    const hitGround = dist < TOTEM_RANGE;

    _v2.subVectors(playerPos, _v);
    const proj = _v2.dot(_dir);
    if (proj > 0 && proj < dist && _v2.addScaledVector(_dir, -proj).lengthSq() < 1.7) {
      this.onBoltHit?.(this);
    } else if (hitGround) {
      _v2.copy(_v).addScaledVector(_dir, dist);
      this.onBoltLand?.(_v2);
    }

    // Post-shot flash: thin blinding line, decays via beamFade
    this.beamWidth = 0.18;
    this.beamOpacity = 0.95;
    this.beamFade = 0.3;
    this.beamOn = true;
  }

  takeDamage(): boolean {
    if (this.intangible) return false;
    this.health--;
    this.flash = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    // Anchored — but a blast during charge drops the aim (it blinks to safety)
    if (this.state === 'charge' && force > 8) this.beginBlink(from);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.state === 'charge' && force > 8) this.beginBlink(to);
  }

  dispose(): void {
    this.foot?.dispose();
    if (this.hasSlots) {
      freeSlots('totem', this);
      this.hasSlots = false;
    }
  }
}

// Zero matrix — hides an instanced part without touching the slot count.
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
function zeroM(out: THREE.Matrix4): THREE.Matrix4 {
  return out.copy(_zero);
}
