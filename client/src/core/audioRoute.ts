import * as THREE from 'three';
import type { AudioEngine } from './audio.js';

// Positional routing: doppler pitch factor + the distance/pan/air-absorb
// chain a world one-shot connects through.

const WORLD_REF_DIST = 16;      // meters at which a positional sound is ~full
const WORLD_MAX_DIST = 260;     // beyond this, don't spawn the node at all
const DOPPLER_C = 550;
const AIR_ABSORB_M = 45;
const airAbsorbHz = (d: number): number =>
  Math.max(400, Math.min(20000, 18000 * Math.exp(-d / AIR_ABSORB_M)));

  /** Relative-pitch factor for a positional emitter: >1 approaching,
   *  <1 receding. Sampled once per one-shot (a sub-second sound doesn't
   *  visibly track) and driven per-frame by worldLoop for sustained
   *  loops. Listener velocity counts too — skiing toward a fight
   *  pitches it up. */
export function dopplerRate(e: AudioEngine, pos: THREE.Vector3, emitVel?: THREE.Vector3): number {
    const dx = pos.x - e.listenerPos.x;
    const dy = pos.y - e.listenerPos.y;
    const dz = pos.z - e.listenerPos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 2 || d > WORLD_MAX_DIST) {return 1;}
    const rvx = (emitVel?.x ?? 0) - e.listenerVel.x;
    const rvy = (emitVel?.y ?? 0) - e.listenerVel.y;
    const rvz = (emitVel?.z ?? 0) - e.listenerVel.z;
    const radial = -(rvx * dx + rvy * dy + rvz * dz) / d; // + = approaching
    if (Math.abs(radial) < 1) {return 1;}
    return Math.min(1.45, Math.max(0.55, DOPPLER_C / (DOPPLER_C - radial)));
  }

  /**
   * Route a source node to the world bus through distance gain + stereo pan.
   * Returns the input node for the caller to connect into, or null if the
   * sound is out of earshot (caller should skip building the voice).
   */
export function worldInput(e: AudioEngine, pos: THREE.Vector3, emitVel?: THREE.Vector3): GainNode | null {
    if (!e.ctx) {return null;}
    e.emitterPitch = dopplerRate(e, pos, emitVel);
    const dx = pos.x - e.listenerPos.x;
    const dy = pos.y - e.listenerPos.y;
    const dz = pos.z - e.listenerPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > WORLD_MAX_DIST) {return null;}
    const distGain = 1 / (1 + dist / WORLD_REF_DIST);
    // Cheap directional cue: pan by projection of the offset onto the
    // listener's right axis. Not HRTF but your ears read it instantly.
    const pan = dist > 1 ? Math.max(-1, Math.min(1,
      (dx * e.listenerRight.x + dz * e.listenerRight.z) / dist)) : 0;
    const g = e.ctx.createGain();
    g.gain.value = distGain;
    // Two cascaded biquads = 24dB/oct — a single pole rolls off too
    // gently, so a 100m shot still carried its 4kHz crack.
    const lp = e.ctx.createBiquadFilter();
    const lp2 = e.ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp.type = lp2.type;
    lp2.frequency.value = airAbsorbHz(dist);
    lp.frequency.value = lp2.frequency.value;
    const p = e.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(lp).connect(lp2).connect(p).connect(e.world);
    // Voice-cap rejections leave this chain attached to the bus forever
    // (connected nodes aren't collectable) — callers free it via freeInput.
    (g as GainNode & { _tail?: AudioNode[] })._tail = [lp, lp2, p];
    return g;
  }

  /** Drop a worldInput chain when the caller's voice was refused —
   *  without this every capped shot leaks filter/panner nodes. */
export function freeInput(g: GainNode): void {
    g.disconnect();
    const tail = (g as GainNode & { _tail?: AudioNode[] })._tail;
    if (tail) {for (const n of tail) n.disconnect();}
  }

