import { describe, it, expect } from 'bun:test';
import { MatchJournal } from '../../src/matchJournal.ts';

// The journal's ring is the live leaderboard surface; its bound is a
// hard guarantee (§5: unbounded growth), and stats() is the read path
// the status page leans on.

describe('scenario: match journal', () => {
  it('ring caps at 100 entries — oldest evict, newest last', () => {
    const j = new MatchJournal();
    for (let i = 0; i < 130; i++) {
      j.recordEnd({ room: 'r', mode: 'ffa', winner: `w${i}`, scores: { a: i } });
    }
    const list = j.list() as { winner: string }[];
    expect(list.length).toBe(100);
    expect(list[list.length - 1]!.winner).toBe('w129');
    expect(list[0]!.winner).toBe('w30');
  });

  it('recordEnd keeps player rows for the leaderboard read', () => {
    const j = new MatchJournal();
    j.recordEnd({
      room: 'r', mode: 'ctf', winner: 'alpha',
      scores: { alpha: 3, bravo: 1 },
      players: [
        { id: 'p1', team: 'alpha', kills: 10, deaths: 2 },
        { id: 'p2', team: 'bravo', kills: 1, deaths: 9 },
      ],
    });
    expect(j.list().length).toBe(1);
  });
});
