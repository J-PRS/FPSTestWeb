import { KNOCKBACK_MULTIPLIER } from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Basilisk — the heavy frame's member of the 80 m/s gravity-arc family.
// Same shell as the cannon/gonne (shared row is a flavored reskin):
// dark iron ball, no trail, pops on contact. The huge-bore gun is the
// flavor; the Bombard stays the heavy's unique weapon.
export const BASILISK_CONFIG: ProjectileConfig = {
  name: 'basilisk',
  displayName: 'Basilisk',
  weaponType: 43,
  speed: WEAPONS[43].speed,
  gravity: WEAPONS[43].gravity,
  explosionRadius: WEAPONS[43].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[43].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[43].bodyRadius,
  hitMin: WEAPONS[43].hitMin,
  hitMax: WEAPONS[43].hitMax,
  hitGrow: WEAPONS[43].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[43].aoeDamage,
  aoeRadius: WEAPONS[43].aoeRadius,
  vfx: 'shellburst',
  burstShards: true,
  damageColor: '#ffbb66',
  ribbonTrail: false,
  trailColors: [],
  trailParticlesPerUnit: 0,
  trailLifeMin: 0,
  trailLifeMax: 0,
  trailSpread: 0,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0,
  trailBaseSize: 0,
  trailSizeRange: 0,
  trailScaleMin: 0,
  trailScaleMax: 0,
  trailRampIn: 0,
  meshColor: 0x2B_27_22, // bronze-dark iron — reads cast and ancient next to the cannon's machined ball
  meshType: 'ball',
  litMesh: true,
  glowShell: false,
  glowColor: 0x00_00_00, // unused — glowShell is off
  glowOpacity: 0,
  terrainOffset: WEAPONS[43].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[43].maxLifetime,
  trailMeshType: 'sphere',
  bounces: WEAPONS[43].terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: WEAPONS[43].bounceRestitution,
  bounceFriction: WEAPONS[43].bounceFriction,
  firstBounceVelScale: WEAPONS[43].firstBounceVelScale,
  fuseAfterBounce: WEAPONS[43].fuseAfterBounce,
  lodgeBounce: WEAPONS[43].lodgeBounce,
  maxBounces: WEAPONS[43].maxBounces,
};
