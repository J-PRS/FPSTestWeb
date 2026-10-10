import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import type { ViewModel } from './ViewModel.js';

// Full spin: 3 barrels at 0.09s cadence, one barrel-index per ~3 shots
// (1/9 rev per shot ≈ 7.8 rad/s). Matching 1-index-per-shot spun the
// triad ~138°/frame at 60fps — just past its 120° symmetry, strobing as
// "nearly a full rev per shot". Below the strobe band it reads as spin.
const SPIN_MAX = (Math.PI * 2 / 9) / 0.09;
const _flashPark = new THREE.Vector3();
const FLASH_LIFE = 0.07; // 1-2 frames feel; >0.15 reads as flamethrower

// Recoil family: one damped oscillator re-triggered per shot, plus a
// separate muzzle FX table — recoil feel and flash look are different
// concerns, so they tune independently.
//
// RECOIL: recoverS = seconds to settle back to rest (the spring's
// internal rate is 3.3/recoverS — damped spring, ζ≈0.55). jitter =
// random sideways/roll spread. amp = muzzle rise, back = backward shove
// scale (1 = baseline — viewmodel.ts multiplies kickZ).
const RECOIL: Record<number, { recover: number; jitter: number; amp: number; back: number }> = {
    [WeaponType.BoltLauncher]:    { recover: 0.90, jitter: 0.03,  amp: 0.45, back: 0.5 },  // same throw as the disc launcher
    [WeaponType.Disc]:            { recover: 0.90, jitter: 0.03,  amp: 0.45, back: 0.5 },  // ~60% of the railgun's throw
    [WeaponType.DiscPull]:        { recover: 0.90, jitter: 0.03,  amp: 0.45, back: 0.5 },
    [WeaponType.Chaingun]:        { recover: 0.18, jitter: 0.02,  amp: 0.5,  back: 1.0 },  // tiny buzz
    [WeaponType.Mortar]:          { recover: 0.47, jitter: 0.00,  amp: 1.0,  back: 1.0 },  // slow heavy heave
    [WeaponType.GrenadeLauncher]: { recover: 0.30, jitter: 0.03,  amp: 0.9,  back: 1.0 },  // pump pop
    [WeaponType.Flak]:            { recover: 0.33, jitter: 0.09,  amp: 1.1,  back: 1.0 },  // hard shove + sideways shudder
    [WeaponType.PlasmaCannon]:    { recover: 0.22, jitter: 0.00,  amp: 0.7,  back: 1.0 },  // light tap
    [WeaponType.PlasmaGun]:       { recover: 0.24, jitter: 0.01,  amp: 0.5,  back: 1.0 },  // repeater
    [WeaponType.Sprinkler]:       { recover: 0.22, jitter: 0.02,  amp: 0.45, back: 1.0 },  // hose — light wobble
    [WeaponType.Railgun]:         { recover: 1.50, jitter: 0.015, amp: 0.75, back: 0.85 }, // modest flip, heavy haul home
    [WeaponType.Lightning]:       { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1.0 },  // per-tick hum
    [WeaponType.Cannon]:          { recover: 0.41, jitter: 0.02,  amp: 1.1,  back: 1.0 },  // heavy naval-gun thump
    [WeaponType.RocketLauncher]:  { recover: 2.8,  jitter: 0.02,  amp: 0.9,  back: 1.15 }, // tube launch — back-blast shove
    [WeaponType.Pistol]:          { recover: 0.15, jitter: 0.01,  amp: 1.1,  back: 1.0 },  // snappy crack — quick settle
    [WeaponType.Revolver]:        { recover: 0.41, jitter: 0.05,  amp: 1.3,  back: 1.0 },  // hand-cannon bark
    [WeaponType.Sticky]:          { recover: 0.25, jitter: 0.02,  amp: 0.9,  back: 1.0 },  // thoomp — tube launch
    [WeaponType.Repair]:          { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1.0 },  // per-tick hum
    [WeaponType.MRVLauncher]:     { recover: 1.5,  jitter: 0.03,  amp: 0.8,  back: 1.35 }, // drum-fed cannon — pull-back
    [WeaponType.Bombard]:         { recover: 0.9,  jitter: 0.02,  amp: 1.35, back: 1.2 },  // siege gun — biggest muzzle rise in the roster
};
// FLASH: color of quad+light, scale of the starburst sprite, life of
// the pop (×70ms), light scale for intensity/range of the lamp pop.
const FLASH: Record<number, { color: number; scale: number; life: number; light: number }> = {
    // Crossbow, not a powder gun: no starburst, no lamp pop — the string
    // release + limb snap animation IS the fire read. Zeroed scale/light
    // rides the existing decay math (flashT still ticks, quad scales to
    // nothing, light intensity 0).
    [WeaponType.BoltLauncher]:    { color: 0xffc866, scale: 0,    life: 0.5, light: 0 },
    [WeaponType.Disc]:            { color: 0x99ddff, scale: 0.7,  life: 0.7, light: 1.0 },
    [WeaponType.DiscPull]:        { color: 0x99ddff, scale: 0.7,  life: 0.7, light: 1.0 },
    [WeaponType.Chaingun]:        { color: 0xffaa44, scale: 0.9,  life: 0.8, light: 0.15 }, // faint lamp — sprite carries the flash
    [WeaponType.Mortar]:          { color: 0xffdd99, scale: 1.6,  life: 1.5, light: 1.0 },  // big flash
    [WeaponType.GrenadeLauncher]: { color: 0xffc866, scale: 0.8,  life: 0.9, light: 1.0 },
    [WeaponType.Flak]:            { color: 0xffbb55, scale: 1.3,  life: 1.0, light: 1.0 },
    [WeaponType.PlasmaCannon]:    { color: 0x44ffbb, scale: 0.5,  life: 0.6, light: 1.0 },  // green glow
    [WeaponType.PlasmaGun]:       { color: 0x66ccff, scale: 0.75, life: 0.6, light: 1.0 },  // ~42ms so it can't bridge the shot gap
    [WeaponType.Sprinkler]:       { color: 0xaaff66, scale: 0.55, life: 1.5, light: 1.0 },  // ~105ms → lit nozzle
    [WeaponType.Railgun]:         { color: 0x77ccff, scale: 1.8,  life: 1.2, light: 1.6 },  // discharge bigger than the prong cluster
    [WeaponType.Lightning]:       { color: 0x8fdcff, scale: 0.4,  life: 0.4, light: 1.0 },  // tiny flash — the beam is the show
    [WeaponType.Cannon]:          { color: 0xff9944, scale: 2,  life: 1.8, light: 1.8 },  // bombard fireball — biggest flash in the roster
    [WeaponType.RocketLauncher]:  { color: 0xff8844, scale: 1.8,  life: 1.6, light: 1.0 },
    [WeaponType.Pistol]:          { color: 0xffe0a0, scale: 0.35, life: 0.4, light: 1.0 },
    [WeaponType.Revolver]:        { color: 0xffb060, scale: 1.1,  life: 0.8, light: 1.0 },
    [WeaponType.Sticky]:          { color: 0xff66dd, scale: 0.8,  life: 0.7, light: 1.0 },  // magenta spit
    [WeaponType.Repair]:          { color: 0x7dffb8, scale: 0.4,  life: 0.4, light: 1.0 },  // green weld spark
    [WeaponType.MRVLauncher]:     { color: 0xff7744, scale: 1.4,  life: 1.4, light: 1.0 },
    [WeaponType.Bombard]:         { color: 0xff8833, scale: 2.4,  life: 1.9, light: 2.0 }, // a powder fireball that fills the bell
};
const RECOIL_FALLBACK = RECOIL[WeaponType.BoltLauncher];
const FLASH_FALLBACK = FLASH[WeaponType.BoltLauncher];

