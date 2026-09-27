// Sound bank — every effect is a tiny synthesized one-shot on Web Audio.
// Keep them short and distinct: in a fast shooter you read sounds by shape,
// not fidelity.
import * as THREE from 'three';
import { audio } from './audio.js';
import { WeaponType } from '../../../shared/weapons.js';

function ctx(): BaseAudioContext | null { return audio.context; }

/** One-shot through a bus node; returns false when voice-capped. */
function play(node: AudioNode, dur: number): boolean {
  const c = ctx();
  if (!c || !audio.takeVoice()) return false;
  setTimeout(() => { audio.releaseVoice(); node.disconnect(); }, dur * 1000 + 100);
  return true;
}

function env(g: GainNode, t0: number, peak: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

function osc(type: OscillatorType, f0: number, f1: number, dur: number,
  peak: number, dest: AudioNode): void {
  const c = ctx()!;
  const o = c.createOscillator();
  const g = c.createGain();
  const t0 = c.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  env(g, t0, peak, dur);
  o.connect(g).connect(dest);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

/** Play a decoded sample into dest. Returns false if the bank hasn't
 *  delivered it yet — caller falls back to the synth version. Rate is
 *  jittered slightly per call so repeats never sound machine-gunned. */
function sample(name: string, dest: AudioNode, gain = 1, rate = 1,
    lpf?: number, cutAfter?: number): boolean {
  const c = ctx();
  const buf = audio.sample(name);
  if (!c || !buf) return false;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
  const g = c.createGain();
  g.gain.value = gain;
  if (lpf) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lpf;
    src.connect(f).connect(g).connect(dest);
  } else {
    src.connect(g).connect(dest);
  }
  if (cutAfter) {
    // Fade out instead of hard-stopping — a click at the cut is worse
    // than the ring we are trying to avoid.
    g.gain.setValueAtTime(gain, c.currentTime + cutAfter - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + cutAfter);
  }
  src.start();
  src.stop(c.currentTime + (cutAfter ?? buf.duration / (rate * 0.94)) + 0.05);
  return true;
}

/** Stack samples into one voice — the classic game-audio trick: a weak
 *  sound + a weak sound at different pitches reads as one big sound.
 *  Per-layer rate jitter, optional lowpass (keeps body, kills ring), and
 *  optional early cut so a long ringy tail doesn't outlive the transient. */
function layer(dest: AudioNode,
    parts: [name: string, gain: number, rate?: number, lpf?: number, cutAfter?: number][]): boolean {
  let any = false;
  for (const [n, g, r, f, cut] of parts) if (sample(n, dest, g, r ?? 1, f, cut)) any = true;
  return any;
}

function noise(dur: number, peak: number, dest: AudioNode,
  filtType: BiquadFilterType = 'bandpass', f0 = 800, f1 = 200, q = 1): void {
  const c = ctx()!;
  const nb = audio.noise;
  if (!nb) return;
  const src = c.createBufferSource();
  src.buffer = nb;
  const filt = c.createBiquadFilter();
  filt.type = filtType; filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, c.currentTime);
  filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), c.currentTime + dur);
  const g = c.createGain();
  env(g, c.currentTime, peak, dur);
  src.connect(filt).connect(g).connect(dest);
  src.start(); src.stop(c.currentTime + dur + 0.05);
}

// ---------------------------------------------------------------------------
// Player-facing (non-positional)

/** Weapon fire — each weapon gets a signature shape so shots are readable. */
export function shoot(weaponType: number): void {
  const bus = audio.sfxBus;
  const c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.3)) return;
  shootInto(g, weaponType);
}

/** Remote player's shot — same signature, distance-attenuated + panned. */
export function shotAt(pos: THREE.Vector3, weaponType: number): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  if (!play(g, 0.3)) return;
  shootInto(g, weaponType);
}

const SHOT_SAMPLES: Partial<Record<number, [string, number]>> = {
  [WeaponType.Rocket]:          ['shot_rocket', 0.9],
  [WeaponType.Chaingun]:        ['shot_chaingun', 0.8],
  [WeaponType.Mortar]:          ['shot_cannon', 1.0],
  [WeaponType.GrenadeLauncher]: ['shot_cannon', 0.8],
  [WeaponType.Grenade]:         ['shot_energy', 0.8],
  // Flak fires a whole shell fan — a cannon boom with a sparks tail,
  // not a shotgun pump (JP: "boom is enough, this isn't quake shotgun").
  [WeaponType.Flak]:            ['shot_cannon', 0.9],
  [WeaponType.Plasma]:          ['shot_plasma', 0.9],
  [WeaponType.Railgun]:         ['shot_energy', 1.0],
};

