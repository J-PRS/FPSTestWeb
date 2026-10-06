import { describe, it, expect } from 'bun:test';
import { RateLimiter } from '../src/RateLimiter.ts';
import { WIRE_DEFAULT_LIMIT } from '../src/wire.ts';

// The limiter windows on ARRIVAL time, not drain time — a stalled-tick
// backlog would otherwise count one burst and eat legit reports. Pin the
// window rollover, the shared default bucket, and player teardown.

describe('RateLimiter', () => {
  const t0 = 1_000_000;

  it('enforces the per-type limit and resets on window rollover', () => {
    const rl = new RateLimiter();
    // 'chat' limit: 4/1000ms
    for (let i = 0; i < 4; i++) expect(rl.check('p', 'chat', t0 + i)).toBe(true);
    expect(rl.check('p', 'chat', t0 + 4)).toBe(false);
    expect(rl.check('p', 'chat', t0 + 999)).toBe(false); // same window
    expect(rl.check('p', 'chat', t0 + 1000)).toBe(true); // rolled over
  });

  it('arrival time, not check time, owns the window — a late-drained backlog windows correctly', () => {
    const rl = new RateLimiter();
    // 30 inputMove reports that arrived across 2s, drained at once
    for (let i = 0; i < 20; i++) expect(rl.check('p', 'inputMove', t0 + i * 50)).toBe(true);
    // the reports sit in windows by their `at` stamps, not "now"
    expect(rl.check('p', 'inputMove', t0 + 999)).toBe(true);
  });

  it('unlisted types share the default bucket, not a free lane', () => {
    const rl = new RateLimiter();
    // 'ping' has no explicit limit → default 120/s, shared across types
    for (let i = 0; i < WIRE_DEFAULT_LIMIT.maxCount; i++) rl.check('p', 'ping', t0);
    expect(rl.check('p', 'ping', t0)).toBe(false);
    expect(rl.check('p', 'clientStats', t0)).toBe(false); // same bucket
  });

  it('limits are per-player — one flooder cannot starve a neighbor', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) rl.check('flooder', 'chat', t0);
    expect(rl.check('flooder', 'chat', t0)).toBe(false);
    expect(rl.check('honest', 'chat', t0)).toBe(true);
  });

  it('removePlayer clears all buckets — a rejoin starts fresh', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) rl.check('p', 'chat', t0);
    expect(rl.check('p', 'chat', t0)).toBe(false);
    rl.removePlayer('p');
    expect(rl.check('p', 'chat', t0)).toBe(true);
  });
});
