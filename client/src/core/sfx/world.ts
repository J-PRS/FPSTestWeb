import * as THREE from 'three';
import { audio } from '../audio.js';
import type { LoopHandle, PositionalLoop } from '../audio.js';
import { ctx, play, osc, sample, layer, noise } from './util.js';

// ---------------------------------------------------------------------------
// Continuous loops — persistent nodes driven per-frame from the game loop.



let loops: { wind: LoopHandle | null; ski: LoopHandle | null; skiTex: LoopHandle | null; jet: LoopHandle | null } | null = null;
let samplesSwapped = false;
const _right = new THREE.Vector3();

// Pack pitch tracks chassis: light frames whine a touch brighter, heavy
// burns low. Rates double as osc-freq multipliers for the synth fallback.
const JET_RATE: Record<string, number> = { light: 1.05, medium: 1.0, heavy: 0.95 };
let jetCls = 'medium';

function jetLoop(cls: string): LoopHandle | null {
  const r = JET_RATE[cls] ?? 1;
  return audio.sampleLoop('jet_loop', r) ?? audio.oscLoop('sawtooth', 90 * r);
}

/** Structural player shape — avoids importing Player (cycle). */
interface LoopPlayer {
  vel: THREE.Vector3;
  jetting: boolean;
  skiing: boolean;
  /** Tier actually simming — a banked class swap only takes on respawn. */
  appliedClass?: string;
}

function ensureLoops(): NonNullable<typeof loops> {
  if (!loops) {
    loops = {
      // snow_amb is a real blizzard loop — the Tribes wind bed.
      // jet_loop is the actual Legions jetpack sample.
      wind: audio.sampleLoop('snow_amb') ?? audio.noiseLoop('bandpass', 900),
      // Scrape = continuous bandpass noise body; the footstep sample
      // layers underneath as granular crunch (a single 0.47s step
      // looped on its own just ticks — never reads as sliding).
      ski: audio.noiseLoop('bandpass', 900),
      skiTex: audio.sampleLoop('ski_scrape', 2.6),
      jet: jetLoop(jetCls),
    };
  }
  return loops;
}

// Samples fetch async after unlock — swap the synth placeholders for the
// real recordings once they land (one shot at it, then stay put).
function swapToRealSamples(): void {
  if (samplesSwapped || !(audio.sample('jet_loop') || audio.sample('snow_amb') || audio.sample('ski_scrape'))) return;
  samplesSwapped = true;
  const jetBuf = audio.sample('jet_loop') && audio.sampleLoop('jet_loop', JET_RATE[jetCls] ?? 1);
  const windBuf = audio.sample('snow_amb') && audio.sampleLoop('snow_amb');
  // ski_scrape is a snow-footstep sample — looped ~2.6x it reads as
  // crunching granular texture under the noise scrape, better than
  // filtered noise alone. Its rate is fixed at acquire time, so the
  // swap below just rebuilds the same handle once the buffer lands.
  const skiBuf = audio.sample('ski_scrape') && audio.sampleLoop('ski_scrape', 2.6);
  if (jetBuf) { loops!.jet?.stop(); loops!.jet = jetBuf; }
  if (windBuf) { loops!.wind?.stop(); loops!.wind = windBuf; }
  if (skiBuf) { loops!.skiTex?.stop(); loops!.skiTex = skiBuf; }
}

/**
 * Per-frame audio state: listener pose + continuous loops (wind whistle by
 * airspeed, ski scrape, jetpack hum). Called from the game loop; safe before
 * the AudioContext unlocks.
 */
export function updateAudio(dt: number, player: LoopPlayer, camera: THREE.PerspectiveCamera): void {
  if (!audio.ready) return;

  // Listener: camera position + its right axis drives cheap stereo pan
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  audio.updateListener(camera.position, _right, player.vel);

  // Respawn can land a banked class swap — rebuild the jet loop at the
  // new pitch (loops carry no live rate control, so swap the handle).
  const cls = player.appliedClass ?? 'medium';
  if (cls !== jetCls) {
    jetCls = cls;
    loops?.jet?.stop();
    if (loops) loops.jet = jetLoop(cls);
  }
  const l = ensureLoops();
  swapToRealSamples();

  const speed = player.vel.length();
  // Wind whistles with airspeed — THE Tribes sound. Never fully silent:
  // a desert has a base breeze even standing still.
  l.wind?.set(Math.min(0.28, 0.04 + speed / 160 * 0.24));
  // Ski scrape only when flagged — ground contact + speed gating lives
  // on the Player side so this just follows the flag. The floor keeps a
  // slow carve audible — the old pure-speed curve stayed inaudible until
  // ~60 m/s where it only matters at cap anyway.
  const skiGain = player.skiing ? Math.min(0.3, 0.04 + speed / 50 * 0.26) : 0;
  l.ski?.set(skiGain);
  l.skiTex?.set(skiGain * 0.6);
  l.jet?.set(player.jetting ? 0.55 : 0);
}

