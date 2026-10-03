import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

/** Regression: bot counts divisible by THINK_DIV parked the shared
 *  think counter — off-phase brains never thought, never fired; posted
 *  HoFs stood on the flag while enemies pressed the stand. Assert that
 *  a multiple-of-5 roster produces real fire volume across roles. */
describe('scenario: defenders fire in a free-running ctf room', () => {
  it('10-bot room: most brains produce volleys', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 10,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const fires = new Map<string, number>();
    const ars = room.bots.arsenal;
    const origFire = ars.fireAt.bind(ars);
    ars.fireAt = (p: Parameters<typeof origFire>[0], t: string, a: never) => {
      fires.set(p.id, (fires.get(p.id) ?? 0) + 1);
      return origFire(p, t, a);
    };
    // ~120 sim-seconds — enough for hunts to acquire and volley.
    for (let i = 0; i < 2400; i++) {
      for (const s of room.sims) s.tick(0.05);
      room.creatureSim.step(0.05);
      room.ballSim.step(0.05);
    }
    const firing = [...room.players.getAllPlayers().keys()]
      .filter((id) => id.startsWith('BOT-') && (fires.get(id) ?? 0) > 0);
    expect(firing.length).toBeGreaterThanOrEqual(4);
  });
});
