import { describe, it, expect } from 'vitest';
import { rankRows, type SbRow } from '../ui/hud/scoreboard';

// One row factory keeps each case honest about which column drives it.
function row(name: string, frags: number, deaths: number, score: number | null = null): SbRow {
  return { name, frags, deaths, score, ping: null, self: false, dead: false };
}

describe('scoreboard ranking', () => {
  it('dm ranks by frags — creature pts cannot outrank a frag leader', () => {
    // BRICK case: 1 kill + 66 creature pts beat a 6-frag player under
    // the old score-first sort.
    const rows = [row('farmer', 1, 2, 67), row('slayer', 6, 6, 62)];
    expect(rankRows('dm', rows).map(r => r.name)).toEqual(['slayer', 'farmer']);
  });

  it('kill modes share the frag rule', () => {
    const rows = [row('a', 2, 0, 99), row('b', 5, 4, 3)];
    for (const mode of ['tdm', 'duel']) {
      expect(rankRows(mode, rows)[0]!.name).toBe('b');
    }
  });

  it('objective modes rank by pts', () => {
    const rows = [row('dmhero', 12, 3, 4), row('capper', 1, 8, 23)];
    for (const mode of ['ctf', 'flagrun', 'rabbit', 'nuggets']) {
      expect(rankRows(mode, rows)[0]!.name).toBe('capper');
    }
  });

  it('falls back to frags when pts are untracked', () => {
    const rows = [row('a', 1, 0), row('b', 9, 2)];
    expect(rankRows('nuggets', rows).map(r => r.name)).toEqual(['b', 'a']);
  });

  it('ties break deterministically: deaths asc, then name', () => {
    const rows = [row('zed', 5, 9), row('amy', 5, 9), row('mid', 5, 2)];
    expect(rankRows('dm', rows).map(r => r.name)).toEqual(['mid', 'amy', 'zed']);
  });
});
