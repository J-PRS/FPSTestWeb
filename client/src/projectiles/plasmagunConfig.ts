import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Quake-style plasma gun: rapid volley of chunky cyan bolts — chaingun's
// cadence but a visible projectile with a fat body. Blue-shifted palette
// so it never reads as the green plasma cannon bolt.
const W = WEAPONS[23]; // WeaponType.PlasmaGun
export const PLASMAGUN_CONFIG: ProjectileConfig = {
  name: 'plasmagun',
  displayName: 'Plasma Gun',
  weaponType: 23,
  speed: W.speed,
  gravity: W.gravity,
  explosionRadius: W.aoeRadius * AOE_VFX_SCALE,
  force: W.knockbackForce,
  forceMode: 'push',
  bodyRadius: W.bodyRadius,
  hitMin: W.hitMin,
  hitMax: W.hitMax,
  hitGrow: W.hitGrow,
  maxLifetime: W.maxLifetime,
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: W.aoeDamage,
  aoeRadius: W.aoeRadius,
  damageColor: '#66ccff',
  trailColors: [
    new THREE.Color(0.4, 0.8, 1.0),
    new THREE.Color(0.1, 0.6, 1.0),
    new THREE.Color(0.0, 0.4, 0.8),
    new THREE.Color(0.05, 0.2, 0.5),
  ],
  trailParticlesPerUnit: 0.6, // a volley × 7.7/s — keep the trail sparse
  trailLifeMin: 0.2,
  trailLifeMax: 0.4,
  trailSpread: 0.06,
  trailForwardSpread: 0.03,
  trailParticleGravity: 0,
  trailOpacity: 0.45,
  trailBaseSize: 0.08,
  trailSizeRange: 0.12,
  trailScaleMin: 0.5,
  trailScaleMax: 1.2,
  trailRampIn: 0.02,
  meshColor: 0x66ddff,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x44bbff,
  glowOpacity: 0.5,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.02,
  meshStartScale: 0.6,
  terrainOffset: W.hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.18,
  ribbonLife: 0.1,
  ribbonColor: 0x44bbff,
};
