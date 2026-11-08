import { describe, expect, it } from 'vitest';
import { TRAIL_LEAD_FRAMES, trailEmitLead } from '../effects/trailLead.js';

// Regression cover for the "smoke puff ahead of the projectile" bug: the
// lead used to be a fixed 2 frames of the RENDERED delta, which overshot
// and was inflated by any renderOffset correction blend. Current design
// (568a728c) is ZERO lead: any positive value puts puffs ahead of the
// mesh on sparse trails, the smoke-ahead bug now lives behind this pin.
describe('trailEmitLead', (): void => {
  it('uses zero lead, no puff ahead of the shell', (): void => {
    expect(TRAIL_LEAD_FRAMES).toBe(0);
    expect(trailEmitLead(3, 4, 0, 250, 1 / 60)).toEqual([0, 0, 0]);
  });

  it('never leads past the overshoot cap on a hitch/teleport frame', (): void => {
    const spd = 200, dt = 1 / 60;
    const cap = spd * dt * 4 + 3;
    const [x] = trailEmitLead(cap * 50, 0, 0, spd, dt); // absurd jump
    expect(x).toBeLessThanOrEqual(cap * TRAIL_LEAD_FRAMES + 1e-9);
  });

  it('stands still on a first or resynced frame (no measured travel)', (): void => {
    expect(trailEmitLead(Number.NaN, 0, 0, 100, 1 / 60)).toEqual([0, 0, 0]);
    expect(trailEmitLead(0, 0, 0, 100, 1 / 60)).toEqual([0, 0, 0]);
  });

  it('is renderOffset-immune: it only ever sees the travel it is given', (): void => {
    // A correction blend that moves the drawn anchor but not sim truth
    // yields zero travel here, so it cannot inflate the lead.
    expect(trailEmitLead(0, 0, 0, 120, 1 / 60)).toEqual([0, 0, 0]);
  });
});
