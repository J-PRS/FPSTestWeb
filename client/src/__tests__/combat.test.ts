import { describe, it, expect } from 'vitest';
import {
  aoeDamage, aoeImpulse, hitRadiusAt,
  validateHitClaim, type TrackedProjectile,
} from '../../../shared/combat';
import { WeaponType, getWeaponStats } from '../../../shared/weapons';
import { PLAYER_HEIGHT } from '../../../shared/constants';
import { nextTargetId } from '../entities/targetIds';
import { createProjectileRegistry } from '../game/projectileRegistry';
import { createWorldState } from '../game/worldState';

describe('aoe banded falloff', (): void => {
  it('three equal thirds: 75/50/25, zero at edge', (): void => {
    // radius 10 — bands are [0,3.33), [3.33,6.66), [6.66,10)
    expect(aoeDamage(50, 0, 10)).toBe(38);      // inner band, 0.75
    expect(aoeDamage(50, 5, 10)).toBe(25);      // mid band, 0.50
    expect(aoeDamage(50, 8, 10)).toBe(13);      // outer band, 0.25
    expect(aoeDamage(50, 10, 10)).toBe(0);
  });

  it('band steps are monotonic', (): void => {
    expect(aoeDamage(50, 2, 10)).toBeGreaterThan(aoeDamage(50, 5, 10));
    expect(aoeDamage(50, 5, 10)).toBeGreaterThan(aoeDamage(50, 8, 10));
  });

  it('impulse follows same falloff', (): void => {
    expect(aoeImpulse(100, 0, 10)).toBe(100);
    expect(aoeImpulse(100, 10, 10)).toBe(0);
  });
});

describe('wake hitbox growth', (): void => {
  it('grows linearly from spawn (no grace period)', (): void => {
    const stats = getWeaponStats(WeaponType.BoltLauncher);
    expect(hitRadiusAt(WeaponType.BoltLauncher, 0)).toBe(0);
    expect(hitRadiusAt(WeaponType.BoltLauncher, stats.hitGrow / 2)).toBeCloseTo(stats.hitMax / 2);
  });

  it('reaches hitMax at hitGrow', (): void => {
    const stats = getWeaponStats(WeaponType.BoltLauncher);
    expect(hitRadiusAt(WeaponType.BoltLauncher, stats.hitGrow)).toBe(stats.hitMax);
    expect(hitRadiusAt(WeaponType.BoltLauncher, stats.hitGrow * 10)).toBe(stats.hitMax);
  });

  it('undefined weaponType resolves to Rocket default', (): void => {
    expect(hitRadiusAt(undefined, 0)).toBe(hitRadiusAt(WeaponType.BoltLauncher, 0));
  });
});

describe('validateHitClaim', (): void => {
  const proj: TrackedProjectile = {
    ownerId: 'shooter',
    weaponType: WeaponType.BoltLauncher,
    origin: { x: 0, y: 60, z: 0 },
    velocity: { x: 120, y: 0, z: 0 },
    spawnAt: 1000,
  };
  const base = {
    projectile: proj,
    airtime: 1,
    shooterVel: { x: 0, y: 0, z: 0 },
    now: 2000,
  };

  it('accepts an honest end-of-flight hit', (): void => {
    // Rocket speed 120, 1s airtime, no drop — lands ~120m out
    const hitPos = { x: 120, y: 60, z: 0 };
    const targetPos = { x: 120, y: 60 + PLAYER_HEIGHT / 2, z: 0 };
    const v = validateHitClaim(Object.assign({}, base, {hitPos,targetPos}));
    expect(v.ok).toBe(true);
  });

  it('rejects a hit beyond ballistic reach', (): void => {
    const v = validateHitClaim(Object.assign({}, base, {hitPos: { x: 900, y: 60, z: 0 },targetPos: { x: 900, y: 60, z: 0 }}));
    expect(v.ok).toBe(false);
  });

  it('rejects airtime beyond wall-clock age', (): void => {
    const v = validateHitClaim(Object.assign({}, base, {airtime: 5,hitPos: { x: 120, y: 60, z: 0 },targetPos: { x: 120, y: 60, z: 0 }}));
    expect(v.ok).toBe(false);
  });

  it('rejects a target outside capsule + wake radius', (): void => {
    const hitPos = { x: 120, y: 60, z: 0 };
    const farTarget = { x: 120, y: 60, z: 100 };
    const v = validateHitClaim(Object.assign({}, base, {hitPos,targetPos: farTarget}));
    expect(v.ok).toBe(false);
  });
});

describe('target ID allocator', (): void => {
  it('never repeats and stays in u16 space', (): void => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      const id = nextTargetId();
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(65_535);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('projectileRegistry', (): void => {
  it('starts empty with byShotId/byId', (): void => {
    const reg = createProjectileRegistry();
    expect(reg.byShotId.size).toBe(0);
    expect(reg.byId.size).toBe(0);
    expect(reg.seq).toBe(0);
  });
});

describe('worldState', (): void => {
  it('bundles all shared collections', (): void => {
    const w = createWorldState();
    expect(w.remotePlayers.size).toBe(0);
    expect(w.killCounts.size).toBe(0);
    expect(w.projectiles).toHaveLength(0);
    expect(w.projectileRegistry.byId.size).toBe(0);
    expect(w.debrisList).toHaveLength(0);
    expect(w.playerDebrisList).toHaveLength(0);
    expect(w.explosions).toHaveLength(0);
    expect(w.scorches).toHaveLength(0);
    expect(w.implosions).toHaveLength(0);
  });
});
