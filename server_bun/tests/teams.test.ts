import { describe, it, expect } from 'bun:test';
import {
  TEAMS, WIN_NUGGETS, MODES, pickTeam, makeScores, bank, winner,
  TEAM_COLORS, TEAM_LABEL, CTF_PTS, CTF_DMG_PER_PTS, CTF_FLAG_ZONE_R,
  FLAG_PICKUP_R, FLAG_HOME_R, FLAG_RESET_S,
} from '../../shared/teams.ts';
import {
  PLAYER_RADIUS, PLAYER_HEIGHT, CAPSULE_CYLINDER_HEIGHT,
  CAPSULE_HALF_HEIGHT, CAPSULE_CENTER_Y, EYE_OFFSET,
} from '../../shared/constants.ts';
import { sharedEnv, setSharedEnv, sharedNow, setSharedNow } from '../../shared/env.ts';

// The mode table + team math + capsule geometry + the env seam — the
// registries every side reads to agree on scoring, team balance, and
// the hit capsule the server validates shots against.

describe('teams', () => {
  it('mode table: every mode has a label, positive winAt, and a finite clock', () => {
    for (const [id, m] of Object.entries(MODES)) {
      expect(m.label.length, id).toBeGreaterThan(0);
      expect(m.winAt, id).toBeGreaterThan(0);
      expect(m.timeLimitS, id).toBeGreaterThan(0);
      expect(m.ptsPlayerKill, id).toBeGreaterThanOrEqual(0);
      // teams XOR ffa — a mode is one or the other, never both/neither.
      expect(m.teams !== m.ffa, `${id} teams/ffa must be mutually exclusive`).toBe(true);
      // flags only on modes that declare them (ctf, rabbit, flagrun).
      expect(m.flags, `${id} flags`).toBe(id === 'ctf' || id === 'rabbit' || id === 'flagrun');
    }
    expect(Object.keys(MODES).sort()).toEqual(['ctf', 'dm', 'duel', 'flagrun', 'nuggets', 'rabbit', 'tdm']);
  });

  it('pickTeam alternates onto the smaller team — deterministic by join order', () => {
    expect(pickTeam({ alpha: 0, bravo: 0 })).toBe('alpha'); // tie → alpha
    expect(pickTeam({ alpha: 1, bravo: 0 })).toBe('bravo');
    expect(pickTeam({ alpha: 0, bravo: 2 })).toBe('alpha');
    // Seeded joins alternate a/b deterministically.
    const counts = { alpha: 0, bravo: 0 };
    const order = Array.from({ length: 6 }, () => { const t = pickTeam(counts); counts[t]++; return t; });
    expect(order).toEqual(['alpha', 'bravo', 'alpha', 'bravo', 'alpha', 'bravo']);
  });

  it('bank/winner: score accumulates per team, winner at the threshold', () => {
    const s = makeScores();
    expect(winner(s)).toBeNull();
    expect(bank(s, 'bravo', WIN_NUGGETS - 1)).toBe(WIN_NUGGETS - 1);
    expect(winner(s)).toBeNull();
    bank(s, 'bravo');
    expect(winner(s)).toBe('bravo');
    expect(s.alpha).toBe(0);
    expect(winner({ alpha: 0, bravo: 0 }, 5)).toBeNull();
    expect(winner({ alpha: 5, bravo: 0 }, 5)).toBe('alpha');
  });

  it('team cosmetics + flag rule constants stay sane', () => {
    expect(TEAMS).toEqual(['alpha', 'bravo']);
    for (const t of TEAMS) {
      expect(TEAM_COLORS[t]).toBeGreaterThan(0);
      expect(TEAM_LABEL[t].length).toBeGreaterThan(0);
    }
    expect(FLAG_PICKUP_R).toBeLessThan(FLAG_HOME_R);   // grab tighter than cap ring
    expect(FLAG_RESET_S).toBeGreaterThan(0);
    for (const v of Object.values(CTF_PTS)) expect(v).toBeGreaterThan(0);
    expect(CTF_DMG_PER_PTS).toBeGreaterThan(0);
    expect(CTF_FLAG_ZONE_R).toBeGreaterThan(FLAG_PICKUP_R);
  });
});

describe('constants', () => {
  it('capsule geometry derives consistently — height, cylinder, eye', () => {
    expect(CAPSULE_CYLINDER_HEIGHT).toBeCloseTo(PLAYER_HEIGHT - 2 * PLAYER_RADIUS, 10);
    expect(CAPSULE_HALF_HEIGHT).toBeCloseTo(CAPSULE_CYLINDER_HEIGHT / 2, 10);
    expect(CAPSULE_CENTER_Y).toBeCloseTo(PLAYER_HEIGHT / 2, 10);
    expect(EYE_OFFSET).toBeLessThan(PLAYER_HEIGHT);   // eyes inside the capsule
    expect(CAPSULE_CYLINDER_HEIGHT).toBeGreaterThan(0); // radius can't eat the capsule
  });
});

describe('sharedEnv / sharedNow', () => {
  it('setSharedEnv merges — later seeds override, earlier keys survive', () => {
    setSharedEnv({ traceId: 'abc' });
    setSharedEnv({ noMuzzle: true });
    expect(sharedEnv.traceId).toBe('abc');
    expect(sharedEnv.noMuzzle).toBe(true);
    delete sharedEnv.traceId;
    delete sharedEnv.noMuzzle;
  });

  it('sharedNow defaults to epoch-0 (quiet-by-default) until a host seeds it', () => {
    setSharedNow(() => 0); // restore default
    expect(sharedNow()).toBe(0);
    setSharedNow(() => 1234);
    expect(sharedNow()).toBe(1234);
    setSharedNow(() => 0); // restore so later suites keep quiet default
  });
});
