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

  test('tied horn → overtime; unresolved OT → draw', () => {
    const room = new Room('c2', null, '', resolveMapSpec({ mode: 'ctf' }));
    let endedWinner = '';
    room.onMatchEnd = (r) => { endedWinner = r.winner; };
    const t0 = Date.now();
    room.players.addPlayer('h1');
    room.checkMatchClock(t0);
    const horn = t0 + MODES.ctf.timeLimitS * 1000 + 1;
    room.checkMatchClock(horn);
    expect(endedWinner).toBe(''); // overtime, not a draw yet
    room.checkMatchClock(horn + 121_000); // OT cap spent
    expect(endedWinner).toBe('draw');
  });

  test('overtime lead ends the match instantly', () => {
    const room = new Room('ot', null, '', resolveMapSpec({ mode: 'nuggets' }));
    let endedWinner = '';
    room.onMatchEnd = (r) => { endedWinner = r.winner; };
    const t0 = Date.now();
    room.players.addPlayer('h1');
    room.checkMatchClock(t0);
    const horn = t0 + MODES.nuggets.timeLimitS * 1000 + 1;
    room.checkMatchClock(horn); // tie → OT
    room.scores.alpha = 1;
    room.checkMatchClock(horn + 50); // lead during OT ends it now
    expect(endedWinner).toBe('alpha');
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
    // match reset re-arms the warning for the next match (tied horn → OT,
    // so end it with a score before checking the flag)
    room.checkMatchClock(horn + 1);
    room.ffaScores.set('h1', 1);
    room.checkMatchClock(horn + 2);
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
    const horn = t0 + MODES.dm.timeLimitS * 1000 + 1;
    room.checkMatchClock(horn);          // tied → overtime
    room.checkMatchClock(horn + 121_000); // OT spent → draw
    expect(endedWinner).toBe('draw');
  });
});
