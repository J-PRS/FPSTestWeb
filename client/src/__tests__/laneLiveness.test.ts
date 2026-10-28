import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type ServerMessage, PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { encodeTickFrame } from '../../../shared/wire.js';
import { makeDeps, feed, feedBin } from './netHarness.js';
vi.mock('../core/sfx.js', () => ({ at: (): void => { return; }, shotAt: (): void => { return; }, init: (): void => { return; }, hitMarker: (): void => { return; }, playerHurt: (): void => { return; }, shieldHit: (): void => { return; }, killConfirm: (): void => { return; }, flagCue: (): void => { return; }, matchHorn: (): void => { return; } }));
vi.mock('../entities/PlayerModel.js', (): { PlayerModel: () => { load: () => Promise<void>; }; } => ({
  PlayerModel: function (): { load: () => Promise<void>; } {
    return new Proxy({ load: (): Promise<void> => Promise.resolve() }, {
      get: (t, k): unknown => (k in t ? (t as Record<PropertyKey, unknown>)[k] : (): void => { return; }),
    });
  },
}));
globalThis.fetch = ((): Promise<Response> => new Promise<Response>((): void => { return; })) as unknown as typeof fetch;

// The zombie-seat regression: a session whose only inbound was inputSync
// (the server's starvation signal) looked "connected" for 75s while every
// tick, event, and keepalive was dark — predicted damage vanished into a
// dead pipe. The lane liveness stamp must treat inputSync as noise, not
// life — it's the symptom, not the heartbeat.
describe('lane liveness — inputSync is not proof of life', (): void => {
  let h!: ReturnType<typeof makeDeps>;
  const wireIn = (nm: ReturnType<typeof makeDeps>['nm']): { lastJsonRxAt: number; lastLiveRxAt: number; lastBinRxAt: number } =>
    (nm as unknown as { wireIn: { lastJsonRxAt: number; lastLiveRxAt: number; lastBinRxAt: number } }).wireIn;
  beforeEach((): void => { h = makeDeps(); vi.useFakeTimers(); });
  afterEach((): void => { vi.useRealTimers(); });

  it('gameState and ping stamp liveness; inputSync does not', (): void => {
    vi.setSystemTime(1000);
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    expect(wireIn(h.nm).lastLiveRxAt).toBe(1000);

    vi.setSystemTime(5000);
    feed(h.nm, { type: 'inputSync', lastSeq: 40 } as ServerMessage);
    // The starvation signal must NOT refresh the clock — a seat that only
    // ever sees inputSync is dead, and the watchdog has to notice.
    expect(wireIn(h.nm).lastLiveRxAt).toBe(1000);

    vi.setSystemTime(7000);
    feed(h.nm, { type: 'ping', timestamp: 123 } as ServerMessage);
    expect(wireIn(h.nm).lastLiveRxAt).toBe(7000);
  });

  it('an inputSync-only session stays stamp-frozen — watchdog sees the gap', (): void => {
    vi.setSystemTime(1000);
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    // 60s of nothing but inputSync — the exact soak failure signature.
    for (let i = 0; i < 60; i += 1) {
      vi.setSystemTime(1000 + i * 1000);
      feed(h.nm, { type: 'inputSync', lastSeq: i } as ServerMessage);
    }
    vi.setSystemTime(61_000);
    // lastLiveRxAt is still the join stamp — 60s of lane silence visible.
    expect(61_000 - wireIn(h.nm).lastLiveRxAt).toBe(60_000);
  });

  it('a late-arriving seq cancels its miss — reorder is not loss', (): void => {
    // WT datagrams reorder constantly; the seqwatch soak read 88% "loss"
    // on a wire where every tick landed. The stale-drop must cancel the
    // counted gap when the skipped frame arrives a ms late.
    vi.setSystemTime(1000);
    feed(h.nm, { type: 'gameState', players: [], protocolVersion: PROTOCOL_VERSION, room: 'r' } as ServerMessage);
    const loss = (): number => (h.nm as unknown as { getPacketLoss(): number }).getPacketLoss();
    feedBin(h.nm, encodeTickFrame(0, 1, 0, []));
    vi.setSystemTime(1100);
    feedBin(h.nm, encodeTickFrame(0, 3, 0, [])); // seq 2 skipped → counted as missed
    expect(loss()).toBeGreaterThan(0);
    feedBin(h.nm, encodeTickFrame(0, 2, 0, [])); // seq 2 arrives late — reorder
    expect(loss()).toBe(0);
    // And a frame that truly never arrives still counts.
    feedBin(h.nm, encodeTickFrame(0, 5, 0, [])); // seq 4 skipped for real
    expect(loss()).toBeGreaterThan(0);
  });
});
