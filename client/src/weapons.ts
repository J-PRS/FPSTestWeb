// Weapon registry — THE slot table. Every loadout-slot weapon is one entry
// here; position in SLOT_DEFS is the wid (what loadout[]/weaponIndex/menus
// use), weaponType is the wire id the server and demo format speak.
//
// This file exists because slot space and wire space used to be kept in
// four separate parallel arrays (WEAPON_RATES, the fire-callback table,
// SLOT_WEAPONS, widToWeaponType) — a missing entry once made the sticky
// launcher silently fire rockets. Now the order is declared once and every
// consumer derives from it, so a weapon can't be half-wired.
//
// To add a weapon: shared/weapons.ts stats + ProjectileConfig + geo/sfx
// entries, then ONE def here. Nothing else aligns positionally.

import { WeaponType, LANCE_CADENCE_S } from '../../shared/weapons.js';
import type { ProjectileConfig } from './projectiles/types.js';
import { BOLT_CONFIG } from './projectiles/boltConfig.js';
import { DISC_CONFIG } from './projectiles/discConfig.js';
import { CHAINGUN_CONFIG } from './projectiles/chaingunConfig.js';
import { MORTAR_CONFIG } from './projectiles/mortarConfig.js';
import { GL_CONFIG } from './projectiles/glConfig.js';
import { FLAK_CONFIG } from './projectiles/flakConfig.js';
import { PLASMA_CONFIG } from './projectiles/plasmaConfig.js';
import { PLASMAGUN_CONFIG } from './projectiles/plasmagunConfig.js';
import { SPRINKLER_CONFIG } from './projectiles/sprinklerConfig.js';
import { RAILGUN_CONFIG } from './projectiles/railgunConfig.js';
import { LIGHTNING_CONFIG } from './projectiles/lightningConfig.js';
import { SHOCKLANCE_CONFIG } from './projectiles/shocklanceConfig.js';
import { SHOTGUN_CONFIG } from './projectiles/shotgunConfig.js';
import { CANNON_CONFIG } from './projectiles/cannonConfig.js';
import { BOMBARD_CONFIG } from './projectiles/bombardConfig.js';
import { RKT_CONFIG } from './projectiles/rocketLauncherConfig.js';
import { PISTOL_CONFIG } from './projectiles/pistolConfig.js';
import { REVOLVER_CONFIG } from './projectiles/revolverConfig.js';
import { BLASTER_CONFIG } from './projectiles/blasterConfig.js';
import { STICKY_CONFIG } from './projectiles/stickyConfig.js';
import { MRV_CONFIG } from './projectiles/mrvConfig.js';
import { REPAIR_CONFIG } from './projectiles/repairConfig.js';
import {
  BOLT_FIRE_RATE, DISC_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE,
  PLASMA_RATE, RAILGUN_RATE, LG_RATE, SHOTGUN_RATE, CANNON_RATE, RKT_RATE,
  PISTOL_RATE, REVOLVER_RATE, BLASTER_RATE, STICKY_RATE, PLASMAGUN_RATE, BOMBARD_RATE,
  SPRINKLER_RATE, SPRINKLER_SPREAD, REPAIR_RATE, MRV_RATE,
  FLAK_SHARDS, FLAK_SPREAD, SG_PELLETS, SG_SPREAD,
} from './core/config.js';

export type WeaponKind = 'projectile' | 'fan' | 'beam';

export interface WeaponDef {
  /** Wire id — shared/weapons.ts enum; what the server validates against. */
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
  /** Projectile kind only: per-shot cone jitter (sprinkler — a stream that
   *  drifts, vs a fan that bursts). */
  readonly spread?: number;
  /** Hold-out weapon — excluded from loadout slot menus (chosen via the
   *  sidearm row, not a primary slot). */
  readonly sidearm?: boolean;
}

function def(weaponType: WeaponType, rate: number, config: ProjectileConfig,
             kick: number, opts: { auto?: boolean; pellets?: { count: number; spread: number }; spread?: number; sidearm?: boolean } = {}): WeaponDef {
  let kind: WeaponDef['kind'] = 'projectile';
  if (opts.pellets) {kind = 'fan';}
  else if (weaponType === WeaponType.Lightning || weaponType === WeaponType.Repair || weaponType === WeaponType.Shocklance) {kind = 'beam';}
  return {
    weaponType, rate, config, kick,
    kind,
    auto: opts.auto ?? false,
    pellets: opts.pellets,
    spread: opts.spread,
    sidearm: opts.sidearm,
  };
}

