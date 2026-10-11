import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

export const BOLT_CONFIG: ProjectileConfig = {
  name: 'rocket',
  displayName: 'Bolt Launcher',
  weaponType: 0,
  speed: WEAPONS[0].speed,
  gravity: WEAPONS[0].gravity,
  explosionRadius: WEAPONS[0].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[0].knockbackForce, // shared table — must match server AOE impulse
  forceMode: 'push',
  bodyRadius: WEAPONS[0].bodyRadius,
  hitMin: WEAPONS[0].hitMin,
  hitMax: WEAPONS[0].hitMax,
  hitGrow: WEAPONS[0].hitGrow,
  maxLifetime: WEAPONS[0].maxLifetime,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[0].aoeDamage,
  aoeRadius: WEAPONS[0].aoeRadius,
  damageColor: '#ffd700',
  trailColors: [
    new THREE.Color(1, 0.7, 0.1),
    new THREE.Color(1, 0.4, 0),
    new THREE.Color(0.8, 0.2, 0.1),
    new THREE.Color(0.5, 0.25, 0.2),
    new THREE.Color(0.35, 0.35, 0.4),
  ],
  trailParticlesPerUnit: 2,
  trailLifeMin: 1.2,
  trailLifeMax: 1.8,
  trailSpread: 0.34,
  trailForwardSpread: 0.2,
  trailParticleGravity: 0.02,
  trailOpacity: 0.45,
  trailBaseSize: 0.12,
  trailSizeRange: 0.34,
  trailScaleMin: 0.6,
  trailScaleMax: 1.8,
  trailRampIn: 0.1,
  meshColor: 0xFF_DD_44,
  meshType: 'rocket',
  glowShell: true,
  glowColor: 0xFF_44_00,
  // Vapor-cone collar like the disc — the collar radius IS the wake
  // hitbox (coupled in projectileVisuals); glowScale only sizes the
  // skirt's trailing length. Opacity runs hotter than the old sphere:
  // the filament map eats most of the additive fill.
  glowOpacity: 0.6,
  glowScale: 0.8,
  glowShape: 'wakeCone',
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: WEAPONS[0].hitMin,
  needsServerTracking: true,
  ribbonTrail: true,
  ribbonWidth: 0.55,
  ribbonLife: 0.3,
  // Emitter ramp-in — streak spawns at 10% width+life, full over 0.1s,
  // so a fresh shot isn't a fat ribbon in the face at the muzzle.
  ribbonRampIn: 0.2,
  ribbonColor: 0xFF_77_33,
};
