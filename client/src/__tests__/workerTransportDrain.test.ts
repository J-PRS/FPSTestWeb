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
  postMessage(m: unknown): void { this.posted.push(m); }
  terminate(): void { this.terminated = true; }
  emit(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}

// oxlint-disable-next-line consistent-type-imports -- lazy class type; typeof import() has no import type equivalent
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let WorkerTransport!: typeof import('../networking/WorkerTransport.js').WorkerTransport;

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

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  ({ WorkerTransport } = await import('../networking/WorkerTransport.js'));
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flushDrain = () => vi.advanceTimersByTime(1);

describe('WorkerTransport drain', (): void => {
  it('dispatches an "up" event — onConnect fires (the queue-aliasing regression)', async (): Promise<void> => {
    const config = makeConfig();
    const t = new WorkerTransport(config);
    t.connect();
    FakeWorker.last.emit({ kind: 'up', tier: 'wt' });
    flushDrain();
    expect(config.onConnect).toHaveBeenCalledTimes(1);
    expect(t.connected()).toBe(true);
  });

  it('dispatches non-tick events (the path that returns the input array)', async (): Promise<void> => {
    const config = makeConfig();
    new WorkerTransport(config);
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'matchNotice', text: 'hi' }, at: Date.now() });
    FakeWorker.last.emit({ kind: 'err', msg: 'boom' });
    flushDrain();
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'matchNotice', text: 'hi' });
    expect(config.onError).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when ticks coalesce (the filtered-array path)', async (): Promise<void> => {
    const config = makeConfig();
    new WorkerTransport(config);
    const tick = (seq: number): Uint8Array<ArrayBuffer> => {
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
