import * as THREE from 'three';
import { audio } from '../audio.js';
import { ctx, play, osc, noise, layer } from './util.js';

// Lightning gun beam loop — a CONTINUOUS drone under the per-tick crackle.
// The hum is the real LG voice: two detuned saws lowpassed into a
// transformer growl + a hiss band. beamLoop() is keepalive — call every
// tick while firing; beamLoopStop() ramps it out when the trigger drops.

let lgLoopGain: GainNode | null = null;
const lgLoopSrcs: AudioScheduledSourceNode[] = [];

export function beamLoop(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) {return;}
  if (lgLoopGain) {return;} // already droning — keepalive is implicit
  const g = c.createGain();
  g.connect(bus);
  g.gain.value = 0.0001;
  g.gain.setTargetAtTime(0.4, c.currentTime, 0.04); // ramp in ~40ms

  // Transformer growl: two detuned saws through a hard lowpass
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(g);
  for (const [type, f, detune] of [['sawtooth', 86, 0], ['sawtooth', 172, 8], ['square', 43, 0]] as const) {
    const o = c.createOscillator();
    o.type = type as OscillatorType;
    o.frequency.value = f;
    o.detune.value = detune;
    o.connect(lp);
    o.start();
    lgLoopSrcs.push(o);
  }
  // Arc hiss: filtered noise on top — the electricity flavor
  if (audio.noise) {
    const n = c.createBufferSource();
    n.buffer = audio.noise; n.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3800; bp.Q.value = 0.8;
    const ng = c.createGain(); ng.gain.value = 0.35;
    n.connect(bp).connect(ng).connect(g);
    n.start();
    lgLoopSrcs.push(n);
  }
  lgLoopGain = g;
}

export function beamLoopStop(): void {
  const c = ctx();
  if (!lgLoopGain) {return;}
  const g = lgLoopGain;
  const srcs = lgLoopSrcs.splice(0);
  lgLoopGain = null;
  if (!c) { try { g.disconnect(); } catch { /* noop */ } return; }
  g.gain.setTargetAtTime(0.0001, c.currentTime, 0.05);
  for (const s of srcs) { try { s.stop(c.currentTime + 0.25); } catch { /* noop */ } }
  setTimeout(() => { try { g.disconnect(); } catch { /* noop */ } }, 400);
}

export function lgSizzle(pos: THREE.Vector3): void {
  const c = ctx();
  if (!c) {return;}
  const inNode = audio.worldInput(pos);
  if (!inNode) {return;}
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.25, inNode)) { audio.freeInput(inNode); return; }
    if (layer(g, [
      ['sparks', 0.5, 1.5 + Math.random() * 0.4, undefined, 0.12],
      ['hg_tick', 0.35, 2.4, 5000, 0.1],
    ])) {return;}
    noise(0.14, 0.3, g, 'bandpass', 4500, 800);
    osc('square', 2400, 900, 0.1, 0.12, g);
  } finally { audio.emitterPitch = 1; }
}
