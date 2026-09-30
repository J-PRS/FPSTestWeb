import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers, watch } from './harness.ts';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Server-side LG charge economy: beam ticks bank withheld damage ON the
// victim, a non-LG hit detonates only what it invests, and a kill pops
// the corpse for the whole remaining bank.
type Room = ReturnType<typeof mkRoom>;
type Player = ReturnType<typeof twoPlayers>[number];

function beamTick(room: Room, shooterId: string, victim: Player): void {
  room.messages.handleMessage(shooterId, {
    type: 'aoeShot',
    position: { ...victim.position },
    weaponType: WeaponType.Lightning,
    excludeTargetId: victim.id,
    projectileId: null,
    airtime: 0,
  } as never);
}

/** Fire a real projectile at the victim and claim the hit — spawn then
 *  claim, the same contract clients follow. */
function shootAt(room: Room, shooter: Player, victim: Player, weapon: WeaponType): void {
  const w = watch(room);
  const dir = {
    x: victim.position.x - shooter.position.x,
    y: 0,
    z: victim.position.z - shooter.position.z,
  };
  const len = Math.hypot(dir.x, dir.z) || 1;
  const speed = getWeaponStats(weapon).speed ?? 90;
  room.messages.handleMessage(shooter.id, {
    type: 'shot', targetId: null, weaponType: weapon,
    position: { x: shooter.position.x, y: shooter.position.y + 1.6, z: shooter.position.z },
    velocity: { x: (dir.x / len) * speed, y: 0, z: (dir.z / len) * speed },
  } as never);
  const created = w.msgs.filter((m) => m.type === 'projectileCreated') as Extract<ServerMessage, { type: 'projectileCreated' }>[];
  const pid = created[created.length - 1]?.projectileId;
  room.messages.handleMessage(shooter.id, {
    type: 'shot', targetId: victim.id, weaponType: weapon, projectileId: pid,
    position: { x: victim.position.x, y: victim.position.y + 1, z: victim.position.z },
    airtime: 0.3,
  } as never);
}

describe('scenario: LG charge economy vs players', () => {
  it('beam ticks bank withheld damage on the victim', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    expect(b.charge).toBe(0);

    for (let i = 0; i < 10; i++) beamTick(room, a.id, b);
    // Ticks 1-4 pay full damage (bank 0); 5-9 bank (4-3)x2=2 each,
    // 10+ bank (4-2)x2=4 — 10 + 4 = 14 gross, minus tiny drain.
    expect(b.charge).toBeGreaterThan(10);
    expect(b.charge).toBeLessThan(15);
  });

  it('a non-LG hit detonates only min(banked, damage) — the rest smolders', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });

    for (let i = 0; i < 12; i++) beamTick(room, a.id, b);
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
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    freeze(room, c.id, { x: 32, y: 31, z: 0 }); // inside the pop radius

    for (let i = 0; i < 12; i++) beamTick(room, a.id, b);
    expect(b.charge).toBeGreaterThan(0);
    const hpC = c.health;
    b.health = 30; // ensure the rocket kill lands

    shootAt(room, a, b, WeaponType.Rocket);
    step(room, 2);
    expect(b.isDead).toBe(true);
    expect(b.charge).toBe(0);
    expect(c.health).toBeLessThan(hpC);
  });

  it('bot direct hits detonate too — the rule is not claim-path-only', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });

    for (let i = 0; i < 12; i++) beamTick(room, a.id, b);
    const banked = b.charge;
    room.messages.botAttack(a.id, b.id, WeaponType.Chaingun);
    expect(b.charge).toBeLessThan(banked);
    expect(b.charge).toBeGreaterThan(0); // a pellet can't empty the bank
  });
});
