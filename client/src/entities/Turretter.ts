import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  TURRET_RADIUS, TURRET_HEALTH,
  TURRET_RANGE, TURRET_RELAUNCH, TURRET_MIN_DWELL,
  TURRET_HOP_T, TURRET_REFIRE, TURRET_BOLT_SPEED,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { TerrainFoot } from '../effects/terrainFoot.js';
import { allocSlots, freeSlots, getSwarm, getShadows, type SwarmPart } from './swarms.js';

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fan = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _root = new THREE.Matrix4();
const _head = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
// Base bottom buries this deep below CENTER ground — shallow, constant.
// Gaps under the rim are the foot's job, not the sink's.
const TURRET_BURROW = 0.18;
const FOOT_RIM = 1.28; // base cone bottom radius (1.3) minus a hair — tucks in

// Shared geometries
let _baseGeo: THREE.CylinderGeometry | null = null;
function baseGeo(): THREE.CylinderGeometry {
  if (!_baseGeo) _baseGeo = new THREE.CylinderGeometry(0.9, 1.3, 0.8, 8); // flared footing
  return _baseGeo;
}
let _domeGeo: THREE.SphereGeometry | null = null;
function domeGeo(): THREE.SphereGeometry {
  if (!_domeGeo) _domeGeo = new THREE.SphereGeometry(0.7, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  return _domeGeo;
}
let _barrelGeo: THREE.CylinderGeometry | null = null;
function barrelGeo(): THREE.CylinderGeometry {
  if (!_barrelGeo) {
    _barrelGeo = new THREE.CylinderGeometry(0.19, 0.26, 1.25, 8); // mortar tube, not a rifle
    _barrelGeo.rotateX(Math.PI / 2); // +z forward
    _barrelGeo.translate(0, 0, 0.65); // pivot at breech
  }
  return _barrelGeo;
}
let _boltGeo: THREE.SphereGeometry | null = null;
function boltGeo(): THREE.SphereGeometry {
  if (!_boltGeo) _boltGeo = new THREE.SphereGeometry(0.16, 8, 6);
  return _boltGeo;
}
let _eyeGeo: THREE.PlaneGeometry | null = null;
function eyeGeo(): THREE.PlaneGeometry {
  if (!_eyeGeo) _eyeGeo = new THREE.PlaneGeometry(0.5, 0.5);
  return _eyeGeo;
}

// Shared materials — per-turret variations ride on instanceColor instead.
let _baseMat: THREE.MeshLambertMaterial | null = null;
function baseMat(): THREE.MeshLambertMaterial {
  if (!_baseMat) _baseMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0a0d12 });
  return _baseMat;
}
let _domeMatS: THREE.MeshLambertMaterial | null = null;
function domeMatS(): THREE.MeshLambertMaterial {
  if (!_domeMatS) _domeMatS = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x101820 });
  return _domeMatS;
}
let _eyeMat: THREE.MeshBasicMaterial | null = null;
function eyeMat(): THREE.MeshBasicMaterial {
  if (!_eyeMat) _eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return _eyeMat;
}
let _boltMat: THREE.MeshBasicMaterial | null = null;
function boltMat(): THREE.MeshBasicMaterial {
  if (!_boltMat) _boltMat = new THREE.MeshBasicMaterial({ color: 0xffcc66 });
  return _boltMat;
}
let _trailMat: THREE.MeshBasicMaterial | null = null;
function trailMat(): THREE.MeshBasicMaterial {
  if (!_trailMat) _trailMat = new THREE.MeshBasicMaterial({
    color: 0xff8830, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return _trailMat;
}

const PART_BASE = 0, PART_DOME = 1, PART_BARREL = 2, PART_EYE = 3;
const DOME_R = 0x4a / 255, DOME_G = 0x5f / 255, DOME_B = 0x73 / 255;
const HULL_R = 0x3a / 255, HULL_G = 0x4a / 255, HULL_B = 0x5a / 255;

export function turretterParts(): SwarmPart[] {
  return [
    { geometry: baseGeo(), material: baseMat(), castShadow: true },
    { geometry: domeGeo(), material: domeMatS(), castShadow: true },
    { geometry: barrelGeo(), material: baseMat() },
    { geometry: eyeGeo(), material: eyeMat() },
  ];
}

export interface Bolt {
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3; // start-of-frame pos — swept interception is segment-vs-segment
  radius: number;         // intercept envelope (visual sphere is only 0.16 — this is the forgiving hitbox)
  vel: THREE.Vector3;
  life: number;
  trailAcc: number;
}

interface TrailDot {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

/**
 * Turretter — the "launch itself at you" enemy. Two states:
 *  planted: stationary turret, lobs bolts at the player (armored — half damage)
 *  air:     inert ballistic arc toward the player's predicted position;
 *           cannot steer, takes double damage — the airshot window.
 * Re-launches only when the player is beyond TURRET_RELAUNCH and it has
 * sat planted for TURRET_MIN_DWELL — close-range never hops, so no ping-pong.
 */
export class Turretter implements Targetable {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  // Dome tops out ~1.8m above pos — capsule covers the turret head, not
  // just the squashed sphere at the base (top-of-dome shots were whiffing).
  capsuleTop = 1.8;
  color = new THREE.Color(0x3a4a5a); // gunmetal
  scale = 1.2;

  // Swarm-slot handles — the turret renders through instanced parts, not a
  // scene-graph Group. bolts/trailDots stay real meshes (counts are tiny).
  swarmSlot = -1;
  shadowSlot = -1;

  private scene: THREE.Scene;
  private _terrain: Terrain;
  private rootQuat = new THREE.Quaternion(); // terrain tilt when planted; tumble when airborne
  private headYaw = 0;                       // turretHead yaw (world aim → tilted local frame)
  private headPitch = 0;
  // Live lobbed shells — public so combat can proximity-check them: a
  // player explosive clipping a bolt cooks it off mid-air (detonateBolt).
  readonly bolts: Bolt[] = [];
  private trailDots: TrailDot[] = [];

  private planted = false;          // false = airborne ballistic
  private dwell = 0;                // time since landing
  private refire = TURRET_REFIRE;   // first shot is immediate-ish
  private flashTimer = 0;
  private meshYOffset = 0;          // visual sink below gameplay pos (set by seat)
  private foot!: TerrainFoot;       // rim→dirt wall, conformed in seat() — set unless swarm alloc fails

  /** Landing shockwave FX hook */
  onLanded?: (pos: THREE.Vector3) => void;
  /** Bolt hit the player — wire sendEnvironmentDamage in main */
  onBoltHit?: (t: Turretter) => void;
  /** Bolt fizzled on terrain — dust/spark hook */
  onBoltLand?: (pos: THREE.Vector3) => void;
  /** Launch moment — dust kick hook */
  onLaunch?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.scene = scene;
    this._terrain = terrain;
    this.id = nextTargetId();
    // Uber = "siege engine": double tank, bigger chassis, and a THREE-BOLT
    // volley — a fanned spread that punishes a straight approach.
    this.uber = uber;
    this.health = this.maxHealth = uber ? TURRET_HEALTH * 2 : TURRET_HEALTH;
    this.radius = uber ? TURRET_RADIUS * 1.4 : TURRET_RADIUS;
    if (uber) this.color.set(0x5a3a2a); // rusted siege bronze

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.planted = true;

    if (!allocSlots('turretter', this)) { this.dead = true; return; }

    this.foot = new TerrainFoot(scene, FOOT_RIM);

    this.seat(terrain); // spawned planted — sit on the slope immediately
    this.writeInstances();
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) return;
    if (this.flashTimer > 0) this.flashTimer -= dt;

    this.updateBolts(dt, terrain, playerPos);

    if (this.planted) {
      this.dwell += dt;
      this.updatePlanted(dt, playerPos, playerVel);
    } else {
      this.updateAir(dt, terrain, playerPos);
    }

    this.writeInstances();
    getShadows()?.set(this, this.pos, this.radius * 1.15, 0.4);
  }

  // Compose root (pos + visual sink + tilt/tumble) then the turret-head
  // pivot (yaw+pitch inside that frame), writing each part's matrix.
  private writeInstances(): void {
    const swarm = getSwarm('turretter');
    if (!swarm || this.swarmSlot < 0) return;
    const slot = this.swarmSlot;

    _p.set(this.pos.x, this.pos.y + this.meshYOffset, this.pos.z);
    _root.compose(_p, this.rootQuat, _s.setScalar(1));

    // Head pivot at (0, 0.85, 0) in root space
    _q.setFromEuler(_e.set(this.headPitch, this.headYaw, 0));
    _local.compose(_v.set(0, 0.85, 0), _q, _s.setScalar(1));
    _head.multiplyMatrices(_root, _local);

    // base rides the root at y=0.4
    _local.compose(_v.set(0, 0.4, 0), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_BASE, slot, _world);
    swarm.setMatrix(PART_DOME, slot, _head);
    _local.compose(_v.set(0, 0.2, 0), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_head, _local);
    swarm.setMatrix(PART_BARREL, slot, _world);
    _local.compose(_v.set(0, 0.3, 0.6), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_head, _local);
    swarm.setMatrix(PART_EYE, slot, _world);

    swarm.setColor(PART_BASE, slot, HULL_R, HULL_G, HULL_B);
    swarm.setColor(PART_BARREL, slot, HULL_R, HULL_G, HULL_B);
    // Damage flash and the mid-air "shoot me now" glow both ride the dome.
    const flash = this.flashTimer > 0;
    const hot = !this.planted;
    swarm.setColor(PART_DOME, slot,
      flash ? 4 : hot ? DOME_R * 3 : DOME_R,
      flash ? 4 : hot ? DOME_G * 2 : DOME_G,
      flash ? 4 : hot ? DOME_B : DOME_B);
    swarm.setColor(PART_EYE, slot,
      hot ? 2.0 : 1.0, hot ? 1.0 : 0.53, hot ? 0.4 : 0.19);
  }

  private updatePlanted(dt: number, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Relaunch: far away AND past the dwell floor — the two conditions
    // together are what prevent ping-pong.
    if (dist > TURRET_RELAUNCH && this.dwell >= TURRET_MIN_DWELL) {
      this.launch(playerPos, playerVel);
      return;
    }
    if (dist > TURRET_RANGE) return; // out of range — sit tight

    // Track the player — the head lives inside the slope-tilted base, so
    // transform the world-space aim into the base's local frame first;
    // otherwise yaw/pitch are off by the tilt amount.
    _dir.set(dx, playerPos.y - this.pos.y, dz);
    _q2.copy(this.rootQuat).invert();
    _dir.applyQuaternion(_q2);
    this.headYaw = Math.atan2(_dir.x, _dir.z);
    const hd = Math.hypot(_dir.x, _dir.z);
    this.headPitch = Math.max(-0.5, Math.min(0.5, -Math.atan2(_dir.y, hd)));

    this.refire -= dt;
    if (this.refire <= 0) {
      const sol = this.solveBolt(playerPos, playerVel);
      if (sol && this.pathClear(sol)) {
        this.refire = TURRET_REFIRE;
        this.fireBolt(sol);
        if (this.uber) {
          // Siege volley: two flank shells fanned off the solve — same arc
          // energy, spread laterally so sidestepping one eats the other.
          _fan.copy(sol).applyAxisAngle(_UP, 0.28);
          this.fireBolt(_fan);
          _fan.copy(sol).applyAxisAngle(_UP, -0.28);
          this.fireBolt(_fan);
        }
      } else if (sol) {
        // Terrain eats the arc — reposition instead of shelling a hillside.
        // Still gated by the dwell floor so a blocked turret doesn't hop-spam.
        if (this.dwell >= TURRET_MIN_DWELL) {
          this.launch(playerPos, playerVel);
        } else {
          this.refire = 0.4; // retry soon — LOS may open
        }
      } else {
        this.refire = TURRET_REFIRE; // out of range — don't spam failed solves
      }
    }
  }

  private updateAir(dt: number, terrain: Terrain, _playerPos: THREE.Vector3): void {
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    // Tumble slightly in flight — reads as "thrown", not "flying"
    _q.setFromEuler(_e.set(dt * 2.2, 0, dt * 1.4));
    this.rootQuat.premultiply(_q);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y - this.radius * 0.5 <= gy) {
      this.pos.y = gy + this.radius * 0.5;
      this.planted = true;
      this.dwell = 0;
      this.vel.set(0, 0, 0);
      this.seat(terrain);
      this.onLanded?.(this.pos);
    }
  }

  // Seat the base onto the terrain:
  //  1. Tilt to the ground normal (works on any slope)
  //  2. Sink the base bottom a shallow burrow under CENTER ground — no
  //     footprint chasing; the skirt owns the gap now, so the base never
  //     needs to dive for the lowest dirt (that was the squash bug).
  //  3. Drape the skirt: hem = terrain per-vertex, shoulder = base rim —
  //     ground contact is a geometric guarantee on any relief.
  // No yaw here — the turret head owns all aiming.
  private seat(terrain: Terrain): void {
    const n = terrain.getNormal(this.pos.x, this.pos.z);
    _v.set(0, 1, 0);
    this.rootQuat.setFromUnitVectors(_v, n);

    const cx = this.pos.x, cz = this.pos.z;
    const gy = terrain.getHeight(cx, cz);
    this.pos.y = gy + this.radius * 0.5;

    const baseBottomWorldY = gy - TURRET_BURROW;
    this.meshYOffset = baseBottomWorldY - this.pos.y;

    // Weld the foot wall: rim ring tracks the tilted body, bottom ring is
    // driven under the terrain at each column — no gap can form.
    this.foot.conform(cx, cz, this.pos.y + this.meshYOffset, terrain, this.rootQuat);
    this.foot.mesh.visible = true;
  }

  // Perfect ballistic arc onto the player's predicted position — fixed
  // flight time, solve for the launch velocity. Inert from here on out.
  private launch(playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    _v.copy(playerPos);
    if (playerVel) _v.addScaledVector(playerVel, TURRET_HOP_T * 0.7); // lead, not lag
    _v.y = 0; // land at terrain height — solve on XZ + terrain
    const tx = _v.x, tz = _v.z;
    const ty = playerPos.y; // aim at the player's feet-ish
    const t = TURRET_HOP_T;
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const dy = ty - this.pos.y;
    this.vel.set(dx / t, (dy + 0.5 * Math.abs(GRAVITY) * t * t) / t, dz / t);
    this.planted = false;
    this.meshYOffset = 0; // in flight the mesh rides the body exactly
    this.rootQuat.identity(); // reset tilt — tumble owns the rotation
    this.foot.mesh.visible = false; // foundation stays behind
    // Dome goes hot mid-air via writeInstances' instanceColor — "shoot me now"
    this.onLaunch?.(this.pos);
  }

  // Solve the bolt launch velocity for the player's predicted position:
  // fixed 60 m/s, elevation from the range equation, low arc preferred.
  // Returns null when the target is beyond max range (disc < 0).
  private solveBolt(playerPos: THREE.Vector3, playerVel?: THREE.Vector3): THREE.Vector3 | null {
    const muzzleY = this.pos.y + 1.0;
    const v = TURRET_BOLT_SPEED;
    const g = Math.abs(GRAVITY);

    // First pass at the un-led distance for a flight-time estimate,
    // then aim at the player's position predicted over that time.
    const pd = Math.hypot(playerPos.x - this.pos.x, playerPos.z - this.pos.z) || 0.001;
    _v.copy(playerPos);
    if (playerVel) _v.addScaledVector(playerVel, (pd / v) * 0.5);

    const dx = _v.x - this.pos.x;
    const dz = _v.z - this.pos.z;
    const dy = _v.y - muzzleY;
    const d = Math.hypot(dx, dz) || 0.001;

    // tan θ = (v² ∓ √(v⁴ - g(g·d² + 2·dy·v²))) / (g·d) — take the low arc.
    const disc = v * v * v * v - g * (g * d * d + 2 * dy * v * v);
    if (disc < 0) return null; // out of range entirely
    const theta = Math.atan((v * v - Math.sqrt(disc)) / (g * d));
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    return new THREE.Vector3((dx / d) * v * cosT, v * sinT, (dz / d) * v * cosT);
  }

  // March the solved arc and check it clears terrain — 12 samples is plenty
  // for a 1s flight. Cheap: no allocation, getHeight is a heightmap read.
  private pathClear(vel: THREE.Vector3): boolean {
    const muzzle = this.pos.y + 1.0;
    const g = Math.abs(GRAVITY);
    const tEnd = Math.min(1.5, 2 * vel.y / g + 0.3); // up-and-down time + margin
    for (let i = 1; i <= 12; i++) {
      const t = (i / 12) * tEnd;
      const x = this.pos.x + vel.x * t;
      const z = this.pos.z + vel.z * t;
      const y = muzzle + vel.y * t - 0.5 * g * t * t;
      if (y < this._terrain.getHeight(x, z) + 0.3) return false; // arc clips terrain
    }
    return true;
  }

  private fireBolt(vel: THREE.Vector3): void {
    const mesh = new THREE.Mesh(boltGeo(), boltMat());
    const pos = this.pos.clone();
    pos.y += 1.0;
    mesh.position.copy(pos);
    // Hot halo — the bolt reads at range even when the sphere is subpixel
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xffaa44, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.setScalar(1.6);
    glow.position.copy(pos);
    this.scene.add(mesh, glow);
    this.bolts.push({
      mesh, glow, pos,
      prevPos: pos.clone(),
      radius: 1.5, // generous — clipping a 60m/s shell mid-air is a skill shot
      vel: vel.clone(),
      life: 10.0, // lobbed shells are slow arks — long fuse so a shot fired
      // at range actually lands instead of fizzing mid-air
      trailAcc: 0,
    });
  }

  /** Cooked mid-air by a player shell — same cleanup as a landed bolt, no callbacks. */
  detonateBolt(i: number): void {
    const b = this.bolts[i];
    if (!b) return;
    this.scene.remove(b.mesh, b.glow);
    (b.glow.material as THREE.SpriteMaterial).dispose();
    this.bolts.splice(i, 1);
  }

  private updateBolts(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.vel.y += GRAVITY * dt;
      b.prevPos.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      b.glow.position.copy(b.pos);
      // Stretch along velocity — a lobbed streak, not a marble
      b.mesh.scale.set(1, 1, 1 + b.vel.length() * 0.05);
      _v.copy(b.vel).normalize();
      b.mesh.lookAt(_v.add(b.pos));

      // Ember trail — dots that shrink out behind the bolt
      b.trailAcc += dt;
      while (b.trailAcc > 0.03) {
        b.trailAcc -= 0.03;
        const dot = new THREE.Mesh(boltGeo(), trailMat());
        dot.scale.setScalar(0.6);
        dot.position.copy(b.pos);
        this.scene.add(dot);
        this.trailDots.push({ mesh: dot, life: 0.35, maxLife: 0.35 });
      }

      const hitPlayer = b.pos.distanceToSquared(playerPos) < 1.7; // ~1.3m
      const hitGround = b.pos.y < terrain.getHeight(b.pos.x, b.pos.z);
      if (hitPlayer) {
        this.scene.remove(b.mesh, b.glow);
        (b.glow.material as THREE.SpriteMaterial).dispose();
        this.bolts.splice(i, 1);
        this.onBoltHit?.(this);
      } else if (hitGround || b.life <= 0) {
        this.scene.remove(b.mesh, b.glow);
        (b.glow.material as THREE.SpriteMaterial).dispose();
        this.bolts.splice(i, 1);
        if (hitGround) this.onBoltLand?.(b.pos);
      }
    }

    // Trail dots shrink to nothing
    for (let i = this.trailDots.length - 1; i >= 0; i--) {
      const d = this.trailDots[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.trailDots.splice(i, 1);
        continue;
      }
      d.mesh.scale.setScalar(0.6 * (d.life / d.maxLife));
    }
  }

  /** Planted = armored (half damage), airborne = vulnerable (triple — the
   *  airshot window is the skill check, make it pay). */
  takeDamage(damage: number): boolean {
    this.health -= damage * (this.planted ? 0.5 : 3.0);
    this.flashTimer = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * (this.planted ? 0.15 : 1.0)); // planted = anchored
    if (this.planted && this.vel.y > 4) this.planted = false; // big blast pops it loose
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * (this.planted ? 0.15 : 1.0));
    if (this.planted && this.vel.y > 4) this.planted = false;
  }

  dispose(): void {
    freeSlots('turretter', this);
    for (const b of this.bolts) {
      this.scene.remove(b.mesh, b.glow);
      (b.glow.material as THREE.SpriteMaterial).dispose();
    }
    this.bolts.length = 0;
    for (const d of this.trailDots) this.scene.remove(d.mesh);
    this.trailDots.length = 0;
    this.foot.dispose();
  }
}
