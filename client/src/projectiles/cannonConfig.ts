import * as THREE from 'three';

import {
  CANNON_BOUNCE_RESTITUTION, CANNON_BOUNCE_FRICTION,
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Serious Sam cannonball: a fast, fat iron sphere that SKIPS off terrain
// (livelier than the GL shell — keeps its speed) and detonates on target
// contact or at fuse. Dark ball + smoke/ember trail — reads as ordnance,
// not energy.
export const CANNON_CONFIG: ProjectileConfig = {
  name: 'cannon',
  displayName: 'Cannon',
  weaponType: 14,
  speed: WEAPONS[14].speed,
  gravity: WEAPONS[14].gravity,
  explosionRadius: WEAPONS[14].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[14].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[14].bodyRadius,
  hitMin: WEAPONS[14].hitMin,
  hitMax: WEAPONS[14].hitMax,
  hitGrow: WEAPONS[14].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[14].aoeDamage,
  aoeRadius: WEAPONS[14].aoeRadius,
  damageColor: '#ffbb66',
  // No trail — the joke IS the giant ball. A smoke streak behind a
  // beach-ball-sized cannonball just clutters the read.
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
  meshColor: 0x23252b, // dark iron cannonball
  meshType: 'ball',
  glowShell: false, // iron, not energy — the ember trail carries the read
  glowColor: 0x000000, // unused — glowShell is off
  glowOpacity: 0,
  // Ramp-in uses the global default (20% → 100% over 0.2s) — explicitly
  // NOT overriding here: the 1.6m ball needs the full ramp, not GL's 40ms
  terrainOffset: WEAPONS[14].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[14].maxLifetime,
  trailMeshType: 'sphere',
  bounces: true,
  bounceSfx: 'hg_clang', // iron ball thunk on every skip
  bounceRestitution: CANNON_BOUNCE_RESTITUTION,
  bounceFriction: CANNON_BOUNCE_FRICTION,
};