/** Any sample through the world bus at a position — the generic positional
 *  player for bounce pings, debris hits, etc. */
export function at(pos: THREE.Vector3, name: string, gain = 1, rate = 1): void {
  const c = ctx();
  if (!c || !audio.sample(name)) return;
  const inNode = audio.worldInput(pos);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  if (!play(g, 1)) return;
  sample(name, g, gain, rate);
}

function shootInto(g: GainNode, weaponType: number): void {
  // Disc launcher: lowpassed cannon body + short metallic twang + punch
  // transient, all cut before their ring tails — verified punchy in the
  // spectrogram (sharp attack, decayed by ~0.4s, no sustained band).
  if (weaponType === WeaponType.Disc &&
      layer(g, [['shot_cannon', 1.0, 0.5, 600, 0.6], ['thud_big', 0.9, 0.8], ['punch', 0.5, 1.1, 2000, 0.2], ['hg_clang', 0.35, 1.8, undefined, 0.12]])) return;
  // Melee swing: whoosh (pitched-up dash) + fist crack + low thud body.
  // The connect 'impact' plays separately in combat on an actual hit.
  if (weaponType === WeaponType.Melee &&
      layer(g, [['dash2', 0.7, 1.35], ['punch', 0.9, 1.15], ['slam_thud', 0.5, 0.9]])) return;
  const s = SHOT_SAMPLES[weaponType];
  if (s && sample(s[0], g, s[1])) return;
  switch (weaponType) {
    case WeaponType.Rocket:    osc('square', 900, 300, 0.12, 0.25, g); noise(0.12, 0.15, g, 'lowpass', 2000, 400); break;
    case WeaponType.Disc:      osc('sawtooth', 1400, 700, 0.18, 0.2, g); noise(0.1, 0.1, g, 'highpass', 3000, 4000); break;
    case WeaponType.Chaingun:  noise(0.06, 0.3, g, 'bandpass', 2500, 1200, 2); osc('square', 400, 200, 0.06, 0.12, g); break;
    case WeaponType.Mortar:    osc('sine', 180, 60, 0.25, 0.5, g); noise(0.15, 0.2, g, 'lowpass', 900, 200); break;
    case WeaponType.GrenadeLauncher: osc('triangle', 500, 150, 0.15, 0.35, g); noise(0.1, 0.15, g, 'bandpass', 1200, 400); break;
    case WeaponType.Grenade:   osc('triangle', 600, 200, 0.12, 0.3, g); break;
    case WeaponType.Flak:      noise(0.2, 0.4, g, 'lowpass', 2500, 300); osc('square', 220, 80, 0.15, 0.3, g); break;
    case WeaponType.Plasma:    osc('sawtooth', 2200, 400, 0.14, 0.18, g); osc('sine', 3300, 900, 0.1, 0.1, g); break;
    case WeaponType.Railgun:   osc('sawtooth', 2600, 200, 0.22, 0.25, g); noise(0.15, 0.2, g, 'highpass', 4000, 6000); break;
    case WeaponType.Melee:     noise(0.15, 0.45, g, 'bandpass', 300, 2200, 1.4); osc('sine', 110, 45, 0.14, 0.5, g); break;
    default:                   osc('square', 700, 300, 0.1, 0.2, g);
  }
}

export function jump(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.15)) return;
  if (sample('jump', g, 0.5)) return;
  osc('sine', 250, 420, 0.12, 0.15, g);
}

export function land(impactSpeed: number): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  const s = Math.min(1, impactSpeed / 30);
  if (sample('land', g, 0.3 * s + 0.1)) return;
  noise(0.15, 0.3 * s + 0.05, g, 'lowpass', 400, 120);
  if (s > 0.6) osc('sine', 120, 50, 0.15, 0.2 * s, g);
}

export function dash(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  if (sample(Math.random() < 0.5 ? 'dash' : 'dash2', g, 0.5)) return;
  noise(0.22, 0.3, g, 'bandpass', 600, 2400, 1.5);
}

export function bounce(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  if (sample('bounce', g, 0.6)) return;
  osc('triangle', 300, 700, 0.15, 0.25, g);
}

export function blink(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  if (sample('teleport', g, 0.4)) return;
  osc('sine', 1200, 2400, 0.08, 0.15, g);
  osc('sine', 800, 300, 0.12, 0.15, g);
}

