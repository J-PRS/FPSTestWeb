import { describe, expect, it } from 'bun:test';
import { MobilityWatchdog } from '../src/botMobility.ts';

/** A wedged bot: stationary, destination far away, not holding/perched. */
function brain() {
  return {
    holding: false,
    perched: false,
    lastDest: { x: 100, y: 0, z: 100 },
    currentHuntId: null,
    stuckDiag: {},
  } as never;
}
const POS = { x: 0, y: 0, z: 0 };

describe('bot unstick escalation', () => {
  it('impulse first, teleport after repeated failed boosts, reset on travel', () => {
    const w = new MobilityWatchdog('t');
    const b = brain();
    let now = 0;
    const step = (ms: number): void => { now += ms; w.checkStuck('bot1', POS, b, false, now); };

    step(1); // anchor
    expect(w.unstickPending).toBe(false);
    step(5001); // past the 5s leash - first warn + impulse
    expect(w.unstickPending).toBe(true);
    w.unstickPending = false;
    expect(w.unstickTeleport).toBe(false);

    // First reboost at +30s: still impulse (boosts=1)
    step(30_001);
    expect(w.unstickPending).toBe(true);
    expect(w.unstickTeleport).toBe(false);
    w.unstickPending = false;

    // Second reboost: boosts=2 - still impulse
    step(30_001);
    expect(w.unstickPending).toBe(true);
    expect(w.unstickTeleport).toBe(false);
    w.unstickPending = false;

    // Third reboost: boosts=3 - escalate to teleport, no more impulses
    step(30_001);
    expect(w.unstickTeleport).toBe(true);
    expect(w.unstickPending).toBe(false);
    w.unstickTeleport = false;

    // And it keeps teleporting, not reverting to impulses
    step(30_001);
    expect(w.unstickTeleport).toBe(true);

    // Travel re-arms the whole ladder
    w.checkStuck('bot1', { x: 10, y: 0, z: 10 }, b, false, now + 1000);
    expect(w.unstickPending).toBe(false);
  });
});
