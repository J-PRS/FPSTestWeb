import { describe, expect, it, vi } from 'vitest';
import { resetMatch, type MatchHost } from '../game/bots/botMatch.js';
import { makeScores } from '../../../shared/teams.js';
import * as THREE from 'three';
import type { GameBot } from '../game/bots/botBrain.js';

// resetMatch is the offline match-boundary funnel — every per-match
// receipt must drain through it or a new match inherits stale state.
// A new keyed map added without a reset hop fails here instead of
// leaking the last match's meters into the next.
const mkBot = (id: string, isDead: boolean) => ({
  playerId: id, carryingFlag: true, isDead,
  botHp: 10, botMaxHp: 100, sheep: 40, sheepShown: 40,
  position: new THREE.Vector3(),
} as unknown as GameBot);

const mkHost = () => {
  const bots = [mkBot('a', true), mkBot('b', false)];
  const m = {
    over: 'alpha' as string | null,
    overAt: 1,
    scores: makeScores(),
    ffaScores: new Map([['local', 5], ['a', 3]]),
    dmgPool: new Map([['local', 90]]),
    teamOf: new Map(),
    bots,
    ctf: { reset: vi.fn() },
    rabbit: { reset: vi.fn() },
    flagrun: { reset: vi.fn() },
    spec: { label: 'test' },
    deps: { world: {}, lazyHud: () => ({ setTeamScore: vi.fn() }) },
    hooks: { killFeed: vi.fn(), remoteKillFeed: vi.fn() },
    respawnBot: vi.fn(),
    rekeyBot: vi.fn(),
  } as unknown as MatchHost;
  m.scores.alpha = 7; m.scores.bravo = 4;
  return { m, bots };
};

describe('resetMatch purges per-match state', () => {
  it('zeroes the scoreboard, damage pool, flags and sheep meters', () => {
    const { m, bots } = mkHost();
    resetMatch(m);
    expect(m.over).toBeNull();
    expect(m.scores.alpha + m.scores.bravo).toBe(0);
    for (const v of m.ffaScores.values()) {expect(v).toBe(0);}
    expect(m.dmgPool.size).toBe(0);
    expect((m.ctf as { reset: unknown }).reset).toHaveBeenCalled();
    expect((m.rabbit as { reset: unknown }).reset).toHaveBeenCalled();
    expect((m.flagrun as { reset: unknown }).reset).toHaveBeenCalled();
    for (const b of bots) {
      expect(b.carryingFlag).toBe(false);
      if (!b.isDead) {expect(b.sheep).toBe(100); expect(b.sheepShown).toBe(100);}
    }
    expect(m.respawnBot).toHaveBeenCalledTimes(1); // only the dead one
    expect(m.hooks.remoteKillFeed).toHaveBeenCalledWith(expect.stringContaining('NEW MATCH'));
  });
});
