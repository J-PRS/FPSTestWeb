import { wallMs } from '../src/wallClock.ts';
import { describe, it, expect } from 'bun:test';
import { pushRewindSample, renderLagOf, renderLagOfTarget, renderLagBoundOf, RENDER_LAG_MS, REWIND_MS } from '../src/rewind.ts';
import { clampPing, rewindPos } from '../src/claimLedger.ts';
import { parseField } from '../tools/netTerrain.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import type { PlayerState } from '../src/types.ts';

// The rewind buffer is the lag-comp contract: both feeders (position
// reports, server-bot driver) push through pushRewindSample so every
// consumer rewinds the same window.
const P = (x = 0, y = 0, z = 0) => ({ x, y, z });
const fakePlayer = () => ({
  position: P(), history: [] as { t: number; x: number; y: number; z: number }[],
}) as unknown as PlayerState;

describe('pushRewindSample', () => {
  it('appends position snapshots at the sample time', () => {
    const p = fakePlayer();
    p.position = P(1, 2, 3);
    pushRewindSample(p, wallMs(1000));
    expect(p.history).toEqual([{ t: wallMs(1000), x: 1, y: 2, z: 3 }]);
  });

  it('trims samples older than the rewind window', () => {
    const p = fakePlayer();
    pushRewindSample(p, wallMs(1000));
    pushRewindSample(p, wallMs(1000 + REWIND_MS));      // edge: exactly at window — kept
    pushRewindSample(p, wallMs(1000 + REWIND_MS + 1));  // pushes the first out
    expect(p.history.length).toBe(2);
    expect(p.history[0]!.t).toBe(wallMs(1000 + REWIND_MS));
  });

  it('never keeps more than the window worth of samples', () => {
    const p = fakePlayer();
    // Trimming is relative to each pushed timestamp, not wall-clock —
    // a static buffer keeps whatever was within-window at its last push.
    const t0 = Date.now() - 5000;
    let last = t0;
    for (let i = 0; i < 100; i++) { last = t0 + i * 20; pushRewindSample(p, wallMs(last)); }
    for (const s of p.history) {expect(last - s.t).toBeLessThanOrEqual(REWIND_MS);}
    expect(p.history.length).toBeGreaterThan(0);
    expect(p.history.length).toBeLessThanOrEqual(REWIND_MS / 20 + 1);
  });
});

describe('rewindPos', () => {
  it('returns current position with an empty buffer', () => {
    const p = fakePlayer();
    p.position = P(5, 5, 5);
    expect(rewindPos(p, 100)).toEqual(P(5, 5, 5));
  });

  it('interpolates between samples around the target time', () => {
    const p = fakePlayer();
    const now = Date.now();
    p.history = [
      { t: wallMs(now - 200), x: 0, y: 0, z: 0 },
      { t: wallMs(now - 100), x: 10, y: 0, z: 0 },
    ];
    p.position = P(20, 0, 0);
    const r = rewindPos(p, 150); // halfway between the two samples
    expect(r.x).toBeCloseTo(5, 1);
  });

  it('clamps to buffer edges instead of extrapolating', () => {
    const p = fakePlayer();
    const now = Date.now();
    p.history = [{ t: wallMs(now - 300), x: 7, y: 0, z: 0 }];
    p.position = P(20, 0, 0);
    // Older than the oldest sample → the oldest sample, not a guess.
    expect(rewindPos(p, 500).x).toBe(7);
    // Newer than the newest sample → live position.
    expect(rewindPos(p, 0).x).toBe(20);
  });
});

describe('parseField', () => {
  it('reads the 8-byte w/h header + raw channel layout', () => {
    const buf = new Uint8Array(8 + 4);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 2, true); dv.setUint32(4, 2, true);
    buf[8] = 10; buf[9] = 20; buf[10] = 30; buf[11] = 40;
    const f = parseField(buf)!;
    expect(f.size).toBe(2);
    expect(hmHeight(f, 0, 0)).toBeDefined();
  });

  it('rejects non-square maps (malformed file falls back to default)', () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 2, true); dv.setUint32(4, 4, true);
    expect(parseField(buf)).toBeNull();
  });
});

describe('clampPing', () => {
  it('bounds ping to the rewind window', () => {
    expect(clampPing(-5)).toBe(0);
    expect(clampPing(100)).toBe(100);
    expect(clampPing(60_000)).toBe(400); // forged 60s ping can't rewind the world
  });
});

// Rewind-entitlement hardening: clientStats.renderLag is client-claimed,
// so it's a hint — the ceiling is what the server measures on the path.
describe('renderLag bound', () => {
  const statsP = (renderLagMs: number, renderLag?: Record<string, number>) => ({
    clientStats: { renderLagMs, renderLag, at: Date.now() },
  }) as unknown as PlayerState;

  it('clean link: a claimed 800ms binds to the casual floor, not the claim', () => {
    const bound = renderLagBoundOf(() => 10, () => 3, 'p1'); // floors at 350
    expect(bound).toBe(350);
    // The exploit: claim 800 on a 10ms path — earns the floor, not 800.
    expect(renderLagOf(statsP(800), bound)).toBe(350);
    expect(renderLagOfTarget(statsP(800, { t1: 800 }), 't1', bound)).toBe(350);
  });

  it('honest claims under the bound pass through', () => {
    const bound = renderLagBoundOf(() => 10, () => 3, 'p1');
    expect(renderLagOf(statsP(100), bound)).toBe(100);
    expect(renderLagOfTarget(statsP(0, { t1: 150 }), 't1', bound)).toBe(150);
  });

  it('bad link: bound still opens to the buffer ceiling', () => {
    // 400ms transit + 150ms jitter — a real bad-link client keeps the
    // full window.
    expect(renderLagBoundOf(() => 400, () => 150, 'p1')).toBe(800);
    const bound = renderLagBoundOf(() => 300, () => 50, 'p1'); // 200+600+150=950→800
    expect(bound).toBe(800);
  });

  it('absent/stale stats degrade to the base delay, never above bound', () => {
    const bound = renderLagBoundOf(() => 10, () => 3, 'p1');
    expect(renderLagOf(statsP(undefined as unknown as number), bound)).toBe(RENDER_LAG_MS);
    expect(renderLagOf({ clientStats: { renderLagMs: 800, at: Date.now() - 60_000 } } as unknown as PlayerState, bound)).toBe(RENDER_LAG_MS);
  });
});
