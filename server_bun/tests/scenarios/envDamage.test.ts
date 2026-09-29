import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer, pin, watch } from './harness.ts';

describe('scenario: environmentDamage claims', () => {
  it('self-damage applies through the funnel, clamped at 40, forces a send', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const w = watch(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 }); // clear spawn protection — it legitimately absorbs hits
    p.health = 100;

    room.messages.handleMessage(p.id, { type: 'environmentDamage', amount: 900 });
    expect(p.health).toBe(60); // clamped to the 40 ceiling, not one-shot
    expect(p.forceSendUntil).toBeGreaterThan(Date.now()); // next tick can't suppress it
    expect(w.count('playerHit')).toBe(1);
  });

  it('dead reporters get nothing — no damage bookkeeping on a corpse', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const w = watch(room);
    p.isDead = true;
    room.messages.handleMessage(p.id, { type: 'environmentDamage', amount: 10 });
    expect(w.count('playerHit')).toBe(0);
  });
});
