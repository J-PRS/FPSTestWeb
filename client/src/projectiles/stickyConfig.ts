import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Sticky launcher: lobbed glue bombs that FREEZE on any contact and pop on
// a 3s fuse. The weapon's identity is the chain — one detonation cooks
// every sibling sticky in blast radius, so a stacked cluster is one huge
// overlapping boom, not three pops.
export const STICKY_CONFIG: ProjectileConfig = {
  name: 'stickyLauncher',
  displayName: 'Sticky Launcher',
  weaponType: 18,
  speed: WEAPONS[18].speed,
  gravity: WEAPONS[18].gravity,
  explosionRadius: WEAPONS[18].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[18].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[18].bodyRadius,
  hitMin: WEAPONS[18].hitMin,
  hitMax: WEAPONS[18].hitMax,
  hitGrow: WEAPONS[18].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[18].aoeDamage,
  aoeRadius: WEAPONS[18].aoeRadius,
  damageColor: '#ff7744',
  // Fuse-spark fizz: near-white sparks pop off the bomb and scatter
  // outward as they cool to ember — a lit fuse throws light, not a
  // wispy smoke wisp. Dense, hot, and short-lived.
  trailColors: [
    new THREE.Color(1, 0.85, 0.4),  // spark flash — almost white-hot
    new THREE.Color(1, 0.55, 0.15),
    new THREE.Color(0.95, 0.3, 0.08),
    new THREE.Color(0.55, 0.18, 0.06),
    new THREE.Color(0.25, 0.1, 0.05),
  ],
  trailParticlesPerUnit: 4,
  trailLifeMin: 0.15,
  trailLifeMax: 0.45,
  trailSpread: 0.35,          // sparks POP off the body, not trail politely
  trailForwardSpread: 0.25,
  trailParticleGravity: 0.6,  // embers rain — positive pulls them down
  trailOpacity: 0.85,
  trailBaseSize: 0.1,
  trailSizeRange: 0.22,
  trailScaleMin: 0.6,
  trailScaleMax: 1.8,
  trailRampIn: 0.03,
  // Thin hot streak along the flight line — the fizz needs a spine or it
  // reads as scattered sparks with no direction. Same trick the MRV
  // carrier and RPG use.
  ribbonTrail: true,
  ribbonLanes: 1, // single thin streak — the fizz particles carry the volume
  ribbonWidth: 0.22,
  ribbonLife: 0.3,
  ribbonColor: 0xFF7733,
  // Dark gunmetal shell + hot amber armed-light that pulses and quickens
  // on the fuse — reads "live ordnance", not gum. The pink trail is gone
  // with it; lobbed bombs shed embers instead.
  meshColor: 0x4A3A26,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0xFF5522,
  glowOpacity: 0.7,
  // Sits permanently just above the shell (pulse crests higher) — a live
  // amber halo so the bomb reads "armed" instead of inert cannonball.
  glowScale: 1.35,
  // Deeper depth so the blink CREST clears the resting halo — with the
  // base glow brightened, a shallow ±35% breathe just wobbles in place.
  glowPulse: { hz: 1.5, depth: 0.6, fuseRamp: true },
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.3,
  terrainOffset: WEAPONS[18].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[18].maxLifetime,
  trailMeshType: 'sphere',
  sticks: true,
};
