import * as THREE from 'three';

import {
  GL_BOUNCE_RESTITUTION, GL_BOUNCE_FRICTION,
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// T2 grenade launcher: arcing shells that BOUNCE off terrain until the
// fuse expires — direct player/ball contact detonates instantly.
// AOE stats intentionally match the server's 'grenade' profile.
export const GL_CONFIG: ProjectileConfig = {
  name: 'grenadeLauncher',
  displayName: 'Grenade Launcher',
  weaponType: 5,
  speed: WEAPONS[5].speed,
  gravity: WEAPONS[5].gravity,
  // VFX = 80% of damage reach — damage covers the shock ring, not just the dome
  explosionRadius: WEAPONS[5].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[5].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[5].bodyRadius,
  hitMin: WEAPONS[5].hitMin,
  hitMax: WEAPONS[5].hitMax, // tight proxy — bouncing shells shouldn't drag a huge wake
  hitGrow: WEAPONS[5].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[5].aoeDamage,
  aoeRadius: WEAPONS[5].aoeRadius,
  damageColor: '#aaff44',
  trailColors: [
    new THREE.Color(0.8, 1.0, 0.4),
    new THREE.Color(0.5, 0.9, 0.2),
    new THREE.Color(0.3, 0.6, 0.15),
    new THREE.Color(0.2, 0.35, 0.15),
    new THREE.Color(0.2, 0.25, 0.2),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.4,
  trailLifeMax: 0.8,
  trailSpread: 0.15,
  trailForwardSpread: 0.08,
  trailParticleGravity: 0.0,
  trailOpacity: 0.35,
  trailBaseSize: 0.08,
  trailSizeRange: 0.2,
  trailScaleMin: 0.5,
  trailScaleMax: 1.5,
  trailRampIn: 0.05,
  meshColor: 0x88ff33,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x66ff22,
  glowOpacity: 0.35,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.3,
  terrainOffset: WEAPONS[5].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[5].maxLifetime,
  armTime: WEAPONS[5].armTime, // T2 arming fuse — bounce/phase until cooked, then contact pops
  trailMeshType: 'sphere',
  bounces: true,
  bounceSfx: 'ricochet1',
  bounceRestitution: GL_BOUNCE_RESTITUTION,
  bounceFriction: GL_BOUNCE_FRICTION,
};
