import type * as THREE from 'three';
import { waterCrossingFx } from './waterSplash.js';

// One locomotion-FX pass for every actor type. The local player, network
// remotes and offline bots each resolve their own "carving / burning"
// signals — input+sim, the wire bits, the bot brain — then land here, so a
// teammate drags the same roostertail and burns the same plume no matter
// who drives. Emitted per frame by all three; effectDust owns the particle
// look, this file owns WHO emits and WHEN.

/** Carve gate: ski engaged, wheels down, real horizontal speed. Was
 *  duplicated (and drifting) between PlayerEmit and the remote cosmetics
 *  tick, which is how remotes ended up carving at a different threshold. */
export function isCarvingSki(vel: THREE.Vector3, grounded: boolean, ski: boolean): boolean {
  return ski && grounded && vel.x * vel.x + vel.z * vel.z > 10;
}

/** The slice of EffectsManager the locomotion pass needs — so the local
 *  player's callback sink and the remotes' EffectsManager both satisfy it. */
export interface LocomotionFxSink {
  spawnJetpack(pos: THREE.Vector3): void;
  spawnSkiDust(pos: THREE.Vector3, vel: THREE.Vector3): void;
}

/** Emit the shared locomotion FX for one actor this frame. `ski`/`jet` are
 *  the actor's own resolved flags; the gate and the spawn calls are common
 *  to all three actor types. */
export function emitLocomotionFx(
  sink: LocomotionFxSink,
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  grounded: boolean,
  ski: boolean,
  jet: boolean,
): void {
  if (jet) {sink.spawnJetpack(pos);}
  if (isCarvingSki(vel, grounded, ski)) {sink.spawnSkiDust(pos, vel);}
  waterCrossingFx(pos, vel.y); // no-op on dry maps
}
