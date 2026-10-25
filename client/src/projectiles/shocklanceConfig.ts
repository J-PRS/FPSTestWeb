import * as THREE from 'three';

import { WEAPONS, WeaponType } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Shocklance — a slot entry + stat/color lookup, never instantiated as a
// Projectile. The zap is a one-shot hitscan in combat/shocklance.ts;
// ballistic fields are inert but present so the type is satisfied.
const S = WEAPONS[WeaponType.Shocklance];
export const SHOCKLANCE_CONFIG: ProjectileConfig = {
  name: 'shocklance',
  displayName: 'Lance',
  weaponType: WeaponType.Shocklance,
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
  damageColor: '#c080ff', // plasma violet — distinct from the LG's blue
  trailColors: [new THREE.Color(0.75, 0.5, 1)],
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
  meshColor: 0xC0_80_FF,
  meshType: 'rocket',
  glowShell: false,
  glowColor: 0xC0_80_FF,
  glowOpacity: 0,
  meshRampIn: false,
  meshRampInDuration: 0,
  meshStartScale: 1,
  terrainOffset: 0,
  maxLifetime: 0.3,
  needsServerTracking: false, // no projectile id — the intent resolves on the server ray
  noExplosion: true,
};
