import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { CLASS_STATS } from '../../../shared/botClasses.ts';
import { flat } from './harness.ts';

// Class-body mechanics: mass divides blast shove, eyeHeight drives the
// hit capsule. Deterministic geometry — no seeds, no brain cadence.

const FLOOR = hmHeight(flat, 0, 0);
const eye = (cls: 'light' | 'medium' | 'heavy') => FLOOR + CLASS_STATS[cls].eyeHeight;

function arena() {
  return mkRoom({ bots: 0 }, 'dm');
}

function addStanding(room: ReturnType<typeof mkRoom>, id: string, cls: 'light' | 'medium' | 'heavy', x: number, z = 0) {
  const p = room.players.addPlayer(id, undefined, 'none', cls);
  p.protectedUntil = 0;
  p.position = { x, y: eye(cls), z };
  return p;
}

describe('scenario: class bodies', () => {
  it('blast shove divides by mass — the light sails further than the heavy', () => {
    const room = arena();
    const shooter = room.players.addPlayer('shooter');
    shooter.isBot = true;
    shooter.protectedUntil = 0;
    shooter.position = { x: 0, y: eye('medium'), z: 0 };
    // Far apart so each blast touches only its own target; each blast sits
    // 5m off at the target's own eye level, so both eat the same raw
    // impulse — the only difference left is mass.
    const light = addStanding(room, 'light', 'light', -20);
    const heavy = addStanding(room, 'heavy', 'heavy', 20);

    room.messages.serverBlast(shooter.id, { x: -25, y: eye('light'), z: 0 }, WeaponType.BoltLauncher, null);
    room.messages.serverBlast(shooter.id, { x: 25, y: eye('heavy'), z: 0 }, WeaponType.BoltLauncher, null);

    const dvL = Math.hypot(light.velocity.x, light.velocity.y, light.velocity.z);
    const dvH = Math.hypot(heavy.velocity.x, heavy.velocity.y, heavy.velocity.z);
    expect(dvL).toBeGreaterThan(0);
    expect(dvH).toBeGreaterThan(0);
    // 0.75 vs 1.25 → the light takes ~1.67x the heavy's impulse.
    expect(dvL / dvH).toBeCloseTo(CLASS_STATS.heavy.mass / CLASS_STATS.light.mass, 5);
  });

  it("a shot over the medium's head still catches the heavy — per-class capsule", () => {
    const room = arena();
    const shooter = room.players.addPlayer('shooter');
    shooter.isBot = true;
    shooter.protectedUntil = 0;
    const medium = addStanding(room, 'medium', 'medium', 20);
    const heavy = addStanding(room, 'heavy', 'heavy', 40);
    // Railgun at FLOOR+2.9: the midpoint-sphere reach (radius+wake+half)
    // is ~1.6 vs medium center FLOOR+1.1 — a whiff — but ~1.85 vs the
    // heavy's FLOOR+1.35 — a wake clip on the mech's taller silhouette.
    room.projectiles.spawn(shooter.id, WeaponType.Railgun,
      { x: 0, y: FLOOR + 2.9, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) room.projectiles.tick(0.05);
    expect(medium.health).toBe(medium.maxHealth); // whiffed overhead
    expect(heavy.health).toBeLessThan(heavy.maxHealth); // clipped the mech
  });

  it('a center-mass bolt still hits the light — smaller silhouette is a bonus, not a shield', () => {
    const room = arena();
    const shooter = room.players.addPlayer('shooter');
    shooter.isBot = true;
    shooter.protectedUntil = 0;
    const light = addStanding(room, 'light', 'light', 20);
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: eye('light') - 0.85, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) room.projectiles.tick(0.05);
    expect(light.health).toBeLessThan(light.maxHealth);
  });
});
