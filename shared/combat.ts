/**

 * Shared combat math — damage falloff, wake-proxy hit radius, and the

 * hit-claim validation the server runs against client-reported hits.

 *

 * Both sides must use these: the client predicts with them, the server

 * enforces with them. Divergence here is exactly the class of bug that

 * already desynced splash falloff once.

 */



import { getWeaponStats } from './weapons.js';
import { dhypot3 } from './dmath.ts';

import { GRAVITY } from './movement.js';

import { segSolidHit } from './solidWorld.js';

import type { StructureCollider } from './ballSim.js';

import { classCapsule } from './botClasses.js';

const ARC_STEP_S = 1 / 120;



export interface Vec3Like {

  x: number;

  y: number;

  z: number;

}



export function aoeFalloff(dist: number, radius: number): number {

  if (radius <= 0 || dist >= radius) {return 0;}

  return 1 - dist / radius;

}



/** Banded splash falloff: three equal-width rings inside the blast

 *  radius pay 75% / 50% / 25% of the base amount — a shell lands hard or

 *  glances, there's no smooth gradient to exploit. Knockback stays on

 *  linear aoeFalloff so push feel is unchanged. */

export const AOE_BAND_SCALES = [0.75, 0.5, 0.25] as const;

/** Global splash dial — every band scales by this. 1.0 for now. */

export const AOE_DAMAGE_MULT = 1;



export function aoeBandScale(dist: number, radius: number, scales: readonly number[] = AOE_BAND_SCALES): number {

  if (radius <= 0 || dist >= radius) {return 0;}

  return scales[Math.min(scales.length - 1, Math.floor((dist / radius) * scales.length))]! * AOE_DAMAGE_MULT;

}



/** Banded falloff applied to an already-resolved amount — used by both the

 *  client's predicted splash and the server's authoritative pass. The

 *  amount is normally the weapon's directDamage (splash is a fraction of

 *  the direct hit), so there is no separate aoe damage stat to tune. */

export function aoeDamage(amount: number, dist: number, radius: number, scales?: readonly number[]): number {

  return Math.round(amount * aoeBandScale(dist, radius, scales));

}



/** Global knockback dial — applied at the call sites, not inside

 *  aoeImpulse, so the falloff math stays pure/testable. 3.0 sent rocket

 *  jumps into orbit (and Slam stacked power on top → ~300 m/s launches);

 *  pulled back to 1.0 — keep the constant as the single tuning point. */

export const KNOCKBACK_SCALE = 1;



/** Ceiling on a single blast's impulse magnitude — blasts scale their

 *  shove down rather than being truncated, so no point-blank pop can

 *  launch a victim to absurd velocity. 40 m/s still makes real rocket

 *  jumps (≈5m apex on the up component) while bounding the worst case. */

export const BLAST_IMPULSE_MAX = 30;



/** Ceiling on self-splash damage from your own blast — a feet-shot

 *  disc-jump costs real health so launching is a resource spend, not

 *  a free ride; distance falloff applies below the cap as usual. */

export const SELF_SPLASH_MAX = 30;



export function aoeImpulse(force: number, dist: number, radius: number): number {

  return force * aoeFalloff(dist, radius);

}



/** T1's odd-but-canonical knockback curve (floodyberry part 4): the

 *  impulse envelope is `dist/d - dist/radius` where `d` is the surface

 *  distance clamped to 1m. Power RAMPS UP over the smallest hitbox

 *  dimension before falling off — a feet blast from a standstill is

 *  weaker than the same blast caught a meter out mid-air, which is the

 *  quirk disc-jumping lives on. `minbox` is the victim's smallest hitbox

 *  dimension (2·capsule radius: light 1.0 = T1's own). Reach extends to

 *  surface distance = radius — i.e. ~minbox past the center-distance rim. */

