import * as THREE from 'three';

import { WEAPONS } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Pump pellet: fast straight slug with a short tracer — tighter cone than
// flak shards and ~3× the muzzle speed, so the burst lands as a pattern,
// not a scatter.
export const SHOTGUN_CONFIG: ProjectileConfig = {
  name: 'shotgun',
  displayName: 'Shotgun',
  weaponType: 13,
  speed: WEAPONS[13].speed,
  gravity: WEAPONS[13].gravity,
  explosionRadius: 0,
  force: 0,
  forceMode: 'push',
  bodyRadius: WEAPONS[13].bodyRadius,
  hitMin: WEAPONS[13].hitMin,
  hitMax: WEAPONS[13].hitMax,
  hitGrow: WEAPONS[13].hitGrow,
  forceMultiplier: 0,
  aoeDamage: 0,
  aoeRadius: 0,
  damageColor: '#ffcc66',
  trailColors: [
    new THREE.Color(1.0, 0.9, 0.5),
    new THREE.Color(1.0, 0.7, 0.3),
    new THREE.Color(0.8, 0.4, 0.1),
  ],
  trailParticlesPerUnit: 0, // ribbon tracers only — 10 particles/shot is fine, 110/s is not
  trailLifeMin: 0,
  trailLifeMax: 0,
  trailSpread: 0,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0.6,
  trailBaseSize: 0.04,
  trailSizeRange: 0.03,
  trailScaleMin: 0.3,
  trailScaleMax: 1.0,
  trailRampIn: 0,
  meshColor: 0xffbb55,
  meshType: 'rocket',
  glowShell: false,
  glowColor: 0xffbb55,
  glowOpacity: 0,
  meshRampIn: false,
  meshRampInDuration: 0,
  meshStartScale: 0.8,
  terrainOffset: 0.05,
  needsServerTracking: true,
  maxLifetime: WEAPONS[13].maxLifetime,
  noExplosion: true,
  trailMeshType: 'sphere',
  // Short warm tracer per pellet — the burst reads as a cone of streaks
  ribbonTrail: true,
  ribbonLanes: 1,
  ribbonWidth: 0.16,
  ribbonLife: 0.07,
  ribbonColor: 0xffaa44,
};
