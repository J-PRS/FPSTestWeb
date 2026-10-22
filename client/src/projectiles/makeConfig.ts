import * as THREE from 'three';

import { WEAPONS, AOE_VFX_SCALE } from '../../../shared/weapons.js';
import type { WeaponStats } from '../../../shared/weaponTable.js';
import { KNOCKBACK_MULTIPLIER } from '../core/config.js';

import type { ProjectileConfig } from './types.js';

/** Cosmetic overrides that can't be derived from WeaponStats. */
export type ProjectileCosmetics = Partial<Omit<ProjectileConfig,
  'weaponType' | 'speed' | 'gravity' | 'explosionRadius' | 'force' | 'forceMode' |
  'bodyRadius' | 'hitMin' | 'hitMax' | 'hitGrow' | 'forceMultiplier' |
  'aoeDamage' | 'aoeRadius' | 'maxLifetime' | 'armTime' | 'bounces' |
  'bounceRestitution' | 'bounceFriction' | 'terrainOffset'>>;

/** Auto-generate a ProjectileConfig from shared WeaponStats + cosmetic overrides.
 *  Eliminates the ~15 lines of boilerplate core-field mapping per weapon.
 *  New weapons only need to specify cosmetics (colors, mesh type, trail, etc.).
 *
 *  Usage:
 *    export const EMP_CONFIG = makeProjectileConfig(WeaponType.EMP, {
 *      name: 'emp', displayName: 'EMP Grenade',
 *      damageColor: '#44ffff', vfx: 'energy',
 *      trailColors: [...], meshColor: 0x1A2A3A, ...
 *    });
 */
export function makeProjectileConfig(
  weaponType: number,
  cosmetics: ProjectileCosmetics & { name: string; displayName: string },
): ProjectileConfig {
  const S = WEAPONS[weaponType];
  if (!S) { throw new Error(`Unknown weapon type: ${weaponType}`); }
  const { name, displayName, damageColor, ...rest } = cosmetics;
  return {
    name,
    displayName,
    weaponType,
    speed: S.speed,
    gravity: S.gravity,
    explosionRadius: S.aoeRadius * AOE_VFX_SCALE,
    force: S.knockbackForce,
    forceMode: S.forceMode,
    bodyRadius: S.bodyRadius,
    hitMin: S.hitMin,
    hitMax: S.hitMax,
    hitGrow: S.hitGrow,
    forceMultiplier: KNOCKBACK_MULTIPLIER,
    aoeDamage: S.aoeDamage,
    aoeRadius: S.aoeRadius,
    damageColor: damageColor ?? '#ffffff',
    trailColors: rest.trailColors ?? [new THREE.Color(1, 1, 1)],
    trailParticlesPerUnit: rest.trailParticlesPerUnit ?? 1,
    trailLifeMin: rest.trailLifeMin ?? 0.3,
    trailLifeMax: rest.trailLifeMax ?? 0.6,
    trailSpread: rest.trailSpread ?? 0.1,
    trailForwardSpread: rest.trailForwardSpread ?? 0.05,
    trailParticleGravity: rest.trailParticleGravity ?? 0,
    trailOpacity: rest.trailOpacity ?? 0.5,
    trailBaseSize: rest.trailBaseSize ?? 0.06,
    trailSizeRange: rest.trailSizeRange ?? 0.14,
    trailScaleMin: rest.trailScaleMin ?? 0.5,
    trailScaleMax: rest.trailScaleMax ?? 1.4,
    trailRampIn: rest.trailRampIn ?? 0.05,
    meshColor: rest.meshColor ?? 0x808080,
    meshType: rest.meshType ?? 'ball',
    glowShell: rest.glowShell ?? false,
    glowColor: rest.glowColor ?? 0xffffff,
    glowOpacity: rest.glowOpacity ?? 0.4,
    meshRampIn: rest.meshRampIn ?? true,
    meshRampInDuration: rest.meshRampInDuration ?? 0.2,
    meshStartScale: rest.meshStartScale ?? 0.2,
    needsServerTracking: rest.needsServerTracking ?? true,
    terrainOffset: S.hitMin,
    maxLifetime: S.maxLifetime,
    armTime: S.armTime,
    bounces: S.terrainBounce === true,
    bounceRestitution: S.bounceRestitution,
    bounceFriction: S.bounceFriction,
    ...rest,
  };
}