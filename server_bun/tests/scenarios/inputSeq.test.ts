import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer } from './harness.ts';

describe('scenario: inputMove seq gate', () => {
  it('stale input seqs never touch skiing or status', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);

    // seq=10 commits: ski flag + claimed status channel latch on.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 10,
      input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 4 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(1);
    expect(p.status & 4).toBe(4);

    // seq=5 is stale (reordered datagram): the sim drops it AND the status/
    // ski commit is skipped — a replayed old packet must not resurrect
    // flags the client already turned off.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 5,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(1);
    expect(p.status & 4).toBe(4);

    // seq=11 is fresh — commits normally.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 11,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(0);
    expect(p.status & 4).toBe(0);
  });
});
