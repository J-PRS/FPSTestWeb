// Gun Game ruleset - the weapon ladder every player climbs.
// Two orderings, one roster:
//   GUN_GAME_LADDER - classic gungame pays table damage, so the climb is
//     a power ladder: weak guns first, heavy ordnance last.
//   IGUN_LADDER - igun pays ~200 on every hit, so weapon "power" is dead;
//     the only axis is how hard the gun is to kill with. The climb runs
//     awkward → forgiving: the underdog chases the hose, the leader is
//     one death away from the bottom.
// Howitzer is excluded from both - it's a deployment toy, not a gun.
// Mortar and MRVLauncher are out too - fuse/carrier mechanics, not guns.
// Bombard (specialty siege slug), Sticky (remote-detonation mines) and
// RocketLauncher (retired universal flat rocket) are out as well.
// igun also drops Railgun - precision is the wrong tax mid-climb - so
// PlasmaCannon folds into the hose family.
// Defined in WeaponType space - the wire id both ends already speak.
// Excluded on purpose: sidearms (hold-out pulls), beams (Repair/
// HealBeam/Shocklance adjudicate outside the projectile path - Lightning
// is the exception, igun fields it as a near-pinnacle hose),
// melee, and every belt throw / deployable - the ladder IS the kit.
import { WeaponType } from './weaponTable.ts';
import { WEAPONS } from './weaponRows.js';
import type { ArmorClass } from './botClasses.js';

/** Classic gungame: weakest → strongest by table damage. Each rung is a
 *  bucket of functionally-similar weapons - the player's slots hold the
 *  members, any member can fire; solo rungs are the unique guns. */
export const GUN_GAME_LADDER: readonly (readonly WeaponType[])[] = [
  [WeaponType.PlasmaGun, WeaponType.Chaingun, WeaponType.Sprinkler], // hose: rapid holds
  [WeaponType.Flak, WeaponType.Shotgun],                           // coverage over precision
  [WeaponType.GrenadeLauncher],                                    // forgiving lob
  [WeaponType.BoltLauncher],                                       // arcing rocket
  [WeaponType.Disc, WeaponType.FastDiscLauncher],                  // disc, arc vs flat
  [WeaponType.Gonne, WeaponType.Cannon, WeaponType.Basilisk],      // same 80m/s arc shell, L/M/H frames
  [WeaponType.Railgun, WeaponType.PlasmaCannon],                   // precision hits
  [WeaponType.MissileLauncher],                                    // big boom
];

/** igun: the same roster climbed backwards - kill-ease ascends. Flat
 *  honest leads open the climb (FastDisc + BoltLauncher: small pop, you
 *  earned the hit); the hose trio is the payoff. */
export const IGUN_LADDER: readonly (readonly WeaponType[])[] = [
  [WeaponType.FastDiscLauncher, WeaponType.BoltLauncher],   // hardest: flat lead, tiny pop
  [WeaponType.Disc],                                        // arc-bounce reads
  [WeaponType.GrenadeLauncher],                             // mid lob
  [WeaponType.Gonne, WeaponType.Cannon, WeaponType.Basilisk], // arc family: same shell, frame is luck
  [WeaponType.MissileLauncher],                             // big boom, low RoF brakes the flow
  [WeaponType.PlasmaGun, WeaponType.Sprinkler, WeaponType.PlasmaCannon], // plasma family - rapid bolts humans track well
  [WeaponType.Flak, WeaponType.Shotgun],                    // very easy: coverage
  [WeaponType.Lightning],                                   // hitscan beam - almost free kills
  [WeaponType.Chaingun],                                    // pinnacle: hold trigger, spray wins
];

/** Rung index of the last bucket for the given ladder - kills past it
 *  stay on top (the frag count decides the match, not the ladder). */
export function gunGameClimax(igun = false): number {
  return (igun ? IGUN_LADDER : GUN_GAME_LADDER).length - 1;
}

function ladderFor(igun: boolean): readonly (readonly WeaponType[])[] {
  return igun ? IGUN_LADDER : GUN_GAME_LADDER;
}

function bucketFor(rung: number, igun: boolean): readonly WeaponType[] {
  const l = ladderFor(igun);
  const i = Number.isFinite(rung) ? Math.max(0, Math.min(l.length - 1, Math.floor(rung))) : 0;
  return l[i]!;
}

/** Every weapon a rung fields in the given ladder - the player's slots
 *  carry these, any member is fireable. Out-of-range rungs clamp. */
export function gunGameBucket(rung: number, igun = false): readonly WeaponType[] {
  return bucketFor(rung, igun);
}

/** The canonical weapon of a rung (first bucket member) - used where a
 *  single weapon is needed: roster weapon for remotes, bot picks, rung-0
 *  seat. Out-of-range rungs clamp. */
export function gunGameWeapon(rung: number, igun = false): WeaponType {
  return bucketFor(rung, igun)[0]!;
}

/** The roll a rung deals: one member of the bucket, `rand` in [0,1).
 *  Buckets are weapon VARIANTS (same family, small stat deltas) - which
 *  member you draw is luck, not a pick. */
export function gunGameRoll(rung: number, igun: boolean, rand: number): WeaponType {
  const b = bucketFor(rung, igun);
  return b[Math.max(0, Math.min(b.length - 1, Math.floor(rand * b.length)))]!;
}

/** May `wt` fire at `rung` in the given ladder? Any bucket member counts -
 *  the fire gate is broader than the roll because the assigned member is
 *  the only one shouldered anyway. The Hook grapple is the one exemption -
 *  it deals no damage (movement tool, not a rung weapon), so it can't farm
 *  ladder progress and every player keeps their traverse. */
export function gunGameAllows(rung: number, wt: number, igun = false): boolean {
  return bucketFor(rung, igun).includes(wt) || wt === WeaponType.Hook;
}

/** igun chassis: the rung weapon's own class tier, so a tier-locked gun
 *  is always legal and the body reads as part of the weapon's identity
 *  (siege frame on ordnance, duelist frame on precision gear). Untiered
 *  weapons ride medium - the neutral frame. Chassis swaps live on rung
 *  edges, so the climb literally changes your silhouette. */
export function igunChassis(wt: number | undefined): ArmorClass {
  return (wt === undefined ? undefined : WEAPONS[wt]?.tier) ?? 'medium';
}
