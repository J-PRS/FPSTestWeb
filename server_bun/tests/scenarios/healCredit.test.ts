import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, firstPlayer, pin } from './harness.ts';

// Dedicated rooms refuse heal claims at the wire gate — the server sims
// every pickup itself, so a legit heal always arrives via onCollect
// (healPool direct), never a client claim. The free-form non-team
// branch was a 25hp/1.5s regen window any client could open; the
// credit-spend math in handleHeal still serves P2P hosts where ambient
// nuggets have no server entity (unit coverage in envClaims.test.ts).

describe('heal claims on dedicated rooms', () => {
  it('a heal claim is refused — no health moves, no credit spends', () => {
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
    expect(p.health).toBe(50); // refused at the gate — no heal applied
    expect(p.healCredit).toBe(10); // dedicated never spends the bank
    expect(sent.some((m) => m.type === 'claimAck' && (m as { ok?: boolean }).ok === false)).toBe(true);
  });
});
