import type { AnimationState } from './PlayerModel.js';

// Walk/run animation state with hysteresis so players don't flicker between
// states at threshold speeds — entering a state needs a higher speed than
// leaving it. Shared by local and remote player models.
export function pickLocomotionAnim(current: AnimationState, speed: number): AnimationState {
  if (current === 'run') return speed > 6.0 ? 'run' : speed > 1.5 ? 'walk' : 'idle';
  if (current === 'walk') return speed < 0.8 ? 'idle' : speed > 9.0 ? 'run' : 'walk';
  return speed > 1.5 ? (speed > 8.0 ? 'run' : 'walk') : 'idle';
}
