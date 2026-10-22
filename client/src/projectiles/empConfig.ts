import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// EMP grenade: timer-based fuse bomb — 0 damage, drains all jet energy
// and strips shield in the blast radius. Electric cyan VFX — distinct
// from the conc's icy white-blue and the frag's ember. The pulse should
// read as a shockwave, not an explosion.
const { 39: S } = WEAPONS; // WeaponType.EMP

export const EMP_CONFIG: ProjectileConfig = {
  name: 'emp',
  displayName: 'EMP Grenade',
  weaponType: 39,
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
  damageColor: '#44ffff',
  vfx: 'energy',
  trailColors: [
    new THREE.Color(0.3, 1.0, 1.0),
    new THREE.Color(0.2, 0.85, 1.0),
    new THREE.Color(0.15, 0.6, 0.9),
    new THREE.Color(0.1, 0.4, 0.7),
    new THREE.Color(0.08, 0.2, 0.4),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.2,
  trailLifeMax: 0.5,
  trailSpread: 0.08,
  trailForwardSpread: 0.03,
  trailParticleGravity: 0,
  trailOpacity: 0.6,
  trailBaseSize: 0.05,
  trailSizeRange: 0.12,
  trailScaleMin: 0.4,
  trailScaleMax: 1.2,
  trailRampIn: 0.04,
  meshColor: 0x1A_2A_3A, // dark shell — electric cyan glow
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x00_FF_FF,
  glowOpacity: 0.55,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.04,
  meshStartScale: 0.15,
  terrainOffset: S.hitMin,
  needsServerTracking: true,
  maxLifetime: S.maxLifetime,
  armTime: S.armTime,
  bounces: S.terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: S.bounceRestitution,
  bounceFriction: S.bounceFriction,
  trailMeshType: 'sphere',
};