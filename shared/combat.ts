/**
 * Shared combat math — damage falloff, wake-proxy hit radius, and the
 * hit-claim validation the server runs against client-reported hits.
 *
 * Both sides must use these: the client predicts with them, the server
 * enforces with them. Divergence here is exactly the class of bug that
 * already desynced splash falloff once.
 */

import { getWeaponStats } from './weapons.js';
import { GRAVITY } from './movement.js';
import { segSolidHit } from './solidWorld.js';
import type { StructureCollider } from './ballSim.js';
import {
  PLAYER_RADIUS,
  EYE_OFFSET,
  CAPSULE_CENTER_Y,
  CAPSULE_HALF_HEIGHT,
} from './constants.js';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function aoeFalloff(dist: number, radius: number): number {
  if (radius <= 0 || dist >= radius) return 0;
  return 1 - dist / radius;
}

/** Falloff applied to an already-resolved amount — used by both the client's
 *  predicted splash and the server's authoritative pass. */
export function aoeDamage(amount: number, dist: number, radius: number): number {
  return Math.round(amount * aoeFalloff(dist, radius));
}

/** Global knockback dial — applied at the call sites, not inside
 *  aoeImpulse, so the falloff math stays pure/testable. 3.0 sent rocket
 *  jumps into orbit (and Slam stacked power on top → ~300 m/s launches);
 *  pulled back to 1.0 — keep the constant as the single tuning point. */
export const KNOCKBACK_SCALE = 1.0;

/** Ceiling on a single blast's impulse magnitude — blasts scale their
 *  shove down rather than being truncated, so no point-blank pop can
 *  launch a victim to absurd velocity. 40 m/s still makes real rocket
 *  jumps (≈5m apex on the up component) while bounding the worst case. */
export const BLAST_IMPULSE_MAX = 30;

export function aoeImpulse(force: number, dist: number, radius: number): number {
  return force * aoeFalloff(dist, radius);
}

export function aoeDamageAt(dist: number, weaponType: number | undefined): number {
  const s = getWeaponStats(weaponType);
  return aoeDamage(s.aoeDamage, dist, s.aoeRadius);
}

export function aoeImpulseAt(dist: number, weaponType: number | undefined): number {
  const s = getWeaponStats(weaponType);
  return aoeImpulse(s.knockbackForce, dist, s.aoeRadius);
}

/**
 * Wake-proxy hit radius at a given airtime — mirrors the client's
 * Projectile.hitRadius getter exactly (hitMin is only a descriptive floor;
 * the formula interpolates 0 → hitMax over hitGrow from spawn, no grace).
 */
export function hitRadiusAt(weaponType: number | undefined, airtime: number): number {
  const s = getWeaponStats(weaponType);
  const t = Math.min(Math.max(airtime / s.hitGrow, 0), 1);
  return s.hitMax * t;
}

/** Lightning beam ramp-down: consecutive ticks on the same target step
 *  8 → 6 → 4, floor reached at tick 10 (~0.5s of hold at 20 ticks/s).
 *  The beam stays lethal on first contact and bleeds off on a sustained
 *  hold — the kill-fork pop is the payoff, not a free bonus. Resets after
 *  a miss window or a target switch. `n` is the 1-based tick count. */
export function lgTickDamage(n: number): number {
  return n <= 4 ? 8 : n <= 9 ? 6 : 4;
}

/** Gap after which a beam's ramp resets — misses within the window keep
 *  the count. Sized off the 50ms tick so brief tracking errors forgive. */
export const LG_RAMP_WINDOW_S = 0.3;

/** Pop-charge economy — shared so the server banks/detonates the same
 *  numbers the client predicts. The victim's withheld tick damage
 *  (8 − stepped tick) banks at MULT ×, caps at DMG_CAP, and drains at
 *  DRAIN/s once the beam leaves them. */
