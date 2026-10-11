import * as THREE from 'three';

import { WEAPONS, WeaponType } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Lightning gun — a slot entry + stat/color lookup, never instantiated as a
// Projectile. The beam is a hitscan path in combat.ts; ballistic fields are
// inert but present so the type is satisfied.
const S = WEAPONS[WeaponType.Lightning];
export const LIGHTNING_CONFIG: ProjectileConfig = {
  name: 'lightning',
  displayName: 'Lightning Gun',
  weaponType: WeaponType.Lightning,
  speed: 0,
  gravity: false,
  explosionRadius: 0,
  force: S.knockbackForce,
  forceMode: 'push',
  bodyRadius: 0,
  hitMin: 0,
  hitMax: 0,
  hitGrow: 0,
  forceMultiplier: 1,
  aoeDamage: S.aoeDamage,
  aoeRadius: S.aoeRadius,
  vfx: 'arc',
  damageColor: '#8fdcff', // Quake-LG electric blue — readable at a glance
  trailColors: [new THREE.Color(0.6, 0.85, 1)],
  trailParticlesPerUnit: 0,
  trailLifeMin: 0,
  trailLifeMax: 0,
  trailSpread: 0,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0,
  trailBaseSize: 0,
  trailSizeRange: 0,
  trailScaleMin: 0,
  trailScaleMax: 0,
  trailRampIn: 0,
  meshColor: 0x8F_DC_FF,
  meshType: 'rocket',
  glowShell: false,
  glowColor: 0x8F_DC_FF,
  glowOpacity: 0,
  meshRampIn: false,
  meshRampInDuration: 0,
  meshStartScale: 1,
  terrainOffset: 0,
  needsServerTracking: false, // no projectile id — claims go through aoeShot
  noExplosion: true,
};
