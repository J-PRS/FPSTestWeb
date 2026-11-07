import * as THREE from 'three';
import { WeaponType } from '../../../shared/weapons.js';
import type { ViewModel } from './ViewModel.js';
import { recoilFor, flashFor } from './viewmodel/weaponVisual.js';

// Full spin: 3 barrels at 0.09s cadence. Cosmetic only — spin doesn't
// owe the firerate honesty: 2× the index-per-shot rate (~15.6 rad/s ≈
// 15°/frame at 60fps) still sits far under the 120°-symmetry strobe
// band, but reads as a properly spooled chaingun instead of a lazy rev.
const SPIN_MAX = (Math.PI * 2 / 9) / 0.09 * 2;
const _flashPark = new THREE.Vector3();
const FLASH_LIFE = 0.07; // 1-2 frames feel; >0.15 reads as flamethrower

// Recoil family: one damped oscillator re-triggered per shot, plus a
// muzzle FX pop — recoil feel and flash look are different concerns, so
// they tune independently. The per-weapon tables live in weaponVisual.ts
// (one WeaponVisual row: muzzleZ + recoil + flash); the lookup helpers
// keep the old bolt-launcher fallbacks for unlisted types.
// RECOIL: recover = seconds to settle (spring rate = 3.3/recover, ζ≈0.55);
// jitter = random sideways/roll spread; amp = muzzle rise; back = shove
// scale. FLASH: color of quad+light, starburst scale, pop life (×70ms),
// lamp scale.

export function kickF(v: ViewModel, strength = 1): void {
    const r = recoilFor(v.activeWeapon);
    const f = flashFor(v.activeWeapon);
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
    // Sliding barrel (howitzer): snap the front tube back into the
    // receiver; the update envelope re-extends it on the reload clock.
    const slide = v.weapons.get(v.activeWeapon)?.getObjectByName('barrels');
    if (slide) { v.slideKickT = 1; v.slideRef = slide; }
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

