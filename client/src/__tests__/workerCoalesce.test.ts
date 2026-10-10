import { describe, it, expect } from 'vitest';
import { coalesceTickFrames } from '../networking/WorkerTransport.js';
import { WIRE_TICK_V4, WIRE_BALLSEG } from '../../../shared/wire.js';

const MAGIC = 0x54;

function tickFrame(seq: number): Uint8Array {
  const u8 = new Uint8Array(32);
  u8[0] = MAGIC;
  u8[1] = WIRE_TICK_V4;
  new DataView(u8.buffer).setUint32(6, seq, true);
  return u8;
}

function segFrame(): Uint8Array {
  const u8 = new Uint8Array(48);
  u8[0] = MAGIC;
  u8[1] = WIRE_BALLSEG;
  return u8;
}

const j = (type: string) => ({ kind: 'ev' as const, j: { type } as never, at: 0 });
const b = (u8: Uint8Array) => ({ kind: 'ev' as const, b: u8, at: 0 });

describe('coalesceTickFrames', () => {
  it('keeps only the newest tick frame in a backlog', () => {
    const evs = [b(tickFrame(10)), j('playerHit'), b(tickFrame(12)), b(tickFrame(11)), j('chat')];
    const out = coalesceTickFrames(evs);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(j('playerHit'));
    expect(new DataView((out[1] as { b: Uint8Array }).b.buffer).getUint32(6, true)).toBe(12);
    expect(out[2]).toEqual(j('chat'));
  });

  it('passes through non-tick frames and order', () => {
    const evs = [b(segFrame()), b(segFrame()), j('gameState')];
    expect(coalesceTickFrames(evs)).toHaveLength(3);
  });

  it('single tick survives unchanged', () => {
    const evs = [b(tickFrame(7))];
    expect(coalesceTickFrames(evs)).toHaveLength(1);
  });

  it('keeps the last-positioned newest tick, not an earlier-seq one', () => {
    const evs = [b(tickFrame(20)), b(tickFrame(15))];
    const out = coalesceTickFrames(evs);
    expect(out).toHaveLength(1);
    expect(new DataView((out[0] as { b: Uint8Array }).b.buffer).getUint32(6, true)).toBe(20);
  });
});