export function slam(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.4)) return;
  // Layered: big metallic slam + low thud an octave down = impact with weight
  if (layer(g, [['thud_big', 0.9], ['slam_thud', 0.8, 0.8]])) return;
  noise(0.35, 0.5, g, 'lowpass', 800, 80);
  osc('sine', 90, 30, 0.35, 0.6, g);
}

export function hitMarker(direct: boolean): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.08)) return;
  if (sample('hit_marker', g, direct ? 0.6 : 0.4, direct ? 1.2 : 1)) return;
  osc('square', direct ? 2200 : 1600, direct ? 1800 : 1400, 0.05, direct ? 0.18 : 0.12, g);
}

export function playerHurt(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.2)) return;
  if (sample('hurt', g, 0.6)) return;
  osc('sawtooth', 300, 120, 0.15, 0.25, g);
  noise(0.12, 0.2, g, 'lowpass', 600, 200);
}

export function pickup(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  if (sample('pickup', g, 0.4)) return;
  osc('sine', 880, 880, 0.07, 0.15, g);
  const o2 = c.createOscillator(); const g2 = c.createGain();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(1320, c.currentTime + 0.07);
  env(g2, c.currentTime + 0.07, 0.15, 0.12);
  o2.connect(g2).connect(bus);
  o2.start(c.currentTime + 0.07); o2.stop(c.currentTime + 0.25);
}

export function melee(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.25)) return;
  if (sample('punch', g, 0.8) || sample('impact', g, 0.7)) return;
  // Arm-whoosh up, fist-thud down — reads as a punch even without a hit
  noise(0.18, 0.3, g, 'bandpass', 400, 1800, 1.2);
  osc('sine', 140, 60, 0.12, 0.35, g);
}

export function equip(): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.5)) return;
  if (sample('equip', g, 0.55)) return;
  osc('square', 500, 700, 0.06, 0.1, g);
}

export function killConfirm(): void {
  const bus = audio.uiBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.3)) return;
  if (sample('powerup', g, 0.5)) return;
  osc('square', 660, 660, 0.06, 0.15, g);
  osc('square', 990, 990, 0.12, 0.15, g);
}

// ---------------------------------------------------------------------------
// World (positional — routed through distance gain + pan)

export function explosionAt(pos: THREE.Vector3, big: boolean, weaponType?: number): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  if (!play(g, 0.8)) return;
  if (explosionSample(g, big, weaponType)) return;
  noise(0.6, big ? 0.9 : 0.55, g, 'lowpass', 3000, 60);
  osc('sine', 60, 25, 0.5, big ? 0.7 : 0.45, g);
}

// Per-weapon explosion identities — same physics, different voice so you
// can hear WHAT blew up, not just that something did.
const BOOM_SAMPLES: Partial<Record<number, [string, number, number?, number?, number?][]>> = {
  [WeaponType.Mortar]: [['explosion1', 1.0, 0.6], ['thud_big', 0.9, 0.6, 300]],
  [WeaponType.Rocket]: [['explosion1', 0.95], ['thud_big', 0.5, 0.7]],
  [WeaponType.GrenadeLauncher]: [['explosion_small', 0.9, 0.9], ['thud_big', 0.4, 0.8, 500]],
  [WeaponType.Grenade]: [['explosion_small', 0.9, 1.2]],
  [WeaponType.Flak]: [['explosion_small', 0.9, 1.5], ['sparks', 0.4, 1.2, undefined, 0.3]],
  [WeaponType.Plasma]: [['explosion_small', 0.6, 1.3], ['sparks', 0.5, 1.0, undefined, 0.4]],
  [WeaponType.Railgun]: [['shot_energy', 0.7, 0.8], ['explosion_small', 0.6, 1.4]],
  [WeaponType.Chaingun]: [['explosion_small', 0.5, 1.6]],
};

function explosionSample(g: GainNode, big: boolean, weaponType?: number): boolean {
  const w = weaponType !== undefined ? BOOM_SAMPLES[weaponType] : undefined;
  if (w && layer(g, w)) return true;
  if (!big) return sample('explosion_small', g, 0.9);
  // Layer blast + deep thud at half rate — the stacking trick: two cheap
  // samples at different pitches read as one massive detonation.
  return layer(g, [
    [Math.random() < 0.5 ? 'explosion1' : 'explosion2', 0.9],
    ['thud_big', 0.5, 0.7],
  ]);
}

/** Pull-mode detonation (disc) — a suck-in zap layered over a deep pop. */
export function implosionAt(pos: THREE.Vector3, direct: boolean): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  if (!play(g, 0.7)) return;
  if (layer(g, [
    ['shot_energy', 0.8, 0.6],
    ['explosion_small', direct ? 0.7 : 0.5, 1.2],
  ])) return;
  osc('sawtooth', 1800, 200, 0.25, 0.4, g);
  noise(0.4, 0.5, g, 'lowpass', 4000, 300);
}

