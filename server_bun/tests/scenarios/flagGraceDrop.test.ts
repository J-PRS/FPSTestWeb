import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: disconnecting carrier drops the flag', () => {
  it('a socket close (grace entry) fumbles the flag instead of riding the ghost', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    const carrier = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    carrier.position = { ...room.flags!.flags.get('bravo')!.pos };
    room.tickFlags(0.05);
    expect(room.flags!.flags.get('bravo')!.carrier).toBe(carrier.id);
    // Socket close → grace entry: the entity stays live for reclaim, but
    // the objective must come off the ghost.
    room.messages.onPlayerDisconnected(carrier.id);
    const flag = room.flags!.flags.get('bravo')!;
    expect(flag.carrier).toBeNull();
    expect(flag.state).toBe('dropped');
    expect(w.count('flagUpdate')).toBeGreaterThan(0);
  });
});
