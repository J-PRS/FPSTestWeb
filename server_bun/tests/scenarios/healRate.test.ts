import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

// The heal verb keeps a 3/2s rate bucket for the claim-accepting
// authorities that still decode it; on a sim-running Room every claim
// is refused before the bucket matters — even the first.
describe('scenario: heal claims refused on a sim authority', () => {
  it('no claim ever lands a heal', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    p.protectedUntil = 0;
    room.players.applyDamage(p.id, Math.min(80, p.maxHealth - 10));
    const before = p.health;
    for (let i = 0; i < 4; i++) room.messages.handleMessage(p.id, { type: 'heal', amount: 25 });
    expect(p.health).toBe(before);
  });
});
