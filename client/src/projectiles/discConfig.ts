import * as THREE from 'three';

import {
  
  KNOCKBACK_MULTIPLIER, PULL_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE, WeaponType } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Launcher disc (slot): normal knockback blast. Belt disc (C): implosion.
export const DISC_CONFIG: ProjectileConfig = {
  name: 'disc',
  displayName: 'Disc Launcher',
  weaponType: 1,
  speed: WEAPONS[1].speed,
  gravity: WEAPONS[1].gravity,
  explosionRadius: WEAPONS[1].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[1].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[1].bodyRadius,
  hitMin: WEAPONS[1].hitMin,
  hitMax: WEAPONS[1].hitMax,
  hitGrow: WEAPONS[1].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[1].aoeDamage,
  aoeRadius: WEAPONS[1].aoeRadius,
  vfx: 'energy',
  damageColor: '#00ffff',
  trailColors: [
    new THREE.Color(0.0, 0.5, 1.0),
    new THREE.Color(0.0, 0.3, 0.8),
    new THREE.Color(0.0, 0.2, 0.6),
    new THREE.Color(0.0, 0.1, 0.4),
    new THREE.Color(0.0, 0.05, 0.2),
  ],
  trailParticlesPerUnit: 2,
  trailLifeMin: 0.8,
  trailLifeMax: 1.2,
  trailSpread: 0.05,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0.5,
  trailBaseSize: 0.1,
  trailSizeRange: 0.2,
  trailScaleMin: 0.5,
  trailScaleMax: 1.5,
  trailRampIn: 0,
  meshColor: 0x00ffff,
  meshType: 'disc',
  glowShell: true,
  glowColor: 0x00ffff,
  glowOpacity: 0.22,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.15,
  meshStartScale: 0.25,
  terrainOffset: 0.2,
  needsServerTracking: true,
  trailMeshType: 'billboard',
  ribbonTrail: true,
  ribbonWidth: 0.6,
  ribbonLife: 0.35,
  ribbonColor: 0x0066ff,
};

// Belt disc (C) — the implosion variant. Same flight/damage, opposite force:
// sucks targets toward the blast instead of scattering them.
export const BELT_DISC_CONFIG: ProjectileConfig = {
  ...DISC_CONFIG,
  name: 'beltDisc',
  weaponType: WeaponType.DiscPull,
  force: WEAPONS[WeaponType.DiscPull].knockbackForce,
  forceMode: 'pull',
  forceMultiplier: PULL_MULTIPLIER,
  aoeDamage: WEAPONS[WeaponType.DiscPull].aoeDamage,
  aoeRadius: WEAPONS[WeaponType.DiscPull].aoeRadius,
};
