import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nextTargetId } from './targetIds.js';

import {
  TURRET_RADIUS, TURRET_HEALTH,
  TURRET_RANGE, TURRET_RELAUNCH, TURRET_MIN_DWELL,
  TURRET_REFIRE, TURRET_DEPRESS,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { TerrainFoot } from '../effects/terrainFoot.js';
import { allocSlots, freeSlots, getSwarm, getShadows, type SwarmPart } from './swarms.js';
import { type Bolt, spawnBolt, detonateBolt as detBolt, updateBolts as stepBolts, disposeBolts } from './turretBolts.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import type { RibbonTrail } from '../effects/RibbonTrail.js';
import { updateAir as balAir, seat as balSeat, launch as balLaunch, solveBolt as balSolve, pathClear as balPath } from './turretBallistics.js';
export type { Bolt } from './turretBolts.js';

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
const FOOT_RIM = 1.28; // base cone bottom radius (1.3) minus a hair — tucks in

// Shared geometries
let _baseGeo: THREE.BufferGeometry | null = null;
function baseGeo(): THREE.BufferGeometry {
  if (!_baseGeo) {
    const hull = new THREE.CylinderGeometry(0.9, 1.3, 0.8, 8); // flared footing
    // Anchor skirt: the bottom face extruded down and pinched — reads as a
    // dirt-stake when the turret's airborne; buried out of sight when planted.
    const skirt = new THREE.CylinderGeometry(1.3, 0.65, 0.3, 8);
    skirt.translate(0, -0.55, 0); // hangs off the hull's bottom face (y=-0.4)
    _baseGeo = mergeGeometries([hull, skirt]);
  }
  return _baseGeo;
}
let _domeGeo: THREE.SphereGeometry | null = null;
function domeGeo(): THREE.SphereGeometry {
  // Full sphere, not a hemisphere cap — the ball IS the gimbal housing,
  // so the barrel stays visibly socketed at any depression angle.
  if (!_domeGeo) {_domeGeo = new THREE.SphereGeometry(0.7, 10, 8);}
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
let _eyeGeo: THREE.PlaneGeometry | null = null;
function eyeGeo(): THREE.PlaneGeometry {
  if (!_eyeGeo) {_eyeGeo = new THREE.PlaneGeometry(0.5, 0.5);}
  return _eyeGeo;
}

// Shared materials — per-turret variations ride on instanceColor instead.
let _baseMat: THREE.MeshLambertMaterial | null = null;
function baseMat(): THREE.MeshLambertMaterial {
  if (!_baseMat) { _baseMat = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF, emissive: 0x0A_0D_12 }); _baseMat.userData.__wearInt = 2.2; }
  return _baseMat;
}
let _domeMatS: THREE.MeshLambertMaterial | null = null;
function domeMatS(): THREE.MeshLambertMaterial {
  if (!_domeMatS) { _domeMatS = new THREE.MeshLambertMaterial({ color: 0xFF_FF_FF, emissive: 0x10_18_20 }); _domeMatS.userData.__wearInt = 2.2; }
  return _domeMatS;
}
let _eyeMat: THREE.MeshBasicMaterial | null = null;
function eyeMat(): THREE.MeshBasicMaterial {
  if (!_eyeMat) {_eyeMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });}
  return _eyeMat;
}
const PART_BASE = 0, PART_DOME = 1, PART_BARREL = 2, PART_EYE = 3;
const DOME_R = 0x4A / 255, DOME_G = 0x5F / 255, DOME_B = 0x73 / 255;
// Match the sentry's steel (0x4a5560) — the grunge shader modulates a few
// percent of albedo, so the bake reads flat below ~30% luminance.
const HULL_R = 0x4A / 255, HULL_G = 0x55 / 255, HULL_B = 0x60 / 255;

