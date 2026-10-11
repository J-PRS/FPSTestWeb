import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Satchel charge: the infiltrator's planted bomb — sticks only on TRUE contact
// (no proxy wake: brush past it and you're fine, touch it and it's yours)
// and cooks off on a slow 4s fuse. The lob is deliberately anemic: you
// can't toss this over a wall, you have to walk it in. Visually a fat
// dark puck with a hot red glow — a planted bomb should read as planted.
const W = WEAPONS[33]; // WeaponType.SatchelCharge
export const SATCHEL_CONFIG: ProjectileConfig = {
  name: 'satchel',
  displayName: 'Satchel Charge',
  weaponType: 33,
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
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: W.aoeDamage,
  aoeRadius: W.aoeRadius,
  damageColor: '#ff5544',
  // Short sputtering fuse-spark trail — it barely flies, so the trail is
  // brief and hot rather than a streak.
  trailColors: [
    new THREE.Color(1, 0.4, 0.25),
    new THREE.Color(0.9, 0.25, 0.15),
    new THREE.Color(0.6, 0.15, 0.1),
    new THREE.Color(0.3, 0.1, 0.08),
  ],
  trailParticlesPerUnit: 1.2,
  trailLifeMin: 0.2,
  trailLifeMax: 0.45,
  trailSpread: 0.08,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0.4, // sparks droop — fuse smoke, not a contrail
  trailOpacity: 0.45,
  trailBaseSize: 0.08,
  trailSizeRange: 0.14,
  trailScaleMin: 0.5,
  trailScaleMax: 1.2,
  trailRampIn: 0.04,
  meshColor: 0x3A_2E_28, // dark casement — the red glow reads as the armed light
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xFF_33_22,
  glowOpacity: 0.7,
  glowScale: 0.9,
  meshRampIn: true,
  meshRampInDuration: 0.06,
  meshStartScale: 0.4,
  terrainOffset: W.hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
  sticks: true,
};
