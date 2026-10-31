// Weapon registry - THE slot table. Every loadout-slot weapon is one entry
// here; position in SLOT_DEFS is the wid (what loadout[]/weaponIndex/menus
// use), weaponType is the wire id the server and demo format speak.
//
// This file exists because slot space and wire space used to be kept in
// four separate parallel arrays (WEAPON_RATES, the fire-callback table,
// SLOT_WEAPONS, widToWeaponType) - a missing entry once made the sticky
// launcher silently fire rockets. Now the order is declared once and every
// consumer derives from it, so a weapon can't be half-wired.
//
// To add a weapon: shared/weapons.ts stats + ProjectileConfig + geo/sfx
// entries, then ONE def here. Nothing else aligns positionally.

import { WeaponType, LANCE_CADENCE_S, getWeaponStats } from '../../shared/weapons.js';
import type { ProjectileConfig } from './projectiles/types.js';
import { WEAPON_CONFIGS } from './projectiles/index.js';
import {
  BOLT_FIRE_RATE, DISC_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE,
  PLASMA_RATE, RAILGUN_RATE, LG_RATE, SHOTGUN_RATE, CANNON_RATE, RKT_RATE,
  PISTOL_RATE, REVOLVER_RATE, BLASTER_RATE, STICKY_RATE, PLASMAGUN_RATE, BOMBARD_RATE,
  SPRINKLER_RATE, SPRINKLER_SPREAD, REPAIR_RATE, MRV_RATE,
  FLAK_SHARDS, FLAK_SPREAD, SG_PELLETS, SG_SPREAD,
} from './core/config.js';

export type WeaponKind = 'projectile' | 'fan' | 'beam';

export interface WeaponDef {
  /** Wire id - shared/weapons.ts enum; what the server validates against. */
  readonly weaponType: WeaponType;
  /** Seconds between shots. */
  readonly rate: number;
  /** Ballistics + render config; also the label source for menus. */
  readonly config: ProjectileConfig;
  /** Viewmodel kick strength on fire (0 = no kick, e.g. beam). */
  readonly kick: number;
  /** Dispatch shape for the trigger:
   *  projectile = one spawn, fan = poisson pellet burst, beam = lightning. */
  readonly kind: WeaponKind;
  /** Fires continuously while the trigger is held (chaingun, LG). */
  readonly auto: boolean;
  /** Fan weapons only: pellet count + cone spread. */
  readonly pellets?: { readonly count: number; readonly spread: number };
  /** Projectile kind only: per-shot cone jitter (sprinkler - a stream that
   *  drifts, vs a fan that bursts). */
  readonly spread?: number;
  /** Hold-out weapon - excluded from loadout slot menus (chosen via the
   *  sidearm row, not a primary slot). */
  readonly sidearm?: boolean;
}

const CONFIG_BY_TYPE = new Map<number, ProjectileConfig>(WEAPON_CONFIGS.map((c): [number, ProjectileConfig] => [c.weaponType, c]));

function def(weaponType: WeaponType, rate: number | undefined,
             kick: number, opts: { auto?: boolean; pellets?: { count: number; spread: number }; spread?: number; sidearm?: boolean } = {}): WeaponDef {
  // Registry miss falls back to the bolt config rather than taking down
  //  firing - same rule weaponDef() applies to a corrupt wid.
  const config = CONFIG_BY_TYPE.get(weaponType) ?? CONFIG_BY_TYPE.get(WeaponType.BoltLauncher)!;
  const stats = getWeaponStats(weaponType);
  let kind: WeaponDef['kind'] = 'projectile';
  if (opts.pellets) {kind = 'fan';}
  else if (stats.beam === true) {kind = 'beam';}
  return {
    weaponType,
    // The shared row's fireInterval IS the law - it's the same number the
    // server's cadence gate reads. The positional arg remains for legacy
    // rows that predate the field (they have no row entry to read).
    rate: stats.fireInterval ?? rate ?? 0.5,
    config, kick,
    kind,
    auto: opts.auto ?? false,
    pellets: opts.pellets,
    spread: opts.spread,
    sidearm: opts.sidearm ?? (stats.sidearm === true || undefined),
  };
}