export function turretterParts(): SwarmPart[] {
  return [
    { geometry: baseGeo(), material: baseMat(), castShadow: true },
    { geometry: domeGeo(), material: domeMatS(), castShadow: true },
    { geometry: barrelGeo(), material: baseMat() },
    { geometry: eyeGeo(), material: eyeMat() },
  ];
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
  color = new THREE.Color(0x3A_4A_5A); // gunmetal
  scale = 1.2;

  // Swarm-slot handles — the turret renders through instanced parts, not a
  // scene-graph Group. bolts stay real meshes (counts are tiny); the ember
  // trail is one slot in the shared dot batch.
  swarmSlot = -1;
  shadowSlot = -1;

  scene: THREE.Scene; // public — turretBolts owns bolt meshes through it
  terrain: Terrain;   // public — turretBallistics reads heights through it
  rootQuat = new THREE.Quaternion(); // terrain tilt when planted; tumble when airborne
  private headYaw = 0;                       // turretHead yaw (world aim → tilted local frame)
  private headPitch = 0;
  // Live lobbed shells — public so combat can proximity-check them: a
  // player explosive clipping a bolt cooks it off mid-air (detonateBolt).
  readonly bolts: Bolt[] = [];
  /** Bolt ribbons past their bolt — turretBolts fades+frees them. */
  readonly deadRibbons: RibbonTrail[] = [];
  // Bolt ember trail — shared Points batch via turretBolts.ts (host-interface pattern).
  readonly trailFx: BallTrailDots;

  planted = false;                // false = airborne ballistic
  dwell = 0;                      // time since landing
  private refire = TURRET_REFIRE;   // first shot is immediate-ish
  private flashTimer = 0;
  meshYOffset = 0;                  // visual sink below gameplay pos (set by seat)
  foot!: TerrainFoot;               // rim→dirt wall, conformed in seat() — set unless swarm alloc fails

  /** Landing shockwave FX hook */
  onLanded?: (pos: THREE.Vector3) => void;
  /** Bolt hit the player — wire sendEnvironmentDamage in main. pos = impact. */
  onBoltHit?: (t: Turretter, pos: THREE.Vector3) => void;
  /** Bolt fizzled on terrain — dust/spark hook */
  onBoltLand?: (pos: THREE.Vector3) => void;
  /** Launch moment — dust kick hook */
  onLaunch?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.scene = scene;
    this.terrain = terrain;
    this.id = nextTargetId();
    // Uber = "siege engine": double tank, bigger chassis, and a THREE-BOLT
    // volley — a fanned spread that punishes a straight approach.
    this.uber = uber;
    this.maxHealth = uber ? TURRET_HEALTH * 2 : TURRET_HEALTH;
    this.health = this.maxHealth;
    this.radius = uber ? TURRET_RADIUS * 1.4 : TURRET_RADIUS;
    if (uber) {this.color.set(0x5A_3A_2A);} // rusted siege bronze

    this.trailFx = new BallTrailDots(scene, { sizeMul: 0.5 });
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.planted = true;

    if (!allocSlots('turretter', this)) { this.dead = true; return; }

    this.foot = new TerrainFoot(scene, FOOT_RIM);

    balSeat(this, terrain); // spawned planted — sit on the slope immediately
    this.writeInstances();
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.flashTimer > 0) {this.flashTimer -= dt;}

    stepBolts(this, this, dt, terrain, playerPos);

    if (this.planted) {
      this.dwell += dt;
      this.updatePlanted(dt, playerPos, playerVel);
    } else {
      balAir(this, dt, terrain);
    }

    this.writeInstances();
    getShadows()?.set(this, this.pos, this.radius * 1.15, 0.4);
  }

  // Compose root (pos + visual sink + tilt/tumble) then the turret-head
  // pivot (yaw+pitch inside that frame), writing each part's matrix.
  private writeInstances(): void {
    const swarm = getSwarm('turretter');
    if (!swarm || this.swarmSlot < 0) {return;}
    const slot = this.swarmSlot;

    _p.set(this.pos.x, this.pos.y + this.meshYOffset, this.pos.z);
    _root.compose(_p, this.rootQuat, _s.setScalar(1));

    // Head pivot at (0, 0.85, 0) in root space
    // Two-axis gimbal: YXZ = yaw the head first, then pitch about the
    // YAWED local X — XYZ would pitch about the un-rotated axis so the
    // barrel's elevation skews sideways as the head turns.
    _q.setFromEuler(_e.set(this.headPitch, this.headYaw, 0, 'YXZ'));
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

    // Muzzle = barrel tip: barrel local +z 1.275 (1.25 tube at 0.65 offset)
    // on the breech pivot at y 0.2 — bolts must leave THROUGH the tube.
    _local.compose(_v.set(0, 0.2, 1.28), _q.identity(), _s.setScalar(1));
    _world.multiplyMatrices(_head, _local);
    this.muzzleWorld.setFromMatrixPosition(_world);

    swarm.setColor(PART_BASE, slot, HULL_R, HULL_G, HULL_B);
    swarm.setColor(PART_BARREL, slot, HULL_R, HULL_G, HULL_B);
    // Damage flash and the mid-air "shoot me now" glow both ride the dome.
    const flash = this.flashTimer > 0;
    const hot = !this.planted;
    let domeR = DOME_R;
    let domeG = DOME_G;
    let domeB = DOME_B;
    if (flash) {domeR = 4; domeG = 4; domeB = 4;}
    else if (hot) {domeR *= 3; domeG *= 2;}
    swarm.setColor(PART_DOME, slot, domeR, domeG, domeB);
    swarm.setColor(PART_EYE, slot,
      hot ? 2 : 1, hot ? 1 : 0.53, hot ? 0.4 : 0.19);
  }

  private updatePlanted(dt: number, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = (dx * dx + dz * dz) ** 0.5;

    // Relaunch: far away AND past the dwell floor — the two conditions
    // together are what prevent ping-pong.
    if (dist > TURRET_RELAUNCH && this.dwell >= TURRET_MIN_DWELL) {
      balLaunch(this, playerPos, playerVel);
      return;
    }
    if (dist > TURRET_RANGE) {return;} // out of range — sit tight

    // Track the player — the head lives inside the slope-tilted base, so
    // transform the world-space aim into the base's local frame first;
    // otherwise yaw/pitch are off by the tilt amount.
    _dir.set(dx, playerPos.y - this.pos.y, dz);
    _q2.copy(this.rootQuat).invert();
    _dir.applyQuaternion(_q2);
    this.headYaw = Math.atan2(_dir.x, _dir.z);
    const hd = Math.hypot(_dir.x, _dir.z);
    // Pitch travel is asymmetric: a mortar arcs UP — full vertical, the
    // ball housing sockets it at any angle. Down binds almost flat:
    // ~5° below horizontal the muzzle is already kissing the hull rim.
    this.headPitch = Math.max(-Math.PI / 2, Math.min(TURRET_DEPRESS, -Math.atan2(_dir.y, hd)));

    this.refire -= dt;
    if (this.refire <= 0) {
      const sol = balSolve(this, playerPos, playerVel);
      // Blind zone = the SHOT's elevation, not the sightline: if the
      // solved launch would leave the tube below the mount's depression
      // limit, no aim can fix it — hop to a far-side spot at proper
      // engagement geometry instead of firing point-blank into the hull.
      const theta = sol ? Math.atan2(sol.y, Math.hypot(sol.x, sol.z)) : 0;
      if (sol && theta < -TURRET_DEPRESS) {
        if (this.dwell >= TURRET_MIN_DWELL) {
          _v.copy(this.pos).sub(playerPos);
          _v.y = 0;
          if (_v.lengthSq() < 1e-4) {_v.set(1, 0, 0);} // dead overhead — pick a side
          _v.normalize().multiplyScalar(TURRET_RELAUNCH * 0.5).add(playerPos);
          _v.y = this.pos.y; // launch() lands on terrain; this seeds the arc height
          balLaunch(this, _v);
          return;
        }
        this.refire = 0.4; // pinned in the blind zone — strain, don't fire
      } else if (sol && balPath(this, sol)) {
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
          balLaunch(this, playerPos, playerVel);
        } else {
          this.refire = 0.4; // retry soon — LOS may open
        }
      } else {
        this.refire = TURRET_REFIRE; // out of range — don't spam failed solves
      }
    }
  }

  private muzzleWorld = new THREE.Vector3();

  private fireBolt(vel: THREE.Vector3): void {
    spawnBolt(this, vel, this.muzzleWorld.lengthSq() > 0 ? this.muzzleWorld : undefined);
  }

  /** Cooked mid-air by a player shell — same cleanup as a landed bolt, no callbacks. */
  detonateBolt(i: number): void {
    detBolt(this, i);
  }



  /** Planted = armored (half damage), airborne = vulnerable (triple — the
   *  airshot window is the skill check, make it pay). */
  takeDamage(damage: number): boolean {
    this.health -= damage * (this.planted ? 0.5 : 3);
    this.flashTimer = 0.12;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force * (this.planted ? 0.15 : 1)); // planted = anchored
    if (this.planted && this.vel.y > 4) {this.planted = false;} // big blast pops it loose
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force * (this.planted ? 0.15 : 1));
    if (this.planted && this.vel.y > 4) {this.planted = false;}
  }

  dispose(): void {
    freeSlots('turretter', this);
    disposeBolts(this);
    this.foot.dispose();
  }
}
