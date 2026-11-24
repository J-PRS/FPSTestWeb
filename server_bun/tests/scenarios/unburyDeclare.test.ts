import { describe, it, expect, afterEach } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import { setStrictInvariants } from '../../../shared/invariants.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Strict mode throws on bot-below-ground BEFORE the rescue runs - burial
// is a bug in test-land by design, which also makes the rescue itself
// unreachable. This test IS the rescue path, so strict comes off for it.
describe('scenario: unbury teleport declaration', () => {
  afterEach((): void => { setStrictInvariants(true); });
  it('a deep rescue declares teleport on the wire; clients never read it as a jump', () => {
    setStrictInvariants(false);
    const room = mkRoom({ bots: 2 }, 'dm');
    const [, p] = twoPlayers(room);
    // Flat-terrain stand height is ~31.9 - pinning at y=18 buries the
    // eye ~14m under, past the 6m declaration floor.
    freeze(room, p.id, { x: 5, y: 18, z: 0 });
    const wire: ServerMessage[] = [];
    const orig = room.connections.broadcast.bind(room.connections);
    room.connections.broadcast = (m, exclude) => { wire.push(m as ServerMessage); orig(m, exclude); };
    step(room, 35); // unbury sweeps every 0.5s of sim time
    const tp = wire.filter((m) => (m as { type?: string }).type === 'teleport');
    expect(tp.length).toBeGreaterThan(0);
    const mine = tp.find((m) => (m as { playerId?: string }).playerId === p.id);
    expect(mine).toBeDefined();
    expect((mine as { position: { y: number } }).position.y).toBeGreaterThan(28);
  });
});
