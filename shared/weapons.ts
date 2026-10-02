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

export const AOE_VFX_SCALE = 0.8;

/** Canonical launchers (Bolt + Disc) bloom their blast on a direct hit:
 *  aoeRadius × this. Shared so client prediction and server validation
 *  compute the same reach — the client claims `directHit` on the aoeShot
 *  and the server re-derives the bonus from this table, never trusting a
 *  radius over the wire. */
export const DIRECT_HIT_AOE_BONUS = 1.5;
export function directHitAoeBonus(weaponType: number): number {
  return (weaponType === WeaponType.BoltLauncher || weaponType === WeaponType.Disc)
    ? DIRECT_HIT_AOE_BONUS
    : 1;
}

/** Skillshot ramp: the flagship launchers (and their belt cousins)
 *  pay direct damage × min(CAP, 1 + airtime) — +50% per 0.5s of flight,
 *  so a 1.5s lead is 2.5× and the 4× cap lands at 2.0s. Applies to the
 *  DIRECT line only: wakes and splash stay flat, otherwise near-misses
 *  would pay like hits. airtime is server-validated on the claim, so the
 *  same formula on both ends can't drift. */
export const AIRTIME_DMG_CAP = 4;
const AIRTIME_SCALED = new Set<number>([
  WeaponType.BoltLauncher, WeaponType.Disc, WeaponType.DiscPull, WeaponType.Javelin,
]);
export function scaledDirectDamage(weaponType: number, airtime?: number): number {
  const w = WEAPONS[weaponType];
  if (!w) return 0;
  if (!AIRTIME_SCALED.has(weaponType) || airtime === undefined || airtime <= 0) {
    return w.directDamage;
  }
  return w.directDamage * Math.min(AIRTIME_DMG_CAP, 1 + airtime);
}

import { WeaponType, type WeaponStats, WEAPONS } from './weaponTable.js';
export { WeaponType, WEAPONS, idSeed, jitteredTtl } from './weaponTable.js';
export type { WeaponStats } from './weaponTable.js';

export const REPAIR_RANGE = 14;        // beam reach (m)
export const REPAIR_HEAL_PER_TICK = 5; // per fire tick → ~50 hp/s at 0.1s rate
export const REPAIR_MIN_TICK_S = 0.07; // server: min seconds between claims per shooter+target
export const REPAIR_ARMOR_MULT = 2;    // armor cap = this × the deployable's base hp

// Armor-grenade economy — the plating the blast sprays is server-derived
// (claims carry no armor amount). Creatures wear it as overcap health up
// to ARMORNADE_OVERCAP × maxHealth — same trick as deployable armor.
export const ARMORNADE_ARMOR = 50;     // flat armor each blast grants
export const ARMORNADE_OVERCAP = 2;    // creature armor cap = this × maxHealth

/** Biggest legal single damage claim vs a creature: table max
 *  (direct+splash) with perk headroom. creatureHit/crawlerHit claims
 *  carry no weapon ref, so this is the widest honest ceiling — anything
 *  above it is doctored. */
export const MAX_HIT_CLAIM_DMG = Math.ceil(
  Math.max(...Object.entries(WEAPONS).map(([wt, w]) =>
    w.directDamage * (AIRTIME_SCALED.has(Number(wt)) ? AIRTIME_DMG_CAP : 1) + w.aoeDamage)) * 1.4);

export function getWeaponStats(weaponType: number | undefined): WeaponStats {
  return WEAPONS[weaponType ?? WeaponType.BoltLauncher] ?? WEAPONS[WeaponType.BoltLauncher]!;
}

/** Legal fire cadence per primary/sidearm (s between shots) — the same
 *  numbers the client trigger enforces. Server bots gate on this so a
 *  drawn weapon can't out-cadence a human with the same gun (a mortar
 *  brain at 0.45s cadence would otherwise out-shoot a player's 2.0s). */
export const WEAPON_FIRE_INTERVAL_S: Partial<Record<WeaponType, number>> = {
  [WeaponType.BoltLauncher]: 0.8,
  [WeaponType.Disc]: 1.0,
  [WeaponType.Chaingun]: 0.09,
  [WeaponType.Mortar]: 2.0,
  [WeaponType.GrenadeLauncher]: 0.7,
  [WeaponType.Flak]: 1.1,
  [WeaponType.PlasmaCannon]: 0.28,
  [WeaponType.Railgun]: 1.5,
  [WeaponType.Lightning]: 0.05,
  [WeaponType.Shotgun]: 0.7,
  [WeaponType.Cannon]: 0.55,
  [WeaponType.RocketLauncher]: 2.5,
  [WeaponType.Pistol]: 0.22,
  [WeaponType.Revolver]: 0.6,
  [WeaponType.Sticky]: 0.8,
  [WeaponType.PlasmaGun]: 0.13,
  [WeaponType.Sprinkler]: 0.11,
  [WeaponType.Melee]: 0.5,
  [WeaponType.MRVLauncher]: 2.4, // slower than the mortar — one trigger = a whole volley
};
