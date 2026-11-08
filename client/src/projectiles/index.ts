import { WEAPONS } from '../../../shared/weapons.js';
import { BOLT_CONFIG } from './boltConfig.js';
import { DISC_CONFIG, BELT_DISC_CONFIG, BELT_DISC_PUSH_CONFIG } from './discConfig.js';
import { GRENADE_CONFIG } from './grenadeConfig.js';
import { CHAINGUN_CONFIG } from './chaingunConfig.js';
import { MORTAR_CONFIG, HOWITZER_CONFIG } from './mortarConfig.js';
import { GL_CONFIG } from './glConfig.js';
import { FLAK_CONFIG } from './flakConfig.js';
import { PLASMA_CONFIG } from './plasmaConfig.js';
import { PLASMAGUN_CONFIG } from './plasmagunConfig.js';
import { SPRINKLER_CONFIG } from './sprinklerConfig.js';
import { REMOTE_RAILGUN_CONFIG } from './remotergunConfig.js';
import { RAILGUN_CONFIG } from './railgunConfig.js';
import { LIGHTNING_CONFIG } from './lightningConfig.js';
import { SHOTGUN_CONFIG } from './shotgunConfig.js';
import { CANNON_CONFIG } from './cannonConfig.js';
import { RKT_CONFIG } from './rocketLauncherConfig.js';
import { PISTOL_CONFIG } from './pistolConfig.js';
import { REVOLVER_CONFIG } from './revolverConfig.js';
import { BLASTER_CONFIG } from './blasterConfig.js';
import { STICKY_CONFIG, BELT_STICKY_CONFIG } from './stickyConfig.js';
import { CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, HOOK_CONFIG } from './beltConfigs.js';
import { ARMORNADE_CONFIG } from './armornadeConfig.js';
import { MRV_CONFIG, MRV_BOMBLET_CONFIG } from './mrvConfig.js';
import { PROXY_CONFIG } from './proxyConfig.js';
import { SATCHEL_CONFIG } from './satchelConfig.js';
import { HEALNADE_CONFIG } from './healnadeConfig.js';
import { CONC_CONFIG } from './concConfig.js';
import { EMP_CONFIG } from './empConfig.js';
import { BOMBARD_CONFIG } from './bombardConfig.js';
import { GONNE_CONFIG } from './gonneConfig.js';
import { BASILISK_CONFIG } from './basiliskConfig.js';
import { ROCKET_CONFIG } from './rocketConfig.js';
import { FAST_DISC_CONFIG } from './fastDiscConfig.js';
import { REPAIR_CONFIG } from './repairConfig.js';
import { SHOCKLANCE_CONFIG } from './shocklanceConfig.js';
import { HEALBEAM_CONFIG } from './healbeamConfig.js';
import { ACCURACY_MAX, ACCURACY_NORMALIZATION } from '../core/config.js';
import type { ProjectileConfig } from './types.js';
export type { ProjectileConfig } from './types.js';
export { Projectile } from './Projectile.js';
export { BOLT_CONFIG } from './boltConfig.js';
export { DISC_CONFIG, BELT_DISC_CONFIG, BELT_DISC_PUSH_CONFIG } from './discConfig.js';
export { GRENADE_CONFIG } from './grenadeConfig.js';
export { CHAINGUN_CONFIG } from './chaingunConfig.js';
export { MORTAR_CONFIG, HOWITZER_CONFIG } from './mortarConfig.js';
export { GL_CONFIG } from './glConfig.js';
export { FLAK_CONFIG } from './flakConfig.js';
export { PLASMA_CONFIG } from './plasmaConfig.js';
export { PLASMAGUN_CONFIG } from './plasmagunConfig.js';
export { SPRINKLER_CONFIG } from './sprinklerConfig.js';
export { REMOTE_RAILGUN_CONFIG } from './remotergunConfig.js';
export { RAILGUN_CONFIG } from './railgunConfig.js';
export { LIGHTNING_CONFIG } from './lightningConfig.js';
export { SHOTGUN_CONFIG } from './shotgunConfig.js';
export { CANNON_CONFIG } from './cannonConfig.js';
export { RKT_CONFIG } from './rocketLauncherConfig.js';
export { PISTOL_CONFIG } from './pistolConfig.js';
export { REVOLVER_CONFIG } from './revolverConfig.js';
export { BLASTER_CONFIG } from './blasterConfig.js';
export { STICKY_CONFIG, BELT_STICKY_CONFIG } from './stickyConfig.js';
export { CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, HOOK_CONFIG } from './beltConfigs.js';
export { ARMORNADE_CONFIG } from './armornadeConfig.js';
export { MRV_CONFIG, MRV_BOMBLET_CONFIG } from './mrvConfig.js';
export { PROXY_CONFIG } from './proxyConfig.js';
export { SATCHEL_CONFIG } from './satchelConfig.js';
export { HEALNADE_CONFIG } from './healnadeConfig.js';
export { CONC_CONFIG } from './concConfig.js';
export { EMP_CONFIG } from './empConfig.js';
export { BOMBARD_CONFIG } from './bombardConfig.js';
export { GONNE_CONFIG } from './gonneConfig.js';
export { BASILISK_CONFIG } from './basiliskConfig.js';
export { ROCKET_CONFIG } from './rocketConfig.js';
export { FAST_DISC_CONFIG } from './fastDiscConfig.js';
export { REPAIR_CONFIG } from './repairConfig.js';
export { SHOCKLANCE_CONFIG } from './shocklanceConfig.js';
export { HEALBEAM_CONFIG } from './healbeamConfig.js';




