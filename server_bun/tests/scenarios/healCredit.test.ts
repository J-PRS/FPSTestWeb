import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, firstPlayer, pin } from './harness.ts';

// Heal claims only decode on claim-accepting authorities (offline rooms,
// P2P hosts). A Room that sims every outcome refuses them — heals here
// arrive through collect intents (RoomPickups' onCollect grants credit
// and pays it server-side).

describe('heal credit (team rooms)', () => {
  it('a sim authority refuses heal claims — credit or not', () => {
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
    expect(p.health).toBe(50);
    expect(p.healCredit).toBe(10); // refused claims never drain the bank
    expect(sent.some((m) => m.type === 'claimAck' && (m as { ok?: boolean }).ok === false)).toBe(true);
  });
});
