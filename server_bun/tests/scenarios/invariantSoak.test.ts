/**
 * Invariant-probe soak — run live rooms under several modes and assert
 * the global legality invariants hold on every sampled tick. A passing
 * lockstep proves rooms match; THIS proves they stay inside the rules:
 * finite kinematics, health/death agreement, bounded energy, and flag
 * ledger coherence under real bot traffic.
 */

import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import { probeRun } from './invariants.ts';

const BASES = { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } };

describe('invariants: legality under live traffic', () => {
  it('ctf 6-bot room stays inside every invariant for 30s', () => {
    const room = mkRoom({ mode: 'ctf', bots: 6, bases: BASES }, 'ctf');
    const violations = probeRun(room, (n) => step(room, n), 30);
    expect(violations).toEqual([]);
  });

  it('tdm room with moveAuthority shadows stays inside every invariant', () => {
    const room = mkRoom({ mode: 'tdm', bots: 6, bases: BASES }, 'tdm', 7, true);
    const violations = probeRun(room, (n) => step(room, n), 30);
    expect(violations).toEqual([]);
  });

  it('arena room stays inside every invariant', () => {
    const room = mkRoom({ mode: 'arena', bots: 8 }, 'arena', 11);
    const violations = probeRun(room, (n) => step(room, n), 20);
    expect(violations).toEqual([]);
  });
});