// Index in this array IS the wid - loadout slots, sidearm hold-outs, and
// the loadout menu all index here. Order is gameplay-significant (it IS
// the identity), so append new weapons; never reorder shipped entries.
export const SLOT_DEFS: readonly WeaponDef[] = [
  def(WeaponType.BoltLauncher, BOLT_FIRE_RATE, 1),
  def(WeaponType.Disc, DISC_RATE, 1),
  def(WeaponType.Chaingun, CHAINGUN_RATE, 0.4, { auto: true }),
  def(WeaponType.Mortar, MORTAR_RATE, 2),
  def(WeaponType.GrenadeLauncher, GL_RATE, 1.1),
  def(WeaponType.Flak, FLAK_RATE, 1.4, { pellets: { count: FLAK_SHARDS, spread: FLAK_SPREAD } }),
  def(WeaponType.PlasmaCannon, PLASMA_RATE, 1),
  def(WeaponType.Railgun, RAILGUN_RATE, 1.8),
  def(WeaponType.Lightning, LG_RATE, 0, { auto: true }),
  def(WeaponType.Shotgun, SHOTGUN_RATE, 1.6, { pellets: { count: SG_PELLETS, spread: SG_SPREAD }, sidearm: true }),
  def(WeaponType.Cannon, CANNON_RATE, 1.2),
  def(WeaponType.MissileLauncher, RKT_RATE, 2),
  def(WeaponType.Pistol, PISTOL_RATE, 0.8, { sidearm: true }),
  def(WeaponType.Revolver, REVOLVER_RATE, 1, { sidearm: true }),
  def(WeaponType.Sticky, STICKY_RATE, 1.2),
  def(WeaponType.PlasmaGun, PLASMAGUN_RATE, 0.6),
  def(WeaponType.Sprinkler, SPRINKLER_RATE, 0.5, { auto: true, spread: SPRINKLER_SPREAD }),
  def(WeaponType.Repair, REPAIR_RATE, 0, { auto: true, sidearm: true }),
  def(WeaponType.MRVLauncher, MRV_RATE, 2.2),
  def(WeaponType.Bombard, BOMBARD_RATE, 2.4),
  // Shocklance - the hold-out power lance: 18m zap on a 2s refire
  // (LANCE_CADENCE_S - the same number the server's lance gate reads).
  def(WeaponType.Shocklance, LANCE_CADENCE_S, 0.4, { sidearm: true }),
  // Blaster - T1 energy sidearm: 35 per bolt, but every pull bills the
  // jet tank (energyCost in the shared row - jets and the sidearm argue
  // over the same pool). wid 23 is hardcoded in SIDEARM_WIDS - don't
  // insert before this.
  def(WeaponType.Blaster, BLASTER_RATE, 0.9, { sidearm: true }),
  // Heal beam - the medic's pocket beam: primary-slot support gun,
  // HP on teammates, jet energy as ammo (server resolves the intent).
  def(WeaponType.HealBeam, 0.1, 0, { auto: true }),
  // Gonne - the light frame's 80 m/s arc primary: cannon stats in a
  // stubby handgonne. Appended last; never reorder shipped entries.
  def(WeaponType.Gonne, CANNON_RATE, 1.2),
  // Basilisk - the heavy frame's 80 m/s arc primary: same family, big
  // bronze bore. Appended last; never reorder shipped entries.
  def(WeaponType.Basilisk, CANNON_RATE, 1.4),
  // Rocket Launcher - the universal flat rocket: bolt stats minus
  // gravity, every class fields it. Appended last.
  def(WeaponType.RocketLauncher, BOLT_FIRE_RATE, 1),
];

/** wid of the shocklance def - the 'lance' sidearm pick binds this. */
export const LANCE_WID = SLOT_DEFS.findIndex((d): boolean => d.weaponType === WeaponType.Shocklance);

export const SLOT_COUNT = SLOT_DEFS.length;

/** wid → def. Unknown ids fall back to rocket rather than throwing - a
 *  corrupt loadout string shouldn't take down firing entirely. */
export function weaponDef(wid: number): WeaponDef {
  return SLOT_DEFS[wid] ?? SLOT_DEFS[0];
}

/** wid for a weaponType - the sidearm table and any "which slot is X"
 *  lookup derives here instead of hardcoding indices that go stale the
 *  next append. -1 if the type has no slot def. */
export function widOf(weaponType: WeaponType): number {
  return SLOT_DEFS.findIndex((d): boolean => d.weaponType === weaponType);
}
