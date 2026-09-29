import { describe, it, expect } from 'bun:test';
import { WEAPONS, WeaponType } from '../../shared/weapons.ts';

// Sticky launcher (wid 14 / WeaponType 18): 3s fuse at 0.8s cadence ⇒ the
// design's ~3-live-bombs window only holds if fuse/rate stay aligned, and
// the chain blast needs a real aoeRadius — pin the contract.
describe('sticky launcher stats', () => {
  const s = WEAPONS[WeaponType.Sticky]!;

  it('exists in the weapon table', () => {
    expect(s).toBeDefined();
  });

  it('3s fuse supports ~3 live bombs at 0.8s fire rate', () => {
    expect(s.maxLifetime).toBe(3.0);
    expect(Math.ceil(s.maxLifetime! / 0.8)).toBeGreaterThanOrEqual(3);
  });

  it('has real blast stats for chain detonation', () => {
    expect(s.aoeDamage).toBeGreaterThan(0);
    expect(s.aoeRadius).toBeGreaterThan(5);
    expect(s.knockbackForce).toBeGreaterThan(0);
  });

  it('flies ballistically (gravity arc, no hitscan wake)', () => {
    expect(s.gravity).toBeLessThan(0);
    expect(s.speed).toBeGreaterThan(20);
  });
});
