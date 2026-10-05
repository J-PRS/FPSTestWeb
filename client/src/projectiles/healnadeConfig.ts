import * as THREE from 'three';

import {
  KNOCKBACK_MULTIPLIER,
} from '../core/config.js';
import { WEAPONS, AOE_VFX_SCALE, WeaponType } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

// Belt heal grenade — a thrown med-charge: the pop coats allies in a
// strong heal while enemies caught eat only the sting + shove. Visual
// language is clean clinical cyan-white, distinct from the armornade's
// weld-arc green.
export const HEALNADE_CONFIG: ProjectileConfig = {
  name: 'healnade',
  displayName: 'Heal Grenade',
  weaponType: WeaponType.HealGrenade,
  speed: WEAPONS[WeaponType.HealGrenade].speed,
  gravity: WEAPONS[WeaponType.HealGrenade].gravity,
  explosionRadius: WEAPONS[WeaponType.HealGrenade].aoeRadius * AOE_VFX_SCALE,
  force: WEAPONS[WeaponType.HealGrenade].knockbackForce,
  forceMode: 'push',
  bodyRadius: WEAPONS[WeaponType.HealGrenade].bodyRadius,
  hitMin: WEAPONS[WeaponType.HealGrenade].hitMin,
  hitMax: WEAPONS[WeaponType.HealGrenade].hitMax,
  hitGrow: WEAPONS[WeaponType.HealGrenade].hitGrow,
  forceMultiplier: KNOCKBACK_MULTIPLIER,
  aoeDamage: WEAPONS[WeaponType.HealGrenade].aoeDamage,
  aoeRadius: WEAPONS[WeaponType.HealGrenade].aoeRadius,
  vfx: 'energy',
  damageColor: '#aaffee',
  trailColors: [
    new THREE.Color(0.6, 1, 0.95),
    new THREE.Color(0.35, 0.95, 0.8),
    new THREE.Color(0.2, 0.75, 0.65),
    new THREE.Color(0.1, 0.45, 0.45),
    new THREE.Color(0.15, 0.3, 0.35),
  ],
  trailParticlesPerUnit: 1,
  trailLifeMin: 0.35,
  trailLifeMax: 0.7,
  trailSpread: 0.1,
  trailForwardSpread: 0.05,
  trailParticleGravity: -0.15, // motes rise — the med-mist feel
  trailOpacity: 0.55,
  trailBaseSize: 0.06,
  trailSizeRange: 0.15,
  trailScaleMin: 0.5,
  trailScaleMax: 1.4,
  trailRampIn: 0.05,
  meshColor: 0x2A4440,
  meshType: 'ball',
  glowShell: true,
  glowColor: 0x55FFDD,
  glowOpacity: 0.5,
  glowScale: 0.7,
  meshRampIn: true,
  meshRampInDuration: 0.05,
  meshStartScale: 0.2,
  terrainOffset: WEAPONS[WeaponType.HealGrenade].hitMin,
  needsServerTracking: true,
  maxLifetime: WEAPONS[WeaponType.HealGrenade].maxLifetime,
  trailMeshType: 'sphere',
};
