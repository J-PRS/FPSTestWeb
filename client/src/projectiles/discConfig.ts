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
  maxLifetime: WEAPONS[1].maxLifetime,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[1].aoeDamage,
  aoeRadius: WEAPONS[1].aoeRadius,
  vfx: 'energy',
  damageColor: '#00ffff',
  trailColors: [
    new THREE.Color(0, 0.5, 1),
    new THREE.Color(0, 0.3, 0.8),
    new THREE.Color(0, 0.2, 0.6),
    new THREE.Color(0, 0.1, 0.4),
    new THREE.Color(0, 0.05, 0.2),
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
  meshColor: 0x00_FF_FF,
  meshType: 'disc',
  glowShell: true,
  glowColor: 0x00_FF_FF,
  // Additive + alphaMap: the map's filament streaks eat most of the
  // fill, so opacity runs hotter than the sphere needed to read.
  glowOpacity: 0.9,
  // Vapor-cone collar instead of the proxy bubble — apex at the disc,
  // energy skirt flaring back along the flight line. The collar radius
  // IS the live wake hitbox (projectileVisuals couples them); this only
  // sizes the skirt's trailing length, never the reach.
  glowScale: 1,
  glowShape: 'wakeCone',
  meshRampIn: true,
  meshRampInDuration: 0.15,
  meshStartScale: 0.25,
  terrainOffset: 0.2,
  needsServerTracking: true,
  trailMeshType: 'billboard',
  ribbonTrail: true,
  ribbonWidth: 0.6,
  ribbonLife: 0.35,
  ribbonColor: 0x00_66_FF,
};

// Belt disc (C) — the implosion variant. Same flight/damage, opposite force:
// sucks targets toward the blast instead of scattering them.
export const BELT_DISC_CONFIG: ProjectileConfig = Object.assign({}, DISC_CONFIG, {name: 'beltDisc',displayName: 'Implodisc',weaponType: WeaponType.Implodisc,force: WEAPONS[WeaponType.Implodisc].knockbackForce,forceMode: 'pull',forceMultiplier: PULL_MULTIPLIER,aoeDamage: WEAPONS[WeaponType.Implodisc].aoeDamage,aoeRadius: WEAPONS[WeaponType.Implodisc].aoeRadius});

// BeltDisc — the plain push belt disc: same flight, knocks back.
export const BELT_DISC_PUSH_CONFIG: ProjectileConfig = Object.assign({}, DISC_CONFIG, {name: 'beltDiscPush',displayName: 'Belt Disc',weaponType: WeaponType.BeltDisc,force: WEAPONS[WeaponType.BeltDisc].knockbackForce,forceMode: 'push',aoeDamage: WEAPONS[WeaponType.BeltDisc].aoeDamage,aoeRadius: WEAPONS[WeaponType.BeltDisc].aoeRadius});
