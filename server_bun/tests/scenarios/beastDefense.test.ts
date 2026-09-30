import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';
import type { Vec3 } from '../../src/types.ts';

// SpawnBall is private — scenario tests stage creatures directly rather
// than waiting on the population drip's wall-clock accumulator.
type Sim = { spawnBall(v: number, near?: Vec3, pos?: Vec3): { id: number };
  balls: Map<number, { health: number }> };
function spawnAt(room: ReturnType<typeof mkRoom>, pos: Vec3): number {
  const sim = room.ballSim as unknown as Sim;
  return sim.spawnBall(0, undefined, pos).id;
}
function ballHp(room: ReturnType<typeof mkRoom>, id: number): number | undefined {
  return (room.ballSim as unknown as Sim).balls.get(id)?.health;
}

describe('scenario: bots defend against creatures in any mode', () => {
  it('a beast inside 30m gets engaged in a team room', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const bot = [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
    pin(room, bot.id, { x: 0, y: 31, z: 0 });
    const bid = spawnAt(room, { x: 12, y: 31, z: 0 });
    const hp0 = ballHp(room, bid)!;
    expect(hp0).toBeGreaterThan(0);
    for (let i = 0; i < 400 && ballHp(room, bid) === hp0; i++) {
      pin(room, bot.id, { x: 0, y: 31, z: 0 });
      step(room, 1);
    }
    expect(ballHp(room, bid) ?? -1).toBeLessThan(hp0);
  });

  it('a beast on the bot outranks a mid-range player threat', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const bot = [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
    const foe = room.players.addPlayer('t-foe', 'bravo', 'none', 'medium');
    foe.isBot = false;
    pin(room, bot.id, { x: 0, y: 31, z: 0 });
    // Enemy player at 40m — inside THREAT_M, would normally always win
    // the hunt. Beast at 8m must outrank it anyway.
    pin(room, foe.id, { x: 40, y: 31, z: 0 });
    const bid = spawnAt(room, { x: 8, y: 31, z: 0 });
    const hp0 = ballHp(room, bid)!;
    for (let i = 0; i < 400 && ballHp(room, bid) === hp0; i++) {
      pin(room, bot.id, { x: 0, y: 31, z: 0 });
      pin(room, foe.id, { x: 40, y: 31, z: 0 });
      step(room, 1);
    }
    expect(ballHp(room, bid) ?? -1).toBeLessThan(hp0);
  });
});
