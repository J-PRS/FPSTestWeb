import { describe, it, expect } from 'vitest';
import { SnapshotBuffer } from '../entities/remoteSnapshots.js';

// The interp queue prunes to a few intervals of history — an unbounded
// ring under sustained 20Hz push would be the same leak class as
// shipQueue/claimLedger (§2.27). Pin the bound: after a long burst the
// buffer holds only the recent window, never the full history.
describe('SnapshotBuffer bound', () => {
  const POS = { x: 0, y: 0, z: 0 };
  const ROT = { yaw: 0, pitch: 0 };
  const VEL = { x: 0, y: 0, z: 0 };

  it('stays windowed under a long sustained stream', () => {
    const b = new SnapshotBuffer();
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += 50; // nominal 20Hz cadence
      b.push(t, POS, ROT, VEL, t);
    }
    // cutoff floor keeps max(1s, arrivalInterval*4) of history — at
    // 50ms cadence that's ~20 samples + the 2-snap minimum, not the
    // 2000 pushed.
    expect(b.size).toBeLessThanOrEqual(32);
  });

  it('keeps at least 2 snapshots for interpolation', () => {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 100; i++) { b.push(i * 50, POS, ROT, VEL, i * 50); }
    expect(b.size).toBeGreaterThanOrEqual(2);
  });
});
