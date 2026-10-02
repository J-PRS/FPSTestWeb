import { WeaponType } from './weapons.ts';
import type { PerkId } from './perks.ts';

/** A bot's kit — weapon picked by engagement range, perk set at spawn so
 *  maxHealth and the move shadow's jet economy match a real loadout.
 *  Shared by the server roster and offline GameBots so both sides field
 *  the same arsenal. */
export interface BotLoadout { perk: PerkId; near: WeaponType; mid: WeaponType; far: WeaponType; belt: WeaponType; side: WeaponType }

export const BOT_NEAR_M = 15, BOT_FAR_M = 40;
export const BOT_MELEE_M = 4.5;   // fist reach — brains press inside CLOSE_PRESS_M
// and two capsule bodies hover ~1-2m apart, so the honest closest gap in a
// chase sits ~4m; 3.0 never opened in soak ledgers (0 w10 rows).
export const BOT_SIDEARM_M = 8.0; // knife range: the hold-out draw is faster than tracking a long gun

export const BOT_LOADOUTS: BotLoadout[] = [
  { perk: 'featherjets', near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.BoltLauncher,        belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // chaser
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // siege
  { perk: 'plated',      near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.Revolver }, // anchor
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // skirmisher
  { perk: 'vitality',    near: WeaponType.Chaingun, mid: WeaponType.Sprinkler, far: WeaponType.BoltLauncher,        belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // hose — area denial
  { perk: 'plated',      near: WeaponType.Shotgun,  mid: WeaponType.Cannon,    far: WeaponType.Railgun,       belt: WeaponType.Javelin,       side: WeaponType.Revolver }, // bruiser — big slugs
  { perk: 'featherjets', near: WeaponType.Flak,     mid: WeaponType.GrenadeLauncher, far: WeaponType.RocketLauncher, belt: WeaponType.ImpactGrenade, side: WeaponType.Pistol }, // skirmisher — shove tools
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.PlasmaCannon, far: WeaponType.Mortar,     belt: WeaponType.ClusterBomb,   side: WeaponType.Pistol   }, // artillery
  { perk: 'overcharge',  near: WeaponType.Lightning, mid: WeaponType.Disc,     far: WeaponType.Railgun,       belt: WeaponType.DiscPull,      side: WeaponType.Pistol   }, // beam rider
  { perk: 'vitality',    near: WeaponType.Shotgun,  mid: WeaponType.Sticky,    far: WeaponType.RocketLauncher, belt: WeaponType.ClusterBomb,   side: WeaponType.Revolver }, // trapper
  { perk: 'vitality',    near: WeaponType.Shotgun,  mid: WeaponType.PlasmaGun, far: WeaponType.BoltLauncher,         belt: WeaponType.ArmorGrenade,  side: WeaponType.Pistol   }, // support — plates the push
];

/** Range-band weapon select — shared by player and creature targets so
 *  the visible tracer reads as the kit the bot would really draw.
 *  `skill` (from the bot's matrix) lets competence bias the draw: a
 *  chaingun phenom reaches for it even at the band's edge, while the
 *  utility of a splash weapon still wins at clearly right ranges —
 *  specialists use their best gun MOST of the time, not always. */
export function pickBotWeapon(lo: BotLoadout, distXZ: number, dist: number, skill?: (w: number) => number): number {
  if (distXZ < BOT_MELEE_M) return WeaponType.Melee;
  if (!skill) return dist < BOT_SIDEARM_M ? lo.side : dist < BOT_NEAR_M ? lo.near : dist > BOT_FAR_M ? lo.far : lo.mid;
  // Triangular band fit: a slot scores 1 dead-center of its range,
  // decaying to 0 one band away — then multiplied by how good the bot
  // is with that gun. Utility (right range) and skill (right weapon)
  // trade off instead of the band being a hard wall.
  const fit = (slot: 'side' | 'near' | 'mid' | 'far'): number => {
    switch (slot) {
      case 'side': return Math.max(0, 1 - dist / (BOT_NEAR_M * 1.2));
      case 'near': return Math.max(0, 1 - Math.abs(dist - BOT_NEAR_M * 0.7) / 14);
      case 'mid': return Math.max(0, 1 - Math.abs(dist - (BOT_NEAR_M + BOT_FAR_M) / 2) / 25);
      case 'far': return dist < BOT_NEAR_M ? Math.max(0, dist / BOT_NEAR_M - 0.4) : Math.min(1, dist / BOT_FAR_M);
    }
  };
  let best: { w: number; s: number } = { w: lo.mid, s: 0 };
  for (const slot of ['side', 'near', 'mid', 'far'] as const) {
    const w = lo[slot];
    const s = fit(slot) * Math.max(0.1, skill(w));
    if (s > best.s) best = { w, s };
  }
  return best.w;
}