export const WEAPON_CONFIGS: ProjectileConfig[] = [BOLT_CONFIG, DISC_CONFIG, GRENADE_CONFIG, CHAINGUN_CONFIG, MORTAR_CONFIG, GL_CONFIG, FLAK_CONFIG, PLASMA_CONFIG, RAILGUN_CONFIG, BELT_DISC_CONFIG, BELT_DISC_PUSH_CONFIG, LIGHTNING_CONFIG, SHOTGUN_CONFIG, CANNON_CONFIG, RKT_CONFIG, PISTOL_CONFIG, REVOLVER_CONFIG, STICKY_CONFIG, CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, PLASMAGUN_CONFIG, REMOTE_RAILGUN_CONFIG, SPRINKLER_CONFIG, ARMORNADE_CONFIG, MRV_CONFIG, MRV_BOMBLET_CONFIG, PROXY_CONFIG, SATCHEL_CONFIG, HEALNADE_CONFIG, CONC_CONFIG, BOMBARD_CONFIG, BELT_STICKY_CONFIG, HOOK_CONFIG, EMP_CONFIG, BLASTER_CONFIG, GONNE_CONFIG, BASILISK_CONFIG, ROCKET_CONFIG, REPAIR_CONFIG, SHOCKLANCE_CONFIG, HEALBEAM_CONFIG, HOWITZER_CONFIG, FAST_DISC_CONFIG];

// Slot order lives in ../weapons.ts (SLOT_DEFS) — index IS the wid there.
// WEAPON_CONFIGS stays weaponType-keyed (find-by-id) and includes belt items.

export function getProjectileConfig(weaponType: number): ProjectileConfig | undefined {
  return WEAPON_CONFIGS.find((c): boolean => c.weaponType === weaponType);
}

export function getProjectileConfigByName(name: string): ProjectileConfig | undefined {
  return WEAPON_CONFIGS.find((c): boolean => c.name === name);
}

/** Unified accuracy formula: 1-10 scale, direct hits = max */
export function computeAccuracy(accRaw: number, directHit: boolean): number {
  let acc = 1 + (ACCURACY_MAX - 1) * Math.max(0, 1 - accRaw / ACCURACY_NORMALIZATION);
  if (directHit) {acc = ACCURACY_MAX;}
  return acc;
}

/** Hidden refire multiplier on shot score: slow deliberate weapons earn
 *  their number per trigger pull, spam cadence pays for it (plasma's
 *  ~0.1s interval ≈ ×0.1). Floor keeps the fastest weapons scoring. */
export function shotScore(acc: number, dist: number, air: number, weaponType: number): number {
  const interval = WEAPONS[weaponType]?.fireInterval ?? 1;
  return Math.round(acc * dist * air * Math.max(0.1, interval));
}
