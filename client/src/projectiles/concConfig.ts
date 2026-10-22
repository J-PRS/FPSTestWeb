import * as THREE from 'three';

import { makeProjectileConfig } from './makeConfig.js';

// Concussion grenade: pale stun-shell read — cold white-blue, a dense
// sparkle trail. Fuse bomb like the frag grenade: armTime == fuse so it
// never arms — bodies phase through, dirt only bounces it, and the 1.5s
// timer pops the flag-strip envelope. Visual sibling of the frag but
// icy instead of ember — players should tell them apart mid-flight.
export const CONC_CONFIG = makeProjectileConfig(34, {
  name: 'concussion',
  displayName: 'Concussion Grenade',
  damageColor: '#aaeeff',
  vfx: 'concussion',
  trailColors: [
    new THREE.Color(0.8, 0.95, 1),
    new THREE.Color(0.55, 0.8, 1),
    new THREE.Color(0.35, 0.55, 0.9),
    new THREE.Color(0.25, 0.35, 0.6),
    new THREE.Color(0.2, 0.22, 0.3),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.3,
  trailLifeMax: 0.6,
  trailSpread: 0.1,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0,
  trailOpacity: 0.5,
  trailBaseSize: 0.06,
  trailSizeRange: 0.14,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0x39_43_4E,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x88_DD_FF,
  glowOpacity: 0.45,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  needsServerTracking: true,
  bounceSfx: 'hg_clang',
  trailMeshType: 'sphere',
});