import { describe, expect, it } from 'bun:test';
import { MatchClock, type MatchHost } from '../../src/roomMatch.ts';
import { simNow } from '../../src/simClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// An empty room's clock must stay disarmed after a match end — otherwise
// an unwatched countdown burns down forever and a rejoiner inherits a
// stale mid-match clock instead of a fresh match.

function mkHost(humans: { n: number }) {
  const sent: ServerMessage[] = [];
  const intermission: boolean[] = [];
  const host: MatchHost = {
    room: 't', mode: 'tdm',
    modeSpec: { label: 'TDM', teams: true, ffa: false, flags: false, gems: false, winAt: 5, timeLimitS: 600, ptsPlayerKill: 1, ptsCreatureKill: 0 },
    scores: { alpha: 0, bravo: 0 },
    ffaScores: new Map(),
    getHumanCount: () => humans.n,
    matchPlayers: () => [],
    broadcast: (m) => sent.push(m),
    endCleanup: () => {},
    rotate: () => null,
    applySpec: () => {},
    setIntermission: (on) => intermission.push(on),
  };
  return { host, sent, intermission };
}
// simNow() stamp — tick() takes sim-clock time, and wall time diverges
// once another suite's harness has warped the clock.

describe('scenario: match clock in an empty room', () => {
  it('stays disarmed after a force-end with no humans', () => {
    const humans = { n: 0 };
    const { host } = mkHost(humans);
    const clock = new MatchClock(host);
    clock.forceEnd();
    expect(clock.timeLeftMs()).toBe(0);
  });

  it('re-arms fresh when a human joins after the empty end', () => {
    const humans = { n: 0 };
    const { host } = mkHost(humans);
    const clock = new MatchClock(host);
    clock.forceEnd();
    humans.n = 1;
    clock.tick(simNow() + 15_001); // intermission lapses → startNext sees the human
    expect(clock.timeLeftMs()).toBeGreaterThan(590_000);
  });

  it('re-arms normally when humans are present at the end', () => {
    const humans = { n: 2 };
    const { host } = mkHost(humans);
    const clock = new MatchClock(host);
    clock.forceEnd();
    clock.tick(simNow() + 15_001); // past the intermission → startNext re-arms
    expect(clock.timeLeftMs()).toBeGreaterThan(590_000);
  });

  it('intermission godmode brackets exactly the standings window', () => {
    const humans = { n: 2 };
    const { host, intermission } = mkHost(humans);
    const clock = new MatchClock(host);
    clock.forceEnd();
    expect(intermission).toEqual([true]); // on at the horn
    clock.tick(simNow() + 14_000); // still inside the window
    expect(intermission).toEqual([true]);
    clock.tick(simNow() + 15_001); // startNext → off before matchStart
    expect(intermission).toEqual([true, false]);
  });
});
