import { WeaponType } from '../../../shared/weapons.js';
import type { ViewModel } from './ViewModel.js';

const SPIN_MAX = 40;   // rad/s at full spin (chaingun spool)
const FLASH_LIFE = 0.07; // 1-2 frames feel; >0.15 reads as flamethrower

// Recoil family: one damped oscillator re-triggered per shot plus the
// muzzle flash+light pop — per-weapon character lives in KICK_TUNE.

// [recoverS, xJitter, flashColor, flashScale, flashLife, kickAmp, kickBack?]
// recoverS = time to settle back to rest in SECONDS (the spring's internal
// rate is 3.3/recoverS — damped spring, ζ≈0.55). kickAmp = muzzle rise,
// kickBack = backward shove scale (default 1 — viewmodel.ts multiplies kickZ).
const KICK_TUNE: Record<number, [number, number, number, number, number, number, number?]> = {
    [WeaponType.BoltLauncher]:          [0.28, 0.00, 0xffc866, 1.0, 1.0, 1.0],  // classic straight-back
    [WeaponType.Disc]:            [0.21, 0.04, 0x99ddff, 0.7, 0.7, 0.9],  // snappy, short travel
    [WeaponType.DiscPull]:        [0.21, 0.04, 0x99ddff, 0.7, 0.7, 0.9],
    [WeaponType.Chaingun]:        [0.18, 0.02, 0xffaa44, 0.6, 0.5, 0.5],  // tiny buzz, no big flash
    [WeaponType.Mortar]:          [0.47, 0.00, 0xffdd99, 1.6, 1.5, 1.0],  // slow heavy heave, big flash
    [WeaponType.GrenadeLauncher]: [0.30, 0.03, 0xffc866, 0.8, 0.9, 0.9],  // pump pop
    [WeaponType.Flak]:            [0.33, 0.09, 0xffbb55, 1.3, 1.0, 1.1],  // hard shove + sideways shudder
    [WeaponType.PlasmaCannon]:          [0.22, 0.00, 0x44ffbb, 0.5, 0.6, 0.7],  // light tap, green glow
    [WeaponType.PlasmaGun]:       [0.24, 0.01, 0x66ccff, 0.35, 0.35, 0.5],// repeater — small kick, cool flash
    [WeaponType.Sprinkler]:       [0.22, 0.02, 0xaaff66, 0.55, 1.5, 0.45],// hose — light wobble; 105ms flash ~bridges the shot gap → lit nozzle
    [WeaponType.Railgun]:         [0.18, 0.01, 0x77ccff, 1.1, 0.9, 1.2],  // fast snap, cyan discharge
    [WeaponType.Lightning]:       [0.21, 0.05, 0x8fdcff, 0.4, 0.4, 0.4],  // per-tick hum — tiny flash, sideways jitter
    [WeaponType.Cannon]:          [0.41, 0.02, 0xffaa55, 1.5, 1.3, 1.1],  // heavy naval-gun thump, big warm flash
    [WeaponType.RocketLauncher]:  [2.8, 0.02, 0xff8844, 1.8, 1.6, 0.9, 1.15],  // MRV-style tube launch — back-blast shove, ~2.8s slow haul home
    [WeaponType.Pistol]:          [0.15, 0.01, 0xffe0a0, 0.35, 0.4, 1.1], // snappy crack — muzzle flip, quick settle
    [WeaponType.Revolver]:        [0.41, 0.05, 0xffb060, 1.1, 0.8, 1.3],  // hand-cannon bark — big muzzle flip
    [WeaponType.Sticky]:          [0.25, 0.02, 0xff66dd, 0.8, 0.7, 0.9],  // thoomp — tube launch, magenta spit
    [WeaponType.Repair]:          [0.21, 0.05, 0x7dffb8, 0.4, 0.4, 0.4],  // per-tick hum — green weld spark
    [WeaponType.MRVLauncher]:     [1.5, 0.03, 0xff7744, 1.4, 1.4, 0.8, 1.35],  // drum-fed cannon — pull-back, ~1.5s slow haul home, minimal muzzle flip
  };

export function kickF(v: ViewModel, strength = 1): void {
    const t = KICK_TUNE[v.activeWeapon] ?? KICK_TUNE[WeaponType.BoltLauncher];
    // Velocity impulse, not a position set: rapid shots stack into a bigger
    // swing instead of re-triggering a flat one, and the spring below
    // overshoots rest so the gun snaps rather than slides.
    v.kickVel += strength * 22;
    // Tune field is recovery SECONDS; the spring works in rates. The 3.3
    // is the ~2% settle time of this spring (ζ≈0.55, ω = decay×2.2).
    v.kickDecay = 3.3 / t[0];
    v.kickAmp = t[5];
    v.kickBack = t[6] ?? 1;
    v.kickX = (Math.random() - 0.5) * t[1];
    v.kickRoll = (Math.random() - 0.5) * t[1] * 4 + strength * 0.04;
    if (v.activeWeapon === WeaponType.Chaingun) {
      v.spinVel = Math.min(v.spinVel + strength * 140, SPIN_MAX);
    }
    v.flashMat.color.setHex(t[2]);
    v.flashT = FLASH_LIFE * t[4];
    v.flashLifeScale = t[4];
    v.flashMesh.visible = true;
    v.flashMesh2.visible = true;
    v.flashMesh.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.85 + Math.random() * 0.3) * t[3];
    v.flashBaseS = s;
    v.flashBaseS2 = s * 0.7;
    v.flashMesh.scale.setScalar(s);
    v.flashMesh2.scale.setScalar(v.flashBaseS2);
    // 60-100ms light pop — reads as "the shot lit the room", not a decal.
    v.flashLight.color.setHex(t[2]);
    v.flashLight.intensity = 5;
    v.flashLight.visible = true;
  }

