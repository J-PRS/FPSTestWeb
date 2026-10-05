import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { SLOT_DEFS, SLOT_COUNT, weaponDef } from '../weapons';
import { WEAPON_CONFIGS } from '../projectiles/index';
import { WEAPONS, getWeaponStats, WeaponType } from '../../../shared/weapons';
import { Projectile } from '../projectiles/Projectile';
import { REMOTE_RAILGUN_CONFIG } from '../projectiles/remotergunConfig';
import type { Terrain } from '../world/terrain';

// The registry exists because slot space (wid) and wire space (WeaponType)
// used to live in four parallel arrays that desynced silently — a missing
// entry once made the sticky launcher fire rockets. These tests pin the
// invariants the registry now carries structurally.

describe('weapon registry', () => {
  it('every slot def has a unique weaponType and a sane rate', () => {
    const seen = new Set<number>();
    for (const def of SLOT_DEFS) {
      expect(seen.has(def.weaponType), `dup weaponType ${def.weaponType}`).toBe(false);
      seen.add(def.weaponType);
      expect(def.rate).toBeGreaterThan(0);
      expect(def.config.weaponType).toBe(def.weaponType);
    }
  });

  it('weaponDef(wid) round-trips and falls back to rocket for bad wids', () => {
    for (let wid = 0; wid < SLOT_COUNT; wid++) {
      expect(weaponDef(wid)).toBe(SLOT_DEFS[wid]);
    }
    expect(weaponDef(999)).toBe(SLOT_DEFS[0]);
  });

  it('fan weapons declare pellets; beams are hitscan only', () => {
    const BEAM_WEAPONS = new Set([WeaponType.Lightning, WeaponType.Repair]);
    for (const def of SLOT_DEFS) {
      if (def.kind === 'fan') {expect(def.pellets).toBeDefined();}
      if (def.kind === 'beam') {expect(BEAM_WEAPONS.has(def.weaponType)).toBe(true);}
      if (BEAM_WEAPONS.has(def.weaponType)) {expect(def.kind).toBe('beam');}
    }
  });

  it('every client config resolves to shared stats (wire id valid)', () => {
    for (const c of WEAPON_CONFIGS) {
      expect(WEAPONS[c.weaponType], `${c.name} has no WEAPONS entry`).toBeDefined();
      const w = WEAPONS[c.weaponType];
      expect(c.speed).toBe(w.speed);
      expect(c.gravity).toBe(w.gravity);
      expect(c.aoeRadius).toBe(w.aoeRadius);
      // aoeDamage is inert when there's no splash (chaingun keeps a
      // placeholder) — only real AOE weapons must agree on it.
      if (c.aoeRadius > 0) {expect(c.aoeDamage).toBe(w.aoeDamage);}
      expect(c.bodyRadius).toBe(w.bodyRadius);
    }
    const seen = new Set<number>();
    for (const c of WEAPON_CONFIGS) {
      expect(seen.has(c.weaponType), `dup weaponType ${c.weaponType} (${c.name})`).toBe(false);
      seen.add(c.weaponType);
    }
  });

  it('every ray-burst weapon declares delay+range in shared stats', () => {
    for (const c of WEAPON_CONFIGS) {
      const w = getWeaponStats(c.weaponType);
      if (c.rayBurst) {
        expect(w.rayDelay).toBe(c.rayBurst.delay);
        expect(w.rayRange).toBe(c.rayBurst.range);
      }
    }
  });
});

// Remote railgun: the mid-flight hitscan discharge is the only client-side
// mechanic in the codebase where a projectile teleports — pin the behavior.
const flatTerrain = { getHeight: () => 0 } as unknown as Terrain;

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

describe('ray-burst discharge (remote railgun)', () => {
  it('discharges the beam at rayDelay and dies at the hit/range endpoint', () => {
    const p = spawnRRG(new THREE.Vector3(0, 50, 0), new THREE.Vector3(1, 0, 0));
    let beam: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
    p.onRayBurst = (from, to) => { beam = { from, to }; };
    stepUntil(p, () => p.exploded);
    expect(beam).not.toBeNull();
    // Beam originated ~0.4s of flight down-range (~22m + gravity sag)
    expect(beam!.from.x).toBeGreaterThan(15);
    expect(beam!.from.x).toBeLessThan(30);
    // Endpoint is far ahead of the discharge point (the rail jump)
    expect(beam!.to.x - beam!.from.x).toBeGreaterThan(100);
    expect(p.exploded).toBe(true);
  });

  it('detonates on a target inside the beam path', () => {
    const p = spawnRRG(new THREE.Vector3(0, 50, 0), new THREE.Vector3(1, 0, 0));
    // Beam dir follows velocity — flat flight now, so the beam line stays
    // level at y=50 and crosses x=70 on the throw axis.
    const players = new Map<string, THREE.Vector3>([['p1', new THREE.Vector3(70, 50, 0)]]);
    const dt = 1 / 60;
    for (let t = 0; t < 2 && !p.exploded; t += dt) {p.update(dt, flatTerrain, undefined, players);}
    expect(p.hitPlayerId).toBe('p1');
  });
});
