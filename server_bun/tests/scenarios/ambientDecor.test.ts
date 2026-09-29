import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';

describe('scenario: ambient is decor only', () => {
  it('ambient caps never create server creatures — interactivity goes through `creatures`', () => {
    // JP's rule: anything interactive must be server-shared; ambient is
    // client-side dressing. Lock it so a spec can't smuggle living things
    // into the decor channel.
    const room = mkRoom({ ambient: { crawler: 12, rakk: 8 }, bots: 1 });
    step(room, 40);
    expect(room.creatureSim.roster().length).toBe(0);
    const shared = mkRoom({ creatures: { crawler: 4 }, bots: 1 });
    step(shared, 40);
    expect(shared.creatureSim.roster().length).toBeGreaterThan(0);
  });
});
