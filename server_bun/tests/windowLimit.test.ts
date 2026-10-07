import { describe, it, expect } from 'bun:test';
import { windowAllow } from '../src/windowLimit.ts';

// The primitive behind every keyed throttle (/join, /demos/upload,
// /client-log, WS handshake). The subtle part is cap pressure: expired
// windows sweep FIRST, then oldest-first evict — a wholesale clear()
// would hand every live flooder a fresh budget at once (the amnesty bug).
describe('windowAllow', () => {
  it('throttles a key at its limit and resets on a fresh window', () => {
    const m = new Map<string, { count: number; start: number }>();
    for (let i = 0; i < 5; i++) expect(windowAllow(m, 'a', 1000, 60_000, 5, 16)).toBe(true);
    expect(windowAllow(m, 'a', 1000, 60_000, 5, 16)).toBe(false);
    // Window elapsed — a fresh claim gets a fresh budget.
    expect(windowAllow(m, 'a', 1000 + 60_001, 60_000, 5, 16)).toBe(true);
  });

  it('sweeps expired windows before evicting — live keys keep their state', () => {
    const m = new Map<string, { count: number; start: number }>();
    const now = 1_000_000;
    // 100 stale keys claimed long ago; 'live' claims later, mid-window.
    for (let i = 0; i < 100; i++) windowAllow(m, `stale${i}`, now - 120_000, 60_000, 5, 4);
    for (let i = 0; i < 5; i++) windowAllow(m, 'live', now - 1000, 60_000, 5, 4);
    // 'new' claims → map exceeds cap → expired entries must die, not 'live'.
    windowAllow(m, 'new', now, 60_000, 5, 4);
    expect(m.has('live')).toBe(true);
    // ...and 'live' is still throttled — it must not have been reset.
    expect(windowAllow(m, 'live', now, 60_000, 5, 4)).toBe(false);
  });

  it('under an all-live map it evicts oldest — never resets everyone', () => {
    const m = new Map<string, { count: number; start: number }>();
    const now = 1_000_000;
    // Fill to cap with live keys, all at their limit.
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 5; j++) windowAllow(m, `k${i}`, now - 500 + i, 60_000, 5, 4);
    }
    // A new key overflows the cap — the eldest live key dies, the rest
    // keep their throttle state (no amnesty for mid-window flooders).
    windowAllow(m, 'new', now, 60_000, 5, 4);
    expect(m.size).toBeLessThanOrEqual(4);
    const survivors = [...m.keys()].filter((k) => k !== 'new' && k !== 'k0');
    for (const k of survivors) {
      expect(windowAllow(m, k, now, 60_000, 5, 4)).toBe(false);
    }
  });
});