/** Enemy telegraph/death sounds at world position. */
/** Warp beacon toss — quick electric chirp, rising. */
export function warpThrow(): void {
  const c = ctx();
  if (!c) return;
  const bus = audio.sfxBus; if (!bus) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.45, undefined, 1)) return;
  if (layer(g, [['shot_energy', 0.7, 1.5], ['hg_tick', 0.4, 2.2, undefined, 0.06]])) return;
  osc('sawtooth', 700, 2600, 0.14, 0.35, g);
}

/** Warp teleport — the money sound: discharge crack + whoosh collapse.
 *  Positional at the ARRIVAL point so distant warps read quiet. */
export function warpJump(pos: THREE.Vector3, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.8, inNode)) { audio.freeInput(inNode); return; }
    if (layer(g, [
      ['sparks', 0.9, 1.15, undefined, 0.2],
      ['shot_energy', 0.65, 0.8],
      ['dash2', 0.55, 1.0, undefined, 0.12],
      ['explosion_small', 0.4, 1.6, 3000, 0.15],
    ])) return;
    noise(0.2, 0.55, g, 'highpass', 2800, 5000);
    osc('sawtooth', 280, 2400, 0.22, 0.45, g);
    osc('sine', 140, 40, 0.3, 0.35, g); // sub-thump under the crack
  } finally { audio.emitterPitch = 1; }
}

// ---------------------------------------------------------------------------
// Remote player move audio — pooled positional loops so you HEAR a disc-
// jockey spooling up behind you, not just see dust. One jet+ski channel
// pair per remote, capped: beyond the cap only silent slots are evicted.
// The wire carries ski but no jet bit — jetting is inferred from a powered
// climb (vel.y past walking jump apex), same read as the remote animation.
// Callers gate on cloak/death upstream, so a cloaked jetter stays silent.
interface RemoteLoops { jet: PositionalLoop | null; ski: PositionalLoop | null; busy: boolean; cls: string; }
const remoteLoops = new Map<string, RemoteLoops>();
const REMOTE_LOOP_CAP = 6;

export function remoteMoveAudioGone(id: string): void {
  const l = remoteLoops.get(id);
  if (!l) return;
  l.jet?.stop(); l.ski?.stop();
  remoteLoops.delete(id);
}

function acquireRemoteLoops(id: string, cls: string): RemoteLoops | null {
  if (remoteLoops.size >= REMOTE_LOOP_CAP) {
    for (const [k, v] of remoteLoops) {
      if (!v.busy) { remoteMoveAudioGone(k); break; }
    }
    if (remoteLoops.size >= REMOTE_LOOP_CAP) return null;
  }
  const r = JET_RATE[cls] ?? 1;
  const l: RemoteLoops = {
    jet: audio.worldLoop('sample', 'jet_loop', r) ?? audio.worldLoop('osc', 'sawtooth', 90 * r),
    ski: audio.worldLoop('sample', 'ski_scrape', 1.3) ?? audio.worldLoop('noise', 'bandpass', 2400),
    busy: false,
    cls,
  };
  remoteLoops.set(id, l);
  return l;
}

export function remoteMoveAudio(id: string, pos: THREE.Vector3, speed: number, jetting: boolean, skiing: boolean, vel?: THREE.Vector3, cls = 'medium'): void {
  if (!audio.ready) return;
  let l = remoteLoops.get(id) ?? ((jetting || skiing) ? acquireRemoteLoops(id, cls) : null);
  // Respawned into a new tier — the pack pitch follows the chassis.
  if (l && l.cls !== cls) { remoteMoveAudioGone(id); l = (jetting || skiing) ? acquireRemoteLoops(id, cls) : null; }
  if (!l) return;
  l.busy = jetting || skiing;
  l.jet?.setPos(pos, vel); l.jet?.set(jetting ? 0.45 : 0);
  l.ski?.setPos(pos, vel); l.ski?.set(skiing ? Math.min(0.24, 0.035 + speed / 50 * 0.2) : 0);
}

type CueKind = 'pounce' | 'skitter' | 'splat' | 'dart' | 'zap' | 'launch' | 'die' | 'hit' | 'rustle' | 'squawk';

