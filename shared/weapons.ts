/**
 * Shared weapon table — THE single source of truth for anything that
 * crosses the wire or affects gameplay outcomes on both sides.
 *
 * Client configs import rendering fields from here; server imports
 * damage/knockback/ballistics to validate claims. Never duplicate a
 * stat — that path already shipped a real bug (splash falloff desync).
 *
 * weaponType is the stable wire ID (binary frames carry it as u8).
 */

export enum WeaponType {
  Rocket = 0,
  Disc = 1,
  Grenade = 2, // thrown fuse bomb (F key) — distinct from the launcher
  Chaingun = 3,
  Mortar = 4,
  GrenadeLauncher = 5,
  Flak = 6,
  Plasma = 7,
  Slam = 8, // skill ground-slam — not a projectile, but lands as an AOE
}

export interface WeaponStats {
  /** Damage on direct hit (server `shot` handler) */
  directDamage: number;
  /** Splash damage at blast center */
  aoeDamage: number;
  /** Splash radius (m) — 0 = no splash */
  aoeRadius: number;
  /** Impulse magnitude at blast center (m/s) */
  knockbackForce: number;
  /** 'pull' = implosion toward center (disc) */
  forceMode: 'push' | 'pull';
  /** Muzzle speed (m/s) — before 50% player-velocity inheritance */
  speed: number;
  /** Ballistic gravity (m/s², negative) — 0 for flat trajectories */
  gravity: number;
  /** Core hitbox radius (m) — a hit inside this counts as direct */
  bodyRadius: number;
  /** Wake proxy hitbox floor (m) at spawn */
  hitMin: number;
  /** Wake proxy hitbox ceiling (m) once fully grown */
  hitMax: number;
  /** Seconds from spawn for the wake to reach hitMax */
  hitGrow: number;
  /** Fuse self-detonate time (s); 0/undefined = terrain/target contact only */
  maxLifetime?: number;
}

/** Explosion VFX dome = aoeRadius × this — damage always reaches a bit past
 *  the visual edge (covers the shock ring), and the two can never drift. */
export const AOE_VFX_SCALE = 0.8;

export const WEAPONS: Record<number, WeaponStats> = {
  [WeaponType.Rocket]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 8.0, // ~1.3× the VFX dome — damage reaches the ring's edge
    knockbackForce: 28.0,
    forceMode: 'push',
    speed: 120.0,
    gravity: -28.0,
    bodyRadius: 0.18,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
  },
  [WeaponType.Disc]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10.0, // slightly exceeds the 8m Implosion VFX — pull reaches everything it visibly sucks
    knockbackForce: 25.0,
    forceMode: 'pull',
    speed: 80.0,
    gravity: 0,
    bodyRadius: 0.5,
    hitMin: 0.3,
    hitMax: 8.0,
    hitGrow: 2.0,
  },
  [WeaponType.Grenade]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13.0,
    knockbackForce: 45.0,
    forceMode: 'push',
    speed: 40.0,
    gravity: -28.0,
    bodyRadius: 0.25,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
    maxLifetime: 2.0,
  },
  [WeaponType.Chaingun]: {
    directDamage: 5,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 250.0,
    gravity: 0,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 0.5, // tight proxy cap — slugs get a small wake, not the 8m shell drag
    hitGrow: 2.0,
  },
  [WeaponType.Mortar]: {
    directDamage: 80,
    aoeDamage: 40,
    aoeRadius: 18.0,
    knockbackForce: 55.0,
    forceMode: 'push',
    speed: 55.0,
    gravity: -28.0,
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — the big splash is the forgiving part, not the wake
    hitGrow: 2.0,
    maxLifetime: 6.0,
  },
  [WeaponType.GrenadeLauncher]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13.0,
    knockbackForce: 45.0,
    forceMode: 'push',
    speed: 55.0,
    gravity: -28.0,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — bouncing shells shouldn't drag a huge wake
    hitGrow: 2.0,
    maxLifetime: 2.5,
  },
  [WeaponType.Flak]: {
    directDamage: 9, // per shard — 9 shards ≈ 81 max
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 90.0,
    gravity: -28.0 * 0.6, // chunks sag a bit — not a laser
    bodyRadius: 0.12,
    hitMin: 0.0,
    hitMax: 2.0,
    hitGrow: 0.5,
    maxLifetime: 4.0,
  },
  [WeaponType.Plasma]: {
    directDamage: 35,
    aoeDamage: 12,
    aoeRadius: 5.5,
    knockbackForce: 20.0,
    forceMode: 'push',
    speed: 90.0,
    gravity: 0,
    bodyRadius: 0.2,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — the fat bolt is already generous
    hitGrow: 2.0,
  },
  [WeaponType.Slam]: {
    // Not a projectile — the Q-skill lands as a ground AOE. Ballistic
    // fields are inert; only aoe/knock stats are live.
    directDamage: 0,
    aoeDamage: 35,
    aoeRadius: 9.0,
    knockbackForce: 40.0,
    forceMode: 'push',
    speed: 0,
    gravity: 0,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
};

export function getWeaponStats(weaponType: number | undefined): WeaponStats {
  return WEAPONS[weaponType ?? WeaponType.Rocket] ?? WEAPONS[WeaponType.Rocket]!;
}
