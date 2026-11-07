import { WeaponType, vmTypeOf } from '../../../../shared/weapons.js';

// Per-weapon PRESENTATION table — one entry per weapon replaces the three
// parallel tables that used to live in ViewModel (MUZZLE_Z), vmKick
// (RECOIL + FLASH). New weapons get ONE row here; missing fields fall
// back to the bolt launcher defaults exactly like the old tables did.
export interface WeaponVisual {
  /** Bore z (group-space) the muzzle flash parks on. */
  muzzleZ?: number;
  /** Recoil spring: settle seconds, sideways jitter, amplitude, back-pull. */
  recoil?: { recover: number; jitter: number; amp: number; back: number };
  /** Muzzle flash: quad+light color, starburst scale, pop life (×70ms), lamp. */
  flash?: { color: number; scale: number; life: number; light: number };
}

const BOLT_RECOIL = { recover: 0.9, jitter: 0.03, amp: 0.45, back: 0.5 };
const BOLT_FLASH = { color: 0xFF_C8_66, scale: 0, life: 0.5, light: 0 };

export const WEAPON_VISUAL: Record<number, WeaponVisual> = {
  [WeaponType.BoltLauncher]:    { muzzleZ: -0.36, recoil: BOLT_RECOIL, flash: BOLT_FLASH },
  [WeaponType.Disc]:            { muzzleZ: -0.36, recoil: BOLT_RECOIL, flash: { color: 0x99_DD_FF, scale: 0.7, life: 0.7, light: 1 } },
  [WeaponType.Implodisc]:        { muzzleZ: -0.36, recoil: BOLT_RECOIL, flash: { color: 0x99_DD_FF, scale: 0.7, life: 0.7, light: 1 } },
  [WeaponType.Chaingun]:        { muzzleZ: -0.8,  recoil: { recover: 0.18, jitter: 0.02,  amp: 0.5,  back: 1 },  flash: { color: 0xFF_AA_44, scale: 0.9, life: 0.8, light: 0.15 } },
  [WeaponType.Mortar]:          { muzzleZ: -0.28, recoil: { recover: 0.47, jitter: 0,     amp: 1,    back: 1 },  flash: { color: 0xFF_DD_99, scale: 1.6, life: 1.5, light: 1 } },
  [WeaponType.GrenadeLauncher]: { muzzleZ: -0.42, recoil: { recover: 0.3,  jitter: 0.03,  amp: 0.9,  back: 1 },  flash: { color: 0xFF_C8_66, scale: 0.8, life: 0.9, light: 1 } },
  [WeaponType.Flak]:            { muzzleZ: -0.28, recoil: { recover: 0.33, jitter: 0.09,  amp: 1.1,  back: 1 },  flash: { color: 0xFF_BB_55, scale: 1.3, life: 1,   light: 1 } },
  [WeaponType.PlasmaCannon]:    { muzzleZ: -0.35, recoil: { recover: 0.22, jitter: 0,     amp: 0.7,  back: 1 },  flash: { color: 0x44_FF_BB, scale: 0.5, life: 0.6, light: 1 } },
  [WeaponType.PlasmaGun]:       { muzzleZ: -0.38, recoil: { recover: 0.24, jitter: 0.01,  amp: 0.5,  back: 1 },  flash: { color: 0x66_CC_FF, scale: 0.75, life: 0.6, light: 1 } },
  [WeaponType.Sprinkler]:       { muzzleZ: -0.3, recoil: { recover: 0.22, jitter: 0.02,  amp: 0.45, back: 1 },  flash: { color: 0xAA_FF_66, scale: 0.55, life: 1.5, light: 1 } },
  [WeaponType.Railgun]:         { muzzleZ: -0.64, recoil: { recover: 1.5,  jitter: 0.015, amp: 0.75, back: 0.85 }, flash: { color: 0x77_CC_FF, scale: 1.8, life: 1.2, light: 1.6 } },
  [WeaponType.Lightning]:       { muzzleZ: -0.42, recoil: { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1 },  flash: { color: 0x8F_DC_FF, scale: 0.4, life: 0.4, light: 1 } },
  [WeaponType.Shotgun]:         { muzzleZ: -0.41 },
  [WeaponType.Cannon]:          { muzzleZ: -0.53, recoil: { recover: 0.41, jitter: 0.02,  amp: 1.1,  back: 1 },  flash: { color: 0xFF_99_44, scale: 2,  life: 1.8, light: 1.8 } },
  [WeaponType.MissileLauncher]:  { muzzleZ: -0.44, recoil: { recover: 2.8,  jitter: 0.02,  amp: 0.9,  back: 1.15 }, flash: { color: 0xFF_88_44, scale: 1.8, life: 1.6, light: 1 } },
  [WeaponType.RocketLauncher]:   { muzzleZ: -0.57, recoil: { recover: 0.9, jitter: 0.025, amp: 0.55, back: 0.7 }, flash: { color: 0xFF_9A_44, scale: 0.9, life: 0.8, light: 0.8 } },
  [WeaponType.Pistol]:          { muzzleZ: -0.17, recoil: { recover: 0.27, jitter: 0.033, amp: 1.1,  back: 1 },  flash: { color: 0xFF_E0_A0, scale: 0.35, life: 0.4, light: 1 } },
  [WeaponType.Revolver]:        { muzzleZ: -0.27, recoil: { recover: 0.41, jitter: 0.05,  amp: 1.3,  back: 1 },  flash: { color: 0xFF_B0_60, scale: 1.1, life: 0.8, light: 1 } },
  [WeaponType.Sticky]:          { muzzleZ: -0.4,  recoil: { recover: 0.25, jitter: 0.02,  amp: 0.9,  back: 1 },  flash: { color: 0xFF_66_DD, scale: 0.8, life: 0.7, light: 1 } },
  [WeaponType.Blaster]:         { muzzleZ: -0.2,  recoil: { recover: 0.28, jitter: 0.025, amp: 0.9,  back: 1 },  flash: { color: 0x7D_FF_9E, scale: 0.5, life: 0.5, light: 1 } },
  [WeaponType.Repair]:          { muzzleZ: -0.2,  recoil: { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1 },  flash: { color: 0x7D_FF_B8, scale: 0.4, life: 0.4, light: 1 } },
  [WeaponType.HealBeam]:        { recoil: { recover: 0.21, jitter: 0.05,  amp: 0.4,  back: 1 }, flash: { color: 0x8F_D8_FF, scale: 0.4, life: 0.4, light: 1 } },
  [WeaponType.MRVLauncher]:     { muzzleZ: -0.56, recoil: { recover: 1.5,  jitter: 0.03,  amp: 0.8,  back: 1.35 }, flash: { color: 0xFF_77_44, scale: 1.4, life: 1.4, light: 1 } },
  // Howitzer - the recoil IS the identity: big shove, slow recover,
  // a blast big enough to read as a cannon report not a pop.
  [WeaponType.Howitzer]:        { muzzleZ: -0.62, recoil: { recover: 0.35, jitter: 0.04, amp: 1.4,  back: 1.6 }, flash: { color: 0xFF_AA_33, scale: 1.9, life: 1.6, light: 1 } },
  [WeaponType.Bombard]:         { muzzleZ: -0.42, recoil: { recover: 0.9,  jitter: 0.02,  amp: 1.35, back: 1.2 }, flash: { color: 0xFF_88_33, scale: 2.4, life: 1.9, light: 2 } },
  [WeaponType.Gonne]:        { muzzleZ: -0.44, recoil: { recover: 0.41, jitter: 0.02,  amp: 1,  back: 1 },  flash: { color: 0xFF_A5_50, scale: 1.7, life: 1.6, light: 1.6 } },
  [WeaponType.Basilisk]:        { muzzleZ: -0.53, recoil: { recover: 0.6,  jitter: 0.03,  amp: 1.3,  back: 1.15 }, flash: { color: 0xFF_90_3A, scale: 2.2, life: 1.8, light: 1.9 } },
  [WeaponType.Shocklance]:      { muzzleZ: -0.56 },
};

/** Missing-field fallbacks — bolt launcher defaults, the same fallbacks
 *  the old RECOIL/FLASH tables used for unlisted weapons. */
export function recoilFor(wt: number): { recover: number; jitter: number; amp: number; back: number } {
  return WEAPON_VISUAL[vmTypeOf(wt)]?.recoil ?? BOLT_RECOIL;
}
export function flashFor(wt: number): { color: number; scale: number; life: number; light: number } {
  return WEAPON_VISUAL[vmTypeOf(wt)]?.flash ?? BOLT_FLASH;
}
export function muzzleZFor(wt: number): number {
  return WEAPON_VISUAL[vmTypeOf(wt)]?.muzzleZ ?? -0.35;
}
