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
  return (weaponType === WeaponType.Rocket || weaponType === WeaponType.Disc)
    ? DIRECT_HIT_AOE_BONUS
    : 1;
}

import { WeaponType, type WeaponStats, WEAPONS } from './weaponTable.js';
export { WeaponType, WEAPONS } from './weaponTable.js';
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
  Math.max(...Object.values(WEAPONS).map(w => w.directDamage + w.aoeDamage)) * 1.4);

export function getWeaponStats(weaponType: number | undefined): WeaponStats {
  return WEAPONS[weaponType ?? WeaponType.Rocket] ?? WEAPONS[WeaponType.Rocket]!;
}

/** Legal fire cadence per primary/sidearm (s between shots) — the same
 *  numbers the client trigger enforces. Server bots gate on this so a
 *  drawn weapon can't out-cadence a human with the same gun (a mortar
 *  brain at 0.45s cadence would otherwise out-shoot a player's 2.0s). */
export const WEAPON_FIRE_INTERVAL_S: Partial<Record<WeaponType, number>> = {
  [WeaponType.Rocket]: 0.8,
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
  [WeaponType.RocketLauncher]: 0.85,
  [WeaponType.Pistol]: 0.22,
  [WeaponType.Revolver]: 0.6,
  [WeaponType.Sticky]: 0.8,
  [WeaponType.PlasmaGun]: 0.13,
  [WeaponType.Sprinkler]: 0.11,
  [WeaponType.Melee]: 0.5,
};
