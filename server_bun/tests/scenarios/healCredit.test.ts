import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, firstPlayer, pin } from './harness.ts';

// Heal claims stay decoded on every authority — ambient pickups have no
// server entity to intent against — but in team rooms they only spend
// banked credit (granted by gem collect), never conjure a heal.

describe('heal credit (team rooms)', () => {
  it('a claim heals only up to banked credit', () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    p.health = 50;
    p.healCredit = 10;
    const sent: ServerMessage[] = [];
    room.connections.register('p1', {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    room.messages.handleMessage('p1', { type: 'heal', amount: 25, claimSeq: 1 } as never);
    expect(p.health).toBe(60); // 25-claim clamped to the 10 banked
    expect(p.healCredit).toBe(0); // the claim drained the bank, nothing more
    expect(sent.some((m) => m.type === 'claimAck' && (m as { ok?: boolean }).ok === true)).toBe(true);
  });
});
