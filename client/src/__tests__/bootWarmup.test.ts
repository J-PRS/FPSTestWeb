import { describe, it, expect, vi } from 'vitest';
import { BootWarmup } from '../game/bootWarmup.js';

function frames(gate: BootWarmup, count: number, seconds = 1 / 60): void {
  for (let frame = 0; frame < count; frame += 1) {gate.tick(seconds);}
}

describe('boot warmup', (): void => {
  it('releases all early waiters only after consecutive stable frames', (): Promise<void> => {
    const gate = new BootWarmup();
    const resolved = vi.fn();
    const first = gate.whenStable().then(resolved);
    const second = gate.whenStable().then(resolved);
    frames(gate, 44);
    return Promise.resolve().then((): Promise<void> => {
      expect(gate.released).toBe(false);
      expect(resolved).not.toHaveBeenCalled();
      gate.tick(1 / 60);
      return Promise.all([first, second]).then((): void => {
        expect(gate.released).toBe(true);
        expect(resolved).toHaveBeenCalledTimes(2);
      });
    });
  });

  it('releases without waiters and serves late callers after a hitch', (): Promise<void> => {
    const gate = new BootWarmup();
    frames(gate, 45);
    expect(gate.released).toBe(true);
    gate.tick(0.1);
    return gate.whenStable().then((): void => {expect(gate.released).toBe(true);});
  });

  it('uses the frame cap on a persistently slow machine', (): Promise<void> => {
    const gate = new BootWarmup();
    const waiting = gate.whenStable();
    frames(gate, 239, 0.1);
    expect(gate.released).toBe(false);
    gate.tick(0.1);
    return waiting.then((): Promise<void> => {
      gate.tick(0.1);
      return gate.whenStable().then((): void => {expect(gate.released).toBe(true);});
    });
  });

  it.each([0.026, 0.1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'resets the stable streak on an invalid or slow frame (%s)',
    (seconds): void => {
      const gate = new BootWarmup();
      frames(gate, 44);
      gate.tick(seconds);
      frames(gate, 44);
      expect(gate.released).toBe(false);
      gate.tick(1 / 60);
      expect(gate.released).toBe(true);
    },
  );
});
