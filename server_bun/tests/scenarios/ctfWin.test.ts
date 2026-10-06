import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: flag capture at winAt ends the match', () => {
  it('the 5th cap runs the funnel: capture point, matchEnd, reset, matchStart', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 0,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    // A brainless alpha carrier: bots think, roam, and die — this capture
    // needs a guaranteed courier.
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.team = 'alpha';
    // CTF winAt is 5 — bank 4 through the real score path so the cap is
    // the legal fifth point, not a rigged one.
    room.score('alpha', 4);
    expect(room.scores.alpha).toBe(4);
    // Grab the bravo flag at its home stand.
    pin(room, 'P1', { x: 70, y: 31, z: 0 });
    step(room, 3);
    const carried = w.msgs.find((m) => m.type === 'flagUpdate'
      && (m as { flags?: { team: string; state: string }[] }).flags!
        .some((f) => f.team === 'bravo' && f.state === 'carried'));
    expect(carried).toBeTruthy();
    // Walk it home — alpha flag sits home so the capture rule can fire.
    pin(room, 'P1', { x: -70, y: 31, z: 0 });
    step(room, 5);
    const end = w.msgs.find((m) => m.type === 'matchEnd') as { winner?: string } | undefined;
    expect(end?.winner).toBe('alpha');
    // Standings window: the board resets only after the 10s intermission.
    expect(room.scores.alpha).toBe(5);
    expect(w.count('matchStart')).toBe(0);
    // The match clock rides TickLoop, not room.sims — step() can't
    // reach it; jump the sim clock past the intermission directly.
    room.checkMatchClock(simNow() + 10_001);
    expect(room.scores.alpha).toBe(0);
    expect(w.count('matchStart')).toBe(1);
  });
});
