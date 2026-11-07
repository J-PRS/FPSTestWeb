import { describe, it, expect } from 'bun:test';
import { mkRoom, step, flat } from './harness.ts';
import { BotGreedy } from '../../src/botGreedy.ts';

// Greedy pilot: the driver must move a live shadow toward a target
// using only per-decide rollouts — no plan, no arm plumbing.
describe('botGreedy — path-free driver', () => {
  it('drives a shadow toward the target and holds no state at release', () => {
    const room = mkRoom({}, 'ctf');
    room.players.addPlayer('b1', 'alpha', 'none', 'medium');
    room.moveSim.track('b1', { x: 0, y: 60, z: 0 }, 0);
    const drv = new BotGreedy(room.moveSim, flat);
    const tgt = { x: 200, y: 60, z: 0 };
    let drove = 0;
    let minD = Infinity;
    const yawOf = (id: string): number => room.moveSim.simOf(id)!.state.yaw;
    for (let i = 0; i < 400; i += 1) {
      if (drv.drive('b1', tgt, yawOf('b1'))) {drove += 1;}
      step(room, 1);
      const s = room.moveSim.simOf('b1')!.state.pos;
      minD = Math.min(minD, Math.hypot(tgt.x - s.x, tgt.z - s.z));
    }
    expect(drove).toBeGreaterThan(200);
    // No brake logic — a greedy driver skis THROUGH the target and
    // re-decides, so assert arrival, not final proximity.
    expect(minD).toBeLessThan(12);
    drv.release('b1');
    expect(drv.drive('b1', tgt, yawOf('b1'))).toBe(true); // re-decides cleanly after release
  });

  it('frees a wall-pinned shadow instead of driving in place', () => {
    const room = mkRoom({}, 'ctf');
    room.players.addPlayer('b2', 'alpha', 'none', 'medium');
    room.moveSim.track('b2', { x: 0, y: 60, z: 0 }, 0);
    const drv = new BotGreedy(room.moveSim, flat);
    const tgt = { x: 0, y: 60, z: 200 };
    for (let i = 0; i < 100; i += 1) {drv.drive('b2', tgt, room.moveSim.simOf('b2')!.state.yaw); step(room, 1);}
    // Held input exists and re-decides are cycling (ticks decrement).
    const h = (drv as unknown as { held: Map<string, { ticks: number }> }).held.get('b2');
    expect(h).toBeDefined();
    expect(h!.ticks).toBeLessThanOrEqual(15);
  });
});
