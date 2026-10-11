import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { oneshotOwnsArms } from '../entities/playerPose.js';

// The aim layer + hip-fire hold must yield only while a full-body oneshot
// OWNS the arms — weight > 0.5 while running. Suppressing on isRunning
// alone used to drop the hold for ~200ms after every shot (arms drifted
// to bind pose on each trigger pull).
function action(running: boolean, weight: number): THREE.AnimationAction {
  const a = Object.create(THREE.AnimationAction.prototype);
  a.isRunning = (): boolean => running;
  a.getEffectiveWeight = (): number => weight;
  return a;
}

describe('oneshotOwnsArms', (): void => {
  it('suppresses the hold only while the oneshot owns the arms', (): void => {
    expect(oneshotOwnsArms(action(true, 0.9), 'UAL_Pistol_Shoot')).toBe(true);
    expect(oneshotOwnsArms(action(true, 0.3), 'UAL_Pistol_Shoot')).toBe(false); // fading out
    expect(oneshotOwnsArms(action(false, 1), 'UAL_Pistol_Shoot')).toBe(false);  // finished
    expect(oneshotOwnsArms(action(true, 0.9), 'UAL_Run_F')).toBe(false); // locomotion
    expect(oneshotOwnsArms(action(true, 0.9), null)).toBe(false);
    expect(oneshotOwnsArms(null, 'UAL_Pistol_Shoot')).toBe(false);
    // Death never fades back — clamps at full weight, holds suppression.
    expect(oneshotOwnsArms(action(true, 1), 'UAL_Death01')).toBe(true);
  });
});
