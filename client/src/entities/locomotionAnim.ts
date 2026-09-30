import type { AnimationState } from './PlayerModel.js';

// Ski thresholds sit above the top run speed (~10 m/s) — grounded and
// faster than a run can only be a ski slide, so a tucked pose reads better
// than a sprint cycle sliding over terrain.
const SKI_ENTER = 11.5;
const SKI_EXIT = 9.0;

// Walk/run animation state with hysteresis so players don't flicker between
// states at threshold speeds — entering a state needs a higher speed than
// leaving it. Shared by local and remote player models. Callers gate
// airborne (jump/jet) before this runs, so 'grounded' is implied.
// `skiing` is the authoritative ski bit when the caller has one (wire flag
// for remotes, input state locally): true → tuck at any speed, false →
// walk/run even past the old speed heuristic — a grounded non-skiing mover
// is running, not sliding. undefined falls back to the speed guess.
export function pickLocomotionAnim(current: AnimationState, speed: number, skiing?: boolean): AnimationState {
  if (skiing === true) return 'ski';
  if (skiing !== false) {
    if (current === 'ski') {
      if (speed > SKI_EXIT) return 'ski';
    } else if (speed > SKI_ENTER) {
      return 'ski';
    }
  }
  if (current === 'run') return speed > 6.0 ? 'run' : speed > 1.5 ? 'walk' : 'idle';
  if (current === 'walk') return speed < 0.8 ? 'idle' : speed > 9.0 ? 'run' : 'walk';
  return speed > 1.5 ? (speed > 8.0 ? 'run' : 'walk') : 'idle';
}
