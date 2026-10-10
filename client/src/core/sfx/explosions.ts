import type * as THREE from 'three';
import { audio } from '../audio.js';
import { WeaponType } from '../../../../shared/weapons.js';
import { ctx, play, osc, sample, layer, noise } from './util.js';

// World (positional — routed through distance gain + pan)

export function explosionAt(pos: THREE.Vector3, big: boolean, weaponType?: number, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c) {return;}
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) {return;}
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.8, inNode)) { audio.freeInput(inNode); return; }
    if (explosionSample(g, big, weaponType)) {return;}
    noise(0.6, big ? 0.9 : 0.55, g, 'lowpass', 3000, 60);
    osc('sine', 60, 25, 0.5, big ? 0.7 : 0.45, g);
  } finally { audio.emitterPitch = 1; }
}

// Per-weapon explosion identities — same physics, different voice so you
// can hear WHAT blew up, not just that something did.
const BOOM_SAMPLES: Partial<Record<number, [string, number, number?, number?, number?][]>> = {
  // Spinfusor pop: the default explosion_small it always was, with the
  // launcher's double low-end stack (thud_big + slam_thud) under it —
  // same voice, more chest.
  [WeaponType.Disc]: [['explosion_small', 0.9, 1.0], ['thud_big', 1.0, 0.55, 350, 0.5], ['slam_thud', 1.0, 0.55, 400, 0.5]],
  [WeaponType.Mortar]: [['explosion1', 1, 0.6], ['thud_big', 0.9, 0.6, 300]],
  [WeaponType.BoltLauncher]: [['explosion1', 0.95], ['thud_big', 0.5, 0.7]],
  [WeaponType.GrenadeLauncher]: [['explosion_small', 0.9, 0.9], ['thud_big', 0.4, 0.8, 500]],
  [WeaponType.Grenade]: [['explosion_small', 0.9, 1.2]],
  [WeaponType.Flak]: [['explosion_small', 0.9, 1.5], ['sparks', 0.4, 1.2, undefined, 0.3]],
  [WeaponType.PlasmaCannon]: [['explosion_small', 0.6, 1.3], ['sparks', 0.5, 1, undefined, 0.4]],
  // Rapid bolt pop — bright and small; a chain of these shouldn't stack
  // into a roar, so it stays thin and pitched up.
  [WeaponType.PlasmaGun]: [['explosion_small', 0.35, 1.7], ['sparks', 0.25, 1.4, undefined, 0.25]],
  // Sprinkler plip — even thinner than the plasma pop; ~9/s of these must
  // read as rain, not gunfire.
  [WeaponType.Sprinkler]: [['explosion_small', 0.28, 2.1], ['sparks', 0.2, 1.8, undefined, 0.2]],
  [WeaponType.Railgun]: [['shot_energy', 0.7, 0.8], ['explosion_small', 0.6, 1.4]],
  // Remote railgun pop: the capacitor dumping — zap forward, blast behind.
  [WeaponType.RemoteRailgun]: [['shot_energy', 0.8, 0.8], ['explosion_small', 0.7, 1.1], ['sparks', 0.5, 1, undefined, 0.3]],
  [WeaponType.Chaingun]: [['explosion_small', 0.5, 1.6]],
  // Spear strike: no powder — a deep impact thunk, the iron ring of the
  // tip, and spark scatter. Reads as MASS landing, not a bang.
  [WeaponType.Javelin]: [['thud_big', 0.9, 0.75], ['hg_clang', 0.55, 1.3, undefined, 0.25], ['sparks', 0.4, 1.3, undefined, 0.3]],
  // LG death-burst: an electric discharge, not a powder blast — zap body,
  // energy-shot tail, spark scatter on top.
  [WeaponType.Lightning]: [['shot_energy', 0.85, 0.7], ['explosion_small', 0.7, 1.1], ['sparks', 0.55, 0.9, undefined, 0.3]],
  // Cannonball pop: deep powder blast + the iron ring of a ball going off —
  // between rocket and mortar in weight, with the clang tail that says
  // "that was a solid shot", not a shell
  [WeaponType.Cannon]: [['explosion1', 0.9, 0.75], ['thud_big', 0.7, 0.7, 400], ['hg_clang', 0.25, 1.4, undefined, 0.2]],
  // Bombard crumble: NO powder — the ball shatters, not detonates. A deep
  // mass thunk + the stone-crack of shards breaking + spark scatter.
  [WeaponType.Bombard]: [['thud_big', 1.0, 0.6, 350], ['hg_clang', 0.6, 0.9, undefined, 0.35], ['sparks', 0.5, 1.1, undefined, 0.3]],
  // Warhead pop: the biggest layered boom — full blast + deep tail
  [WeaponType.RocketLauncher]: [['explosion1', 1, 0.8], ['explosion2', 0.7, 0.6], ['thud_big', 0.8, 0.65, 400]],
  // MRV airburst pop — the carrier's delivery bang: mid-size blast +
  // spark scatter; the bomblet rain follows on its own voices.
  [WeaponType.MRVLauncher]: [['explosion1', 0.8, 1.1], ['sparks', 0.6, 0.9, undefined, 0.4], ['thud_big', 0.5, 0.9, 400]],
  // Bomblet contact pop — small and bright; six in a row must read as a
  // rain of pops, not one boom — thin like the plasma plip but warmer.
  [WeaponType.MRVBomblet]: [['explosion_small', 0.5, 1.3], ['sparks', 0.3, 1.1, undefined, 0.25]],
  // Satchel pop: the loudest voice in the kit — two stacked blasts + a
  // deep tail + iron ring. A planted charge should sound heavier than
  // anything you can shoot.
  [WeaponType.SatchelCharge]: [['explosion1', 1, 0.7], ['explosion2', 0.85, 0.55], ['thud_big', 0.9, 0.6, 350], ['hg_clang', 0.3, 1.1, undefined, 0.3]],
  // Heal pop: a mist burst, not a bang — soft energy puff + airy sparks.
  [WeaponType.HealGrenade]: [['shot_energy', 0.45, 1.5], ['explosion_small', 0.3, 1.7], ['sparks', 0.3, 1.2, undefined, 0.3]],
  // Proxy pop: the sensor tripping — a zap-forward snap + compact blast.
  [WeaponType.ProxyGrenade]: [['shot_energy', 0.6, 1.1], ['explosion_small', 0.55, 1.4], ['sparks', 0.4, 1.1, undefined, 0.3]],
};

