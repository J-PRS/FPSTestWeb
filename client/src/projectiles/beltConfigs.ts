import * as THREE from 'three';

import {
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Belt throws — the C-key item slot. Each is a fuse/contact explosive or a
// kinetic dart; stats live in shared/weapons.ts keyed by weaponType.

const SMOKE_TRAIL = [
  new THREE.Color(1.0, 0.9, 0.5),
  new THREE.Color(0.7, 0.5, 0.3),
  new THREE.Color(0.4, 0.35, 0.3),
  new THREE.Color(0.25, 0.22, 0.2),
];

function beltBall(wt: number, shell: number, glow: number, extra: Partial<ProjectileConfig>): ProjectileConfig {
  const w = WEAPONS[wt];
  return {
    name: `belt-${wt}`,
    displayName: 'Belt',
    weaponType: wt,
    speed: w.speed,
    gravity: w.gravity,
    explosionRadius: w.aoeRadius * AOE_VFX_SCALE,
    force: w.knockbackForce,
    forceMode: 'push',
    bodyRadius: w.bodyRadius,
    hitMin: w.hitMin,
    hitMax: w.hitMax,
    hitGrow: w.hitGrow,
    falloffMultiplier: EXPLOSION_FALLOFF_MULTIPLIER_ROCKET,
    collisionMultiplier: 1.0,
    forceMultiplier: KNOCKBACK_MULTIPLIER,
    aoeDamage: w.aoeDamage,
    aoeRadius: w.aoeRadius,
    damageColor: '#ffb060',
    trailColors: SMOKE_TRAIL,
    trailParticlesPerUnit: 1,
    trailLifeMin: 0.3,
    trailLifeMax: 0.6,
    trailSpread: 0.1,
    trailForwardSpread: 0.05,
    trailParticleGravity: 0.0,
    trailOpacity: 0.45,
    trailBaseSize: 0.05,
    trailSizeRange: 0.12,
    trailScaleMin: 0.5,
    trailScaleMax: 1.3,
    trailRampIn: 0.05,
    meshColor: shell,
    meshType: 'ball',
    glowShell: true,
    glowColor: glow,
    glowOpacity: 0.4,
    glowScale: 0.7,
    meshRampIn: true,
    meshRampInDuration: 0.05,
    meshStartScale: 0.2,
    terrainOffset: w.hitMin,
    needsServerTracking: true,
    maxLifetime: w.maxLifetime,
    trailMeshType: 'sphere',
    ...extra,
  };
}

// Cluster bomb: dull green shell, fuse pop scatters bomblets upward.
export const CLUSTER_CONFIG: ProjectileConfig = beltBall(19, 0x3d4a2a, 0x99ff44, {
  displayName: 'Cluster Bomb',
  damageColor: '#aaff66',
  glowColor: 0x88ff33,
  cluster: { count: 5, spread: 0.9, fuse: 1.1 },
});

// Bomblet — spawned by the carrier's detonation, never fired. speed is
// ignored (velocity comes from the scatter math); fuse pops it.
export const BOMBLET_CONFIG: ProjectileConfig = beltBall(22, 0x2a2d24, 0xccff66, {
  displayName: 'Bomblet',
  damageColor: '#aaff66',
  glowColor: 0xccff66,
  glowOpacity: 0.5,
  needsServerTracking: false, // visual-only — damage is the server's cluster scatter
});

// Javelin: a fast near-flat dart — no splash, precision throw.
export const JAVELIN_CONFIG: ProjectileConfig = {
  ...beltBall(20, 0x8a8f96, 0xccddff, { displayName: 'Javelin' }),
  meshType: 'javelin', // real spear — shaft + flared tip, ~2m long
  noExplosion: true,  // contact is a thunk + bullet mark, not a blast
  embeds: 2.0,        // planted for 2s, then shrinks away
  damageColor: '#ccddff',
  trailOpacity: 0.25,
  // Single thin ribbon lane — the bolt-launcher line streak, not a smoke
  // plume; particles still ride alongside.
  ribbonTrail: true,
  ribbonLanes: 1,
  ribbonWidth: 0.16,
  ribbonLife: 0.3,
  ribbonColor: 0x9db8ff,
};

// Impact grenade: bright cyan shell, flat long arc, pops on touch,
// outsized shove. The movement tool.
export const IMPACT_CONFIG: ProjectileConfig = beltBall(21, 0x2a4a4d, 0x44ffee, {
  displayName: 'Impact Grenade',
  vfx: 'energy',
  damageColor: '#66ffee',
  glowColor: 0x44ffee,
});
