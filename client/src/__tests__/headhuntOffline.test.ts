import { describe, expect, it, vi } from 'vitest';
import { collect, syncHeld, checkWin, clockWin, resetMatch, type MatchHost } from '../game/bots/botMatch.js';
import { MODES, makeScores } from '../../../shared/teams.js';
import * as THREE from 'three';
import type { GameBot } from '../game/bots/botBrain.js';

type THost = MatchHost & { _held: Map<string, number> };

// Offline headhunt referee — the TeamBots half of the hold economy.
// MatchHost fakes carry the same held/teamOf/scores surface the real
// host does, so collect/syncHeld/clockWin/checkWin/resetMatch run their
// real logic without a live lobby.
const mkHost = (extra?: Partial<MatchHost>): MatchHost => {
  const held = new Map<string, number>();
  const m = {
    over: null as string | null,
    scores: makeScores(),
    ffaScores: new Map<string, number>(),
    teamOf: new Map<string, string>([['local', 'alpha'], ['b1', 'alpha'], ['b2', 'bravo']]),
    bots: [{ playerId: 'b1' }, { playerId: 'b2' }] as GameBot[],
    spec: MODES.headhunt,
    mode: 'headhunt',
    matchStart: performance.now(),
    heldOf: (id: string): number => held.get(id) ?? 0,
    setHeld: (id: string, n: number): void => { held.set(id, n); },
    dmgPool: new Map(),
    ctf: { reset: vi.fn() },
    rabbit: { reset: vi.fn() },
    flagrun: { reset: vi.fn() },
    deps: { world: { killCounts: new Map(), deathCounts: new Map() }, lazyHud: () => ({ setTeamScore: vi.fn() }) },
    hooks: { killFeed: vi.fn(), remoteKillFeed: vi.fn(), dropNuggets: vi.fn() },
    respawnBot: vi.fn(),
    rekeyBot: vi.fn(),
    _held: held,
    ...(extra as object),
  } as unknown as THost;
  return m;
};
const heldOf = (m: MatchHost): Map<string, number> => (m as THost)._held;

describe('offline headhunt economy', (): void => {
  it('token collects pocket into held and grow the live team score', (): void => {
    const m = mkHost();
    collect(m, 'local', 'token', 9);   // grabbed a blue coin
    collect(m, 'local', 'token', 1);   // + a white
    collect(m, 'b2', 'token', 3);      // enemy pocketed a green
    expect(m.heldOf('local')).toBe(10);
    expect(m.scores.alpha).toBe(10);
    expect(m.scores.bravo).toBe(3);
  });

  it('gems do not score in headhunt — only tokens pocket', (): void => {
    const m = mkHost();
    collect(m, 'local', undefined, 1); // a stray gem/powerup touch
    expect(m.heldOf('local')).toBe(0);
    expect(m.scores.alpha + m.scores.bravo).toBe(0);
  });

  it('a hoard collapsing flips the live score — collect-driven resync', (): void => {
    const m = mkHost();
    const held = heldOf(m);
    held.set('local', 10);
    held.set('b1', 20);
    syncHeld(m);
    expect(m.scores.alpha).toBe(30);
    held.set('local', 0); // corpse spill zeroed the pocket upstream
    held.set('b2', 11);   // enemy scooped the spill (9+1+1 → pocketed 11)
    syncHeld(m);
    expect(m.scores.alpha).toBe(20);
    expect(m.scores.bravo).toBe(11);
  });

  it('reaching 100 held wins instantly — no horn needed', (): void => {
    const m = mkHost();
    heldOf(m).set('local', 40);
    heldOf(m).set('b1', 60);
    syncHeld(m);
    expect(checkWin(m)).toBe('alpha');
  });

  it('the horn resolves a leader; a tie keeps playing', (): void => {
    const m = mkHost();
    m.matchStart = performance.now() - m.spec.timeLimitS * 1000 - 1; // past the horn
    m.scores.alpha = 20; m.scores.bravo = 11;
    expect(clockWin(m)).toBe('alpha');
    m.scores.alpha = 11;
    expect(clockWin(m)).toBeNull(); // tie → sudden death, not a draw
  });

  it('resetMatch empties every pocket — no hoard carries over', (): void => {
    const m = mkHost();
    const held = heldOf(m);
    held.set('local', 10);
    held.set('b1', 5);
    held.set('b2', 30);
    m.over = 'alpha';
    resetMatch(m);
    expect(held.get('local')).toBe(0);
    expect(held.get('b1')).toBe(0);
    expect(held.get('b2')).toBe(0);
    expect(m.scores.alpha + m.scores.bravo).toBe(0);
  });
});
void THREE;
