import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Belt throws — the C-key item slot. Each is a fuse/contact explosive or a
// kinetic dart; stats live in shared/weapons.ts keyed by weaponType.

const SMOKE_TRAIL = [
  new THREE.Color(1, 0.9, 0.5),
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
    trailParticleGravity: 0,
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
export const CLUSTER_CONFIG: ProjectileConfig = beltBall(19, 0x3D_4A_2A, 0x99_FF_44, {
  displayName: 'Cluster Bomb',
  damageColor: '#aaff66',
  glowColor: 0x88_FF_33,
  cluster: { count: 5, spread: 1.2, fuse: 1.1 },
});

// Bomblet — spawned by the carrier's detonation, never fired. speed is
// ignored (velocity comes from the scatter math); fuse pops it.
export const BOMBLET_CONFIG: ProjectileConfig = beltBall(22, 0x2A_2D_24, 0xCC_FF_66, {
  displayName: 'Bomblet',
  damageColor: '#aaff66',
  glowColor: 0xCC_FF_66,
  glowOpacity: 0.5,
  needsServerTracking: false, // visual-only — damage is the server's cluster scatter
});

// Javelin: a fast near-flat dart — no splash, precision throw. The whole
// sell is SPEED: a fat bright streak behind a real spear, not a dust puff.
export const JAVELIN_CONFIG: ProjectileConfig = {
  ...beltBall(20, 0x8A_8F_96, 0xCC_DD_FF, { displayName: 'Javelin' }),
  meshType: 'javelin', // real spear — shaft + flared tip, ~2m long
  noExplosion: true,  // contact is a thunk + bullet mark, not a blast
  embeds: 2,        // planted for 2s, then shrinks away
  damageColor: '#ccddff',
  trailOpacity: 0.5,
  trailParticlesPerUnit: 1.6, // was ~1 — a thrown spear wants a readable wake
  // Triple ribbon lane (wide band + bright core pair) — the power-throw
  // streak that sells "this one's lethal".
  ribbonTrail: true,
  ribbonLanes: 3,
  ribbonWidth: 0.34,
  ribbonLife: 0.6,
  ribbonColor: 0x9D_B8_FF,
};

// Impact grenade: bright cyan shell, flat long arc, pops on touch,
// outsized shove. The movement tool.
export const IMPACT_CONFIG: ProjectileConfig = beltBall(21, 0x2A_4A_4D, 0x44_FF_EE, {
  displayName: 'Impact Grenade',
  vfx: 'bolt', // touch-pop — compact snap sells the movement tool
  damageColor: '#66ffee',
  glowColor: 0x44_FF_EE,
});
