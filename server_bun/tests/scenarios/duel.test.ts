import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: two bots duel', () => {
  it('enemy-team bots shoot each other until one is hurt or dead', () => {
    // Team mode so bots actually hunt each other (FFA bots skip bot-vs-bot —
    // filler fighting filler is wasted compute by design).
    const room = mkRoom({ mode: 'tdm', bots: 2,
      bases: { alpha: { x: -100, y: 60, z: 0 }, bravo: { x: 100, y: 60, z: 0 } } }, 'tdm');
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    expect(bots.length).toBe(2);
    const [a, b] = bots;
    expect(a!.team).not.toBe(b!.team); // balanced across teams
    a!.health = 40; b!.health = 40; // force a quick resolution
    // Pin them 30m apart — brains roam to objectives on the first think,
    // and the thing under test is the fire → projectile → damage chain.
    for (let i = 0; i < 400 && w.count('playerKill') === 0; i++) {
      pin(room, a!.id, { x: -15, y: 32, z: 0 });
      pin(room, b!.id, { x: 15, y: 32, z: 0 });
      step(room, 1);
    }
    expect(w.count('projectileCreated')).toBeGreaterThan(0);
    expect(w.count('playerHit') + w.count('playerKill')).toBeGreaterThan(0);
  });
});
