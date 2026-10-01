import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Quake railgun: a hypervelocity slug (450 m/s — hitscan in practice at any
// sane range, but it rides the normal projectile/track/claim path, so no
// new server plumbing). Small AOE on impact so near-misses still pop.
// Visual: white-hot core + cyan 3-lane ribbon = the corkscrew read.
export const RAILGUN_CONFIG: ProjectileConfig = {
  name: 'railgun',
  displayName: 'Railgun',
  weaponType: 9,
  speed: WEAPONS[9].speed,
  gravity: WEAPONS[9].gravity,
  explosionRadius: WEAPONS[9].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[9].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[9].bodyRadius,
  hitMin: WEAPONS[9].hitMin,
  hitMax: WEAPONS[9].hitMax,
  hitGrow: WEAPONS[9].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[9].aoeDamage,
  aoeRadius: WEAPONS[9].aoeRadius,
  vfx: 'kinetic',
  damageColor: '#66ccff',
  trailColors: [
    new THREE.Color(0.7, 0.95, 1.0), // white-hot core
    new THREE.Color(0.3, 0.7, 1.0),  // cyan
    new THREE.Color(0.1, 0.4, 0.9),  // deep blue tail
  ],
  trailParticlesPerUnit: 1.2,
  trailLifeMin: 0.25,
  trailLifeMax: 0.5,
  trailSpread: 0.08,
  trailForwardSpread: 0.02,
  trailParticleGravity: 0,
  trailOpacity: 0.7,
  trailBaseSize: 0.08,
  trailSizeRange: 0.12,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0,
  meshColor: 0xbbeeff,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x66ccff,
  glowOpacity: 0.6,
  glowScale: 1.2,
  meshRampIn: false,
  meshRampInDuration: 0,
  meshStartScale: 1,
  terrainOffset: WEAPONS[9].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[9].maxLifetime,
  trailMeshType: 'sphere',
  // 3 lanes = the corkscrew band — wide, long-lived, bright cyan
  ribbonTrail: true,
  ribbonWidth: 0.55,
  ribbonLife: 0.4,
  ribbonColor: 0x55bbff,
};
