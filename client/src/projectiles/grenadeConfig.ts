import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
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
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[2].aoeDamage,
  aoeRadius: WEAPONS[2].aoeRadius,
  damageColor: '#ff6600',
  // Ember-streak trail — tighter and faster-fading than the old smoky
  // fireball trail, matching the small thrown ball
  trailColors: [
    new THREE.Color(1, 0.85, 0.4),
    new THREE.Color(1, 0.55, 0.1),
    new THREE.Color(0.9, 0.3, 0.05),
    new THREE.Color(0.5, 0.2, 0.1),
    new THREE.Color(0.3, 0.2, 0.18),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.4,
  trailLifeMax: 0.8,
  trailSpread: 0.1,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0,
  trailOpacity: 0.55,
  trailBaseSize: 0.06,
  trailSizeRange: 0.15,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0x3A_3D_42, // dark shell — the glow reads as heat leaking out
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xFF_55_00,
  glowOpacity: 0.4,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: WEAPONS[2].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[2].maxLifetime,
  // Fuse bomb: armTime == fuse ⇒ never "arms" — bodies phase through,
  // terrain can only bounce it, the 1.5s timer is the sole trigger.
  armTime: WEAPONS[2].armTime,
  bounces: WEAPONS[2].terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: WEAPONS[2].bounceRestitution,
  bounceFriction: WEAPONS[2].bounceFriction,
  trailMeshType: 'sphere',
};
