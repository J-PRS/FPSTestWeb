import { KNOCKBACK_MULTIPLIER } from '../core/config.js';
import { WEAPONS } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Bombard — the heavy's siege slug. Same "giant iron ball" read as the
// cannon but bigger, and it NEVER detonates: the ball crumbles into
// shards on any contact (noExplosion + crumbles). The crumble's shards
// deal real radial damage server-side (WEAPONS aoe envelope) — the
// visual stays the same burst either way.
export const BOMBARD_CONFIG: ProjectileConfig = {
  name: 'bombard',
  displayName: 'Bombard',
  weaponType: 35,
  speed: WEAPONS[35].speed,
  gravity: WEAPONS[35].gravity,
  explosionRadius: 0, // it crumbles — no blast dome, ever
  force: WEAPONS[35].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[35].bodyRadius,
  hitMin: WEAPONS[35].hitMin,
  hitMax: WEAPONS[35].hitMax,
  hitGrow: WEAPONS[35].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[35].aoeDamage,
  aoeRadius: WEAPONS[35].aoeRadius,
  noExplosion: true, // contact = crumble, not a boom — rides the hitscan-style impact path
  crumbles: true,    // the ball bursts into rock shards where it lands
  vfx: 'kinetic',
  damageColor: '#ffcc88',
  // No trail — same contract as the cannonball: the joke IS the giant ball.
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
  meshColor: 0x1d1f24, // near-black iron — reads heavier than the cannon's dark ball
  meshType: 'ball',
  glowShell: false,
  glowColor: 0x00_00_00,
  glowOpacity: 0,
  terrainOffset: WEAPONS[35].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[35].maxLifetime,
  trailMeshType: 'sphere',
};
