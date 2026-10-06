import { describe, it, expect } from 'bun:test';
import { STATUS, STATUS_MASK, CLIENT_STATUS_MASK, SHOOT_REVEAL_S, shootRevealed, MEND_HP_PER_SEC } from '../../shared/status.ts';

// The status byte is a shared contract in one wire field: bits 1-2 are
// movement/death plumbing, bits >=4 the status channel. A colliding or
// mis-masked bit either strips a legit effect server-side or lets a
// client claim a buff it never picked up (REGEN/DD/CHARGED are
// server-owned — that boundary is the anti-cheat seam).

describe('status', () => {
  it('every claimed bit is a unique power of two at >=4 — no collision with movement bits 1/2', () => {
    const bits = Object.values(STATUS);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) {
      expect(b & (b - 1), `bit ${b} is not a single bit`).toBe(0);
      expect(b, `bit ${b} collides with movement/death bits`).toBeGreaterThanOrEqual(4);
    }
  });

  it('STATUS_MASK covers exactly the claimed bits', () => {
    let mask = 0;
    for (const b of Object.values(STATUS)) mask |= b;
    expect(STATUS_MASK).toBe(mask);
  });

  it('CLIENT_STATUS_MASK keeps toggles, strips server-owned buffs', () => {
    for (const b of [STATUS.CLOAK, STATUS.SHIELD, STATUS.MEND]) {
      expect(CLIENT_STATUS_MASK & b).toBe(b);
    }
    // REGEN/DD/CHARGED are server-owned — a client claiming them gets
    // stripped; that strip is the only thing stopping a forged inputMove
    // from wearing a damage-doubler it never picked up.
    for (const b of [STATUS.REGEN, STATUS.DD, STATUS.CHARGED]) {
      expect(CLIENT_STATUS_MASK & b).toBe(0);
    }
    // And it must not reach outside the status byte's own lane.
    expect(CLIENT_STATUS_MASK & ~STATUS_MASK).toBe(0);
    expect(CLIENT_STATUS_MASK & 3).toBe(0);
  });

  it('shootRevealed: inside the window revealed, past it masked — boundary included', () => {
    const fired = 10_000;
    expect(shootRevealed(fired, fired)).toBe(true);                        // same tick
    expect(shootRevealed(fired, fired + SHOOT_REVEAL_S * 1000)).toBe(true); // at the edge
    expect(shootRevealed(fired, fired + SHOOT_REVEAL_S * 1000 + 1)).toBe(false);
  });

  it('mend channel rate is positive and sane', () => {
    expect(MEND_HP_PER_SEC).toBeGreaterThan(0);
    expect(MEND_HP_PER_SEC).toBeLessThan(100); // an instant-full channel is a typo
  });
});
