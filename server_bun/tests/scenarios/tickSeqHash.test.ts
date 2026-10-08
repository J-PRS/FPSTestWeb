import { wallMs } from '../../src/wallClock.ts';
import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { mkRoom, freeze } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Room } from '../../src/Room.ts';

// Regression: the state-hash broadcast once did `room.tickSeq++` to tag
// itself, consuming a sequence number no tick frame ever carries. Every
// client then counted a phantom dropped frame (~2-3% bogus "loss" at the
// hash cadence). The hash must tag the last EMITTED seq instead.
describe('scenario: state hash tags, never consumes, tickSeq', () => {
  it('tickSeq advances only by emitted frames across hash broadcasts', () => {
    const room = mkRoom({ bots: 1 });
    const [bot] = [...room.players.getAllPlayers().values()];
    freeze(room, bot!.id, { x: 0, y: 60, z: 0 });
    let frames = 0;
    room.connections.sendBinaryToPlayer = () => { frames++; return 'sent' as const; };
    const sent: ServerMessage[] = [];
    room.connections.broadcast = (m) => { sent.push(m); };

    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    const broadcastHash = () => (loop as unknown as { broadcastStateHash: (r: Room) => void }).broadcastStateHash(room);

    const seq0 = room.tickSeq;
    loop.tickRoomNow(room, wallMs(Date.now()));
    loop.tickRoomNow(room, wallMs(Date.now() + 50));
    broadcastHash();
    loop.tickRoomNow(room, wallMs(Date.now() + 100));
    broadcastHash();

    const hashes = sent.filter((m) => m.type === 'stateHash') as Extract<ServerMessage, { type: 'stateHash' }>[];
    expect(hashes.length).toBe(2);
    // The old bug: each hash bumped tickSeq — the total would exceed the
    // frames sent by exactly the hash count.
    expect(room.tickSeq - seq0).toBe(frames);
    // Each hash tags the seq of the frame that already shipped.
    expect(hashes[0]!.tick).toBe(seq0 + 2);
    expect(hashes[1]!.tick).toBe(seq0 + 3);
  });
});
