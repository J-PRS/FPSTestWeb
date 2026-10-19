import { describe, test, expect } from 'bun:test';
import { computeStateHash } from '../../shared/stateHash.ts';

// The desync check only works if server and client hash identically —
// this pins the algorithm itself so neither end can silently drift
// (which is exactly what the old djb2/FNV split did: 0% match rate).
describe('computeStateHash', () => {
  const players: [string, { x: number; y: number; z: number; health: number; isDead: boolean }][] = [
    ['alpha', { x: 1.4, y: 2.5, z: -3.6, health: 87, isDead: false }],
    ['bravo', { x: -10.1, y: 0, z: 7.9, health: 0, isDead: true }],
  ];

  test('is order-insensitive (reconnects reorder the roster)', () => {
    const forward = computeStateHash(players);
    const backward = computeStateHash([...players].reverse());
    expect(forward).toBe(backward);
  });

  test('quantizes positions to integers', () => {
    const a = computeStateHash([['p', { x: 1.2, y: 0, z: 0, health: 50, isDead: false }]]);
    const b = computeStateHash([['p', { x: 1.4, y: 0, z: 0, health: 50, isDead: false }]]);
    expect(a).toBe(b);
  });

  test('echo-channel lag cannot trip the hash', () => {
    // Health is server-owned and echoed at ~2Hz — the client's value is
    // always up to one interval stale while a heal channel runs. The
    // contract: lag inside a bucket is invisible, a dropped hit is not.
    const base: [string, { x: number; y: number; z: number; health: number; isDead: boolean }][] =
      [['p', { x: 0, y: 0, z: 0, health: 50, isDead: false }]];
    const h = computeStateHash(base);
    // ±1hp of heal-echo lag — the same 4hp bucket as 50 (48..51).
    for (const lagged of [48, 49, 51]) {
      expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: lagged, isDead: false }]])).toBe(h);
    }
    // A real hit (>=4hp swing) crosses a bucket and MUST differ.
    expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: 45, isDead: false }]])).not.toBe(h);
  });

  test('distinguishes state changes it claims to watch', () => {
    const base: [string, { x: number; y: number; z: number; health: number; isDead: boolean }][] =
      [['p', { x: 0, y: 0, z: 0, health: 50, isDead: false }]];
    const h = computeStateHash(base);
    expect(computeStateHash([['p', { x: 1, y: 0, z: 0, health: 50, isDead: false }]])).not.toBe(h);
    // Health is hashed in ~4hp buckets (heal channels lag the wire) —
    // 50->46 crosses a bucket boundary like a dropped hit does.
    expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: 45, isDead: false }]])).not.toBe(h);
    expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: 50, isDead: true }]])).not.toBe(h);
    expect(computeStateHash([['q', { x: 0, y: 0, z: 0, health: 50, isDead: false }]])).not.toBe(h);
    expect(computeStateHash([])).not.toBe(h); // membership counts
  });
});

// Room seeds: production rooms carry a minted private stream so a
// recorded match can replay its draw sequence; seedless rooms keep the
// injectable botRand default (harness compat).
describe('room rng seeding', () => {
  test('same seed reproduces the same draw stream; seedless stays ambient', async () => {
    const { Room } = await import('../src/Room.ts');
    const a = new Room('a', null, '', undefined, false, 4242);
    const b = new Room('b', null, '', undefined, false, 4242);
    // Ctor-time consumers (spawn scatter) draw off the stream — compare
    // the two seeded rooms to each other so that consumption is aligned.
    expect(a.rngStream?.draws).toBe(b.rngStream?.draws);
    for (let i = 0; i < 50; i += 1) { expect(a.rng()).toBe(b.rng()); }
    // Unseeded room keeps the injectable default (botRand).
    const c = new Room('c', null, '', undefined, false);
    expect(c.rngSeed).toBeUndefined();
    a.dispose(); b.dispose(); c.dispose();
  });
});
