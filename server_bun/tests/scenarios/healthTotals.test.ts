import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';

describe('scenario: room health rollup', () => {
  it('flushes counters to the log line and keeps cumulative totals for /metrics', () => {
    const room = mkRoom({ bots: 0 });
    room.healthBump('shot', 3);
    room.healthBump('rej.Shot');
    room.healthBump('gapMax', 9);

    // Under the 15s window nothing is folded yet — and nothing is lost.
    step(room, 100, 0.05); // 5s
    expect(room.healthTotal.get('shot')).toBeUndefined();

    // Past the flush, the window clears into since-boot totals — metrics
    // can scrape any time without racing the rollup.
    step(room, 220, 0.05); // +11s → past 15s
    expect(room.health.size).toBe(0);
    expect(room.healthTotal.get('shot')).toBe(3);
    expect(room.healthTotal.get('rej.Shot')).toBe(1);
    expect(room.healthTotal.get('gapMax')).toBe(9);

    // Second window: counters accumulate; the gap gauge takes the max.
    room.healthBump('shot', 2);
    room.healthBump('gapMax', 5);
    step(room, 310, 0.05);
    expect(room.healthTotal.get('shot')).toBe(5);
    expect(room.healthTotal.get('gapMax')).toBe(9);
  });
});
