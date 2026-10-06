import { describe, expect, it } from 'bun:test';
import { MatchClock, type MatchHost } from '../../src/roomMatch.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { MODES } from '../../../shared/teams.ts';

// Match lifecycle: clock arms on the first human, warns at 60s, horn ends
// a lead instantly, a tie goes to overtime (next score wins), OT window
// spent is a draw. All through a stub MatchHost — no Room needed.

function mkHost() {
  const sent: ServerMessage[] = [];
  const host: MatchHost = {
    room: 't', mode: 'tdm',
    modeSpec: { ...MODES.tdm, winAt: 5, timeLimitS: 600 },
    scores: { alpha: 0, bravo: 0 },
    ffaScores: new Map(),
    getHumanCount: () => 1,
    matchPlayers: () => [],
    broadcast: (m) => sent.push(m),
    endCleanup: () => {},
    rotate: () => null,
    applySpec: () => {},
  };
  return { host, sent };
}
const t0 = Date.now();

describe('match clock', () => {
  it('arms on first human, ends the leader at the horn', () => {
    const { host, sent } = mkHost();
    const clock = new MatchClock(host);
    clock.tick(t0);                       // arms: now + 600s
    host.scores.alpha = 3;
    clock.tick(t0 + 600_000 + 1);         // horn past, alpha leads
    const end = sent.find((m) => m.type === 'matchEnd');
    expect(end && (end as { winner: string }).winner).toBe('alpha');
    // The intermission holds the standings — no reset until it lapses.
    expect(sent.some((m) => m.type === 'matchStart')).toBe(false);
    clock.tick(t0 + 600_000 + 10_002);
    expect(sent.some((m) => m.type === 'matchStart')).toBe(true);
  });

  it('a tie at the horn goes to overtime — next score wins', () => {
    const { host, sent } = mkHost();
    const clock = new MatchClock(host);
    clock.tick(t0);
    clock.tick(t0 + 600_000 + 1);         // tied at horn → OT
    expect(sent.some((m) => m.type === 'matchNotice' && (m as { text: string }).text.includes('OVERTIME'))).toBe(true);
    expect(sent.some((m) => m.type === 'matchEnd')).toBe(false);
    host.scores.bravo = 1;                // someone scores in OT
    clock.tick(t0 + 600_000 + 2);
    const end = sent.find((m) => m.type === 'matchEnd');
    expect(end && (end as { winner: string }).winner).toBe('bravo');
  });

  it('overtime window spent tied resolves draw', () => {
    const { host, sent } = mkHost();
    const clock = new MatchClock(host);
    clock.tick(t0);
    clock.tick(t0 + 600_000 + 1);         // → OT
    clock.tick(t0 + 720_000 + 1);         // OT 120s cap spent, still tied
    const end = sent.find((m) => m.type === 'matchEnd');
    expect(end && (end as { winner: string }).winner).toBe('draw');
  });

  it('warns exactly once at the 60s mark', () => {
    const { host, sent } = mkHost();
    const clock = new MatchClock(host);
    clock.tick(t0);
    clock.tick(t0 + 600_000 - 59_000);    // 59s left → warn
    clock.tick(t0 + 600_000 - 58_000);    // 58s left → no repeat
    const warns = sent.filter((m) => m.type === 'matchNotice' && (m as { text: string }).text === '60 seconds left');
    expect(warns.length).toBe(1);
  });
});
