import { describe, it, expect } from 'bun:test';
import { mkRoom, step, watch, firstPlayer, freeze } from './harness.ts';

describe('scenario: dropped loot decays', () => {
  it('an uncollected gem expires at 60s — the economy can\'t accumulate garbage', () => {
    const room = mkRoom({ mode: 'nuggets', bots: 1 }, 'nuggets');
    const w = watch(room);
    const bot = firstPlayer(room);
    // Nuggets brains hunt pickups — silence it or the gem gets eaten
    // instead of decaying.
    freeze(room, bot.id, { x: 0, y: 31, z: 0 });
    room.pickups!.spawn({ x: 100, y: 31, z: 0 }, 'gem');
    expect(room.pickups!.snapshot().length).toBe(1);
    step(room, 1150); // 57.5s — still alive
    expect(room.pickups!.snapshot().length).toBe(1);
    step(room, 100); // past 60s TTL
    expect(room.pickups!.snapshot().length).toBe(0);
    const gone = w.msgs.find((m) => m.type === 'pickupGone') as { by?: string | null } | undefined;
    expect(gone).toBeTruthy();
    expect(gone!.by ?? null).toBeNull(); // decayed, not collected
  });
});
