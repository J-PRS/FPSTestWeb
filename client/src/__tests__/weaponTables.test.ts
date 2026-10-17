/* oxlint-disable vitest/no-conditional-in-test -- table/fuzz harness: branchy drives and ?? fallbacks ARE the test logic */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { SLOT_DEFS, SLOT_COUNT, weaponDef } from '../weapons';
import { WEAPON_CONFIGS } from '../projectiles/index';
import { WEAPONS, getWeaponStats, WeaponType, serverSimmed } from '../../../shared/weapons';
import { HEAVY_ONLY_WEAPONS } from '../../../shared/botClasses';
import { BOMBARD_CONFIG } from '../projectiles/bombardConfig';
import { PlayerLoadout } from '../entities/playerLoadout';
import { Projectile } from '../projectiles/Projectile';
import { REMOTE_RAILGUN_CONFIG } from '../projectiles/remotergunConfig';
import type { Terrain } from '../world/terrain';

// The registry exists because slot space (wid) and wire space (WeaponType)
// used to live in four parallel arrays that desynced silently — a missing
// entry once made the sticky launcher fire rockets. These tests pin the
// invariants the registry now carries structurally.

describe('weapon registry', (): void => {
  it('every slot def has a unique weaponType and a sane rate', (): void => {
    const seen = new Set<number>();
    for (const def of SLOT_DEFS) {
      expect(seen.has(def.weaponType), `dup weaponType ${def.weaponType}`).toBe(false);
      seen.add(def.weaponType);
      expect(def.rate).toBeGreaterThan(0);
      expect(def.config.weaponType).toBe(def.weaponType);
    }
  });

  it('weaponDef(wid) round-trips and falls back to rocket for bad wids', (): void => {
    for (let wid = 0; wid < SLOT_COUNT; wid += 1) {
      expect(weaponDef(wid)).toBe(SLOT_DEFS[wid]);
    }
    expect(weaponDef(999)).toBe(SLOT_DEFS[0]);
  });

  it('fan weapons declare pellets; beams are hitscan only', (): void => {
    const BEAM_WEAPONS = new Set([WeaponType.Lightning, WeaponType.Repair]);
    SLOT_DEFS.filter((def): boolean => def.kind === 'fan').forEach((def): void => { expect(def.pellets).toBeDefined(); });
    SLOT_DEFS.filter((def): boolean => def.kind === 'beam').forEach((def): void => { expect(BEAM_WEAPONS.has(def.weaponType)).toBe(true); });
    SLOT_DEFS.filter((def): boolean => BEAM_WEAPONS.has(def.weaponType)).forEach((def): void => { expect(def.kind).toBe('beam'); });
  });

  it('every client config resolves to shared stats (wire id valid)', (): void => {
    for (const c of WEAPON_CONFIGS) {
      expect(WEAPONS[c.weaponType], `${c.name} has no WEAPONS entry`).toBeDefined();
      const w = WEAPONS[c.weaponType];
      expect(c.speed).toBe(w.speed);
      expect(c.gravity).toBe(w.gravity);
      expect(c.aoeRadius).toBe(w.aoeRadius);
      // aoeDamage is inert when there's no splash (chaingun keeps a
      // placeholder) — only real AOE weapons must agree on it.
      expect(c.aoeRadius <= 0 || c.aoeDamage === w.aoeDamage, `${c.name} aoeDamage must match when radius > 0`).toBe(true);
      expect(c.bodyRadius).toBe(w.bodyRadius);
    }
    const seen = new Set<number>();
    for (const c of WEAPON_CONFIGS) {
      expect(seen.has(c.weaponType), `dup weaponType ${c.weaponType} (${c.name})`).toBe(false);
      seen.add(c.weaponType);
    }
  });

  it('bombard is heavy-only, server-simmed, and tops the direct-damage table', (): void => {
    const w = WEAPONS[WeaponType.Bombard];
    expect(w).toBeDefined();
    // Highest flat direct hit among PRIMARIES — the planted satchel
    // (belt item) is allowed to keep the overall record.
    const PRIMARIES = new Set(SLOT_DEFS.map((d): WeaponType => d.weaponType));
    for (const [wt, s] of Object.entries(WEAPONS)) {
      if (!PRIMARIES.has(Number(wt))) {continue;}
      expect(s.directDamage, `w${wt} out-damages the bombard`).toBeLessThanOrEqual(w.directDamage);
    }
    // Crumble shrapnel: the radial sweep's per-victim payout is a
    // fraction of directDamage, so the direct line stays the ceiling.
    expect(w.aoeDamage).toBe(w.directDamage);
    expect(w.aoeRadius).toBeGreaterThan(0);
    expect(w.aoeRadius).toBe(2); // a tiny reliable sphere — not a shard cone
    expect(w.aoeRadius).toBeLessThan(w.directDamage / 4); // splash, not a mortar shell
    // Bounce experiment is SHELVED: maxBounces 0 = crumble on first contact.
    expect(w.terrainBounce).toBe(true);
    expect(w.maxBounces).toBe(0);
    expect(w.bounceRestitution).toBe(0.5);
    expect(w.bounceFriction).toBe(0.5);
    expect(serverSimmed(WeaponType.Bombard)).toBe(true);
    expect(HEAVY_ONLY_WEAPONS.has(WeaponType.Bombard)).toBe(true);
    // The slot-space gate must agree with the wire-space gate — the bombard
    // slot def is the last SLOT_DEFS entry and both lists must carry it.
    const wid = SLOT_DEFS.findIndex((d): boolean => d.weaponType === WeaponType.Bombard);
    expect(wid).toBeGreaterThanOrEqual(0);
    expect(PlayerLoadout.HEAVY_ONLY).toContain(wid);
    // Client contract: no explosion dome, always crumbles, standard 2m
    // splash sphere; the skip is shelved (maxBounces 0).
    expect(BOMBARD_CONFIG.noExplosion).toBeUndefined();
    expect(BOMBARD_CONFIG.crumbles).toBe(true);
    expect(BOMBARD_CONFIG.explosionRadius).toBe(0);
    expect(BOMBARD_CONFIG.bounces).toBe(true);
    expect(BOMBARD_CONFIG.maxBounces).toBe(0);
    expect(BOMBARD_CONFIG.bodyRadius).toBe(w.bodyRadius);
  });

  it('every ray-burst weapon declares delay+range in shared stats', (): void => {
    for (const c of WEAPON_CONFIGS) {
      const w = getWeaponStats(c.weaponType);
      expect(c.rayBurst === undefined || w.rayDelay === c.rayBurst.delay, 'rayDelay matches burst').toBe(true);
      expect(c.rayBurst === undefined || w.rayRange === c.rayBurst.range, 'rayRange matches burst').toBe(true);
    }
  });
});

