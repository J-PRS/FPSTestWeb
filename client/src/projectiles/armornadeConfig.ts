import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE, WeaponType } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Belt armor grenade — a thrown charge that plates the blast zone instead
// of just breaking it. Visual language borrows the repair beam's green:
// the shell glows weld-arc green and the pop reads as plating, not fire.
export const ARMORNADE_CONFIG: ProjectileConfig = {
  name: 'armornade',
  displayName: 'Armor Grenade',
  weaponType: WeaponType.ArmorGrenade,
  speed: WEAPONS[WeaponType.ArmorGrenade].speed,
  gravity: WEAPONS[WeaponType.ArmorGrenade].gravity,
  explosionRadius: WEAPONS[WeaponType.ArmorGrenade].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[WeaponType.ArmorGrenade].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[WeaponType.ArmorGrenade].bodyRadius,
  hitMin: WEAPONS[WeaponType.ArmorGrenade].hitMin,
  hitMax: WEAPONS[WeaponType.ArmorGrenade].hitMax,
  hitGrow: WEAPONS[WeaponType.ArmorGrenade].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[WeaponType.ArmorGrenade].aoeDamage,
  aoeRadius: WEAPONS[WeaponType.ArmorGrenade].aoeRadius,
  vfx: 'energy',
  damageColor: '#66ffaa',
  trailColors: [
    new THREE.Color(0.6, 1, 0.75),
    new THREE.Color(0.3, 1, 0.5),
    new THREE.Color(0.15, 0.8, 0.4),
    new THREE.Color(0.1, 0.5, 0.3),
    new THREE.Color(0.15, 0.3, 0.25),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.4,
  trailLifeMax: 0.8,
  trailSpread: 0.1,
  trailForwardSpread: 0.05,
  trailParticleGravity: 0,
  trailOpacity: 0.55,
  trailBaseSize: 0.06,
  trailSizeRange: 0.15,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0x2A_3D_34, // dark shell — the glow reads as the charge inside
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x33_FF_88,
  glowOpacity: 0.45,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: WEAPONS[WeaponType.ArmorGrenade].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[WeaponType.ArmorGrenade].maxLifetime,
  trailMeshType: 'sphere',
};