export function aoeImpulseT1(force: number, dist: number, radius: number, minbox: number): number {

  if (radius <= 0) {return 0;}

  const d = Math.max(dist - minbox, 1);

  if (d > radius) {return 0;}

  // The raw curve overshoots ~2× at the hitbox rim (its quirk is a

  // position-dependent *shape*, not a global boost) — normalize by the

  // peak power so `force` still means "max impulse", then return raw

  // shape × force. Peak sits at dist = minbox+1 where d is still 1:

  // power = (minbox+1)·(1 − 1/radius).

  const peak = (minbox + 1) * (1 - 1 / radius);

  return force * ((dist / d - dist / radius) / peak);

}



/** Victim hitbox min-dimension for aoeImpulseT1 — capsule width and depth

 *  are both 2·radius and always smaller than the height. */

export function t1Minbox(cls?: string): number {

  return 2 * classCapsule(cls).radius;

}



/** aoeImpulseT1 from positions — T1 measures blast→hitbox-center, not

 *  blast→feet, and the center distance is what puts a feet blast near

 *  the ramp's peak instead of in the point-blank dead zone. `targetPos`

 *  is the entity's networked (eye) position, same frame

 *  pointToCapsuleDistance uses. */

export function aoeImpulseT1At(

  force: number, blastPos: Vec3Like, targetPos: Vec3Like, radius: number, cls?: string,

): number {

  const cap = classCapsule(cls);

  const dx = targetPos.x - blastPos.x;

  const dy = (targetPos.y + cap.centerOff) - blastPos.y;

  const dz = targetPos.z - blastPos.z;

  return aoeImpulseT1(force, dhypot3(dx, dy, dz), radius, 2 * cap.radius);

}



export function aoeDamageAt(dist: number, weaponType: number | undefined): number {

  const s = getWeaponStats(weaponType);

  return aoeDamage(s.directDamage || s.aoeDamage, dist, s.aoeRadius, s.aoeScales);

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

  // hitGrow 0 = instantly full radius (beams, instant proxies) - the
  // raw division would turn a 0/0 airtime into NaN and poison the hit.
  const t = s.hitGrow > 0 ? Math.min(Math.max(airtime / s.hitGrow, 0), 1) : 1;

  return s.hitMax * t;

}



/** Lightning beam ramp-down: consecutive ticks on the same target step

 *  4 → 3 → 2 (halved from 8→6→4 — ~45 dps sustained, the pop bank is the

 *  damage, not the beam), floor reached at tick 10 (~0.5s of hold at 20

 *  ticks/s). Resets after a miss window or a target switch. `n` is the

 *  1-based tick count. */

export const LG_TICK_BASE = 4;

export function lgTickDamage(n: number): number {

  if (n <= 4) {return 4;}
if (n <= 9) {return 3;}
return 2;

}



/** Gap after which a beam's ramp resets — misses within the window keep

 *  the count. Sized off the 50ms tick so brief tracking errors forgive. */

export const LG_RAMP_WINDOW_S = 0.3;



/** Pop-charge economy — shared so the server banks/detonates the same

 *  numbers the client predicts. The victim's withheld tick damage

 *  (LG_TICK_BASE − stepped tick) banks at MULT ×, caps at DMG_CAP, and drains at

 *  DRAIN/s once the beam leaves them. */

export const LG_POP_DMG_CAP = 320;

export const LG_POP_CHARGE_MULT = 2;

export const LG_CHARGE_DRAIN_S = 400; // 800 emptied a full bank in 0.4s — the pop only worked indoors; half that keeps the swap-and-pop window real in open terrain

export const LG_POP_RADIUS_MAX = 14;

export const LG_POP_RADIUS_MIN = 3;



/** Beam reach + the chain-fork fork range/damage scale — shared so the

 *  server's beam trace pays the same set the client predicts. */

export const LG_RANGE = 55;

export const LG_CHAIN_RANGE = 9;

export const LG_CHAIN_DMG_SCALE = 0.5;
// Terrain bounce — the bolt grounds, then arcs to the nearest enemy
// within LG_BOUNCE_RANGE of the contact. Half damage up to the NEAR
// range, quarter past it. Client prediction and the server's
// beamSweepRay share these; a bounce only happens when TERRAIN is the
// first occluder (walls still stop it).
export const LG_BOUNCE_RANGE = 8;
export const LG_BOUNCE_NEAR = 4;
export const LG_BOUNCE_DMG_SCALE = 0.5;
export const LG_BOUNCE_FAR_DMG_SCALE = 0.25;

