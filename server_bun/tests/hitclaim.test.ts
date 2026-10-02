import { describe, it, expect } from 'bun:test';
import {
  validateHitClaim,
  validateAoeClaim,
  hitRadiusAt,
  pointToCapsuleDistance,
  aoeDamage,
  aoeImpulse,
  type TrackedProjectile,
} from '../../shared/combat.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { PLAYER_RADIUS, EYE_OFFSET, CAPSULE_CENTER_Y } from '../../shared/constants.ts';

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const ZERO = V();

// Eye position of a target standing at origin
const TARGET_EYE = V(0, EYE_OFFSET, 0);

function rocketProjectile(over: Partial<TrackedProjectile> = {}): TrackedProjectile {
  return {
    ownerId: 'shooter',
    weaponType: WeaponType.BoltLauncher,
    origin: V(0, 0, 0),
    velocity: V(120, 0, 0),
    spawnAt: 1000,
    ...over,
  };
}

describe('aoeDamage / aoeImpulse', () => {
  it('banded: 75/50/25 rings, zero at and beyond radius', () => {
    expect(aoeDamage(40, 0, 10)).toBe(30);   // inner band = 75%
    expect(aoeDamage(40, 5, 10)).toBe(20);   // mid band = 50%
    expect(aoeDamage(40, 8, 10)).toBe(10);   // outer band = 25%
    expect(aoeDamage(40, 10, 10)).toBe(0);
    expect(aoeDamage(40, 12, 10)).toBe(0);
    expect(aoeImpulse(28, 3, 6)).toBeCloseTo(14); // knockback stays linear
  });
});

describe('hitRadiusAt', () => {
  it('grows 0 → hitMax over hitGrow from spawn (no grace)', () => {
    expect(hitRadiusAt(WeaponType.BoltLauncher, 0)).toBe(0);
    expect(hitRadiusAt(WeaponType.BoltLauncher, 0.1)).toBeCloseTo(8 * 0.05);
    expect(hitRadiusAt(WeaponType.BoltLauncher, 1.05)).toBeCloseTo(8 * 0.525);
    expect(hitRadiusAt(WeaponType.BoltLauncher, 2.1)).toBe(8);
    expect(hitRadiusAt(WeaponType.BoltLauncher, 99)).toBe(8);
  });
});

describe('pointToCapsuleDistance', () => {
  it('measures distance to the capsule, not the eye point', () => {
    // Eye is 0.8 above capsule center; cylinder half-height is 0.2, so a
    // point at eye height sits 0.6 above the capsule surface.
    expect(pointToCapsuleDistance(V(0, EYE_OFFSET, 0), TARGET_EYE)).toBeCloseTo(0.6);
    // 1m to the side at capsule-center height → exactly 1m off the wall
    expect(pointToCapsuleDistance(V(1, CAPSULE_CENTER_Y, 0), TARGET_EYE)).toBeCloseTo(1);
  });
});

