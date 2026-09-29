import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: dropped flag returns on own-team touch', () => {
  it('a bravo player walking over their dropped flag sends it home', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    watch(room);
    const alpha = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    const bravo = [...room.players.getAllPlayers().values()].find((p) => p.team === 'bravo')!;
    const flag = room.flags!.flags.get('bravo')!;
    // Alpha steals it mid-field, then dies → drop in place.
    alpha.position = { ...flag.pos };
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(alpha.id);
    room.flagCarrierDied(alpha.id);
    expect(flag.state).toBe('dropped');
    // The (now-dead) alpha is still standing on the flag — leave them on
    // the spot and they'd re-grab it before the return check runs.
    alpha.position = { x: flag.pos.x + 40, y: flag.pos.y, z: flag.pos.z };
    // A bravo defender touches it → straight home, no countdown needed.
    bravo.position = { ...flag.pos };
    room.tickFlags(0.05);
    expect(flag.state).toBe('home');
    expect(flag.pos).toEqual(flag.home);
  });
});
