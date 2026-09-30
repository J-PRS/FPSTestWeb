import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

// Non-team rooms accept free-form heal claims (local nuggets have no
// server backing), so the rate limit is the only bound on invincibility
// heals — 3 per 2s, ~37hp/s ceiling.
describe('scenario: heal rate bound', () => {
  it('the 4th claim inside the window is dropped', () => {
    const room = mkRoom({ bots: 1 }); // no mode → non-team, free-form heal
    const p = firstPlayer(room);
    p.protectedUntil = 0; // spawn protection eats the staged damage
    room.players.applyDamage(p.id, 80); // leave room for three full heals
    const before = p.health;
    const heal = () => room.messages.handleMessage(p.id, { type: 'heal', amount: 25 });
    heal(); heal(); heal();
    const afterThree = p.health;
    expect(afterThree).toBeGreaterThan(before); // free-form heals did land
    heal(); // past the 3/2s cap — dropped before any heal lands
    expect(p.health).toBe(afterThree);
  });
});
