import * as THREE from 'three';
import { audio } from '../audio.js';
import { WeaponType } from '../../../../shared/weapons.js';
import { ctx, play, osc, sample, layer, noise } from './util.js';

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

// Layered shot recipes — checked before SHOT_SAMPLES. Flak's voice is a
// deep boom + sparks tail (a shell fan going off, not a shotgun pump).
const SHOT_LAYERS: Partial<Record<number, [name: string, gain: number, rate?: number, lpf?: number, cutAfter?: number, delay?: number][]>> = {
  [WeaponType.Flak]: [['shot_cannon', 0.9, 0.8], ['sparks', 0.45, 1.3, undefined, 0.3]],
  // Chaingun: the raw sample has a burst tail — at 0.09s per shot the tail
  // overlaps the next crack and reads as a fake 2x fire rate. Hard-cut at
  // 80ms, slight pitch-up, so every trigger is exactly one crack. Under it:
  // a lowpassed punch thump (the bolt slamming home) + a faint metal tick.
  // The stack reads as machinery, not raspberry.
  // Lightning gun: per-tick crackle ON TOP of the continuous beam hum —
  // the ticks supply arcing sizzle detail, the loop supplies the voice.
  [WeaponType.Lightning]: [
    ['sparks', 0.35, 1.7, undefined, 0.04],
    ['hg_tick', 0.2, 2.6, undefined, 0.03],
  ],
  // Shotgun: BOOM is the identity — cannon body lowpassed into a chest
  // thump, crack on top, then a delayed pump shuck ~130ms out (the
  // classic ka-CHUNK sell: shot then action).
  [WeaponType.Shotgun]: [
    ['shot_cannon', 0.9, 0.6, 700, 0.22],
    ['thud_big', 0.7, 0.8, undefined, 0.14],
    ['punch', 0.55, 1.4, undefined, 0.07],
    ['shot_chaingun', 0.35, 0.9, undefined, 0.05],
    ['hg_clang', 0.45, 0.5, undefined, 0.25, 0.13], // pump shuck tail
  ],
  // Rocket launcher: launch is THUMP + whoosh — the motor kicking off,
  // not a powder crack. Delayed hiss = the burn travelling away.
  [WeaponType.RocketLauncher]: [
    ['thud_big', 0.7, 1.0, 900, 0.14],
    ['punch', 0.5, 0.8, undefined, 0.08],
    ['hg_tick', 0.4, 0.5, 2000, 0.3, 0.06], // motor hiss, slightly delayed
  ],
  // Cannon: naval-gun boom — big chest cavity + crack + the iron ring
  // tail of a ball leaving the bore. The THUMP is the whole identity.
  [WeaponType.Cannon]: [
    ['shot_cannon', 1.0, 0.55, 500, 0.5],
    ['thud_big', 0.85, 0.7],
    ['punch', 0.45, 0.9, 1500, 0.15],
    ['hg_clang', 0.3, 0.8, undefined, 0.25],
  ],
  // Sidearms: pistol = short snappy crack + hammer tick; revolver = deeper
  // bark with a metallic ring — the two need to be distinguishable blind.
  [WeaponType.Pistol]: [
    ['shot_chaingun', 0.8, 1.3, undefined, 0.06],
    ['hg_tick', 0.4, 1.8, 3000, 0.05],
    ['punch', 0.3, 1.0, 1200, 0.05],
  ],
  [WeaponType.Revolver]: [
    ['shot_cannon', 0.85, 1.1, 900, 0.16],
    ['punch', 0.55, 0.9, 1800, 0.1],
    ['hg_clang', 0.3, 1.5, undefined, 0.18],
  ],
  [WeaponType.Chaingun]: [
    ['shot_chaingun', 0.75, 1.15, undefined, 0.08],
    ['punch', 0.35, 0.7, 700, 0.06],
    // Low body — the chest-thump under the crack. LPF'd hard, cut at 70ms
    // so it adds weight without ringing into the next shot
    ['thud_big', 0.5, 0.95, 500, 0.07],
    ['hg_clang', 0.12, 2.2, undefined, 0.04],
  ],
};

const SHOT_SAMPLES: Partial<Record<number, [string, number, number?]>> = {
  [WeaponType.Rocket]:          ['shot_rocket', 0.9],
  [WeaponType.Chaingun]:        ['shot_chaingun', 0.8],
  [WeaponType.Mortar]:          ['shot_cannon', 1.0],
  [WeaponType.GrenadeLauncher]: ['shot_cannon', 0.8],
  [WeaponType.Grenade]:         ['shot_energy', 0.8],
  // Flak is layered below in SHOT_LAYERS — not a shotgun pump.

  [WeaponType.PlasmaCannon]:    ['shot_plasma', 0.9],
  // Plasma gun bolt — reuse the plasma shot but pitched up + quieter;
  // at ~8/s a fat sample would smear into a hum.
  [WeaponType.PlasmaGun]:       ['shot_plasma', 0.4, 1.6],
  [WeaponType.Railgun]:         ['shot_energy', 1.0],
};

