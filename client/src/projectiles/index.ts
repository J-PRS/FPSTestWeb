export type { ProjectileConfig } from './types.js';
export { ROCKET_CONFIG } from './rocketConfig.js';
export { DISC_CONFIG } from './discConfig.js';
export { GRENADE_CONFIG } from './grenadeConfig.js';
export { CHAINGUN_CONFIG } from './chaingunConfig.js';
export { MORTAR_CONFIG } from './mortarConfig.js';
export { GL_CONFIG } from './glConfig.js';
export { FLAK_CONFIG } from './flakConfig.js';
export { PLASMA_CONFIG } from './plasmaConfig.js';

import { ROCKET_CONFIG } from './rocketConfig.js';
import { DISC_CONFIG } from './discConfig.js';
import { GRENADE_CONFIG } from './grenadeConfig.js';
import { CHAINGUN_CONFIG } from './chaingunConfig.js';
import { MORTAR_CONFIG } from './mortarConfig.js';
import { GL_CONFIG } from './glConfig.js';
import { FLAK_CONFIG } from './flakConfig.js';
import { PLASMA_CONFIG } from './plasmaConfig.js';

import { ACCURACY_MAX, ACCURACY_NORMALIZATION } from '../core/config.js';

import type { ProjectileConfig } from './types.js';

export const WEAPON_CONFIGS: ProjectileConfig[] = [ROCKET_CONFIG, DISC_CONFIG, GRENADE_CONFIG, CHAINGUN_CONFIG, MORTAR_CONFIG, GL_CONFIG, FLAK_CONFIG, PLASMA_CONFIG];

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
