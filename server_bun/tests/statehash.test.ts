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

  test('distinguishes state changes it claims to watch', () => {
    const base: [string, { x: number; y: number; z: number; health: number; isDead: boolean }][] =
      [['p', { x: 0, y: 0, z: 0, health: 50, isDead: false }]];
    const h = computeStateHash(base);
    expect(computeStateHash([['p', { x: 1, y: 0, z: 0, health: 50, isDead: false }]])).not.toBe(h);
    expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: 49, isDead: false }]])).not.toBe(h);
    expect(computeStateHash([['p', { x: 0, y: 0, z: 0, health: 50, isDead: true }]])).not.toBe(h);
    expect(computeStateHash([['q', { x: 0, y: 0, z: 0, health: 50, isDead: false }]])).not.toBe(h);
    expect(computeStateHash([])).not.toBe(h); // membership counts
  });
});
