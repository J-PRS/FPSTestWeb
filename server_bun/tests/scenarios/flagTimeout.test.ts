import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';
import { FLAG_RESET_S } from '../../../shared/teams.ts';

describe('scenario: dropped flag auto-resets', () => {
  it('an unrecovered flag teleports home after FLAG_RESET_S', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 0,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    room.players.addPlayer('P1');
    const p = room.players.getPlayer('P1')!;
    p.team = 'bravo';
    // Grab the alpha flag at its stand.
    pin(room, 'P1', { x: -70, y: 31, z: 0 });
    step(room, 3);
    // Kill the courier in the field — flag drops at the corpse.
    p.isDead = true;
    step(room, 3);
    const dropped = w.msgs.find((m) => m.type === 'flagUpdate'
      && (m as { flags?: { team: string; state: string }[] }).flags!
        .some((f) => f.team === 'alpha' && f.state === 'dropped'));
    expect(dropped).toBeTruthy();
    // Nobody touches it — the reset clock sends it home.
    step(room, Math.ceil(FLAG_RESET_S / 0.05) + 5);
    const back = w.msgs.reverse().find((m) => m.type === 'flagUpdate'
      && (m as { flags?: { team: string; state: string; pos: { x: number } }[] }).flags!
        .some((f) => f.team === 'alpha' && f.state === 'home'));
    expect(back).toBeTruthy();
  });
});
