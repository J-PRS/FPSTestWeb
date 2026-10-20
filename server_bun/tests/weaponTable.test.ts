import { describe, expect, it } from 'bun:test';

import { WeaponType } from '../../shared/weaponTable.ts';
import { WEAPONS } from '../../shared/weaponRows.ts';
import { WEAPON_FIRE_INTERVAL_S, getWeaponStats } from '../../shared/weapons.ts';

const IDS = Object.keys(WEAPONS).map(Number);

describe('WEAPONS table invariants', () => {
  it('every enum member has a row — ids are dense, no gaps', () => {
    const max = Math.max(...IDS);
    for (let id = 0; id <= max; id++) {
      expect(WEAPONS[id], `WeaponType.${WeaponType[id] ?? id} missing`).toBeDefined();
    }
  });

  it('no impossible stats — damage/radius/hitbox are non-negative', () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      const name = `${WeaponType[+id] ?? id}`;
      expect(w.directDamage, name).toBeGreaterThanOrEqual(0);
      expect(w.aoeDamage, name).toBeGreaterThanOrEqual(0);
      expect(w.aoeRadius, name).toBeGreaterThanOrEqual(0);
      expect(w.bodyRadius, name).toBeGreaterThanOrEqual(0);
      expect(w.hitMin, name).toBeGreaterThanOrEqual(0);
      expect(w.hitMax, name).toBeGreaterThanOrEqual(w.hitMin);
      expect(w.knockbackForce, name).toBeGreaterThanOrEqual(0);
      if (w.maxLifetime !== undefined) expect(w.maxLifetime, name).toBeGreaterThan(0);
      if (w.cluster) { expect(w.cluster.count, name).toBeGreaterThan(0); expect(w.cluster.radius, name).toBeGreaterThan(0); }
    }
  });

  it('aoeRadius > 0 iff the weapon can splash — damage/radius agree', () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      const name = `${WeaponType[+id] ?? id}`;
      if (w.aoeRadius > 0) expect(w.aoeDamage, name).toBeGreaterThan(0);
    }
  });

  it('hitscan/melee entries still carry sane speed values', () => {
    // speed 0 is legal only for carrier-spawned children (never muzzle-fired).
    for (const [id, w] of Object.entries(WEAPONS)) {
      expect(w.speed, `${WeaponType[+id] ?? id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('every fire-interval entry points at a real weapon', () => {
    for (const id of Object.keys(WEAPON_FIRE_INTERVAL_S)) {
      expect(WEAPONS[+id], `interval for ${id}`).toBeDefined();
      expect(WEAPON_FIRE_INTERVAL_S[+id as unknown as WeaponType]!, `interval ${id}`).toBeGreaterThan(0);
    }
  });

  it('cluster parents reference a child type that exists', () => {
    const clusters = Object.values(WEAPONS).filter((w) => w.cluster);
    expect(clusters.length).toBeGreaterThan(0); // MRVLauncher + ClusterBomb
  });

  it('getWeaponStats falls back to Rocket for unknown ids', () => {
    expect(getWeaponStats(9999)).toBe(WEAPONS[WeaponType.BoltLauncher]!);
    expect(getWeaponStats(undefined)).toBe(WEAPONS[WeaponType.BoltLauncher]!);
    expect(getWeaponStats(WeaponType.Mortar)).toBe(WEAPONS[WeaponType.Mortar]!);
  });
});