export function enemyCue(pos: THREE.Vector3, kind: CueKind, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.4, inNode)) { audio.freeInput(inNode); return; }
    CUES[kind](g);
  } finally { audio.emitterPitch = 1; }
}

// Crawler landing: chitin tick-rattle + short hiss + soft leg thud —
// insectoid, not a monster bellow
function cueSkitter(g: GainNode): void {
  if (sample('hg_tick', g, 0.55, 1.9)) {
    sample('hg_tick', g, 0.45, 2.3, undefined, undefined, 0.035);
    sample('hg_tick', g, 0.35, 1.6, undefined, undefined, 0.075);
    sample('sparks', g, 0.3, 1.8, 4000, 0.15, 0.02);
    sample('punch', g, 0.25, 1.4, 900, 0.05);
    return;
  }
  for (let i = 0; i < 3; i++) noise(0.02, 0.3, g, 'highpass', 4000 - i * 800, 5000);
  noise(0.1, 0.25, g, 'bandpass', 3500, 5000, 3);
}

// Crawler death: wet pop + squelch, not an alien roar
function cueSplat(g: GainNode): void {
  if (sample('impact', g, 0.7, 0.8)) {
    sample('punch', g, 0.5, 0.6, 600, 0.12, 0.02);
    noise(0.14, 0.3, g, 'lowpass', 900, 150);
    return;
  }
  noise(0.12, 0.5, g, 'lowpass', 1000, 150);
  osc('sine', 160, 50, 0.1, 0.4, g);
}

function cuePounce(g: GainNode): void {
  if (sample('monster1', g, 0.7)) return;
  osc('sawtooth', 400, 900, 0.15, 0.45, g);
}

function cueDart(g: GainNode): void {
  if (sample('monster2', g, 0.6, 1.4)) return;
  noise(0.25, 0.55, g, 'bandpass', 1500, 3000, 2);
}

function cueZap(g: GainNode): void {
  if (sample('sparks', g, 0.8)) return;
  osc('sawtooth', 1800, 400, 0.12, 0.45, g);
}

function cueLaunch(g: GainNode): void {
  if (sample('missile', g, 0.8)) return;
  noise(0.3, 0.6, g, 'bandpass', 300, 1200);
}

function cueDie(g: GainNode): void {
  if (sample(`alien_die${1 + Math.floor(Math.random() * 3)}`, g, 0.8)) return;
  noise(0.3, 0.5, g, 'lowpass', 1500, 200);
  osc('square', 300, 60, 0.2, 0.35, g);
}

// Brush breaking apart: 3-4 dry snap ticks + a short papery crunch —
// a tumbleweed should crackle, not squeal
function cueRustle(g: GainNode): void {
  if (sample('hg_tick', g, 0.5, 1.1)) {
    sample('hg_tick', g, 0.4, 0.9, undefined, undefined, 0.03);
    sample('hg_tick', g, 0.35, 1.4, undefined, undefined, 0.07);
    sample('punch', g, 0.2, 2.0, 1400, 0.04);
    noise(0.1, 0.22, g, 'highpass', 2600, 3500);
    return;
  }
  for (let i = 0; i < 3; i++) noise(0.02, 0.28, g, 'highpass', 3200 - i * 600, 4500);
  noise(0.12, 0.2, g, 'bandpass', 2400, 4000, 2);
}

// Bird death: short raucous screech (pitched monster bark) + wing
// thrash — dying wildlife, not a monster roar
function cueSquawk(g: GainNode): void {
  if (sample('monster2', g, 0.4, 2.4, undefined, 0.25)) {
    noise(0.16, 0.3, g, 'bandpass', 2800, 5000, 2);
    sample('hg_tick', g, 0.3, 0.8, undefined, undefined, 0.1);
    return;
  }
  osc('sawtooth', 1600, 500, 0.2, 0.5, g);
  noise(0.18, 0.3, g, 'bandpass', 2500, 4500, 2);
}

function cueHit(g: GainNode): void {
  if (sample('sparks', g, 0.5, 1.3)) return;
  noise(0.08, 0.35, g, 'highpass', 2000, 3000);
}

const CUES: Record<CueKind, (g: GainNode) => void> = {
  pounce: cuePounce,
  skitter: cueSkitter,
  splat: cueSplat,
  dart: cueDart,
  zap: cueZap,
  launch: cueLaunch,
  die: cueDie,
  hit: cueHit,
  rustle: cueRustle,
  squawk: cueSquawk,
};