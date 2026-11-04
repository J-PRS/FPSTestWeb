import { simMs } from '../../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

// Dedicated rooms refuse heal claims at the wire gate regardless of
// team mode — server pickups pay heals directly through onCollect, so
// a claim stream is a regen cheat, not a nugget report. The 1.5s
// cadence in handleHeal still serves P2P hosts (envClaims.test.ts).
describe('scenario: heal claims on a sim authority', () => {
  it('the gate refuses the whole stream — zero heals, not one', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    p.protectedUntil = simMs(0);
    room.players.applyDamage(p.id, Math.min(80, p.maxHealth - 10));
    const before = p.health;
    for (let i = 0; i < 4; i++) room.messages.handleMessage(p.id, { type: 'heal', amount: 25 });
    expect(p.health).toBe(before);
  });
});
