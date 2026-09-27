import { describe, expect, test } from 'bun:test';
import { Room } from '../src/Room';
import { resolveMapSpec } from '../../shared/mapSpec';
import { MODES } from '../../shared/teams';

describe('match clock', () => {
  test('no mode → clock never arms', () => {
    const room = new Room('c', null, '', resolveMapSpec({}));
    room.players.addPlayer('h');
    room.checkMatchClock(Date.now());
    room.checkMatchClock(Date.now() + 10_000_000);
    // still alive, no crash, scores untouched
    expect(room.players.getPlayerCount()).toBe(1);
  });

  test('clock arms on first human join, leader wins at the horn', () => {
    const room = new Room('c1', null, '', resolveMapSpec({ mode: 'nuggets' }));
    let endedWinner = '';
    room.onMatchEnd = (r) => { endedWinner = r.winner; };
    const t0 = Date.now();
    room.checkMatchClock(t0); // nobody home → not armed
        room.players.addPlayer('h1');
    room.checkMatchClock(t0); // arms now
    room.scores.alpha = 5;
    room.scores.bravo = 3;
    room.checkMatchClock(t0 + MODES.nuggets.timeLimitS * 1000 + 1);
    expect(endedWinner).toBe('alpha');
    expect(room.scores.alpha).toBe(0); // reset for the next match
  });

  test('tied horn is a draw', () => {
    const room = new Room('c2', null, '', resolveMapSpec({ mode: 'ctf' }));
    let endedWinner = '';
    room.onMatchEnd = (r) => { endedWinner = r.winner; };
    const t0 = Date.now();
    room.players.addPlayer('h1');
    room.checkMatchClock(t0);
    room.checkMatchClock(t0 + MODES.ctf.timeLimitS * 1000 + 1);
    expect(endedWinner).toBe('draw');
  });

  test('60s warning fires once per match', () => {
    const room = new Room('w', null, '', resolveMapSpec({ mode: 'dm' }));
    const priv = room as unknown as { matchEndsAt: number; matchWarned: boolean };
    const t0 = Date.now();
    room.players.addPlayer('h1');
    room.checkMatchClock(t0);
    const horn = priv.matchEndsAt;
    room.checkMatchClock(horn - 59_000);
    expect(priv.matchWarned).toBe(true);
    priv.matchWarned = false; // re-arm check: only fires once
    room.checkMatchClock(horn - 30_000);
    expect(priv.matchWarned).toBe(true);
    // match reset re-arms the warning for the next match
    room.checkMatchClock(horn + 1);
    expect(priv.matchWarned).toBe(false);
  });

  test('ffa horn picks the top scorer; ties draw', () => {
    const room = new Room('c3', null, '', resolveMapSpec({ mode: 'dm' }));
    let endedWinner = '';
    room.onMatchEnd = (r) => { endedWinner = r.winner; };
    const t0 = Date.now();
    room.players.addPlayer('h1');
    room.checkMatchClock(t0);
    room.ffaScores.set('h1', 30);
    room.ffaScores.set('bot-x', 30);
    room.checkMatchClock(t0 + MODES.dm.timeLimitS * 1000 + 1);
    expect(endedWinner).toBe('draw');
  });
});