/** sfxdump-only hook: render an arbitrary layer recipe through the sfx bus
 *  so candidate mixes can be auditioned/analyzed headlessly. */
export function debugMix(parts: [string, number, number?, number?, number?][]): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 1)) return;
  layer(g, parts);
}

export function explosionClose(big: boolean): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) return;
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.8)) return;
  if (explosionSample(g, big)) return;
  noise(0.6, big ? 0.9 : 0.55, g, 'lowpass', 3000, 60);
  osc('sine', 60, 25, 0.5, big ? 0.7 : 0.45, g);
}

// ---------------------------------------------------------------------------
// Continuous loops — persistent nodes driven per-frame from the game loop.

import type { LoopHandle } from './audio.js';

let loops: { wind: LoopHandle | null; ski: LoopHandle | null; jet: LoopHandle | null } | null = null;
let samplesSwapped = false;
const _right = new THREE.Vector3();

/** Structural player shape — avoids importing Player (cycle). */
interface LoopPlayer {
  vel: THREE.Vector3;
  jetting: boolean;
  skiing: boolean;
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
  audio.updateListener(camera.position, _right);

  if (!loops) {
    loops = {
      // snow_amb is a real blizzard loop — the Tribes wind bed.
      // jet_loop is the actual Legions jetpack sample.
      wind: audio.sampleLoop('snow_amb') ?? audio.noiseLoop('bandpass', 900),
      ski: audio.noiseLoop('bandpass', 2400),
      jet: audio.sampleLoop('jet_loop') ?? audio.oscLoop('sawtooth', 90),
    };
  }

  // Samples fetch async after unlock — swap the synth placeholders for the
  // real recordings once they land (one shot at it, then stay put).
  if (!samplesSwapped && (audio.sample('jet_loop') || audio.sample('snow_amb') || audio.sample('ski_scrape'))) {
    samplesSwapped = true;
    const jetBuf = audio.sample('jet_loop') && audio.sampleLoop('jet_loop');
    const windBuf = audio.sample('snow_amb') && audio.sampleLoop('snow_amb');
    // ski_scrape is a snow-footstep sample — looped slightly fast it reads
    // as crunching granular scrape, better than filtered noise.
    const skiBuf = audio.sample('ski_scrape') && audio.sampleLoop('ski_scrape', 1.3);
    if (jetBuf) { loops.jet?.stop(); loops.jet = jetBuf; }
    if (windBuf) { loops.wind?.stop(); loops.wind = windBuf; }
    if (skiBuf) { loops.ski?.stop(); loops.ski = skiBuf; }
  }

  const speed = player.vel.length();
  // Wind whistles with airspeed — THE Tribes sound. Never fully silent:
  // a desert has a base breeze even standing still.
  loops.wind?.set(Math.min(0.28, 0.04 + speed / 160 * 0.24));
  // Ski scrape only when flagged — ground contact + speed gating lives
  // on the Player side so this just follows the flag.
  loops.ski?.set(player.skiing ? Math.min(0.2, speed / 90 * 0.2) : 0);
  loops.jet?.set(player.jetting ? 0.55 : 0);
}

/** Enemy telegraph/death sounds at world position. */
export function enemyCue(pos: THREE.Vector3, kind: 'pounce' | 'dart' | 'zap' | 'launch' | 'die' | 'hit'): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  if (!play(g, 0.4)) return;
  switch (kind) {
    case 'pounce': if (sample('monster1', g, 0.7)) break; osc('sawtooth', 400, 900, 0.15, 0.45, g); break;
    case 'dart':   if (sample('monster2', g, 0.6, 1.4)) break; noise(0.25, 0.55, g, 'bandpass', 1500, 3000, 2); break;
    case 'zap':    if (sample('sparks', g, 0.8)) break; osc('sawtooth', 1800, 400, 0.12, 0.45, g); break;
    case 'launch': if (sample('missile', g, 0.8)) break; noise(0.3, 0.6, g, 'bandpass', 300, 1200); break;
    case 'die':    if (sample(`alien_die${1 + Math.floor(Math.random() * 3)}`, g, 0.8)) break;
                   noise(0.3, 0.5, g, 'lowpass', 1500, 200); osc('square', 300, 60, 0.2, 0.35, g); break;
    case 'hit':    if (sample('sparks', g, 0.5, 1.3)) break; noise(0.08, 0.35, g, 'highpass', 2000, 3000); break;
  }
}
