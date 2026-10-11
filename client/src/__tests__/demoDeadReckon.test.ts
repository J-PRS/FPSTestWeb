// Dead-reckon dedupe: bit-identical frames must skip (lossless — playback
// lerps constants identically), any single-field drift must write. This
// is the recorder's size lever; a regression either bloats clips or eats
// motion.
import { describe, it, expect } from 'vitest';
import { DemoRecorder } from '../demo/DemoRecorder.js';
import type { IPlayerDataProvider, IInputProvider } from '../demo/interfaces.js';

const mkPlayer = (): IPlayerDataProvider => ({
  posX: 1, posY: 2, posZ: 3, velX: 4, velY: 5, velZ: 6,
  yaw: 0.1, pitch: 0.2, weaponType: 7,
});
const mkInput = (): IInputProvider => ({
  inputFlags: 0, mouseDeltaX: 0, mouseDeltaY: 0, jetpackFlags: 0, jetpackFuel: 0,
});

function rec(): { r: DemoRecorder; p: IPlayerDataProvider; i: IInputProvider } {
  const r = new DemoRecorder(60, 60);
  const p = mkPlayer(), i = mkInput();
  r.start(p, i);
  return { r, p, i };
}

// dt must exceed tickInterval — equal-to-interval hits FP-boundary misses.
const tick = (r: DemoRecorder): void => r.update(0.02);

describe('DemoRecorder dead-reckon', (): void => {
  it('skips bit-identical frames, writes on any drift', (): void => {
    const { r, p } = rec();
    tick(r); tick(r); tick(r);
    expect(r.frameCount).toBe(1); // 2nd/3rd identical → skipped
    p.velX = 4.0000001; // any drift — even sub-display
    tick(r);
    expect(r.frameCount).toBe(2);
    p.velX = 4.0000001;
    tick(r);
    expect(r.frameCount).toBe(2); // identical again → skipped
    p.weaponType = 3; // held-weapon swap forces a write (viewmodel cut)
    tick(r);
    expect(r.frameCount).toBe(3);
  });

  it('deadReckon=false records verbatim', (): void => {
    const { r } = rec();
    r.deadReckon = false;
    for (let k = 0; k < 5; k += 1) {tick(r);}
    expect(r.frameCount).toBe(5);
  });
});
