import * as THREE from 'three';

import { WEAPONS } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// UT flak shard: fast jagged chunk that bounces off terrain a few times
// and only damages on direct hits — no explosion, no AOE.
export const FLAK_CONFIG: ProjectileConfig = {
  name: 'flak',
  displayName: 'Flak Cannon',
  weaponType: 6,
  speed: WEAPONS[6].speed,
  gravity: WEAPONS[6].gravity,
  explosionRadius: 0,
  force: 0,
  forceMode: 'push',
  bodyRadius: WEAPONS[6].bodyRadius,
  hitMin: WEAPONS[6].hitMin,
  hitMax: WEAPONS[6].hitMax,
  hitGrow: WEAPONS[6].hitGrow,
  forceMultiplier: 0,
  aoeDamage: 0,
  aoeRadius: 0,
  vfx: 'flak', // air-burst bloom — shell fragments, not a ground fireball
  damageColor: '#ffaa33',
  trailColors: [
    new THREE.Color(1, 0.75, 0.3),
    new THREE.Color(0.9, 0.5, 0.15),
    new THREE.Color(0.6, 0.3, 0.1),
  ],
  trailParticlesPerUnit: 0.4,
  trailLifeMin: 0.15,
  trailLifeMax: 0.35,
  trailSpread: 0.05,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0.05,
  trailOpacity: 0.5,
  trailBaseSize: 0.05,
  trailSizeRange: 0.12,
  trailScaleMin: 0.4,
  trailScaleMax: 1.2,
  trailRampIn: 0,
  meshColor: 0xFF_CC_66,
  meshType: 'rocket',
  glowShell: false,
  glowColor: 0xFF_AA_33,
  glowOpacity: 0,

  terrainOffset: 0.08,
  needsServerTracking: true,
  maxLifetime: WEAPONS[6].maxLifetime,
  ttlJitter: WEAPONS[6].ttlJitter,
  trailMeshType: 'sphere',
  noExplosion: true,
  bounces: WEAPONS[6].terrainBounce === true,
  bounceSfx: 'ricochet1',
  bounceRestitution: WEAPONS[6].bounceRestitution,
  bounceFriction: WEAPONS[6].bounceFriction,
  maxBounces: WEAPONS[6].maxBounces,
  // Short single-lane streak like the chaingun tracer, but wider/longer —
  // a shard is slower and heavier than a bullet, it should read as a
  // tumbling chunk, not a laser flick.
  ribbonTrail: true,
  ribbonLanes: 1,
  ribbonWidth: 0.35,
  ribbonLife: 0.15,
  ribbonColor: 0xFF_AA_33,
};
