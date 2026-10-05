import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Sprinkler: a plasma hose — same chunky-bolt family as the plasma gun but
// every shot arcs at half-mortar gravity inside a slight cone (the cone
// lives in weapons.ts as a per-shot jitter, not a pellet fan). Lime-green
// palette so a sprinkler volley never reads as blue plasma.
const W = WEAPONS[25]; // WeaponType.Sprinkler
export const SPRINKLER_CONFIG: ProjectileConfig = {
  name: 'sprinkler',
  displayName: 'Sprinkler',
  weaponType: 25,
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
  damageColor: '#aaff55',
  trailColors: [
    new THREE.Color(0.6, 1, 0.3),
    new THREE.Color(0.4, 0.9, 0.2),
    new THREE.Color(0.2, 0.7, 0.1),
    new THREE.Color(0.1, 0.4, 0.05),
  ],
  trailParticlesPerUnit: 0.5, // ~9/s stream — sparse or it smears
  trailLifeMin: 0.15,
  trailLifeMax: 0.35,
  trailSpread: 0.08,
  trailForwardSpread: 0.03,
  trailParticleGravity: 2, // droplets sag — sells the watering-can arc
  trailOpacity: 0.45,
  trailBaseSize: 0.08,
  trailSizeRange: 0.12,
  trailScaleMin: 0.5,
  trailScaleMax: 1.2,
  trailRampIn: 0.02,
  meshColor: 0xAAFF66,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x88FF44,
  glowOpacity: 0.5,
  glowScale: 0.7,
  meshRampIn: true,
  // Long ramp — the 9/s stream used to spawn near-full-size and screen-flood;
  // grow over 0.12s so the bolt is meters away before it's big.
  meshRampInDuration: 0.12,
  meshStartScale: 0.2,
  terrainOffset: W.hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.15,
  ribbonLife: 0.1,
  ribbonColor: 0x88FF44,
  vfx: 'splash', // watery burst, not a fireball — it's a hose
};