/** Bounce-leg damage scale by contact-to-victim distance. */
export function lgBounceDmgScale(dist: number): number {
  return dist <= LG_BOUNCE_NEAR ? LG_BOUNCE_DMG_SCALE : LG_BOUNCE_FAR_DMG_SCALE;
}



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

  /** Client-generated nonce from the spawn claim — claims can name the

   *  shell before (or instead of) the server-minted id echo. */

  clientShotId?: string;

}



export type HitClaimVerdict =

  | { ok: true; airtime: number }

  | { ok: false; reason: string };



/**

 * Distance from a point to the player capsule whose networked position is

 * `eyePos` (feet + eyeHeight, per armor class). Cylinder segment ±half

 * around the capsule center, spheres at the caps. `cls` picks the body's

 * size — a 2.5m heavy head is a different target than a 1.8m light.

 */

export function pointToCapsuleDistance(point: Vec3Like, eyePos: Vec3Like, cls?: string): number {

  const cap = classCapsule(cls);

  const centerY = eyePos.y + cap.centerOff;

  const dy = Math.max(0, Math.abs(point.y - centerY) - cap.half);

  const dx = point.x - eyePos.x;

  const dz = point.z - eyePos.z;

  return (dx * dx + dy * dy + dz * dz) ** 0.5;

}



// Slack allowances — the client's hit position is an end-of-frame sample and

// the target's position is whatever the server last saw, so these cover

// interpolation lag, tick quantization, and velocity inheritance. They are

// anti-cheat tolerances, not correctness bounds: tight enough to reject a

// forged kill across the map, loose enough to never reject an honest hit.

const TARGET_SLACK = 3;

const AIRTIME_SLACK_S = 0.5;

const REACH_MARGIN_M = 15;

const INHERITANCE_MARGIN = 0.6;

function arcBlockedAt(

  projectile: TrackedProjectile, g: number, airtime: number,

  solids: readonly StructureCollider[], passTeam?: string,

): number | null {

  const steps = Math.max(4, Math.min(240, Math.ceil(airtime / ARC_STEP_S)));

  const dt = airtime / steps;

  const v = Object.assign({}, projectile.velocity);

  let px = projectile.origin.x, py = projectile.origin.y, pz = projectile.origin.z;

  for (let i = 1; i <= steps; i += 1) {

    v.y += g * dt;

    const nx = px + v.x * dt;

    const ny = py + v.y * dt;

    const nz = pz + v.z * dt;

    const t = i * dt;

    if (t > 0.03) { // muzzle grace — a spawn point may hug a doorway lip

      // Terminal-step grace: a shell that honestly detonates ON a face

      // lands its final segment on that face — that is the impact the

      // claim describes, not a wall flown through. Only a face hit

      // BEFORE the last step means the arc can't honestly reach the end.

      if (i < steps && segSolidHit({ x: px, y: py, z: pz }, { x: nx, y: ny, z: nz }, solids, undefined, passTeam)) {return t;}

    }

    px = nx; py = ny; pz = nz;

  }

  return null;

}





/** Max legal reach for a claimed airtime: ballistic v·t + ½·|g|·t², plus

 *  ray-burst range once the discharge delay has passed (remote railgun

 *  teleports its beam forward — that range is legal reach). */

