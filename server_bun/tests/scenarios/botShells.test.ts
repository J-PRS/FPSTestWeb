import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import type { Vec3 } from '../../src/types.ts';

// Bots fire REAL shells through RoomProjectiles — this suite pins the
// projectile→creature sweep and splash, and the honest miss.
type Sim = { spawnBall(v: number, near?: Vec3, pos?: Vec3): { id: number };
  balls: Map<number, { health: number }> };
function spawnAt(room: ReturnType<typeof mkRoom>, pos: Vec3): number {
  return (room.ballSim as unknown as Sim).spawnBall(0, undefined, pos).id;
}
function ballHp(room: ReturnType<typeof mkRoom>, id: number): number {
  return (room.ballSim as unknown as Sim).balls.get(id)?.health ?? -1;
}
function bot(room: ReturnType<typeof mkRoom>) {
  return [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
}

describe('scenario: bot shells hit creatures like player shots', () => {
  it('a rocket into the swarm takes direct + splash damage', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    const aim = spawnAt(room, { x: 20, y: 31, z: 0 });
    const splash = spawnAt(room, { x: 22.5, y: 31, z: 0 });
    const hpAim = ballHp(room, aim), hpSplash = ballHp(room, splash);
    const id = room.projectiles.spawn(b.id, WeaponType.Rocket,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(id).toBeTruthy();
    for (let i = 0; i < 60; i++) step(room, 1);
    // Direct-hit beast takes the directDamage line; its neighbor only the blast.
    expect(ballHp(room, aim)).toBeLessThan(hpAim);
    expect(ballHp(room, splash)).toBeLessThan(hpSplash);
  });

  it('a whiffed shell damages nothing — geometry, not dice', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const b = bot(room);
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    const aim = spawnAt(room, { x: 20, y: 31, z: 30 }); // 30m off-axis
    const hp0 = ballHp(room, aim);
    room.projectiles.spawn(b.id, WeaponType.Rocket,
      { x: 0, y: 31.4, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60; i++) step(room, 1);
    expect(ballHp(room, aim)).toBe(hp0);
  });

  it('a beam-rider bot welds a player for real — same funnel as botAttack', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const b = bot(room);
    const victim = room.players.addPlayer('victim');
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    pin(room, 'victim', { x: 10, y: 31, z: 0 }); // inside the 15m near band
    // Force the beam-rider kit (index 8) — near band draws Lightning, which
    // has no projectile body and routes through fireSpeedless.
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void };
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    };
    bots.loadouts.set(b.id, BOT_LOADOUTS[8]!);
    const hp0 = victim.health;
    for (let i = 0; i < 6; i++) bots.arsenal.fireAt(b, 'victim', { x: 10, y: 32, z: 0 });
    expect(victim.health).toBeLessThan(hp0);
  });

  it('a beam into empty dirt pays nothing — the tracer lies less than the RNG did', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const b = bot(room);
    const victim = room.players.addPlayer('victim');
    pin(room, b.id, { x: 0, y: 31, z: 0 });
    pin(room, 'victim', { x: 10, y: 31, z: 0 });
    const bots = room.bots as unknown as {
      arsenal: { fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, t: string, aim: Vec3): void };
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    };
    bots.loadouts.set(b.id, BOT_LOADOUTS[8]!);
    // Aim 4m over the victim's head — the ray must not "hit" anyway.
    bots.arsenal.fireAt(b, 'victim', { x: 10, y: 36, z: 0 });
    expect(victim.health).toBe(victim.maxHealth);
  });
});