function shootInto(g: GainNode, weaponType: number): void {
  // Disc launcher + belt disc share the voice: lowpassed cannon body +
  // short metallic twang + punch transient, all cut before their ring
  // tails — verified punchy in the spectrogram (sharp attack, decayed by
  // ~0.4s, no sustained band). A thrown disc IS a disc launch.
  if ((weaponType === WeaponType.Disc || weaponType === WeaponType.DiscPull) &&
      layer(g, [['shot_cannon', 1.0, 0.5, 600, 0.6], ['thud_big', 0.9, 0.8], ['punch', 0.5, 1.1, 2000, 0.2], ['hg_clang', 0.35, 1.8, undefined, 0.12]])) return;
  // Melee swing: whoosh (pitched-up dash) + fist crack + low thud body.
  // The connect 'impact' plays separately in combat on an actual hit.
  if (weaponType === WeaponType.Melee &&
      layer(g, [['dash2', 0.7, 1.35], ['punch', 0.9, 1.15], ['slam_thud', 0.5, 0.9]])) return;
  const layered = SHOT_LAYERS[weaponType];
  // Chaingun gets extra jitter — at 11 shots/s it's the recipe where the
  // identical-waveform buzz is most audible
  if (layered && layer(g, layered, weaponType === WeaponType.Chaingun ? 0.22 : 0.1)) return;
  const s = SHOT_SAMPLES[weaponType];
  if (s && sample(s[0], g, s[1], s[2])) return;
  switch (weaponType) {
    case WeaponType.Rocket:    osc('square', 900, 300, 0.12, 0.25, g); noise(0.12, 0.15, g, 'lowpass', 2000, 400); break;
    case WeaponType.Disc:
    case WeaponType.DiscPull:  osc('sawtooth', 1400, 700, 0.18, 0.2, g); noise(0.1, 0.1, g, 'highpass', 3000, 4000); break;
    case WeaponType.Chaingun:  {
      // Crack (randomized band) + bolt thump + metal tick — jittered so a
      // held trigger doesn't phase into one continuous buzz
      const j = 1 + (Math.random() - 0.5) * 0.25;
      noise(0.05, 0.28, g, 'bandpass', 2500 * j, 1100 * j, 2);
      osc('square', 380 * j, 190, 0.05, 0.14, g);
      osc('sine', 140, 90, 0.05, 0.12, g);
      break;
    }
    case WeaponType.Mortar:    osc('sine', 180, 60, 0.25, 0.5, g); noise(0.15, 0.2, g, 'lowpass', 900, 200); break;
    case WeaponType.GrenadeLauncher: osc('triangle', 500, 150, 0.15, 0.35, g); noise(0.1, 0.15, g, 'bandpass', 1200, 400); break;
    case WeaponType.Grenade:   osc('triangle', 600, 200, 0.12, 0.3, g); break;
    case WeaponType.Flak:      noise(0.2, 0.4, g, 'lowpass', 2500, 300); osc('square', 220, 80, 0.15, 0.3, g); break;
    case WeaponType.Shotgun:   noise(0.18, 0.6, g, 'lowpass', 1800, 250); osc('sine', 160, 55, 0.18, 0.5, g); noise(0.05, 0.3, g, 'highpass', 3500, 5000); break;
    case WeaponType.Cannon:    osc('sine', 130, 45, 0.3, 0.7, g); noise(0.25, 0.35, g, 'lowpass', 800, 150); osc('square', 700, 200, 0.06, 0.15, g); break;
    case WeaponType.RocketLauncher: osc('sine', 150, 60, 0.2, 0.5, g); noise(0.3, 0.3, g, 'bandpass', 800, 500, 1.5); break; // thump + whoosh
    case WeaponType.PlasmaCannon:    osc('sawtooth', 2200, 400, 0.14, 0.18, g); osc('sine', 3300, 900, 0.1, 0.1, g); break;
    case WeaponType.PlasmaGun:   {
      // Quick zap — jittered like chaingun so the volley doesn't phase
      const j = 1 + (Math.random() - 0.5) * 0.3;
      osc('sawtooth', 2800 * j, 900 * j, 0.07, 0.13, g);
      osc('sine', 3800 * j, 1400, 0.05, 0.07, g);
      break;
    }
    case WeaponType.Railgun:   osc('sawtooth', 2600, 200, 0.22, 0.25, g); noise(0.15, 0.2, g, 'highpass', 4000, 6000); break;
    case WeaponType.Lightning: {
      // Per-tick crackle — jittered heavily so 22/s reads as a live arc,
      // not a machine-gun loop
      const j = 1 + (Math.random() - 0.5) * 0.6;
      noise(0.05, 0.4, g, 'highpass', 3200 * j, 5500 * j, 1.5);
      osc('sawtooth', 2600 * j, 900, 0.04, 0.12, g);
      break;
    }
    case WeaponType.Melee:     noise(0.15, 0.45, g, 'bandpass', 300, 2200, 1.4); osc('sine', 110, 45, 0.14, 0.5, g); break;
    default:                   osc('square', 700, 300, 0.1, 0.2, g);
  }
}
