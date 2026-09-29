import { describe, it, expect } from 'bun:test';
import { WIN_NUGGETS } from '../../../shared/teams.ts';
import { mkRoom, watch } from './harness.ts';

describe('scenario: match end reset funnel', () => {
  it('reaching winAt ends, resets the board, and starts a fresh match', () => {
    const room = mkRoom({ mode: 'nuggets' });
    const w = watch(room);
    room.score('alpha', WIN_NUGGETS);
    const end = w.msgs.find((m) => m.type === 'matchEnd')!;
    expect((end as { winner?: string }).winner).toBe('alpha');
    expect((end as { scores?: { alpha: number } }).scores!.alpha).toBe(WIN_NUGGETS);
    // The funnel must restart — a matchEnd with no matchStart strands
    // every client on a frozen board.
    expect(w.count('matchStart')).toBe(1);
    expect(room.scores.alpha).toBe(0);
    expect(room.scores.bravo).toBe(0);
  });
});
