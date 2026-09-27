import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

export const GRENADE_CONFIG: ProjectileConfig = {
  name: 'grenade',
  displayName: 'Grenade',
  weaponType: 2,
  speed: WEAPONS[2].speed,
  gravity: WEAPONS[2].gravity,
  explosionRadius: WEAPONS[2].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[2].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[2].bodyRadius,
  hitMin: WEAPONS[2].hitMin,
  hitMax: WEAPONS[2].hitMax,
  hitGrow: WEAPONS[2].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
  collisionMultiplier: 1.0, // ball radius + explosion radius
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[2].aoeDamage,
  aoeRadius: WEAPONS[2].aoeRadius,
  damageColor: '#ff6600',
  trailColors: [
    new THREE.Color(1.0, 0.9, 0.5),
    new THREE.Color(1.0, 0.6, 0.1),
    new THREE.Color(0.8, 0.3, 0.05),
    new THREE.Color(0.4, 0.2, 0.15),
    new THREE.Color(0.25, 0.25, 0.28),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 1.0,
  trailLifeMax: 1.5,
  trailSpread: 0.25,
  trailForwardSpread: 0.1,
  trailParticleGravity: 0.0,
  trailOpacity: 0.4,
  trailBaseSize: 0.1,
  trailSizeRange: 0.3,
  trailScaleMin: 0.6,
  trailScaleMax: 2.0,
  trailRampIn: 0.1,
  meshColor: 0xff8800,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xff4400,
  glowOpacity: 0.25,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: WEAPONS[2].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[2].maxLifetime,
  trailMeshType: 'sphere',
};
