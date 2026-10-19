import { describe, expect, it } from 'vitest';
import { InputStream } from '../networking/inputStream.js';

const MOVE = { forward: 1, right: 0, jump: 0, ski: 0 };
const ROT = { yaw: 0, pitch: 0 };

describe('InputStream.reset (reconnect epoch)', () => {
  it('clears the journal so wrong-room inputs cannot replay into corrections', () => {
    const s = new InputStream();
    s.sendMove(MOVE, ROT, () => {});
    s.sendMove({ ...MOVE, jump: 1 }, ROT, () => {});
    // New room echoes a small inputSeq — without reset(), every old-room
    // entry (all seq > it) would replay.
    s.reset();
    expect(s.inputsAfter(0)).toHaveLength(0);
  });

  it('clears change-only send state so the first post-reconnect move always emits', () => {
    const s = new InputStream();
    const sent: unknown[] = [];
    s.sendMove(MOVE, ROT, (m) => sent.push(m));
    s.reset();
    // Same held input as before the flap — must still emit: the server
    // never saw the release/edge that died on the dead lane.
    s.sendMove(MOVE, ROT, (m) => sent.push(m));
    expect(sent).toHaveLength(2);
  });

  it('keeps inputSeq monotonic across the reset', () => {
    const s = new InputStream();
    s.sendMove(MOVE, ROT, () => {});
    const {seq} = s;
    s.reset();
    expect(s.seq).toBe(seq);
    s.sendMove({ ...MOVE, forward: 0 }, ROT, (m) => expect((m as { seq: number }).seq).toBe(seq + 1));
  });

  it('held() reports nothing until the next real input edge', () => {
    const s = new InputStream();
    s.sendMove(MOVE, ROT, () => {});
    s.reset();
    expect(s.held()).toBeNull();
  });
});
