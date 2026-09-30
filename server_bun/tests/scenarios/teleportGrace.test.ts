import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';

describe('scenario: teleport report grace', () => {
  it('mutes the plausibility judge for in-flight pre-warp reports', () => {
    const room = mkRoom({ bots: 2 });
    const [a] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });

    room.messages.handleMessage(a.id, {
      type: 'teleport',
      position: { x: 120, y: 31, z: 120 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 1, pitch: 0 },
    });

    // A report queued before the client warped still comes from the old
    // neighborhood — 170m from the new anchor. Without the drain window
    // that reads as impossible speed and starts a reject streak.
    const straggler = { x: 2, y: 31, z: 1 };
    room.messages.handleMessage(a.id, {
      type: 'position',
      position: straggler,
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      seq: a.lastSeq + 1,
    });

    expect(a.consecutiveRejects).toBe(0);
    // Judge mode keeps the client's own report as truth — the straggler
    // is accepted, not bounced.
    expect(a.position).toEqual(straggler);
  });
});
