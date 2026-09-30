export type { ProjectileConfig } from './types.js';
export { Projectile } from './Projectile.js';
export { ROCKET_CONFIG } from './rocketConfig.js';
export { DISC_CONFIG, BELT_DISC_CONFIG } from './discConfig.js';
export { GRENADE_CONFIG } from './grenadeConfig.js';
export { CHAINGUN_CONFIG } from './chaingunConfig.js';
export { MORTAR_CONFIG } from './mortarConfig.js';
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
export { STICKY_CONFIG } from './stickyConfig.js';
export { CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG } from './beltConfigs.js';
export { ARMORNADE_CONFIG } from './armornadeConfig.js';

import { ROCKET_CONFIG } from './rocketConfig.js';
import { DISC_CONFIG, BELT_DISC_CONFIG } from './discConfig.js';
import { GRENADE_CONFIG } from './grenadeConfig.js';
import { CHAINGUN_CONFIG } from './chaingunConfig.js';
import { MORTAR_CONFIG } from './mortarConfig.js';
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
import { STICKY_CONFIG } from './stickyConfig.js';
import { CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG } from './beltConfigs.js';
import { ARMORNADE_CONFIG } from './armornadeConfig.js';

import { ACCURACY_MAX, ACCURACY_NORMALIZATION } from '../core/config.js';

import type { ProjectileConfig } from './types.js';

export const WEAPON_CONFIGS: ProjectileConfig[] = [ROCKET_CONFIG, DISC_CONFIG, GRENADE_CONFIG, CHAINGUN_CONFIG, MORTAR_CONFIG, GL_CONFIG, FLAK_CONFIG, PLASMA_CONFIG, RAILGUN_CONFIG, BELT_DISC_CONFIG, LIGHTNING_CONFIG, SHOTGUN_CONFIG, CANNON_CONFIG, RKT_CONFIG, PISTOL_CONFIG, REVOLVER_CONFIG, STICKY_CONFIG, CLUSTER_CONFIG, BOMBLET_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, PLASMAGUN_CONFIG, REMOTE_RAILGUN_CONFIG, SPRINKLER_CONFIG, ARMORNADE_CONFIG];

// Slot order lives in ../weapons.ts (SLOT_DEFS) — index IS the wid there.
// WEAPON_CONFIGS stays weaponType-keyed (find-by-id) and includes belt items.

export function getProjectileConfig(weaponType: number): ProjectileConfig | undefined {
  return WEAPON_CONFIGS.find((c) => c.weaponType === weaponType);
}

export function getProjectileConfigByName(name: string): ProjectileConfig | undefined {
  return WEAPON_CONFIGS.find((c) => c.name === name);
}

/** Unified accuracy formula: 1-10 scale, direct hits = max */
export function computeAccuracy(accRaw: number, directHit: boolean): number {
  let acc = 1 + (ACCURACY_MAX - 1) * Math.max(0, 1 - accRaw / ACCURACY_NORMALIZATION);
  if (directHit) acc = ACCURACY_MAX;
  return acc;
}
