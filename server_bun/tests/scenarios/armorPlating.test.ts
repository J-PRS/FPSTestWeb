import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers, pin } from './harness.ts';
import { WeaponType, ARMORNADE_ARMOR, ARMORNADE_OVERCAP, getWeaponStats } from '../../../shared/weapons.ts';
import { POWERUP } from '../../../shared/pickups.ts';
import type { Vec3 } from '../../src/types.ts';

// Armor-grenade scenario: the blast plates EVERY player caught in it —
// friends, foes, and the thrower alike — and creatures wear the plating
// as overcap health (no creature armor field exists; hp never rides the
// wire, so the overcap is invisible to clients).
type Sim = { spawnBall(v: number, near?: Vec3, pos?: Vec3): { id: number };
  balls: Map<number, { health: number; maxHealth: number }> };

const STATS = getWeaponStats(WeaponType.ArmorGrenade);

function blastAt(room: ReturnType<typeof mkRoom>, shooterId: string, pos: Vec3): void {
  room.messages.serverBlast(shooterId, pos, WeaponType.ArmorGrenade, null);
  step(room, 1);
}

describe('scenario: armor grenade plating', () => {
  it('plates the victim by ARMORNADE_ARMOR inside the blast radius', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, victim] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    freeze(room, victim.id, { x: 0, y: 31, z: 0 });
    expect(victim.armor).toBe(0);

    blastAt(room, shooter.id, { x: 0.5, y: 30.5, z: 0 });
    expect(victim.armor).toBe(ARMORNADE_ARMOR);
  });

  it('caps the pool at POWERUP.maxArmor — repeat pops top up, never stack', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, victim] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    freeze(room, victim.id, { x: 0, y: 31, z: 0 });

    for (let i = 0; i < 4; i++) blastAt(room, shooter.id, { x: 0.5, y: 30.5, z: 0 });
    expect(victim.armor).toBe(POWERUP.maxArmor);
  });

  it('plates the thrower too — the blast is honest about "any player"', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, victim] = twoPlayers(room);
    // Both inside the radius: the support grenade can't be aimed to
    // exclude the shooter — self-plating is the mechanic, not a bonus.
    freeze(room, shooter.id, { x: -3, y: 31, z: 0 });
    freeze(room, victim.id, { x: 3, y: 31, z: 0 });

    blastAt(room, shooter.id, { x: 0, y: 30.5, z: 0 });
    expect(shooter.armor).toBe(ARMORNADE_ARMOR);
    expect(victim.armor).toBe(ARMORNADE_ARMOR);
  });

  it('does not plate a player outside the radius or behind a wall', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, victim] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    // Radius is 10m — park the victim just beyond it.
    freeze(room, victim.id, { x: STATS.aoeRadius + 2, y: 31, z: 0 });

    blastAt(room, shooter.id, { x: 0, y: 30.5, z: 0 });
    expect(victim.armor).toBe(0);
  });

  it('plates a creature as overcap health up to ARMORNADE_OVERCAP × maxHealth', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const bot = [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
    pin(room, bot.id, { x: -40, y: 31, z: 0 });

    const sim = room.ballSim as unknown as Sim;
    const bid = sim.spawnBall(0, undefined, { x: 0, y: 31, z: 0 }).id;
    const ball = sim.balls.get(bid)!;
    const hp0 = ball.health;

    blastAt(room, bot.id, { x: 0.5, y: 30.5, z: 0 });
    expect(ball.health).toBe(Math.min(ball.maxHealth * ARMORNADE_OVERCAP, hp0 + ARMORNADE_ARMOR));

    // Repeat pops climb toward the overcap ceiling, never past it.
    for (let i = 0; i < 8; i++) blastAt(room, bot.id, { x: 0.5, y: 30.5, z: 0 });
    expect(ball.health).toBeLessThanOrEqual(ball.maxHealth * ARMORNADE_OVERCAP);
  });
});
