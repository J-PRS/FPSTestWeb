import * as THREE from 'three';

import { makeProjectileConfig } from './makeConfig.js';

// EMP grenade: timer-based fuse bomb — 0 damage, drains all jet energy
// and strips shield in the blast radius. Cool cyan/electric VFX.
export const EMP_CONFIG = makeProjectileConfig(39, {
  name: 'emp',
  displayName: 'EMP Grenade',
  damageColor: '#44ffff',
  vfx: 'energy',
  trailColors: [
    new THREE.Color(0.3, 1, 1),
    new THREE.Color(0.2, 0.85, 1),
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
  meshColor: 0x1A_2A_3A,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x00_FF_FF,
  glowOpacity: 0.55,
  glowScale: 0.8,
  meshRampIn: true,
  meshRampInDuration: 0.04,
  meshStartScale: 0.15,
  needsServerTracking: true,
  bounceSfx: 'hg_clang',
  trailMeshType: 'sphere',
});