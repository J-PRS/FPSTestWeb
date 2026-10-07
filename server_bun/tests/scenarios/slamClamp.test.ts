import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';

// Slam power derives from the move shadow's own velocity, clamped to
// [0.2, 1.8] — a 150 m/s shadow sample reads as a max-dive, nothing more.
describe('scenario: slam power clamp', () => {
  it('extreme shadow speed still lands at the 1.8x ceiling, not a nuke', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 4, y: 31, z: 0 }); // inside the blast ring
    const hp = b.health;
    room.players.getPlayer(a.id)!.velocity.y = -150;
    room.messages.handleMessage(a.id, {
      type: 'slam', position: { x: 0, y: 31, z: 0 },
    } as never);
    const loss = hp - b.health;
    // Base slam is 35 inside 9m — at 1.8x the legal ceiling that's ≤63.
    expect(loss).toBeGreaterThan(0);
    expect(loss).toBeLessThanOrEqual(63);
  });
});
