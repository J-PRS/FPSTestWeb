import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.ts';

// Server-side LG charge economy: beam ticks bank withheld damage ON the
// victim, a non-LG hit detonates only what it invests, and a kill pops
// the corpse for the whole remaining bank.
type Room = ReturnType<typeof mkRoom>;
type Player = ReturnType<typeof twoPlayers>[number];

/** One beam tick = one shotFired Lightning intent — the room's honest
 *  ray (beamSweep) names the contact and the charge economy pays it. */
function beamTick(room: Room, shooter: Player, victim: Player): void {
  const eye = { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z };
  const dir = {
    x: victim.position.x - eye.x,
    y: (victim.position.y - 0.9) - eye.y,
    z: victim.position.z - eye.z,
  };
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  room.messages.handleMessage(shooter.id, {
    type: 'shotFired',
    weaponType: WeaponType.Lightning,
    dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
  } as never);
}

/** Fire a real intent — the server sims the shell toward the victim and
 *  owns the hit itself; the shooter only ever declares direction. */
function shootAt(room: Room, shooter: Player, victim: Player, weapon: WeaponType): void {
  // Aim at the capsule's axis midpoint: position.y is the eye, so
  // position.y - 0.9 lands on chest height (centerOff is negative).
  const dir = {
    x: victim.position.x - shooter.position.x,
    y: (victim.position.y - 0.9) - (shooter.position.y),
    z: victim.position.z - shooter.position.z,
  };
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  room.messages.handleMessage(shooter.id, {
    type: 'shotFired', weaponType: weapon,
    dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
    pos: { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z },
  } as never);
  // The shell needs flight time to reach the victim — step the sim.
  step(room, Math.ceil(len / (getWeaponStats(weapon).speed || 90) * 30) + 5);
}

describe('scenario: LG charge economy vs players', () => {
  it('beam ticks bank withheld damage on the victim', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    a.armorClass = 'light'; // Lightning is light-tier - the class-lock gate refuses medium/heavy
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    expect(b.charge).toBe(0);

    for (let i = 0; i < 10; i++) {beamTick(room, a, b);}
    // Ticks 1-4 pay full damage (bank 0); 5-9 bank (4-3)x2=2 each,
    // 10+ bank (4-2)x2=4 — 10 + 4 = 14 gross, minus tiny drain.
    expect(b.charge).toBeGreaterThan(10);
    expect(b.charge).toBeLessThan(15);
  });

  it('a non-LG hit detonates only min(banked, damage) — the rest smolders', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    a.armorClass = 'light'; // Lightning is light-tier - the class-lock gate refuses medium/heavy
    freeze(room, b.id, { x: 10, y: 31, z: 0 });

    for (let i = 0; i < 12; i++) {beamTick(room, a, b);}
    const banked = b.charge;
    const dmg = getWeaponStats(WeaponType.Chaingun).directDamage;

    shootAt(room, a, b, WeaponType.Chaingun);
    // The pellet sparks its own damage worth of charge — no more.
    expect(b.charge).toBeLessThan(banked);
    // Expected remainder minus the lazy drain between bank and detonate.
    const want = Math.max(0, banked - Math.min(banked, dmg));
    expect(b.charge).toBeLessThanOrEqual(want);
    expect(b.charge).toBeGreaterThan(want - 1.5);
  });

  it('killing a charged victim pops the corpse onto nearby players', () => {
    const room = mkRoom({ bots: 3 }, 'dm');
    const [a, b] = twoPlayers(room);
    const c = [...room.players.getAllPlayers().values()].find((p) => p.id !== a.id && p.id !== b.id)!;
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    a.armorClass = 'light'; // Lightning is light-tier - the class-lock gate refuses medium/heavy
    // Close range: a real flight step lets the bank drain before impact,
    // so the corpse test fires from inside the detonation window.
    freeze(room, b.id, { x: 6, y: 31, z: 0 });
    freeze(room, c.id, { x: 8, y: 31, z: 0 }); // inside the pop radius

    for (let i = 0; i < 12; i++) {beamTick(room, a, b);}
    expect(b.charge).toBeGreaterThan(0);
    const hpC = c.health;
    b.health = 30; // ensure the rocket kill lands

    shootAt(room, a, b, WeaponType.BoltLauncher);
    step(room, 2);
    expect(b.isDead).toBe(true);
    expect(b.charge).toBe(0);
    expect(c.health).toBeLessThan(hpC);
  });

  it('bot direct hits detonate too — the rule is not claim-path-only', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    a.armorClass = 'light'; // Lightning is light-tier - the class-lock gate refuses medium/heavy
    freeze(room, b.id, { x: 30, y: 31, z: 0 });

    for (let i = 0; i < 12; i++) {beamTick(room, a, b);}
    const banked = b.charge;
    room.messages.botAttack(a.id, b.id, WeaponType.Chaingun);
    expect(b.charge).toBeLessThan(banked);
    expect(b.charge).toBeGreaterThan(0); // a pellet can't empty the bank
  });
});
