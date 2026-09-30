import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// RPG missile: flat-trajectory, deliberately slow, big warhead boom.
// Smoke-column trail is the whole read — a rocket announces itself.
export const RKT_CONFIG: ProjectileConfig = {
  name: 'rocketLauncher',
  displayName: 'Rocket Launcher',
  weaponType: 15,
  speed: WEAPONS[15].speed,
  gravity: WEAPONS[15].gravity,
  explosionRadius: WEAPONS[15].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[15].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[15].bodyRadius,
  hitMin: WEAPONS[15].hitMin,
  hitMax: WEAPONS[15].hitMax,
  hitGrow: WEAPONS[15].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[15].aoeDamage,
  aoeRadius: WEAPONS[15].aoeRadius,
  vfx: 'concussion',
  damageColor: '#ffaa55',
  // Thick exhaust column — hot orange at the motor, drying to grey smoke
  trailColors: [
    new THREE.Color(1.0, 0.6, 0.15),
    new THREE.Color(0.9, 0.45, 0.1),
    new THREE.Color(0.6, 0.55, 0.5),
    new THREE.Color(0.45, 0.45, 0.45),
    new THREE.Color(0.35, 0.35, 0.38),
  ],
  trailParticlesPerUnit: 3,
  trailLifeMin: 0.8,
  trailLifeMax: 1.6,
  trailSpread: 0.35,
  trailForwardSpread: 0.15,
  trailParticleGravity: -0.5, // smoke RISES off the line
  trailOpacity: 0.5,
  trailBaseSize: 0.15,
  trailSizeRange: 0.4,
  trailScaleMin: 0.8,
  trailScaleMax: 2.5,
  trailRampIn: 0.1,
  meshColor: 0x3d4a35, // military olive — ordnance, not energy
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xff5500, // burning motor at the tail
  glowOpacity: 0.25,
  glowScale: 0.6,
  terrainOffset: WEAPONS[15].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[15].maxLifetime,
};
