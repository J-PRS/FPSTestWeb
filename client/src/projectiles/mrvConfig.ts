import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
  MRV_BOUNCE_RESTITUTION, MRV_BOUNCE_FRICTION,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// MRV launcher: the mortar's counterpart. A mortar puts ONE big shell
// on one spot; the MRV puts a burst of small shells over an AREA — a
// bouncing carrier that airbursts at ~1s into a rain of contact bombs
// (MRV = multiple rounds, one volley — NOT MIRV: the bomblets aren't
// independently targeted, they scatter off the same carrier).
//
// Same lob physics as the mortar (55 m/s, gravity, bounces until fuse)
// so the read transfers: aim the carrier line, the airburst footprint
// does the area denial.
const W = WEAPONS[28];   // MRVLauncher (carrier)
const WB = WEAPONS[29];  // MRVBomblet (airburst child)

// Bomblet visual — spawns only on carrier detonation, contact-pops on
// whatever it lands on. Untracked: damage is the server's cluster
// scatter at the burst point; a client claim would bounce off
// projectile resolution.
export const MRV_BOMBLET_CONFIG: ProjectileConfig = {
  name: 'mrv-bomblet',
  displayName: 'MRV Bomblet',
  weaponType: 29,
  speed: 0, // velocity comes from the scatter math, not the muzzle
  gravity: true,
  explosionRadius: WB.aoeRadius * AOE_VFX_SCALE,
  force: WB.knockbackForce,
  forceMode: 'push',
  bodyRadius: WB.bodyRadius,
  hitMin: WB.hitMin,
  hitMax: WB.hitMax,
  hitGrow: WB.hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WB.aoeDamage,
  aoeRadius: WB.aoeRadius,
  vfx: 'bolt', // compact snap — the punch is the count, not each blast
  damageColor: '#ff8833',
  trailColors: [
    new THREE.Color(1.0, 0.6, 0.25),
    new THREE.Color(0.8, 0.35, 0.15),
    new THREE.Color(0.4, 0.25, 0.2),
  ],
  trailParticlesPerUnit: 0.6,
  trailLifeMin: 0.2,
  trailLifeMax: 0.45,
  trailSpread: 0.08,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0.0,
  trailOpacity: 0.4,
  trailBaseSize: 0.06,
  trailSizeRange: 0.15,
  trailScaleMin: 0.5,
  trailScaleMax: 1.2,
  trailRampIn: 0,
  meshColor: 0x8a2a18,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xff5522,
  glowOpacity: 0.45,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.25,
  terrainOffset: 0.1,
  needsServerTracking: false,
  maxLifetime: WB.maxLifetime,
  trailMeshType: 'sphere',
  // Falling rain has to READ — a bare 0.15m ball at 30+ m/s is invisible.
  ribbonTrail: true,
  ribbonWidth: 0.18,
  ribbonLife: 0.3,
  ribbonColor: 0xff7733,
};

export const MRV_CONFIG: ProjectileConfig = {
  name: 'mrv',
  displayName: 'MRV Launcher',
  weaponType: 28,
  speed: W.speed,
  gravity: W.gravity,
  explosionRadius: W.aoeRadius * AOE_VFX_SCALE,
  force: W.knockbackForce,
  forceMode: 'push',
  bodyRadius: W.bodyRadius,
  hitMin: W.hitMin,
  hitMax: W.hitMax,
  hitGrow: W.hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: W.aoeDamage,
  aoeRadius: W.aoeRadius,
  vfx: 'concussion',
  damageColor: '#ff6622',
  trailColors: [
    new THREE.Color(1.0, 0.65, 0.3),
    new THREE.Color(0.9, 0.4, 0.15),
    new THREE.Color(0.55, 0.25, 0.15),
    new THREE.Color(0.3, 0.2, 0.18),
  ],
  trailParticlesPerUnit: 1.2,
  trailLifeMin: 0.5,
  trailLifeMax: 0.9,
  trailSpread: 0.2,
  trailForwardSpread: 0.1,
  trailParticleGravity: 0.0,
  trailOpacity: 0.45,
  trailBaseSize: 0.12,
  trailSizeRange: 0.3,
  trailScaleMin: 0.6,
  trailScaleMax: 1.8,
  trailRampIn: 0.05,
  meshColor: 0xb84a18,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xff6633,
  glowOpacity: 0.3,
  glowScale: 1.1,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.4,
  terrainOffset: 0.12,
  needsServerTracking: true,
  maxLifetime: W.maxLifetime, // fuse pop = the airburst, ~1s in
  bounces: true,
  bounceSfx: 'hg_clang',
  bounceRestitution: MRV_BOUNCE_RESTITUTION,
  bounceFriction: MRV_BOUNCE_FRICTION,
  // No fuse — bomblets are CONTACT bombs: they fall until they hit
  // something (terrain, wall, body), the carrier's own 10s safety TTL is
  // the only timer. A mid-air fuse pops the rain where nobody is.
  // Full carrier-velocity inherit + uniform sphere scatter — bomblets
  // ride the arc as a cloud, then rain down and contact-pop at different
  // times instead of flash-popping in unison.
  cluster: { count: 6, spread: 1.0, sphere: true },
  // The carrier is a delivery truck, not a shell — contact pops would
  // make it a 55 m/s mortar with a bonus bomblet rain. Fuse or GTFO.
  passThroughTargets: W.fuseOnly,
  bomblet: MRV_BOMBLET_CONFIG,
  trailMeshType: 'sphere',
  ribbonTrail: true,
  ribbonWidth: 0.5,
  ribbonLife: 0.35,
  ribbonColor: 0xcc5522,
};
