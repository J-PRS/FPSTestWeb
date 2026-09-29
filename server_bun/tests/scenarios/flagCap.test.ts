import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: flag capture scores', () => {
  it('a carrier standing on the enemy stand eventually captures', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    expect(room.flags).not.toBeNull();
    const carrier = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    // Grab bravo's flag — snap to the flag's real pos (the dy gate is ±6m,
    // so guessing base height can fall outside it on non-flat maps).
    const bravoFlag = room.flags!.flags.get('bravo')!;
    carrier.position = { ...bravoFlag.pos };
    room.tickFlags(0.05);
    expect(room.flags!.flags.get('bravo')!.carrier).toBe(carrier.id);
    carrier.position = { ...room.flags!.flags.get('alpha')!.home };
    room.tickFlags(0.05);
    expect(w.count('teamScore')).toBeGreaterThan(0);
    const scored = w.msgs.find((m) => m.type === 'teamScore')! as { scores: { alpha: number } };
    expect(scored.scores.alpha).toBe(1);
    expect(room.flags!.flags.get('bravo')!.state).toBe('home');
  });
});