export function kickF(v: ViewModel, strength = 1): void {
    const r = RECOIL[v.activeWeapon] ?? RECOIL_FALLBACK;
    const f = FLASH[v.activeWeapon] ?? FLASH_FALLBACK;
    // Velocity impulse, not a position set: rapid shots stack into a bigger
    // swing instead of re-triggering a flat one, and the spring below
    // overshoots rest so the gun snaps rather than slides.
    v.kickVel += strength * 22;
    // Tune field is recovery SECONDS; the spring works in rates. The 3.3
    // is the ~2% settle time of this spring (ζ≈0.55, ω = decay×2.2).
    v.kickDecay = 3.3 / r.recover;
    v.kickAmp = r.amp;
    v.kickBack = r.back;
    v.kickX = (Math.random() - 0.5) * r.jitter;
    v.kickRoll = (Math.random() - 0.5) * r.jitter * 4 + strength * 0.04;
    if (v.activeWeapon === WeaponType.Chaingun) {
      v.spinVel = Math.min(v.spinVel + strength * 140, SPIN_MAX);
    }
    v.flashMat.color.setHex(f.color);
    v.flashT = FLASH_LIFE * f.life;
    v.flashLifeScale = f.life;
    v.flashMesh.visible = true;
    v.flashMesh2.visible = true;
    // Re-park per shot, not just on switch — a weapon equipped without a
    // switch dip (spawn, loadout apply) would leave the flash at the
    // default group-axis spot, occluded inside the body forever.
    if (v.muzzleGroupPos(v.activeWeapon, _flashPark)) {
      v.flashMesh.position.copy(_flashPark);
      v.flashMesh2.position.copy(_flashPark);
    }
    v.flashMesh.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.85 + Math.random() * 0.3) * f.scale;
    v.flashBaseS = s;
    v.flashBaseS2 = s * 0.7;
    v.flashMesh.scale.setScalar(s);
    v.flashMesh2.scale.setScalar(v.flashBaseS2);
    // 60-100ms light pop — reads as "the shot lit the room", not a decal.
    v.flashLight.color.setHex(f.color);
    const ls = f.light;
    v.flashLightI = 5 * ls;
    v.flashLight.intensity = v.flashLightI;
    v.flashLight.distance = 2.2 * ls; // small pop = small pool of light
    v.flashLight.visible = true;
  }

