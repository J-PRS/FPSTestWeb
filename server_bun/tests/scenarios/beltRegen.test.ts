import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, step, replica } from './harness.ts';
import { wallNow } from '../../src/wallClock.ts';
import { BELT_MAX, BELT_REGEN_S } from '../../../shared/weapons.ts';

// Ambient belt drip: a spent belt slowly refills at BELT_REGEN_S per
// charge, no pickup needed, capped at BELT_MAX. Lives in tickRecords'
// server-heals pass — needs the record fanout to tick (replica +
// hasReceivedPosition, same seam the hoard-drip test uses).

describe('scenario: ambient belt regen', () => {
  it('an empty belt gains a charge after ~10s, then stops at the cap', () => {
    const room = mkRoom({ mode: 'dm', bots: 0 }, 'dm');
    const p = room.players.addPlayer('P1', 'alpha');
    replica(room);
    pin(room, 'P1', { x: 0, y: 31, z: 0 });
    p.hasReceivedPosition = true; // else skipRecord ghosts the record and the drip never ticks
    p.lastSeen = wallNow();
    p.beltCharges = 0;
    p.beltAcc = 0;
    step(room, Math.ceil(BELT_REGEN_S / 0.05) + 2); // just past one drip period
    expect(p.beltCharges).toBe(1);
    // Cap: a full belt does not over-accrue into phantom charges.
    p.beltCharges = BELT_MAX;
    step(room, 2 * Math.ceil(BELT_REGEN_S / 0.05));
    expect(p.beltCharges).toBe(BELT_MAX);
  });
});
