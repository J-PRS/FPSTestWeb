import { wallMs } from '../../src/wallClock.ts';
import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { mkRoom, pin, seat } from './harness.ts';

// Frame cadence: a tick frame must reach every player EVERY tick, even
// when suppression emptied the record set — the client's loss metric
// reads arrival cadence (a silent stream is ~100% loss) and ackSeq
// pruning rides each frame. Regression for the fanout gate that skipped
// quiet ticks entirely.
describe('fanout cadence', () => {
  it('an all-suppressed tick still ships an (empty) frame', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-VEKTOR-01';
    seat(room, id);
    pin(room, id, { x: 0, y: 60, z: 0 });
    let frames = 0;
    room.connections.sendBinaryToPlayer = () => { frames++; return 'sent' as const; };
    const loop = new TickLoop(new Map([['t', room]]), { tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 }, () => {});
    // Tick 1 builds the first record (lastSent absent); tick 2+ find the
    // bot still on its extrapolated path → suppressed → zero records.
    // The frame count must keep climbing regardless.
    for (let i = 0; i < 4; i++) {loop.tickRoomNow(room, wallMs(Date.now() + i * 50));}
    expect(frames).toBeGreaterThanOrEqual(4);
  });
});
