import { describe, expect, it } from 'vitest';

import { pickLocomotionAnim } from '../entities/locomotionAnim.js';

describe('pickLocomotionAnim', (): void => {
  it('authoritative ski bit wins over the speed heuristic', (): void => {
    expect(pickLocomotionAnim('idle', 0, true)).toBe('ski');
    expect(pickLocomotionAnim('run', 30, true)).toBe('ski');
    // grounded, explicitly-not-skiing mover at slide speed reads as run
    expect(pickLocomotionAnim('walk', 20, false)).toBe('run');
  });

  it('speed heuristic: enter ski above 11.5, leave below 9', (): void => {
    expect(pickLocomotionAnim('run', 12, undefined)).toBe('ski');
    expect(pickLocomotionAnim('run', 10, undefined)).not.toBe('ski'); // inside hysteresis band
    expect(pickLocomotionAnim('ski', 10, undefined)).toBe('ski');
    expect(pickLocomotionAnim('ski', 8, undefined)).not.toBe('ski');
  });

  it('walk/run/idle hysteresis prevents threshold flicker', (): void => {
    expect(pickLocomotionAnim('idle', 1.4, undefined)).toBe('idle');
    expect(pickLocomotionAnim('idle', 1.6, undefined)).toBe('walk');
    expect(pickLocomotionAnim('walk', 0.9, undefined)).toBe('walk'); // below-run but above-idle-exit
    expect(pickLocomotionAnim('walk', 0.7, undefined)).toBe('idle');
    expect(pickLocomotionAnim('run', 5.5, undefined)).toBe('walk');
    expect(pickLocomotionAnim('run', 7, undefined)).toBe('run');
    expect(pickLocomotionAnim('walk', 9.5, undefined)).toBe('run');
  });
});
