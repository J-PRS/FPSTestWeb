import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// RPG missile: flat-trajectory, deliberately slow, big warhead boom.
// Smoke-column trail is the whole read — a rocket announces itself.
export const RKT_CONFIG: ProjectileConfig = {
  name: 'rocketLauncher',
  displayName: 'Rocket Launcher',
  weaponType: 15,
  speed: WEAPONS[15].speed,
  gravity: WEAPONS[15].gravity,
  explosionRadius: WEAPONS[15].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[15].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[15].bodyRadius,
  hitMin: WEAPONS[15].hitMin,
  hitMax: WEAPONS[15].hitMax,
  hitGrow: WEAPONS[15].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[15].aoeDamage,
  aoeRadius: WEAPONS[15].aoeRadius,
  vfx: 'concussion',
  damageColor: '#ffaa55',
  // Thick exhaust column — hot orange at the motor, drying to grey smoke.
  // MRV-inspired linger: at 2.5s cadence each missile is an event, so the
  // smoke column hangs around to read the flight line after it's gone.
  trailColors: [
    new THREE.Color(1.0, 0.6, 0.15),
    new THREE.Color(0.9, 0.45, 0.1),
    new THREE.Color(0.6, 0.55, 0.5),
    new THREE.Color(0.45, 0.45, 0.45),
    new THREE.Color(0.35, 0.35, 0.38),
  ],
  trailParticlesPerUnit: 4,
  trailLifeMin: 1.2,
  trailLifeMax: 2.6,
  trailSpread: 0.4,
  trailForwardSpread: 0.15,
  trailParticleGravity: -0.5, // smoke RISES off the line
  trailOpacity: 0.55,
  trailBaseSize: 0.2,
  trailSizeRange: 0.5,
  trailScaleMin: 0.8,
  trailScaleMax: 3.0,
  trailRampIn: 0.1,
  meshColor: 0x3d4a35, // military olive — ordnance, not energy
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xff5500, // burning motor at the tail
  glowOpacity: 0.35,
  glowScale: 0.9,
  // Billboard streak like the MRV carrier — the missile's flight line
  // reads at range, not just its smoke puffs.
  ribbonTrail: true,
  ribbonWidth: 0.55,
  ribbonLife: 0.5,
  ribbonColor: 0xff6622,
  terrainOffset: WEAPONS[15].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[15].maxLifetime,
};
