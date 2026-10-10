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
  if (!play(g, 0.3, undefined, 1)) return;
  shootInto(g, weaponType);
}

/** Remote player's shot — same signature, distance-attenuated + panned. */
export function shotAt(pos: THREE.Vector3, weaponType: number, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c) return;
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) return;
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.3, inNode)) { audio.freeInput(inNode); return; }
    shootInto(g, weaponType);
  } finally { audio.emitterPitch = 1; }
}

// Layered shot recipes — checked before SHOT_SAMPLES. Flak's voice is a
// deep boom + sparks tail (a shell fan going off, not a shotgun pump).
const SHOT_LAYERS: Partial<Record<number, [name: string, gain: number, rate?: number, lpf?: number, cutAfter?: number, delay?: number][]>> = {
  [WeaponType.Flak]: [['shot_cannon', 0.9, 0.8], ['sparks', 0.45, 1.3, undefined, 0.3]],
  // Bolt launcher: crossbow TWANG + deep sci-fi thump played together,
  // each shot pitched 1.5–2.0 (base 1.75, ±0.25 jitter) — the ballista
  // snap is the attack, the scifi layer is the body. Recipe from the
  // FPS_Test project; old voice (shot_rocket sample) is noted in
  // _docs/OLD/reference.md.
  [WeaponType.BoltLauncher]: [
    ['g_loud-powerful-ballista-crossbow-shot_2_5865d', 0.85, 1.75],
    ['g_powerful-deep-scifi-weapon-shot-game-sound_1_2fa9a', 0.8, 1.75],
  ],
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
  // Cannon: naval-gun boom — the powder body sits a half-octave under
  // the disc launch (0.32/~300Hz vs disc's 0.5/600Hz) so the two can't
  // be confused blind, and a delayed low explosion_small rolls behind
  // it as the echo off the hills. Bore ring tail stays — the identity.
  [WeaponType.Cannon]: [
    ['shot_cannon', 1.0, 0.32, 300, 0.5],
    ['thud_big', 0.9, 0.45, 320, 0.4],
    ['explosion_small', 0.35, 0.55, 1400, 0.3, 0.1], // rolling far echo
    ['punch', 0.4, 0.8, 1200, 0.12],
    ['hg_clang', 0.3, 0.7, undefined, 0.25],
  ],
  // Bombard: the same naval gun a full octave down — a slower, deeper
  // chest hit with a long clang tail. Slower cadence lets the ring ride.
  [WeaponType.Bombard]: [
    ['shot_cannon', 1.0, 0.26, 280, 0.6],
    ['thud_big', 0.95, 0.55, 350, 0.4],
    ['punch', 0.5, 0.7, 1200, 0.2],
    ['hg_clang', 0.4, 0.6, undefined, 0.4, 0.08],
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
  // Sticky launcher: pneumatic THOOMP — a pressurized tube cough, not a
  // powder crack. Soft lowpassed thud body + punch transient + a short
  // air hiss tail as the charge vents. Wet, not explosive.
  [WeaponType.Sticky]: [
    ['thud_big', 0.9, 0.65, 500, 0.2],
    ['punch', 0.45, 0.9, 1500, 0.08],
    ['hg_tick', 0.3, 0.6, 1200, 0.18, 0.04], // venting hiss, slightly delayed
  ],
  // Javelin: a THROWN spear — pure whoosh sell. hg_throw carries a
  // launcher clunk baked in (read as a weird second sound), so the throw
  // is the dash whoosh + a fast rising air-streak whistle over it.
  [WeaponType.Javelin]: [
    ['dash2', 0.9, 1.2],
    // release tick — the wrist-snap, not a whistle (that layer read wrong)
    ['hg_tick', 0.3, 1.8, 3000, 0.04],
  ],
  // Demo charge: a planted satchel — slowed whoosh for the heavy underhand
  // lob, then the strap-slap of the charge leaving the hand. No launch
  // crack: it was never fired, it was placed.
  [WeaponType.SatchelCharge]: [
    ['dash2', 0.6, 0.8],
    ['hg_tick', 0.5, 0.9, 900, 0.1],
    ['thud_big', 0.4, 0.7, 400, 0.12],
  ],
  // Heal grenade: a soft underhand lob — light whoosh + a priming chirp.
  [WeaponType.HealGrenade]: [
    ['dash2', 0.5, 1.1],
    ['hg_tick', 0.35, 1.4, 2400, 0.06],
  ],
  // Proxy grenade: a sensor ball leaving the hand — short whoosh + the
  // arming beep that tells you the bubble is live.
  [WeaponType.ProxyGrenade]: [
    ['dash2', 0.45, 1.0],
    ['hg_tick', 0.45, 1.7, 2200, 0.08],
  ],
  // Chaingun @ ~11/s: voice is the authentic T2 fire crack (bright
  // high-band snap — 60% of its energy sits >2kHz, vs the old sample's
  // mid-heavy body that stacked into sputter). Punch lives in ONE
  // low-mid slam under the crack — a single deep bolt-thump, not the
  // old stacked sub-thumps that read as a fart. Cut stays tight so
  // every trigger is one crack.
  [WeaponType.Chaingun]: [
    ['shot_chaingun', 0.9, 1.0, undefined, 0.075],
    ['punch', 0.7, 0.55, 550, 0.09],
    // Faint bolt tick for mechanical detail — quiet enough to read as
    // texture under sustained fire, not a second transient.
    ['hg_tick', 0.18, 1.6, 3000, 0.03],
  ],
};

const SHOT_SAMPLES: Partial<Record<number, [string, number, number?]>> = {
  [WeaponType.BoltLauncher]:          ['shot_rocket', 0.9],
  [WeaponType.Chaingun]:        ['shot_chaingun', 0.8],
  [WeaponType.Mortar]:          ['shot_cannon', 1.0],
  // MRV volley — same tube bark as the GL but heavier: one trigger
  // serves the whole burst, so it needs cannon weight, not pump snap.
  [WeaponType.MRVLauncher]:     ['shot_cannon', 0.9, 0.75],
  [WeaponType.GrenadeLauncher]: ['shot_cannon', 0.8],
  [WeaponType.Grenade]:         ['shot_energy', 0.8],
  // Flak is layered below in SHOT_LAYERS — not a shotgun pump.

  [WeaponType.PlasmaCannon]:    ['shot_plasma', 0.9],
  // Plasma gun bolt — reuse the plasma shot but pitched up + quieter;
  // at ~8/s a fat sample would smear into a hum.
  [WeaponType.PlasmaGun]:       ['shot_plasma', 0.4, 1.6],
  // Sprinkler — plasma sample pitched higher and quieter still; at ~9/s
  // anything fatter drones into a hum.
  [WeaponType.Sprinkler]:       ['shot_plasma', 0.32, 2.0],
  [WeaponType.Railgun]:         ['shot_energy', 1.0],
};

function shootInto(g: GainNode, weaponType: number): void {
  // Disc launcher + belt disc share the voice: lowpassed cannon body +
  // a double low-end stack (thud_big + slam_thud — the launcher's chest
  // thump) + short metallic twang + punch transient, all cut before their
  // ring tails — verified punchy in the spectrogram (sharp attack, decayed
  // by ~0.4s, no sustained band). A thrown disc IS a disc launch.
  if ((weaponType === WeaponType.Disc || weaponType === WeaponType.DiscPull) &&
      layer(g, [['shot_cannon', 1.0, 0.5, 600, 0.6], ['thud_big', 0.9, 0.7], ['slam_thud', 0.85, 0.7, 500, 0.25], ['punch', 0.5, 1.1, 2000, 0.2], ['hg_clang', 0.35, 1.8, undefined, 0.12]])) return;
  // Melee swing: whoosh (pitched-up dash) + fist crack + low thud body.
  // The connect 'impact' plays separately in combat on an actual hit.
  if (weaponType === WeaponType.Melee &&
      layer(g, [['dash2', 0.7, 1.35], ['punch', 0.9, 1.15], ['slam_thud', 0.5, 0.9]])) return;
  const layered = SHOT_LAYERS[weaponType];
  // Chaingun gets the widest jitter — at 11 shots/s it's the recipe where
  // the identical-waveform buzz is most audible; ±15% pitch + gain spread
  // keeps successive cracks from phasing into a drone. Bolt launcher's
  // 0.29 isn't drift-jitter: it's the authored 1.5–2.0 pitch randomization
  // around the 1.75 base rate.
  const layerJitter = weaponType === WeaponType.Chaingun ? 0.3
    : weaponType === WeaponType.BoltLauncher ? 0.29
    : 0.1;
  if (layered && layer(g, layered, layerJitter)) return;
  const s = SHOT_SAMPLES[weaponType];
  if (s && sample(s[0], g, s[1], s[2])) return;
  (SYNTH_SHOTS[weaponType] ?? synthDefault)(g);
}

// Synth fallbacks — only reached when no sample is loaded for the weapon.
function synthChaingun(g: GainNode): void {
  // Snap band + single bolt-slam — short bright burst on top, one deep
  // thump under it. The punch is a fast pitch-drop sine (the classic
  // kick-drum body), not a square — a buzz there reads as sputter.
  const j = 1 + (Math.random() - 0.5) * 0.3;
  noise(0.04, 0.24, g, 'bandpass', 2100 * j, 1100 * j, 2);
  osc('sine', 220 * j, 70, 0.07, 0.2, g);
}
function synthPlasmaGun(g: GainNode): void {
  // Quick zap — jittered like chaingun so the volley doesn't phase
  const j = 1 + (Math.random() - 0.5) * 0.3;
  osc('sawtooth', 2800 * j, 900 * j, 0.07, 0.13, g);
  osc('sine', 3800 * j, 1400, 0.05, 0.07, g);
}
function synthSprinkler(g: GainNode): void {
  // Watery zap — brighter carrier, extra jitter so the hose never phases
  const j = 1 + (Math.random() - 0.5) * 0.4;
  osc('sawtooth', 3200 * j, 1100 * j, 0.06, 0.11, g);
  osc('sine', 4400 * j, 1700, 0.04, 0.06, g);
}
function synthLightning(g: GainNode): void {
  // Per-tick crackle — jittered heavily so 22/s reads as a live arc,
  // not a machine-gun loop
  const j = 1 + (Math.random() - 0.5) * 0.6;
  noise(0.05, 0.4, g, 'highpass', 3200 * j, 5500 * j, 1.5);
  osc('sawtooth', 2600 * j, 900, 0.04, 0.12, g);
}
function synthDefault(g: GainNode): void {
  osc('square', 700, 300, 0.1, 0.2, g);
}

const SYNTH_SHOTS: Record<number, (g: GainNode) => void> = {
  [WeaponType.BoltLauncher]:    (g) => { osc('square', 900, 300, 0.12, 0.25, g); noise(0.12, 0.15, g, 'lowpass', 2000, 400); },
  [WeaponType.Disc]:      (g) => { osc('sawtooth', 1400, 700, 0.18, 0.2, g); noise(0.1, 0.1, g, 'highpass', 3000, 4000); },
  [WeaponType.DiscPull]:  (g) => { osc('sawtooth', 1400, 700, 0.18, 0.2, g); noise(0.1, 0.1, g, 'highpass', 3000, 4000); },
  [WeaponType.Chaingun]:  synthChaingun,
  [WeaponType.Mortar]:    (g) => { osc('sine', 180, 60, 0.25, 0.5, g); noise(0.15, 0.2, g, 'lowpass', 900, 200); },
  [WeaponType.GrenadeLauncher]: (g) => { osc('triangle', 500, 150, 0.15, 0.35, g); noise(0.1, 0.15, g, 'bandpass', 1200, 400); },
  [WeaponType.Grenade]:   (g) => { osc('triangle', 600, 200, 0.12, 0.3, g); },
  [WeaponType.Flak]:      (g) => { noise(0.2, 0.4, g, 'lowpass', 2500, 300); osc('square', 220, 80, 0.15, 0.3, g); },
  [WeaponType.Shotgun]:   (g) => { noise(0.18, 0.6, g, 'lowpass', 1800, 250); osc('sine', 160, 55, 0.18, 0.5, g); noise(0.05, 0.3, g, 'highpass', 3500, 5000); },
  [WeaponType.Cannon]:    (g) => { osc('sine', 130, 45, 0.3, 0.7, g); noise(0.25, 0.35, g, 'lowpass', 800, 150); osc('square', 700, 200, 0.06, 0.15, g); },
  [WeaponType.Bombard]:   (g) => { osc('sine', 95, 32, 0.4, 0.85, g); noise(0.35, 0.4, g, 'lowpass', 600, 120); osc('square', 500, 140, 0.08, 0.18, g); },
  // thump + whoosh
  [WeaponType.RocketLauncher]: (g) => { osc('sine', 150, 60, 0.2, 0.5, g); noise(0.3, 0.3, g, 'bandpass', 800, 500, 1.5); },
  [WeaponType.PlasmaCannon]:   (g) => { osc('sawtooth', 2200, 400, 0.14, 0.18, g); osc('sine', 3300, 900, 0.1, 0.1, g); },
  [WeaponType.PlasmaGun]:  synthPlasmaGun,
  [WeaponType.Sprinkler]:  synthSprinkler,
  [WeaponType.Railgun]:   (g) => { osc('sawtooth', 2600, 200, 0.22, 0.25, g); noise(0.15, 0.2, g, 'highpass', 4000, 6000); },
  [WeaponType.Lightning]: synthLightning,
  [WeaponType.Melee]:     (g) => { noise(0.15, 0.45, g, 'bandpass', 300, 2200, 1.4); osc('sine', 110, 45, 0.14, 0.5, g); },
  // MRV volley thump — mortar body + a bright spit tail that hints at
  // the burst payload about to scatter.
  [WeaponType.MRVLauncher]: (g) => { osc('sine', 170, 55, 0.22, 0.55, g); noise(0.18, 0.3, g, 'lowpass', 1100, 250); noise(0.06, 0.2, g, 'bandpass', 1800, 600, 1.3); },
  // Javelin synth fallback — same idea as the layered version: release
  // snap + rising air-tear whoosh + body thump.
  [WeaponType.Javelin]:   (g) => { noise(0.22, 0.5, g, 'bandpass', 900, 3800, 1.6); osc('sawtooth', 240, 900, 0.16, 0.3, g); osc('sine', 150, 60, 0.18, 0.35, g); },
};
