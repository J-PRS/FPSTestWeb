// Sound bank internals — Web Audio one-shot plumbing shared by every
// effect family: context guard, voice cap, envelopes, osc/noise/sample
// synths, and the generic positional player `at`.
import type * as THREE from 'three';
import { audio } from '../audio.js';

export function ctx(): BaseAudioContext | null { return audio.context; }

/** One-shot through a bus node; returns false when voice-capped.
 *  prio: 0 = world, 1 = self, 2 = UI/stinger — the pool steals the
 *  oldest strictly-lower-priority voice on overflow. */
export function play(node: AudioNode, dur: number, chain?: GainNode, prio = 0): boolean {
  const c = ctx();
  if (!c || !audio.takeVoice(prio, node, chain)) {return false;}
  setTimeout((): void => {
    audio.releaseVoice(node);
    node.disconnect();
    // Positional calls pass their worldInput node as `chain` — without
    // freeing it the lp/pan tail stays attached to the world bus forever
    // (connected nodes aren't collectable, so every shot would leak).
    if (chain) {audio.freeInput(chain);}
  }, dur * 1000 + 100);
  return true;
}

export function env(g: GainNode, t0: number, peak: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

export function osc(type: OscillatorType, f0: number, f1: number, dur: number,
  peak: number, dest: AudioNode): void {
  const c = ctx()!;
  const o = c.createOscillator();
  const g = c.createGain();
  const t0 = c.currentTime;
  o.type = type;
  const bend = audio.emitterPitch;
  o.frequency.setValueAtTime(f0 * bend, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * bend), t0 + dur);
  env(g, t0, peak, dur);
  o.connect(g).connect(dest);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

/** Play a decoded sample into dest. Returns false if the bank hasn't
 *  delivered it yet — caller falls back to the synth version. Rate is
 *  jittered slightly per call so repeats never sound machine-gunned. */
export function sample(name: string, dest: AudioNode, gain = 1, rate = 1,
    ...opts: [lpf?: number, cutAfter?: number, delay?: number]): boolean {
  const [lpf, cutAfter, delay = 0] = opts;
  const c = ctx();
  const buf = audio.sample(name);
  if (!c || !buf) {return false;}
  const src = c.createBufferSource();
  src.buffer = buf;
  const playRate = rate * audio.emitterPitch * (0.94 + Math.random() * 0.12);
  src.playbackRate.value = playRate;
  const g = c.createGain();
  g.gain.value = gain;
  if (lpf) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lpf;
    src.connect(f).connect(g).connect(dest);
  } else {
    src.connect(g).connect(dest);
  }
  const t0 = c.currentTime + delay;
  if (cutAfter) {
    // Fade out instead of hard-stopping — a click at the cut is worse
    // than the ring we are trying to avoid.
    g.gain.setValueAtTime(gain, t0 + cutAfter - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + cutAfter);
  } else {
    // Universal release ramp at the natural end — most .ogg tails don't
    // decay to exact zero, so an untapered stop() is an audible "pop"
    // (discontinuity click). 30ms covers stubborn tails; still short
    // enough to read as a natural release rather than a fade.
    const playDur = buf.duration / playRate;
    g.gain.setValueAtTime(gain, t0 + Math.max(0, playDur - 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + playDur);
  }
  src.start(t0);
  src.stop(t0 + (cutAfter ?? buf.duration / playRate) + 0.05);
  return true;
}

/** Stack samples into one voice — the classic game-audio trick: a weak
 *  sound + a weak sound at different pitches reads as one big sound.
 *  Per-layer rate jitter, optional lowpass (keeps body, kills ring), and
 *  optional early cut so a long ringy tail doesn't outlive the transient. */
export function layer(dest: AudioNode,
    parts: [name: string, gain: number, rate?: number, lpf?: number, cutAfter?: number, delay?: number][],
    jitter = 0.1): boolean {
  let any = false;
  for (const [n, g, r, f, cut, delay] of parts) {
    // Pitch+gain jitter per shot — identical stacked waveforms phase into a
    // buzz at auto-fire rates; ±5% pitch breaks the loop, reads as machinery
    const jr = (r ?? 1) * (1 + (Math.random() - 0.5) * jitter);
    const jg = g * (1 + (Math.random() - 0.5) * jitter * 0.6);
    if (sample(n, dest, jg, jr, f, cut, delay)) {any = true;}
  }
  return any;
}

export function noise(dur: number, peak: number, dest: AudioNode,
  filtType: BiquadFilterType = 'bandpass',
  ...sweep: [f0?: number, f1?: number, q?: number]): void {
  const [f0 = 800, f1 = 200, q = 1] = sweep;
  const c = ctx()!;
  const nb = audio.noise;
  if (!nb) {return;}
  const src = c.createBufferSource();
  src.buffer = nb;
  const filt = c.createBiquadFilter();
  filt.type = filtType; filt.Q.value = q;
  filt.frequency.setValueAtTime(f0 * audio.emitterPitch, c.currentTime);
  filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * audio.emitterPitch), c.currentTime + dur);
  const g = c.createGain();
  env(g, c.currentTime, peak, dur);
  src.connect(filt).connect(g).connect(dest);
  src.start(); src.stop(c.currentTime + dur + 0.05);
}

/** Any sample through the world bus at a position — the generic positional
 *  player for bounce pings, debris hits, etc. */
export function at(pos: THREE.Vector3, name: string, gain = 1, rate = 1, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c || !audio.sample(name)) {return;}
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) {return;}
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 1, inNode)) { audio.freeInput(inNode); return; }
    sample(name, g, gain, rate);
  } finally { audio.emitterPitch = 1; }
}
