import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch } from './harness.ts';

// The nugget deploy mints a 'gem' pickup where the pod lands — it must
// survive ground contact and stay grabbable, not blink out on landing.

describe('scenario: nugget deploy mints a persistent pickup', () => {
  it('the gem lands, settles, and remains grabbable — not gone on impact', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 1,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const alpha = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    freeze(room, alpha.id, { x: 0, y: 31, z: 0 });

    const belt0 = alpha.beltCharges;
    room.deployables.handleDeploy(alpha.id, 'nugget', { x: 4, y: 31, z: 4 });
    expect(alpha.beltCharges).toBe(belt0 - 2);

    // The pickup must exist immediately (it mints at plant, not on land).
    const gems = room.pickups!.snapshot().filter((p) => p.kind === 'gem');
    expect(gems.length).toBe(1);

    // Thrower walks away so the arm delay can't self-collect, then settle.
    for (let i = 0; i < 120; i++) {
      freeze(room, alpha.id, { x: -20, y: 31, z: 0 });
      step(room, 1);
    }
    const rested = room.pickups!.snapshot().filter((p) => p.kind === 'gem');
    expect(rested.length).toBe(1); // STILL THERE after ground contact
    expect(w.count('pickupGone')).toBe(0);

    // And it can actually be picked up — walk onto it, one step past arm.
    for (let i = 0; i < 30; i++) {
      freeze(room, alpha.id, { x: 4, y: 31, z: 4 });
      step(room, 1);
    }
    expect(room.pickups!.snapshot().filter((p) => p.kind === 'gem').length).toBe(0);
    expect(w.count('pickupGone')).toBe(1);
  });
});
