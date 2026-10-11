import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketConnection } from '../networking/WebSocketConnection.js';

// Minimal fake so connect()'s listeners land on something we can drive:
// each constructed instance exposes fire(name) to emit open/close.
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  binaryType = '';
  readyState = FakeWS.CONNECTING;
  sent: unknown[] = [];
  private listeners = new Map<string, ((e?: unknown) => void)[]>();
  constructor(public url: string) { FakeWS.instances.push(this); }
  addEventListener(name: string, fn: (e?: unknown) => void) {
    const l = this.listeners.get(name) ?? []; l.push(fn); this.listeners.set(name, l);
  }
  send(d: unknown) { this.sent.push(d); }
  close() { this.readyState = FakeWS.CLOSED; this.fire('close', { code: 1000, reason: '' }); }
  fire(name: string, e?: unknown) {
    if (name === 'open') {this.readyState = FakeWS.OPEN;}
    if (name === 'close') {this.readyState = FakeWS.CLOSED;}
    for (const fn of this.listeners.get(name) ?? []) {fn(e);}
  }
}

describe('WebSocketConnection reconnect contract', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const conn = (interval = 1000) =>
    new WebSocketConnection({ url: 'ws://x', reconnectInterval: interval });

  it('deliberate disconnect() never schedules a reconnect', () => {
    const c = conn();
    c.connect();
    FakeWS.instances[0]!.fire('open');
    c.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1); // 'close' fired but no re-dial
  });

  it('a session that died before stabilizing backs off 4x (flap damper)', () => {
    const c = conn(1000);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fire('open');
    vi.advanceTimersByTime(500);            // uptime 500ms < 5s → flap
    ws.fire('close', { code: 1006, reason: '' });
    vi.advanceTimersByTime(1000);           // base interval: must NOT redial
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(3000);           // 4x interval reached → redial
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('a long-lived session retries at the base interval', () => {
    const c = conn(1000);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fire('open');
    vi.advanceTimersByTime(10_000);         // uptime > 5s → not a flap
    ws.fire('close', { code: 1006, reason: '' });
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('offline queue caps at 100 and KEEP_NEWEST dedupes volatile types', () => {
    const c = conn();
    c.connect();                            // socket still CONNECTING → queued
    for (let i = 0; i < 60; i++) {c.send(JSON.stringify({ type: 'position', i }));}
    for (let i = 0; i < 60; i++) {c.send(JSON.stringify({ type: 'claim', i }));}
    const q = (c as unknown as { messageQueue: unknown[] }).messageQueue;
    expect(q.length).toBeLessThanOrEqual(100);
    const positions = (q as { type?: string }[]).filter(m => m.type === 'position');
    expect(positions).toHaveLength(1);      // only the freshest position kept
  });

  it('a handshake stuck in CONNECTING is closed at 10s so the retry loop keeps cycling', () => {
    // The zombie: a black-holed host fires no events for the OS TCP
    // timeout (~2min); each retry starves that whole window. The connect
    // timer closes the socket instead, its 'close' re-arms the loop.
    const c = conn(1000);
    c.connect();
    const ws = FakeWS.instances[0]!;
    vi.advanceTimersByTime(10_000);
    expect(ws.readyState).toBe(FakeWS.CLOSED);           // force-closed
    // Never opened → uptime 0 < MIN_UPTIME_MS → flap damper backs off 4x.
    vi.advanceTimersByTime(4000);
    expect(FakeWS.instances).toHaveLength(2);            // re-dialed, not starved
  });

  it('an opened socket is left alone by the handshake watchdog', () => {
    const c = conn(1000);
    c.connect();
    const ws = FakeWS.instances[0]!;
    ws.fire('open');
    vi.advanceTimersByTime(30_000);
    expect(ws.readyState).toBe(FakeWS.OPEN);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('binary frames dedupe to the newest while queued', () => {
    const c = conn();
    c.connect();
    c.send(new Uint8Array([1, 2]));
    c.send(new Uint8Array([3, 4]));
    const q = (c as unknown as { messageQueue: { data: unknown }[] }).messageQueue;
    expect(q.filter(m => m.data instanceof Uint8Array)).toHaveLength(1);
  });
});
