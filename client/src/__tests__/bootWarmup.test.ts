import { describe, it, expect, vi } from 'vitest';
import { BootWarmup } from '../game/bootWarmup.js';

function frames(gate: BootWarmup, count: number, seconds = 1 / 60): void {
  for (let frame = 0; frame < count; frame += 1) {gate.tick(seconds);}
}

describe('boot warmup', (): void => {
  it('releases all early waiters once the stable window fills', async (): Promise<void> => {
    const gate = new BootWarmup();
    const resolved = vi.fn();
    const first = gate.whenStable().then(resolved);
    const second = gate.whenStable().then(resolved);
    frames(gate, 29);
    await Promise.resolve();
    expect(gate.released).toBe(false);
    expect(resolved).not.toHaveBeenCalled();
    gate.tick(1 / 60);
    await Promise.all([first, second]);
    expect(gate.released).toBe(true);
    expect(resolved).toHaveBeenCalledTimes(2);
  });

  it('releases without waiters and serves late callers', async (): Promise<void> => {
    const gate = new BootWarmup();
    frames(gate, 30);
    expect(gate.released).toBe(true);
    gate.tick(0.1);
    await gate.whenStable();
    expect(gate.released).toBe(true);
  });

  it('uses the wall-clock cap on a persistently slow machine', async (): Promise<void> => {
    const gate = new BootWarmup();
    const waiting = gate.whenStable();
    // 39 slow frames ≈ 3.9s — under the 4s cap, still gated.
    frames(gate, 39, 0.1);
    expect(gate.released).toBe(false);
    gate.tick(0.1); // 4.0s — the cap drops the veil regardless of stability
    await waiting;
    expect(gate.released).toBe(true);
  });

  it('tolerates occasional slow frames but requires a majority-stable window', (): void => {
    const gate = new BootWarmup();
    // Fill the window with mostly slow frames — should NOT release.
    frames(gate, 20, 0.1);
    frames(gate, 10, 1 / 60);
    expect(gate.released).toBe(false);
    // Now make the window majority-stable.
    frames(gate, 20, 1 / 60);
    expect(gate.released).toBe(true);
  });
});
