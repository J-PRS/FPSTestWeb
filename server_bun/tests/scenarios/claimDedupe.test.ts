import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, firstPlayer, pin } from './harness.ts';

// Post-reclaim intent replay resends the same stamped claim verbatim.
// (type, claimSeq) dedupe must replay the ORIGINAL verdict without
// re-applying the effect — a resent deploy can't double-plant or
// double-charge the belt.

describe('claimSeq dedupe (post-reclaim replay)', () => {
  it('the same deploy claim applies once and re-acks identically', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 31, z: 0 });
    p.beltCharges = 10;
    const sent: ServerMessage[] = [];
    room.connections.register('p1', {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    const claim = { type: 'deploy', kind: 'mine', position: { x: 1, y: 31, z: 0 }, claimSeq: 7 } as never;
    room.messages.handleMessage('p1', claim);
    const minesAfterFirst = sent.filter((m) => m.type === 'deploySpawn').length;
    const beltAfterFirst = p.beltCharges;
    room.messages.handleMessage('p1', claim); // verbatim replay — same seq
    const acks = sent.filter((m) => m.type === 'claimAck');
    expect(minesAfterFirst).toBe(1);
    expect(sent.filter((m) => m.type === 'deploySpawn').length).toBe(1); // no second plant
    expect(p.beltCharges).toBe(beltAfterFirst); // no second charge
    expect(acks.length).toBe(2); // the replay re-acks the stored verdict
    expect((acks[1] as { ok?: boolean }).ok).toBe((acks[0] as { ok?: boolean }).ok);
  });
});
