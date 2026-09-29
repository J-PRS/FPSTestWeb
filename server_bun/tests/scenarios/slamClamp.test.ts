import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';

// Slam power is client-reported impact speed — the server clamps it to
// [0.2, 1.8], so a forged power=100 must never amplify past a max dive.
describe('scenario: slam power clamp', () => {
  it('forged extreme power still lands at the 1.8x ceiling, not a nuke', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 4, y: 31, z: 0 }); // inside the blast ring
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'aoeShot', weaponType: 8 /* Slam */,
      position: { x: 2, y: 31, z: 0 }, power: 100,
    } as never);
    const loss = hp - b.health;
    // Base slam is 35 inside 9m — at 1.8x the legal ceiling that's ≤63.
    expect(loss).toBeGreaterThan(0);
    expect(loss).toBeLessThanOrEqual(63);
  });
});
