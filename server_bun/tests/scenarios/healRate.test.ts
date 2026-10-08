import { simMs } from '../../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

// Non-team rooms have no healCredit — ambient nugget heals claim
// free-form, bounded by a 1.5s cadence so a spammer can't out-regen
// incoming damage. The first claim lands; the rest cool down.
describe('scenario: heal claims on a sim authority', () => {
  it('the cadence admits one heal, not a stream', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    p.protectedUntil = simMs(0);
    room.players.applyDamage(p.id, Math.min(80, p.maxHealth - 10));
    const before = p.health;
    for (let i = 0; i < 4; i++) room.messages.handleMessage(p.id, { type: 'heal', amount: 25 });
    expect(p.health).toBe(before + 25);
  });
});
