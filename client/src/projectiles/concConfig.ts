import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Concussion grenade: pale stun-shell read — cold white-blue, a dense
// sparkle trail. Fuse bomb like the frag grenade: armTime == fuse so it
// never arms — bodies phase through, dirt only bounces it, and the 1.5s
// timer pops the flag-strip envelope. Visual sibling of the frag but
// icy instead of ember — players should tell them apart mid-flight.
const S = WEAPONS[34]; // WeaponType.Concussion

export const CONC_CONFIG: ProjectileConfig = {
  name: 'concussion',
  displayName: 'Concussion Grenade',
  weaponType: 34,
  speed: S.speed,
  gravity: S.gravity,
  explosionRadius: S.aoeRadius * AOE_VFX_SCALE,
  force: S.knockbackForce,
  forceMode: 'push',
  bodyRadius: S.bodyRadius,
  hitMin: S.hitMin,
  hitMax: S.hitMax,
  hitGrow: S.hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: S.aoeDamage,
  aoeRadius: S.aoeRadius,
  damageColor: '#aaeeff',
  trailColors: [
    new THREE.Color(0.8, 0.95, 1.0),
    new THREE.Color(0.55, 0.8, 1.0),
    new THREE.Color(0.35, 0.55, 0.9),
    new THREE.Color(0.25, 0.35, 0.6),
    new THREE.Color(0.2, 0.22, 0.3),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.3,
  trailLifeMax: 0.6,
  trailSpread: 0.1,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0.0,
  trailOpacity: 0.5,
  trailBaseSize: 0.06,
  trailSizeRange: 0.14,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0x39434e, // cold gunmetal shell — frost glow, not ember heat
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x88ddff,
  glowOpacity: 0.45,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: S.hitMin,
  needsServerTracking: true,
  maxLifetime: S.maxLifetime,
  // armTime == fuse ⇒ never arms — bodies phase through, terrain bounces.
  armTime: S.armTime,
  bounces: S.terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: S.bounceRestitution,
  bounceFriction: S.bounceFriction,
  trailMeshType: 'sphere',
};
