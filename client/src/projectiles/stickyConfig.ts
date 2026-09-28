import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Sticky launcher: lobbed glue bombs that FREEZE on any contact and pop on
// a 3s fuse. The weapon's identity is the chain — one detonation cooks
// every sibling sticky in blast radius, so a stacked cluster is one huge
// overlapping boom, not three pops.
export const STICKY_CONFIG: ProjectileConfig = {
  name: 'stickyLauncher',
  displayName: 'Sticky Launcher',
  weaponType: 18,
  speed: WEAPONS[18].speed,
  gravity: WEAPONS[18].gravity,
  explosionRadius: WEAPONS[18].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[18].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[18].bodyRadius,
  hitMin: WEAPONS[18].hitMin,
  hitMax: WEAPONS[18].hitMax,
  hitGrow: WEAPONS[18].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[18].aoeDamage,
  aoeRadius: WEAPONS[18].aoeRadius,
  damageColor: '#ff88ff',
  trailColors: [
    new THREE.Color(1.0, 0.6, 1.0),
    new THREE.Color(0.8, 0.4, 0.9),
    new THREE.Color(0.5, 0.25, 0.6),
    new THREE.Color(0.3, 0.15, 0.35),
    new THREE.Color(0.2, 0.15, 0.25),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.3,
  trailLifeMax: 0.6,
  trailSpread: 0.12,
  trailForwardSpread: 0.06,
  trailParticleGravity: 0.0,
  trailOpacity: 0.4,
  trailBaseSize: 0.07,
  trailSizeRange: 0.18,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0xdd55ee,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xff44dd,
  glowOpacity: 0.4,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.3,
  terrainOffset: WEAPONS[18].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[18].maxLifetime,
  trailMeshType: 'sphere',
  sticks: true,
};
