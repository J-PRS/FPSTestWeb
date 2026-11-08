import { DISC_CONFIG } from './discConfig.js';
import { WEAPONS, WeaponType, AOE_VFX_SCALE } from '../../../shared/weapons.js';
import type { ProjectileConfig } from './types.js';

// Fast Disc Launcher (type 46): the iconic spinfusor silhouette at
// 130 m/s flat - same disc body + wake, smaller splash, speed is the
// skill tax. Replaces the benched universal rocket as the
// fast-straight-proj pick.
export const FAST_DISC_CONFIG: ProjectileConfig = Object.assign({}, DISC_CONFIG, {
  name: 'fastDisc',
  displayName: 'Fast Disc',
  weaponType: WeaponType.FastDiscLauncher,
  speed: WEAPONS[WeaponType.FastDiscLauncher].speed,
  bodyRadius: WEAPONS[WeaponType.FastDiscLauncher].bodyRadius,
  gravity: false,
  aoeDamage: WEAPONS[WeaponType.FastDiscLauncher].aoeDamage,
  aoeRadius: WEAPONS[WeaponType.FastDiscLauncher].aoeRadius,
  // Recompute off THIS row - the spread would inherit Disc's 10m dome
  // while FDL's splash is only 5, doubling the blast visual's reach.
  // staticRing: the ground ring spawns AT the 5m edge and fades, never
  // expanding past the real damage line.
  explosionRadius: WEAPONS[WeaponType.FastDiscLauncher].aoeRadius * AOE_VFX_SCALE,
  staticRing: true,
});
