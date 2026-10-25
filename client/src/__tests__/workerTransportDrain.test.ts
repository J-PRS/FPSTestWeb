import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionConfig } from '../networking/WebSocketConnection.js';

const tick = (seq: number): Uint8Array<ArrayBuffer> => {
  const u8 = new Uint8Array(32);
  u8[0] = 0x54; u8[1] = 0x07; // MAGIC + WIRE_TICK_V4
  new DataView(u8.buffer).setUint32(6, seq, true);
  return u8;
};


// WorkerTransport drain regression — coalesceTickFrames returns its input
// array unchanged when nothing coalesces, so clearing `pending` in place
// emptied the dispatch list too: EVERY event (incl. 'up') was swallowed and
// the client never sent join. drain() must swap the queue out by reference.

class FakeWorker {
  static last: FakeWorker;
  private listeners = new Map<string, ((e: never) => void)[]>();
  posted: unknown[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; }
  postMessage(m: unknown): void { this.posted.push(m); }
  terminate(): void { this.terminated = true; }
  addEventListener(type: string, fn: (e: never) => void): void {
    let l = this.listeners.get(type);
    if (!l) { l = []; this.listeners.set(type, l); }
    l.push(fn);
  }
  emit(data: unknown): void {
    for (const fn of this.listeners.get('message') ?? []) {fn({ data } as never);}
  }
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
    const _t = new WorkerTransport(config);
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'matchNotice', text: 'hi' }, at: Date.now() });
    FakeWorker.last.emit({ kind: 'err', msg: 'boom' });
    flushDrain();
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'matchNotice', text: 'hi' });
    expect(config.onError).toHaveBeenCalledTimes(1);
  });


  it('still dispatches when ticks coalesce (the filtered-array path)', async (): Promise<void> => {
    // Coalescing needs a REAL stall — drain gap > max(100, ema*3) — and
    // >3 queued ticks. Fake timers don't fake performance.now here, so
    // the stall is produced honestly: queue the batch, busy-block the
    // main thread past the gap, then let the armed drain run.
    vi.useRealTimers();
    const spin = (ms: number): void => {
      const t = performance.now();
      while (performance.now() - t < ms) { /* busy */ }
    };
    const config = makeConfig();
    const _t2 = new WorkerTransport(config);
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'chat' }, at: 0 });
    await new Promise((r): number => setTimeout(r, 5) as unknown as number); // drain 1: stamps lastDrainAt
    FakeWorker.last.emit({ kind: 'ev', b: tick(1), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', b: tick(2), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', b: tick(3), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', b: tick(4), at: 0 });
    FakeWorker.last.emit({ kind: 'ev', j: { type: 'chat' }, at: 0 });
    spin(150); // block the armed drain past the stall bound
    await new Promise((r): number => setTimeout(r, 5) as unknown as number); // drain 2: stalled → coalesce
    expect(config.onBinaryMessage).toHaveBeenCalledTimes(1); // older ticks dropped
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'chat' });
  });

  it('time-slices a large burst at the 8ms budget and preserves order across turns', async (): Promise<void> => {
    // A ~1024-event reclaim replay used to dispatch in one macrotask at
    // exactly the rejoin moment. The drain now breaks past an 8ms budget
    // (checked every 64 events) and continues on a new timer turn.
    // Fake timers freeze performance.now, so this needs the real clock:
    // the handler spins ~1ms/event to make the budget honestly expire.
    vi.useRealTimers();
    const spin = (ms: number): void => {
      const t = performance.now();
      while (performance.now() - t < ms) { /* busy */ }
    };
    const config = makeConfig();
    const seen: number[] = [];
    config.onMessage = vi.fn((j) => { spin(1); seen.push((j as unknown as { n: number }).n); });
    const _t = new WorkerTransport(config);
    for (let i = 0; i < 130; i++) {FakeWorker.last.emit({ kind: 'ev', j: { type: 'm', n: i }, at: 0 });}

    await new Promise((r): number => setTimeout(r, 0) as unknown as number);
    const first = (config.onMessage as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(64);
    expect(first).toBeLessThan(130);          // budget tripped — not one giant task
    for (let i = 0; i < 10 && (config.onMessage as ReturnType<typeof vi.fn>).mock.calls.length < 130; i++) {
      await new Promise((r): number => setTimeout(r, 0) as unknown as number);
    }
    expect(config.onMessage).toHaveBeenCalledTimes(130); // carry-over turns finished it
    expect(seen).toEqual(Array.from({ length: 130 }, (_, i) => i)); // order preserved
  });
});
