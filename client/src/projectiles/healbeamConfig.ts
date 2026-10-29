import * as THREE from 'three';

import { WEAPONS } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Heal beam: the medic's pocket beam — same display-only config as the
// repair tool; the payload is HP on a teammate (HEALBEAM_* in shared/
// weapons), the ammo is jet energy. Ballistics fields inert.
export const HEALBEAM_CONFIG: ProjectileConfig = {
  name: 'healbeam',
  displayName: 'Heal Beam',
  weaponType: 30,
  speed: WEAPONS[30].speed,
  gravity: WEAPONS[30].gravity,
  explosionRadius: 0,
  force: 0,
  forceMode: 'push',
  bodyRadius: WEAPONS[30].bodyRadius,
  hitMin: WEAPONS[30].hitMin,
  hitMax: WEAPONS[30].hitMax,
  hitGrow: WEAPONS[30].hitGrow,
  forceMultiplier: 0,
  aoeDamage: 0,
  aoeRadius: 0,
  damageColor: '#8fd8ff',
  trailColors: [new THREE.Color(0.55, 0.85, 1)],
  trailParticlesPerUnit: 0,
  trailLifeMin: 0,
  trailLifeMax: 0,
  trailSpread: 0,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0.6,
  trailBaseSize: 0.04,
  trailSizeRange: 0.03,
  trailScaleMin: 0.3,
  trailScaleMax: 1,
  trailRampIn: 0,
  meshColor: 0x8F_D8_FF,
  meshType: 'rocket',
  glowShell: false,
  glowColor: 0x8F_D8_FF,
  glowOpacity: 0,
  meshRampIn: false,
  meshRampInDuration: 0,
  meshStartScale: 1,
  terrainOffset: 0.05,
  needsServerTracking: true,
  noExplosion: true,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonLanes: 1,
  ribbonWidth: 0.16,
  ribbonLife: 0.06,
  ribbonColor: 0x8F_D8_FF,
};
