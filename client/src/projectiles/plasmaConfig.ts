import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// T1/T2 plasma cannon: fat glowing bolt, no gravity, small splash — the
// sustained midrange weapon between chaingun and rocket. The rapid-fire
// Quake-style sibling is PLASMAGUN_CONFIG.
export const PLASMA_CONFIG: ProjectileConfig = {
  name: 'plasma',
  displayName: 'Plasma Cannon',
  weaponType: 7,
  speed: WEAPONS[7].speed,
  gravity: WEAPONS[7].gravity,
  explosionRadius: WEAPONS[7].aoeRadius * AOE_VFX_SCALE, // VFX = 80% of damage reach
  force: WEAPONS[7].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[7].bodyRadius,
  hitMin: WEAPONS[7].hitMin,
  hitMax: WEAPONS[7].hitMax, // tight proxy — the fat bolt is already generous
  hitGrow: WEAPONS[7].hitGrow,
  maxLifetime: WEAPONS[7].maxLifetime,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[7].aoeDamage,
  aoeRadius: WEAPONS[7].aoeRadius,
  vfx: 'energy',
  damageColor: '#55ffcc',
  trailColors: [
    new THREE.Color(0.4, 1, 0.7),
    new THREE.Color(0.1, 0.9, 0.5),
    new THREE.Color(0, 0.6, 0.4),
    new THREE.Color(0.1, 0.3, 0.3),
  ],
  trailParticlesPerUnit: 0.8,
  trailLifeMin: 0.3,
  trailLifeMax: 0.6,
  trailSpread: 0.12,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0,
  trailOpacity: 0.5,
  trailBaseSize: 0.1,
  trailSizeRange: 0.2,
  trailScaleMin: 0.6,
  trailScaleMax: 1.6,
  trailRampIn: 0.05,
  meshColor: 0x44FFAA,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x33FFAA,
  glowOpacity: 0.4,
  glowScale: 0.9,
  meshRampIn: true,
  meshRampInDuration: 0.03,
  meshStartScale: 0.5,
  terrainOffset: WEAPONS[7].hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.3,
  ribbonLife: 0.15,
  ribbonColor: 0x33FFAA,
};