// Remote railgun: the mid-flight hitscan discharge is the only client-side
// mechanic in the codebase where a projectile teleports — pin the behavior.
const flatTerrain = { getHeight: (): number => 0 } as unknown as Terrain;

function stepUntil(p: Projectile, cond: () => boolean, maxSeconds = 10): void {
  const dt = 1 / 60;
  for (let t = 0; t < maxSeconds && !cond(); t += dt) {p.update(dt, flatTerrain);}
}

function spawnRRG(origin: THREE.Vector3, dir: THREE.Vector3): Projectile {
  const scene = new THREE.Scene();
  const p = new Projectile(scene, origin, dir, new THREE.Vector3(), REMOTE_RAILGUN_CONFIG);
  p.spawnedThisFrame = false;
  return p;
}

describe('ray-burst discharge (remote railgun)', (): void => {
  it('discharges the beam at rayDelay and dies at the hit/range endpoint', (): void => {
    const p = spawnRRG(new THREE.Vector3(0, 50, 0), new THREE.Vector3(1, 0, 0));
    let beam: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
    p.onRayBurst = (from, to): void => { beam = { from, to }; };
    stepUntil(p, (): boolean => p.exploded);
    expect(beam).not.toBeNull();
    // Beam originated ~0.4s of flight down-range (~22m + gravity sag)
    expect(beam!.from.x).toBeGreaterThan(15);
    expect(beam!.from.x).toBeLessThan(30);
    // Endpoint is far ahead of the discharge point (the rail jump)
    expect(beam!.to.x - beam!.from.x).toBeGreaterThan(100);
    expect(p.exploded).toBe(true);
  });

  it('detonates on a target inside the beam path', (): void => {
    const p = spawnRRG(new THREE.Vector3(0, 50, 0), new THREE.Vector3(1, 0, 0));
    // Beam dir follows velocity — flat flight now, so the beam line stays
    // level at y=50 and crosses x=70 on the throw axis.
    const players = new Map<string, THREE.Vector3>([['p1', new THREE.Vector3(70, 50, 0)]]);
    const dt = 1 / 60;
    for (let t = 0; t < 2 && !p.exploded; t += dt) {p.update(dt, flatTerrain, undefined, players);}
    expect(p.hitPlayerId).toBe('p1');
  });
});
