import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionConfig } from '../networking/WebSocketConnection.js';

// WorkerTransport drain regression — coalesceTickFrames returns its input
// array unchanged when nothing coalesces, so clearing `pending` in place
// emptied the dispatch list too: EVERY event (incl. 'up') was swallowed and
// the client never sent join. drain() must swap the queue out by reference.

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

// oxlint-disable-next-line consistent-type-imports -- lazy class type; typeof import() has no import type equivalent
let WorkerTransport: typeof import('../networking/WorkerTransport.js').WorkerTransport;

function makeConfig(): ConnectionConfig {
  return {
    url: 'ws://x/ws',
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onMessage: vi.fn(),
    onBinaryMessage: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  ({ WorkerTransport } = await import('../networking/WorkerTransport.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flushDrain = () => vi.advanceTimersByTime(1);

describe('WorkerTransport drain', () => {
  it('dispatches an "up" event — onConnect fires (the queue-aliasing regression)', async () => {
    const config = makeConfig();
    const t = new WorkerTransport(config);
    t.connect();
    FakeWorker.last.emit({ kind: 'up', tier: 'wt' });
    flushDrain();
    expect(config.onConnect).toHaveBeenCalledTimes(1);
    expect(t.connected()).toBe(true);
  });

  it('dispatches non-tick events (the path that returns the input array)', async () => {
    const config = makeConfig();
    new WorkerTransport(config);
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'matchNotice', text: 'hi' }, at: Date.now() });
    FakeWorker.last.emit({ kind: 'err', msg: 'boom' });
    flushDrain();
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'matchNotice', text: 'hi' });
    expect(config.onError).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when ticks coalesce (the filtered-array path)', async () => {
    const config = makeConfig();
    new WorkerTransport(config);
    const tick = (seq: number) => {
      const u8 = new Uint8Array(32);
      u8[0] = 0x54; u8[1] = 0x07; // MAGIC + WIRE_TICK_V4
      new DataView(u8.buffer).setUint32(6, seq, true);
      return u8;
    };
    FakeWorker.last.emit({ kind: 'ev', b: tick(1), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', b: tick(2), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'chat' }, at: 0 });
    flushDrain();
    expect(config.onBinaryMessage).toHaveBeenCalledTimes(1); // older tick dropped
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'chat' });
  });
});
