import { describe, expect, it } from 'bun:test';
import { mkRoom, pin } from './harness.ts';
import type { Room } from '../../src/Room.ts';

// Stamped input edges: the client's ageMs lands each edge at its real
// intra-tick time instead of the uniform-slice approximation. The
// observable is acceleration: a forward edge that fired 5ms before send
// holds ~5ms of the window, while an unstamped edge holds all 50ms.

const speed = (room: Room, pid: string): number => {
  const s = room.moveSim.simState(pid);
  if (!s) {throw new Error('no sim state');}
  return Math.hypot(s.vel.x, s.vel.z);
};

const drive = (ageMs?: number): Room => {
  const room = mkRoom({}, 'dm');
  room.players.addPlayer('p1', 'alpha', 'none', 'medium');
  pin(room, 'p1', { x: 0, y: 1, z: 0 });
  room.moveSim.track('p1', { x: 0, y: 1, z: 0 }, 0);
  room.moveSim.queueInput('p1', { forward: 1, right: 0 }, 0, 1, ageMs);
  room.moveSim.tick(0.05);
  return room;
};

describe('stamped input edges', () => {
  it('a late-stamped edge accelerates for its real slice, not the whole tick', () => {
    const stamped = speed(drive(5), 'p1');
    const uniform = speed(drive(undefined), 'p1');
    // ~5ms of thrust vs ~50ms — the tail slice lands in the sim's
    // sub-step accumulator (vz may still read 0 this tick; the residue
    // applies next tick). Assert ordering, not an absolute floor.
    expect(uniform).toBeGreaterThan(stamped * 2);
    expect(stamped).toBeLessThan(uniform * 0.5);
  });

  it('a forged deep-past ageMs clamps instead of time-traveling', () => {
    // 60s ago is absurd on any link — clamps to the transit+jitter
    // window (~50ms floor), so it replays as a nearly-full-window edge:
    // bounded generosity, not arbitrary replay.
    const forged = speed(drive(60_000), 'p1');
    const uniform = speed(drive(undefined), 'p1');
    expect(forged).toBeLessThanOrEqual(uniform * 1.01);
    expect(forged).toBeGreaterThan(uniform * 0.5);
  });
});