/** LG damage connect — frying sizzle at the contact point. Caller throttles
 *  (~6/s); positional so a beam on a distant target reads quieter. */function explosionSample(g: GainNode, big: boolean, weaponType?: number): boolean {
  const w = weaponType === undefined ? undefined : BOOM_SAMPLES[weaponType];
  if (w && layer(g, w)) {return true;}
  if (!big) {return sample('explosion_small', g, 0.9);}
  // Layer blast + deep thud at half rate — the stacking trick: two cheap
  // samples at different pitches read as one massive detonation.
  return layer(g, [
    [Math.random() < 0.5 ? 'explosion1' : 'explosion2', 0.9],
    ['thud_big', 0.5, 0.7],
  ]);
}

/** Pull-mode detonation (disc) — a suck-in zap layered over a deep pop. */
export function implosionAt(pos: THREE.Vector3, direct: boolean, emitVel?: THREE.Vector3): void {
  const c = ctx();
  if (!c) {return;}
  const inNode = audio.worldInput(pos, emitVel);
  if (!inNode) {return;}
  const g = c.createGain(); g.connect(inNode);
  try {
    if (!play(g, 0.7, inNode)) { audio.freeInput(inNode); return; }
    if (layer(g, [
      ['shot_energy', 0.8, 0.6],
      ['explosion_small', direct ? 0.7 : 0.5, 1.2],
    ])) {return;}
    osc('sawtooth', 1800, 200, 0.25, 0.4, g);
    noise(0.4, 0.5, g, 'lowpass', 4000, 300);
  } finally { audio.emitterPitch = 1; }
}

/** sfxdump-only hook: render an arbitrary layer recipe through the sfx bus
 *  so candidate mixes can be auditioned/analyzed headlessly. */
export function debugMix(parts: [string, number, number?, number?, number?][]): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) {return;}
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 1)) {return;}
  layer(g, parts);
}

export function explosionClose(big: boolean): void {
  const bus = audio.sfxBus, c = ctx();
  if (!bus || !c) {return;}
  const g = c.createGain(); g.connect(bus);
  if (!play(g, 0.8, undefined, 1)) {return;}
  if (explosionSample(g, big)) {return;}
  noise(0.6, big ? 0.9 : 0.55, g, 'lowpass', 3000, 60);
  osc('sine', 60, 25, 0.5, big ? 0.7 : 0.45, g);
}
