import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// T2 mortar: fat lobbed shell with an ARMING fuse — hits before ~1.5s
// bounce off the terrain (BounceVelocityModifier 0.25), armed shells
// detonate on contact. Point-blank shots bounce first, then pop —
// the T2 "suicide mortar" tactic lives or dies on this.
export const MORTAR_CONFIG: ProjectileConfig = {
  name: 'mortar',
  displayName: 'Mortar',
  weaponType: 4,
  speed: WEAPONS[4].speed,
  gravity: WEAPONS[4].gravity,
  explosionRadius: WEAPONS[4].aoeRadius * AOE_VFX_SCALE, // VFX = 80% of damage reach — the ring edge is the truth
  force: WEAPONS[4].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[4].bodyRadius,
  hitMin: WEAPONS[4].hitMin,
  hitMax: WEAPONS[4].hitMax, // tight proxy — the big splash is the forgiving part, not the wake
  hitGrow: WEAPONS[4].hitGrow,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[4].aoeDamage,
  aoeRadius: WEAPONS[4].aoeRadius,
  vfx: 'concussion',
  damageColor: '#ff3344',
  trailColors: [
    new THREE.Color(1.0, 0.5, 0.3),
    new THREE.Color(0.9, 0.25, 0.15),
    new THREE.Color(0.6, 0.15, 0.2),
    new THREE.Color(0.3, 0.15, 0.2),
    new THREE.Color(0.25, 0.25, 0.28),
  ],
  // Heavy smoke column — reads as a fat slow shell, not a dart. Denser
  // than the baseline since the stale-emitter fix made trails honest:
  // the old chunky look came from a bug, this is the legitimate version.
  trailParticlesPerUnit: 2.4,
  trailLifeMin: 0.8,
  trailLifeMax: 1.4,
  trailSpread: 0.3,
  trailForwardSpread: 0.15,
  trailParticleGravity: 0.0,
  trailOpacity: 0.55,
  trailBaseSize: 0.2,
  trailSizeRange: 0.4,
  trailScaleMin: 0.7,
  trailScaleMax: 2.2,
  trailRampIn: 0.1,
  meshColor: 0xcc2233,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xff2233,
  glowOpacity: 0.3,
  glowScale: 1.2,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.4,
  terrainOffset: WEAPONS[4].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[4].maxLifetime,
  bounces: true,
  bounceSfx: 'hg_clang',
  bounceRestitution: 0.25, // T2 BounceVelocityModifier — mortars thud, not skip
  bounceFriction: 0.7,
  armTime: 1.5, // T2 FuseTimer: bounce before this, detonate after
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.6,
  ribbonLife: 0.4,
  ribbonColor: 0xcc3333,
};
