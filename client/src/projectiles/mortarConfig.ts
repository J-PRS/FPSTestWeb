import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// T2 mortar: fat lobbed shell with an ARMING fuse - hits before ~1.5s
// bounce off the terrain (BounceVelocityModifier 0.25), armed shells
// detonate on contact. Point-blank shots bounce first, then pop -
// the T2 "suicide mortar" tactic lives or dies on this.
export const MORTAR_CONFIG: ProjectileConfig = {
  name: 'mortar',
  displayName: 'Mortar',
  weaponType: 4,
  speed: WEAPONS[4].speed,
  gravity: WEAPONS[4].gravity,
  explosionRadius: WEAPONS[4].aoeRadius * AOE_VFX_SCALE, // VFX = 80% of damage reach - the ring edge is the truth
  force: WEAPONS[4].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[4].bodyRadius,
  hitMin: WEAPONS[4].hitMin,
  hitMax: WEAPONS[4].hitMax, // tight proxy - the big splash is the forgiving part, not the wake
  hitGrow: WEAPONS[4].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[4].aoeDamage,
  aoeRadius: WEAPONS[4].aoeRadius,
  vfx: 'concussion',
  damageColor: '#ff3344',
  trailColors: [
    new THREE.Color(1, 0.5, 0.3),
    new THREE.Color(0.9, 0.25, 0.15),
    new THREE.Color(0.6, 0.15, 0.2),
    new THREE.Color(0.3, 0.15, 0.2),
    new THREE.Color(0.25, 0.25, 0.28),
  ],
  // Heavy smoke column - reads as a fat slow shell, not a dart. Denser
  // than the baseline since the stale-emitter fix made trails honest:
  // the old chunky look came from a bug, this is the legitimate version.
  trailParticlesPerUnit: 3,
  trailLifeMin: 0.8,
  trailLifeMax: 1.4,
  trailSpread: 0.45,
  trailForwardSpread: 0.15,
  trailParticleGravity: 0,
  trailOpacity: 0.55,
  trailBaseSize: 0.3,
  trailSizeRange: 0.4,
  trailScaleMin: 0.7,
  trailScaleMax: 3,
  trailRampIn: 0.1,
  meshColor: 0xCC_22_33,
  meshType: 'rocket',
  meshScale: 2, // fat lobbed silo - the shared rocket geo is dart-tuned
  meshStartScale: 0, // pop-in from zero - a 2x shell materializing at full size read as a glitch
  glowShell: true,
  glowColor: 0xFF_22_33,
  glowOpacity: 0.3,
  glowScale: 1.8,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  terrainOffset: WEAPONS[4].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[4].maxLifetime,
  bounces: WEAPONS[4].terrainBounce === true,
  bounceSfx: 'hg_clang',
  bounceRestitution: WEAPONS[4].bounceRestitution, // T2 BounceVelocityModifier - mortars thud, not skip
  bounceFriction: WEAPONS[4].bounceFriction,
  armTime: WEAPONS[4].armTime, // T2 FuseTimer: shared authority - bounce off dirt, phase through bodies before this
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 1.1,
  ribbonLife: 0.4,
  ribbonColor: 0xCC_33_33,
};

// Howitzer - the mortar's siege brother: same bounce/arming machinery,
// just re-pointed at the wt45 row (fat shell, longer dead-fuse, bigger
// boom). Fields not overridden ride WEAPONS[4] equivalents.
export const HOWITZER_CONFIG: ProjectileConfig = {
  ...MORTAR_CONFIG,
  name: 'howitzer',
  displayName: 'Howitzer',
  weaponType: 45,
  // Siege shell reads differently than the mortar's dart: hotter amber
  // shell + glow, wider ember trail - an artillery round, not a bomb.
  meshColor: 0xFF_88_22,
  glowColor: 0xFF_AA_33,
  glowScale: 2.2,
  ribbonColor: 0xFF_88_33,
  ribbonWidth: 1.4,
  damageColor: '#ffaa33',
  vfx: 'shellburst', // cannon-family blast: dirty flash + smoke + iron chips
  speed: WEAPONS[45].speed,
  explosionRadius: WEAPONS[45].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[45].knockbackForce,
  aoeDamage: WEAPONS[45].aoeDamage,
  aoeRadius: WEAPONS[45].aoeRadius,
  maxLifetime: WEAPONS[45].maxLifetime,
  armTime: WEAPONS[45].armTime,
};