export const LG_POP_DMG_CAP = 320;
export const LG_POP_CHARGE_MULT = 2;
export const LG_CHARGE_DRAIN_S = 800;
export const LG_POP_RADIUS_MAX = 14;
export const LG_POP_RADIUS_MIN = 3;

/** Decayed banked charge on a victim — both ends run the same lazy drain.
 *  `chargeT` is in the caller's timebase (server: epoch seconds). */
export function lgChargeAt(acc: number, chargeT: number, nowS: number): number {
  return Math.max(0, acc - LG_CHARGE_DRAIN_S * Math.max(0, nowS - chargeT));
}

/** What the server knows about a live projectile. */
export interface TrackedProjectile {
  ownerId: string;
  weaponType: number;
  origin: Vec3Like;
  velocity: Vec3Like;
  /** Server timestamp (ms) when the spawn claim was accepted */
  spawnAt: number;
}

export type HitClaimVerdict =
  | { ok: true; airtime: number }
  | { ok: false; reason: string };

/**
 * Distance from a point to the player capsule whose networked position is
 * `eyePos` (feet + EYE_OFFSET). Cylinder segment ±CAPSULE_HALF_HEIGHT around
 * the capsule center, spheres at the caps.
 */
export function pointToCapsuleDistance(point: Vec3Like, eyePos: Vec3Like): number {
  const centerY = eyePos.y - EYE_OFFSET + CAPSULE_CENTER_Y;
  const dy = Math.max(0, Math.abs(point.y - centerY) - CAPSULE_HALF_HEIGHT);
  const dx = point.x - eyePos.x;
  const dz = point.z - eyePos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Slack allowances — the client's hit position is an end-of-frame sample and
// the target's position is whatever the server last saw, so these cover
// interpolation lag, tick quantization, and velocity inheritance. They are
// anti-cheat tolerances, not correctness bounds: tight enough to reject a
// forged kill across the map, loose enough to never reject an honest hit.
const TARGET_SLACK = 3.0;
const AIRTIME_SLACK_S = 0.5;
const REACH_MARGIN_M = 15.0;
const INHERITANCE_MARGIN = 0.6; // max |shooterVel| fraction a projectile can inherit

// Shared legality core: claimed airtime and the point where the flight ended
// must be consistent with what the tracked projectile could physically reach.
// Hit claims additionally check target proximity (below); AOE blasts end the
// flight wherever the shooter claims, so blast position IS the flight end.
function checkFlightLegality(args: {
  projectile: TrackedProjectile;
  endPos: Vec3Like;
  airtime: number;
  shooterVel: Vec3Like;
  now: number;
  /** Map-structure colliders — when present, the claimed flight must
   *  not pass through a wall to reach its end point. */
  solids?: readonly StructureCollider[];
}): HitClaimVerdict {
  const { projectile, endPos, shooterVel, now } = args;
  let { airtime } = args;
  const stats = getWeaponStats(projectile.weaponType);

  if (!Number.isFinite(airtime) || airtime < 0) {
    return { ok: false, reason: 'bad airtime' };
  }

  // Airtime can't exceed wall-clock age since the spawn claim.
  const elapsed = (now - projectile.spawnAt) / 1000;
  if (airtime > elapsed + AIRTIME_SLACK_S) {
    return { ok: false, reason: `airtime ${airtime.toFixed(2)}s exceeds age ${elapsed.toFixed(2)}s` };
  }
  if (stats.maxLifetime && airtime > stats.maxLifetime + AIRTIME_SLACK_S) {
    return { ok: false, reason: 'airtime exceeds fuse lifetime' };
  }
  // Clamp rather than reject small under-reports — reach/wake checks use it.
  airtime = Math.min(airtime, elapsed + AIRTIME_SLACK_S);

  // Trajectory reach: |origin→endPos| can't outrun v·t + ½·|g|·t² plus
  // inherited shooter speed and a margin for the end-of-frame sample error.
  const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z)
    + Math.hypot(shooterVel.x, shooterVel.y, shooterVel.z) * INHERITANCE_MARGIN;
  // Ray-burst weapons (remote railgun) teleport forward along their velocity
  // once they pass the discharge delay — the beam's range is legal reach.
  const rayReach = (stats.rayRange !== undefined && stats.rayDelay !== undefined && airtime >= stats.rayDelay)
    ? stats.rayRange : 0;
  const gMag = stats.gravity ? Math.abs(GRAVITY) : 0;
  const maxReach = speed * airtime + 0.5 * gMag * airtime * airtime + rayReach + REACH_MARGIN_M;
  const dx = endPos.x - projectile.origin.x;
  const dy = endPos.y - projectile.origin.y;
  const dz = endPos.z - projectile.origin.z;
  const claimedReach = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (claimedReach > maxReach) {
    return { ok: false, reason: `end ${claimedReach.toFixed(1)}m beyond reach ${maxReach.toFixed(1)}m` };
  }

  // Wall occlusion: sample the ballistic arc — a shell that would have
  // struck a face before its claimed end can't honestly get there.
  if (args.solids?.length) {
    const STEPS = 16;
    const g = stats.gravity ? GRAVITY : 0;
    let px = projectile.origin.x, py = projectile.origin.y, pz = projectile.origin.z;
    for (let i = 1; i <= STEPS; i++) {
      const t = (airtime * i) / STEPS;
      const nx = projectile.origin.x + projectile.velocity.x * t;
      const ny = projectile.origin.y + projectile.velocity.y * t + 0.5 * g * t * t;
      const nz = projectile.origin.z + projectile.velocity.z * t;
      if (t > 0.03) { // muzzle grace — a spawn point may hug a doorway lip
        if (segSolidHit({ x: px, y: py, z: pz }, { x: nx, y: ny, z: nz }, args.solids)) {
          return { ok: false, reason: `flight blocked by structure at ~${t.toFixed(2)}s` };
        }
      }
      px = nx; py = ny; pz = nz;
    }
  }

  return { ok: true, airtime };
}

