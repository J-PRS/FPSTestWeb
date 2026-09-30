import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

// Removal paths that skip onPlayerDisconnected (kick, idle reap, admin
// reload, bot retire) must still free the moveSim shadow — the untrack
// lives on onPlayerRemoved so every funnel hits it.
describe('scenario: moveSim shadow leak', () => {
  it('removePlayerCompletely frees the shadow', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    expect(room.moveSim.energyOf(p.id)).not.toBeNull(); // shadow exists
    room.removePlayerCompletely(p.id, 'test', () => {});
    expect(room.moveSim.energyOf(p.id)).toBeNull();
  });
});
