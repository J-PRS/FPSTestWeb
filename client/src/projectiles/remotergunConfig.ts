import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Remote railgun — a belt-thrown capacitor slug. It lobs like a weak
// impact nade for ~0.4s, then discharges a railgun-class hitscan beam
// along its velocity and detonates at whatever the beam touches. The
// hang time is the tell: leading the throw IS aiming the rail.
const W = WEAPONS[24]; // WeaponType.RemoteRailgun
export const REMOTE_RAILGUN_CONFIG: ProjectileConfig = {
  name: 'remoterailgun',
  displayName: 'Remote Railgun',
  weaponType: 24,
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
  falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_DEFAULT,
  collisionMultiplier: 1.0,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: W.aoeDamage,
  aoeRadius: W.aoeRadius,
  rayBurst: W.rayDelay !== undefined && W.rayRange !== undefined
    ? { delay: W.rayDelay, range: W.rayRange }
    : undefined,
  vfx: 'kinetic',
  damageColor: '#99eeff',
  trailColors: [
    new THREE.Color(0.6, 0.95, 1.0),
    new THREE.Color(0.3, 0.8, 1.0),
    new THREE.Color(0.1, 0.5, 0.9),
    new THREE.Color(0.05, 0.25, 0.5),
  ],
  trailParticlesPerUnit: 0.9,
  trailLifeMin: 0.15,
  trailLifeMax: 0.3,
  trailSpread: 0.04,
  trailForwardSpread: 0.02,
  trailParticleGravity: 0,
  trailOpacity: 0.55,
  trailBaseSize: 0.09,
  trailSizeRange: 0.1,
  trailScaleMin: 0.5,
  trailScaleMax: 1.1,
  trailRampIn: 0.02,
  meshColor: 0x99eeff,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0x77ddff,
  glowOpacity: 0.7,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.02,
  meshStartScale: 0.7,
  terrainOffset: W.hitMin,
  needsServerTracking: true,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.12,
  ribbonLife: 0.08,
  ribbonColor: 0x77ddff,
};
