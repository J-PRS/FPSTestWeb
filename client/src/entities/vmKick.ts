import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import type { ViewModel } from './ViewModel.js';

// Full spin: 3 barrels at 0.09s cadence. Cosmetic only — spin doesn't
// owe the firerate honesty: 2× the index-per-shot rate (~15.6 rad/s ≈
// 15°/frame at 60fps) still sits far under the 120°-symmetry strobe
// band, but reads as a properly spooled chaingun instead of a lazy rev.
const SPIN_MAX = (Math.PI * 2 / 9) / 0.09 * 2;
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
    [WeaponType.BoltLauncher]:    { recover: 0.9, jitter: 0.03,  amp: 0.45, back: 0.5 },  // same throw as the disc launcher
    [WeaponType.Disc]:            { recover: 0.9, jitter: 0.03,  amp: 0.45, back: 0.5 },  // ~60% of the railgun's throw
    [WeaponType.Implodisc]:        { recover: 0.9, jitter: 0.03,  amp: 0.45, back: 0.5 },
    [WeaponType.Chaingun]:        { recover: 0.18, jitter: 0.02,  amp: 0.5,  back: 1 },  // tiny buzz
    [WeaponType.Mortar]:          { recover: 0.47, jitter: 0,  amp: 1,  back: 1 },  // slow heavy heave
    [WeaponType.GrenadeLauncher]: { recover: 0.3, jitter: 0.03,  amp: 0.9,  back: 1 },  // pump pop
    [WeaponType.Flak]:            { recover: 0.33, jitter: 0.09,  amp: 1.1,  back: 1 },  // hard shove + sideways shudder
    [WeaponType.PlasmaCannon]:    { recover: 0.22, jitter: 0,  amp: 0.7,  back: 1 },  // light tap
    [WeaponType.PlasmaGun]:       { recover: 0.24, jitter: 0.01,  amp: 0.5,  back: 1 },  // repeater
    [WeaponType.Sprinkler]:       { recover: 0.22, jitter: 0.02,  amp: 0.45, back: 1 },  // hose — light wobble
    [WeaponType.Railgun]:         { recover: 1.5, jitter: 0.015, amp: 0.75, back: 0.85 }, // modest flip, heavy haul home
    [WeaponType.Lightning]:       { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1 },  // per-tick hum
    [WeaponType.Cannon]:          { recover: 0.41, jitter: 0.02,  amp: 1.1,  back: 1 },  // heavy naval-gun thump
    [WeaponType.RocketLauncher]:  { recover: 2.8,  jitter: 0.02,  amp: 0.9,  back: 1.15 }, // tube launch — back-blast shove
    [WeaponType.Pistol]:          { recover: 0.27, jitter: 0.033, amp: 1.1,  back: 1 },  // ~65% of the revolver's kick — snap without the full throw
    [WeaponType.Revolver]:        { recover: 0.41, jitter: 0.05,  amp: 1.3,  back: 1 },  // hand-cannon bark
    [WeaponType.Sticky]:          { recover: 0.25, jitter: 0.02,  amp: 0.9,  back: 1 },  // thoomp — tube launch
    [WeaponType.Repair]:          { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1 },  // per-tick hum
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
    [WeaponType.BoltLauncher]:    { color: 0xFF_C8_66, scale: 0,    life: 0.5, light: 0 },
    [WeaponType.Disc]:            { color: 0x99_DD_FF, scale: 0.7,  life: 0.7, light: 1 },
    [WeaponType.Implodisc]:        { color: 0x99_DD_FF, scale: 0.7,  life: 0.7, light: 1 },
    [WeaponType.Chaingun]:        { color: 0xFF_AA_44, scale: 0.9,  life: 0.8, light: 0.15 }, // faint lamp — sprite carries the flash
    [WeaponType.Mortar]:          { color: 0xFF_DD_99, scale: 1.6,  life: 1.5, light: 1 },  // big flash
    [WeaponType.GrenadeLauncher]: { color: 0xFF_C8_66, scale: 0.8,  life: 0.9, light: 1 },
    [WeaponType.Flak]:            { color: 0xFF_BB_55, scale: 1.3,  life: 1, light: 1 },
    [WeaponType.PlasmaCannon]:    { color: 0x44_FF_BB, scale: 0.5,  life: 0.6, light: 1 },  // green glow
    [WeaponType.PlasmaGun]:       { color: 0x66_CC_FF, scale: 0.75, life: 0.6, light: 1 },  // ~42ms so it can't bridge the shot gap
    [WeaponType.Sprinkler]:       { color: 0xAA_FF_66, scale: 0.55, life: 1.5, light: 1 },  // ~105ms → lit nozzle
    [WeaponType.Railgun]:         { color: 0x77_CC_FF, scale: 1.8,  life: 1.2, light: 1.6 },  // discharge bigger than the prong cluster
    [WeaponType.Lightning]:       { color: 0x8F_DC_FF, scale: 0.4,  life: 0.4, light: 1 },  // tiny flash — the beam is the show
    [WeaponType.Cannon]:          { color: 0xFF_99_44, scale: 2,  life: 1.8, light: 1.8 },  // bombard fireball — biggest flash in the roster
    [WeaponType.RocketLauncher]:  { color: 0xFF_88_44, scale: 1.8,  life: 1.6, light: 1 },
    [WeaponType.Pistol]:          { color: 0xFF_E0_A0, scale: 0.35, life: 0.4, light: 1 },
    [WeaponType.Revolver]:        { color: 0xFF_B0_60, scale: 1.1,  life: 0.8, light: 1 },
    [WeaponType.Sticky]:          { color: 0xFF_66_DD, scale: 0.8,  life: 0.7, light: 1 },  // magenta spit
    [WeaponType.Repair]:          { color: 0x7D_FF_B8, scale: 0.4,  life: 0.4, light: 1 },  // green weld spark
    [WeaponType.MRVLauncher]:     { color: 0xFF_77_44, scale: 1.4,  life: 1.4, light: 1 },
    [WeaponType.Bombard]:         { color: 0xFF_88_33, scale: 2.4,  life: 1.9, light: 2 }, // a powder fireball that fills the bell
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