export function validateHitClaim(args: {
  projectile: TrackedProjectile;
  hitPos: Vec3Like;
  targetPos: Vec3Like;
  /** Client-reported projectile age at the moment of impact (seconds) */
  airtime: number;
  /** Shooter's last-known velocity (for the inherited-velocity allowance) */
  shooterVel: Vec3Like;
  now: number;
  solids?: readonly StructureCollider[];
}): HitClaimVerdict {
  const { projectile, hitPos, targetPos, shooterVel, now, airtime } = args;
  const flight = checkFlightLegality({ projectile, endPos: hitPos, airtime, shooterVel, now, solids: args.solids });
  if (!flight.ok) return flight;

  // Target proximity: hitPos must be within the legal hit radius at that
  // airtime (core body + grown wake) of the target's capsule.
  const stats = getWeaponStats(projectile.weaponType);
  const legalRadius = Math.max(stats.bodyRadius, hitRadiusAt(projectile.weaponType, flight.airtime));
  const dist = pointToCapsuleDistance(hitPos, targetPos);
  if (dist > PLAYER_RADIUS + legalRadius + TARGET_SLACK) {
    return { ok: false, reason: `target ${dist.toFixed(1)}m outside legal radius ${(PLAYER_RADIUS + legalRadius).toFixed(1)}m` };
  }

  return flight;
}

/**
 * AOE blast claims end a tracked projectile's flight wherever the shooter
 * says it detonated — the legality check is trajectory + airtime only.
 * Without this, a client could detonate anywhere within 200m of itself.
 */
export function validateAoeClaim(args: {
  projectile: TrackedProjectile;
  blastPos: Vec3Like;
  airtime: number;
  shooterVel: Vec3Like;
  now: number;
  solids?: readonly StructureCollider[];
}): HitClaimVerdict {
  const { projectile, blastPos, shooterVel, now, airtime } = args;
  return checkFlightLegality({ projectile, endPos: blastPos, airtime, shooterVel, now, solids: args.solids });
}
