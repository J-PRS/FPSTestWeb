import { KNOCKBACK_MULTIPLIER } from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Gonne — the light frame's member of the 80 m/s gravity-arc family.
// Same shell as the cannon (shared row is a flavored reskin): dark iron
// ball, no trail, pops on contact. The gun differs, the ball doesn't.
export const GONNE_CONFIG: ProjectileConfig = {
  name: 'gonne',
  displayName: 'Gonne',
  weaponType: 42,
  speed: WEAPONS[42].speed,
  gravity: WEAPONS[42].gravity,
  explosionRadius: WEAPONS[42].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[42].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[42].bodyRadius,
  hitMin: WEAPONS[42].hitMin,
  hitMax: WEAPONS[42].hitMax,
  hitGrow: WEAPONS[42].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[42].aoeDamage,
  aoeRadius: WEAPONS[42].aoeRadius,
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
  trailMeshType: 'sphere',
  meshColor: 0x2A_2D_33, // slightly bluer dark iron than the cannonball — the wrought-forged read
  meshType: 'ball',
  litMesh: true,
  glowShell: false,
  glowColor: 0x00_00_00, // unused — glowShell is off
  glowOpacity: 0,
  terrainOffset: WEAPONS[42].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[42].maxLifetime,
  bounces: WEAPONS[42].terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: WEAPONS[42].bounceRestitution,
  bounceFriction: WEAPONS[42].bounceFriction,
  firstBounceVelScale: WEAPONS[42].firstBounceVelScale,
  fuseAfterBounce: WEAPONS[42].fuseAfterBounce,
  lodgeBounce: WEAPONS[42].lodgeBounce,
  maxBounces: WEAPONS[42].maxBounces,
};