// Index in this array IS the wid — loadout slots, sidearm hold-outs, and
// the loadout menu all index here. Order is gameplay-significant (it IS
// the identity), so append new weapons; never reorder shipped entries.
export const SLOT_DEFS: readonly WeaponDef[] = [
  def(WeaponType.BoltLauncher, BOLT_FIRE_RATE, BOLT_CONFIG, 1),
  def(WeaponType.Disc, DISC_RATE, DISC_CONFIG, 1),
  def(WeaponType.Chaingun, CHAINGUN_RATE, CHAINGUN_CONFIG, 0.4, { auto: true }),
  def(WeaponType.Mortar, MORTAR_RATE, MORTAR_CONFIG, 2),
  def(WeaponType.GrenadeLauncher, GL_RATE, GL_CONFIG, 1.1),
  def(WeaponType.Flak, FLAK_RATE, FLAK_CONFIG, 1.4, { pellets: { count: FLAK_SHARDS, spread: FLAK_SPREAD } }),
  def(WeaponType.PlasmaCannon, PLASMA_RATE, PLASMA_CONFIG, 1),
  def(WeaponType.Railgun, RAILGUN_RATE, RAILGUN_CONFIG, 1.8),
  def(WeaponType.Lightning, LG_RATE, LIGHTNING_CONFIG, 0, { auto: true }),
  def(WeaponType.Shotgun, SHOTGUN_RATE, SHOTGUN_CONFIG, 1.6, { pellets: { count: SG_PELLETS, spread: SG_SPREAD }, sidearm: true }),
  def(WeaponType.Cannon, CANNON_RATE, CANNON_CONFIG, 1.2),
  def(WeaponType.RocketLauncher, RKT_RATE, RKT_CONFIG, 2),
  def(WeaponType.Pistol, PISTOL_RATE, PISTOL_CONFIG, 0.8, { sidearm: true }),
  def(WeaponType.Revolver, REVOLVER_RATE, REVOLVER_CONFIG, 1, { sidearm: true }),
  def(WeaponType.Sticky, STICKY_RATE, STICKY_CONFIG, 1.2),
  def(WeaponType.PlasmaGun, PLASMAGUN_RATE, PLASMAGUN_CONFIG, 0.6),
  def(WeaponType.Sprinkler, SPRINKLER_RATE, SPRINKLER_CONFIG, 0.5, { auto: true, spread: SPRINKLER_SPREAD }),
  def(WeaponType.Repair, REPAIR_RATE, REPAIR_CONFIG, 0, { auto: true, sidearm: true }),
  def(WeaponType.MRVLauncher, MRV_RATE, MRV_CONFIG, 2.2),
  def(WeaponType.Bombard, BOMBARD_RATE, BOMBARD_CONFIG, 2.4),
  // Shocklance — the hold-out power lance: 18m zap on a 2s refire
  // (LANCE_CADENCE_S — the same number the server's lance gate reads).
  def(WeaponType.Shocklance, LANCE_CADENCE_S, SHOCKLANCE_CONFIG, 0.4, { sidearm: true }),
  // Blaster — T1 energy sidearm: 35 per bolt, but every pull bills the
  // jet tank (energyCost in the shared row — jets and the sidearm argue
  // over the same pool). Keep LAST: wid 23.
  def(WeaponType.Blaster, BLASTER_RATE, BLASTER_CONFIG, 0.9, { sidearm: true }),
];

/** wid of the shocklance def — the 'lance' sidearm pick binds this. */
export const LANCE_WID = SLOT_DEFS.findIndex((d): boolean => d.weaponType === WeaponType.Shocklance);

export const SLOT_COUNT = SLOT_DEFS.length;

/** wid → def. Unknown ids fall back to rocket rather than throwing — a
 *  corrupt loadout string shouldn't take down firing entirely. */
export function weaponDef(wid: number): WeaponDef {
  return SLOT_DEFS[wid] ?? SLOT_DEFS[0];
}