function flightReach(stats: ReturnType<typeof getWeaponStats>, speed: number, airtime: number): number {

  const rayReach = (stats.rayRange !== undefined && stats.rayDelay !== undefined && airtime >= stats.rayDelay)

    ? stats.rayRange : 0;

  const gMag = stats.gravity ? Math.abs(GRAVITY) : 0;

  return speed * airtime + 0.5 * gMag * airtime * airtime + rayReach + REACH_MARGIN_M;

}

 // max |shooterVel| fraction a projectile can inherit



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

  /** Shooter's team — team-filtered solids (shield gates) don't block

   *  a matching shell's claimed flight. */

  shooterTeam?: string;

}): HitClaimVerdict {

  const { projectile, endPos, shooterVel, now } = args;

  let { airtime } = args;

  const stats = getWeaponStats(projectile.weaponType);



  if (!Number.isFinite(airtime) || airtime < 0) {

    return { ok: false, reason: 'bad airtime' };

  }

  // NaN position components pass every distance comparison below

  // (NaN > x is always false) — a non-finite end point would otherwise

  // sail through reach and target-proximity checks into an accepted hit.

  if (!Number.isFinite(endPos.x + endPos.y + endPos.z)) {

    return { ok: false, reason: 'non-finite end position' };

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

  const speed = dhypot3(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z)

    + dhypot3(shooterVel.x, shooterVel.y, shooterVel.z) * INHERITANCE_MARGIN;

  const maxReach = flightReach(stats, speed, airtime);

  const dx = endPos.x - projectile.origin.x;

  const dy = endPos.y - projectile.origin.y;

  const dz = endPos.z - projectile.origin.z;

  const claimedReach = (dx * dx + dy * dy + dz * dz) ** 0.5;

  if (claimedReach > maxReach) {

    return { ok: false, reason: `end ${claimedReach.toFixed(1)}m beyond reach ${maxReach.toFixed(1)}m` };

  }



  // Wall occlusion: sample the ballistic arc — a shell that would have

  // struck a face before its claimed end can't honestly get there.

  if (args.solids?.length) {

    const blockedAt = arcBlockedAt(projectile, stats.gravity ? GRAVITY : 0, airtime, args.solids, args.shooterTeam);

    if (blockedAt !== null) {

      return { ok: false, reason: `flight blocked by structure at ~${blockedAt.toFixed(2)}s` };

    }

  }



  return { ok: true, airtime };

}



/** March the ballistic arc with the SAME semi-implicit Euler the live

 *  sims step (projSim.ts: vel.y += g·dt then pos += vel·dt), not the

 *  analytic v·t+½g·t² — the analytic path diverges from the sim by

 *  ½·g·T·dt·(steps), up to a metre on a long lob, which rejected honest

 *  wall-grazing detonations as "flight blocked". 1/120s steps bound the

 *  divergence below any wall thickness. */



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

  /** Shooter's team — gate solids matching it don't occlude the claim. */

  shooterTeam?: string;

  /** Target armor class — the capsule a heavy presents is taller. */

  targetClass?: string;

}): HitClaimVerdict {

  const { projectile, hitPos, targetPos, shooterVel, now, airtime } = args;

  const flight = checkFlightLegality({ projectile, endPos: hitPos, airtime, shooterVel, now, solids: args.solids, shooterTeam: args.shooterTeam });

  if (!flight.ok) {return flight;}



  // Target proximity: hitPos must be within the legal hit radius at that

  // airtime (core body + grown wake) of the target's capsule.

  const stats = getWeaponStats(projectile.weaponType);

  const legalRadius = Math.max(stats.bodyRadius, hitRadiusAt(projectile.weaponType, flight.airtime));

  if (!Number.isFinite(targetPos.x + targetPos.y + targetPos.z)) {

    return { ok: false, reason: 'non-finite target position' };

  }

  const dist = pointToCapsuleDistance(hitPos, targetPos, args.targetClass);

  const bodyRadius = classCapsule(args.targetClass).radius;

  if (dist > bodyRadius + legalRadius + TARGET_SLACK) {

    return { ok: false, reason: `target ${dist.toFixed(1)}m outside legal radius ${(bodyRadius + legalRadius).toFixed(1)}m` };

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

  /** Shooter's team — gate solids matching it don't occlude the claim. */

  shooterTeam?: string;

}): HitClaimVerdict {

  const { projectile, blastPos, shooterVel, now, airtime } = args;

  return checkFlightLegality({ projectile, endPos: blastPos, airtime, shooterVel, now, solids: args.solids, shooterTeam: args.shooterTeam });

}

