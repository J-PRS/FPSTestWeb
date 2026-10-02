import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: disc-jump propel', () => {
  it('a grounded bot with a distant goal fires a shot into the ground', () => {
    const room = mkRoom({ mode: 'ctf', bots: 1,
      // Far stands: the press probes a staged ENTRY waypoint first, and
      // with close bases the first stage sits <35m out — under the
      // launch gate. Real routes are hundreds of metres.
      bases: { alpha: { x: -400, y: 60, z: 0 }, bravo: { x: 400, y: 60, z: 0 } } }, 'ctf');
    const w = watch(room);
    const bot = [...room.players.getAllPlayers().values()].find((p) => p.isBot)!;
    // Hunt-role goals point at the enemy base ~100m out — eligible once
    // the bot is grounded, slow, and has tank.
    let saw = false;
    for (let i = 0; i < 300 && !saw; i++) {
      pin(room, bot.id, { x: 0, y: 31, z: 0 });
      step(room, 1);
      saw = w.msgs.some((m) => m.type === 'projectileCreated'
        && (m as { ownerId?: string }).ownerId === bot.id
        && ((m as { velocity?: { y: number } }).velocity?.y ?? 0) < -10);
    }
    expect(saw).toBe(true);
  });
});