describe('validateHitClaim', () => {
  it('accepts an honest mid-range rocket hit', () => {
    // rocket flown 0.5s: 60m out; target stands at the impact point
    const hitPos = V(60, EYE_OFFSET, 0);
    const verdict = validateHitClaim({
      projectile: rocketProjectile(),
      hitPos,
      targetPos: V(60, EYE_OFFSET, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 2000, // 1s elapsed wall-clock > claimed 0.5s
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a claim with airtime beyond wall-clock age', () => {
    const verdict = validateHitClaim({
      projectile: rocketProjectile({ spawnAt: 1900 }), // 100ms ago
      hitPos: V(60, EYE_OFFSET, 0),
      targetPos: V(60, EYE_OFFSET, 0),
      airtime: 5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects hits beyond ballistic reach', () => {
    const verdict = validateHitClaim({
      projectile: rocketProjectile(),
      hitPos: V(500, 0, 0), // 500m in 0.5s — impossible at 120m/s
      targetPos: V(500, EYE_OFFSET, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 5000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects when the target is outside the legal hit radius', () => {
    // Young rocket: wake still ~0, so a target 20m off the hit point is forged
    const verdict = validateHitClaim({
      projectile: rocketProjectile(),
      hitPos: V(50, EYE_OFFSET, 0),
      targetPos: V(30, EYE_OFFSET, 0),
      airtime: 0.4,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('accepts a wake hit once the proxy has grown', () => {
    // 2.5s rocket: fully-grown 8m wake + capsule + slack covers a ~10m offset
    const hitPos = V(290, EYE_OFFSET, 0);
    const targetPos = V(280, EYE_OFFSET, 0); // 10m off the hit point
    const verdict = validateHitClaim({
      projectile: rocketProjectile(),
      hitPos,
      targetPos,
      airtime: 2.4,
      shooterVel: ZERO,
      now: 5000,
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects fuse weapons claiming past maxLifetime', () => {
    const verdict = validateHitClaim({
      projectile: rocketProjectile({ weaponType: WeaponType.Grenade, velocity: V(40, 0, 0) }),
      hitPos: V(60, EYE_OFFSET, 0),
      targetPos: V(60, EYE_OFFSET, 0),
      airtime: 3.0, // grenade fuse is 2.0s
      shooterVel: ZERO,
      now: 10000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects non-finite / negative airtime', () => {
    for (const airtime of [NaN, Infinity, -1]) {
      const verdict = validateHitClaim({
        projectile: rocketProjectile(),
        hitPos: V(10, EYE_OFFSET, 0),
        targetPos: V(10, EYE_OFFSET, 0),
        airtime,
        shooterVel: ZERO,
        now: 2000,
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it('close-range chaingun hit still needs proximity (tiny wake)', () => {
    const slug: TrackedProjectile = {
      ownerId: 'shooter',
      weaponType: WeaponType.Chaingun,
      origin: V(0, 0, 0),
      velocity: V(250, 0, 0),
      spawnAt: 1000,
    };
    // 15m off the hit point — way past the 0.5m chaingun cap
    const verdict = validateHitClaim({
      projectile: slug,
      hitPos: V(50, EYE_OFFSET, 0),
      targetPos: V(50 - 15, EYE_OFFSET, 0),
      airtime: 0.2,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
    expect(PLAYER_RADIUS).toBeGreaterThan(0);
  });
});

describe('validateAoeClaim', () => {
  it('accepts a blast at the honest end of flight', () => {
    // rocket flown 0.5s at 120m/s → blast ~60m out is legit
    const verdict = validateAoeClaim({
      projectile: rocketProjectile(),
      blastPos: V(60, 0, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a blast placed beyond ballistic reach', () => {
    // detonate-anywhere cheat: blast 400m out in 0.5s of flight
    const verdict = validateAoeClaim({
      projectile: rocketProjectile(),
      blastPos: V(400, 0, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects a blast claiming airtime beyond the projectile age', () => {
    const verdict = validateAoeClaim({
      projectile: rocketProjectile({ spawnAt: 1900 }),
      blastPos: V(60, 0, 0),
      airtime: 5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });

  // Remote railgun: the slug's ray burst teleports the detonation forward
  // by rayRange once past rayDelay — the reach check must allow the jump
  // but only for that weapon and only after the delay.
  const rrgProjectile = () => rocketProjectile({
    weaponType: WeaponType.RemoteRailgun,
    velocity: V(55, 0, 0),
  });

  it('accepts a remote-railgun blast at the discharged beam endpoint', () => {
    // 0.5s flight ≈ 27.5m + gravity sag, then up to 160m of beam.
    const verdict = validateAoeClaim({
      projectile: rrgProjectile(),
      blastPos: V(180, -10, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects the same blast claimed before the discharge delay', () => {
    const verdict = validateAoeClaim({
      projectile: rrgProjectile(),
      blastPos: V(180, -10, 0),
      airtime: 0.2,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects a remote-railgun blast past the beam range', () => {
    const verdict = validateAoeClaim({
      projectile: rrgProjectile(),
      blastPos: V(320, 0, 0),
      airtime: 0.5,
      shooterVel: ZERO,
      now: 2000,
    });
    expect(verdict.ok).toBe(false);
  });
});
