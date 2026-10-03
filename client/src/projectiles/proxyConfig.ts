import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Proxy grenade: a 1-second belt throw whose trigger bubble inflates to
// 4m over its whole fuse — the wake IS the weapon. Visually it's a small
// pulsing sensor ball; the threat read is the expanding glow, not size.
const W = WEAPONS[32]; // WeaponType.ProxyGrenade
export const PROXY_CONFIG: ProjectileConfig = {
  name: 'proxy',
  displayName: 'Proxy Grenade',
  weaponType: 32,
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
  damageColor: '#ffcc44',
  // Sensor ping trail — faint amber dots, sparse so the throw line reads
  // without smearing the 1s arc.
  trailColors: [
    new THREE.Color(1.0, 0.8, 0.3),
    new THREE.Color(1.0, 0.65, 0.15),
    new THREE.Color(0.9, 0.45, 0.05),
    new THREE.Color(0.5, 0.3, 0.1),
  ],
  trailParticlesPerUnit: 0.8,
  trailLifeMin: 0.15,
  trailLifeMax: 0.35,
  trailSpread: 0.06,
  trailForwardSpread: 0.04,
  trailParticleGravity: 0.0,
  trailOpacity: 0.5,
  trailBaseSize: 0.07,
  trailSizeRange: 0.1,
  trailScaleMin: 0.6,
  trailScaleMax: 1.3,
  trailRampIn: 0.02,
  meshColor: 0x554a33, // drab shell — the hot amber glow does the talking
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xffbb33,
  glowOpacity: 0.65, // hotter than a fuse nade — it's a sensor armed to pop
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.04,
  meshStartScale: 0.3,
  terrainOffset: W.hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
};
