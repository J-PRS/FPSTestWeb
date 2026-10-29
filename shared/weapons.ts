/**
 * Shared weapon table — THE single source of truth for anything that
 * crosses the wire or affects gameplay outcomes on both sides.
 *
 * Client configs import rendering fields from here; server imports
 * damage/knockback/ballistics to validate claims. Never duplicate a
 * stat — that path already shipped a real bug (splash falloff desync).
 *
 * weaponType is the stable wire ID (binary frames carry it as u8).
 */

import { WeaponType, type WeaponStats } from './weaponTable.js';
import { WEAPONS } from './weaponRows.js';
export const AOE_VFX_SCALE = 0.8;

/** Melee cone half-angle (cos) — ~57°. The client swings this cone for
 *  prediction; the server re-derives the same cone on the intent, so
 *  both ends need one constant or the paid set drifts from the shown set. */
export const MELEE_ARC_DOT = 0.55;
/** Flat damage a melee swing deals to creatures — the old creatureHit
 *  claim carried this, so the server sweep pays the same number. Player
 *  melee damage is aoeDamage (55) on the weapon table. */
export const MELEE_CREATURE_DAMAGE = 60;

/** Canonical launchers (Bolt + Disc) bloom their blast on a direct hit:
 *  aoeRadius × this. Shared so client prediction and server validation
 *  compute the same reach — the client claims `directHit` on the aoeShot
 *  and the server re-derives the bonus from this table, never trusting a
 *  radius over the wire. */
export const DIRECT_HIT_AOE_BONUS = 1.5;
export function directHitAoeBonus(weaponType: number): number {
  return (weaponType === WeaponType.BoltLauncher || weaponType === WeaponType.Disc)
    ? DIRECT_HIT_AOE_BONUS
    : 1;
}

/** Skillshot ramp: the flagship launchers (and their belt cousins)
 *  pay direct damage × min(CAP, 1 + airtime) — +50% per 0.5s of flight,
 *  so a 1.5s lead is 2.5× and the 4× cap lands at 2.0s. Applies to the
 *  DIRECT line only: wakes and splash stay flat, otherwise near-misses
 *  would pay like hits. airtime is server-validated on the claim, so the
 *  same formula on both ends can't drift. */
export const AIRTIME_DMG_CAP = 4;
const AIRTIME_SCALED = new Set<number>([
  WeaponType.BoltLauncher, WeaponType.Disc, WeaponType.Implodisc, WeaponType.BeltDisc, WeaponType.Javelin,
]);
export function scaledDirectDamage(weaponType: number, airtime?: number): number {
  const w = WEAPONS[weaponType];
  if (!w) {return 0;}
  if (!AIRTIME_SCALED.has(weaponType) || airtime === undefined || airtime <= 0) {
    return w.directDamage;
  }
  return w.directDamage * Math.min(AIRTIME_DMG_CAP, 1 + airtime);
}

export { WeaponType, idSeed, jitteredTtl, RIDE_CATCH_R } from './weaponTable.js';
export { WEAPONS } from './weaponRows.js';
export type { WeaponStats } from './weaponTable.js';

/** Claimless-combat rollout: intents (shotFired) for these weaponTypes
 *  spawn a server-authoritative shell instead of riding the
 *  shot/aoeShot claim path. One table on both ends — the client's
 *  predictor and the server's intent gate must never disagree. */
// The server sim (RoomProjectiles/projContact) models everything here:
// every weapon whose shell has a body (speed > 0) — contact pops,
// bounce + arm time, fuses, stickies, proximity wake, cluster scatter,
// ray-burst discharge, heal/armor payloads, burst fans (pellet-index
// echoes). Excluded: the body-less kinds — Melee, Lightning, Repair,
// HealBeam, Slam, and the carrier-spawned bomblets.
export const SERVER_SIMMED_WEAPONS = new Set<number>(Object.keys(WEAPONS).map(Number));
export function serverSimmed(weaponType: number | undefined): boolean {
  return weaponType !== undefined && SERVER_SIMMED_WEAPONS.has(weaponType);
}

export const REPAIR_RANGE = 14;        // beam reach (m)
export const REPAIR_HEAL_PER_TICK = 5; // per fire tick → ~50 hp/s at 0.1s rate
export const REPAIR_MIN_TICK_S = 0.07; // server: min seconds between claims per shooter+target
export const REPAIR_ARMOR_MULT = 2;    // armor cap = this × the deployable's base hp

// Armor-grenade economy — the plating the blast sprays is server-derived
// (claims carry no armor amount). Creatures wear it as overcap health up
// to ARMORNADE_OVERCAP × maxHealth — same trick as deployable armor.
export const ARMORNADE_ARMOR = 50;     // flat armor each blast grants
export const ARMORNADE_OVERCAP = 2;    // creature armor cap = this × maxHealth

// Heal-kit economy — the beam's ammo is jet energy, so pocket-healing a
// push taxes the healer's own mobility. Claims carry no amounts: the
// server re-derives the tick and the energy cost.
export const HEALBEAM_RANGE = 22;         // beam reach (m)
export const HEALBEAM_PER_TICK = 4;       // hp per fire tick → ~40 hp/s at 0.1s rate
export const HEALBEAM_MIN_TICK_S = 0.07;  // min seconds between claims per shooter+target
export const HEALBEAM_ENERGY = 6;         // jet energy per heal tick — a full tank is ~16s of beam
export const HEALNADE_HEAL = 60;          // flat heal on allies caught in the nade blast
export const CONC_JET_DRAIN = 40;         // jet energy the concussion blast saps — the escape debuff, not just the fumble

// Shocklance — the honest ray's reach for the pull-out zap. Shared: the
// client draws the bolt to the same stop the server's beamSweep pays at.
export const LANCE_RANGE = 18;
// Shocklance cadence — seconds between zaps. ONE number, read by the
// client trigger (the weapon def's rate), the legal-cadence table below
// (bots, the server's spawn-claim window) and the server's own lance
// gate, so a lance can't drift into a 2s client against a 1.85s server.
export const LANCE_CADENCE_S = 2;

// Belt economy — one charge pool feeds every belt throw AND every pack
// deploy: the nuggets you pick up ARE the ordnance you carry.
export const BELT_MAX = 5;        // spawn stock AND the pickup cap
export const BELT_THROW_COST = 1; // per belt toss

/** Power-class weapons: a kill on DIRECT contact bursts the body into
 *  its chunk gibs. Splash from the same gun (and all bullet/hitscan
 *  kills) stays the Verlet ragdoll. */
export const GIB_WEAPONS = new Set<number>([
  WeaponType.BoltLauncher, WeaponType.PlasmaCannon, WeaponType.RocketLauncher,
  WeaponType.Mortar, WeaponType.Bombard, WeaponType.Cannon, WeaponType.Gonne, WeaponType.Basilisk,
  WeaponType.Sticky, WeaponType.GrenadeLauncher]);
// Pack items (turret/mine/station/…) are priced per-kind in
// shared/deployItems.ts (turret 2, mortar 3, …) — not a flat constant.
// WeaponTypes that ONLY exist as belt throws — any spawn claim carrying
// one pays BELT_THROW_COST. BeltSticky is its own type so a toss CAN be
// told from a launcher shot — the old shared type made throws unchargeable.
export const BELT_THROW_WEAPONS = new Set<number>([
  ...Object.entries(WEAPONS)
    .filter(([, w]) => w.beltThrow === true)
    .map(([wt]) => Number(wt)),
  // Fallback for weapons without beltThrow field yet (legacy)
  WeaponType.BeltSticky,
  WeaponType.Grenade, WeaponType.Implodisc, WeaponType.ClusterBomb,
  WeaponType.Javelin, WeaponType.ImpactGrenade, WeaponType.RemoteRailgun,
  WeaponType.ArmorGrenade, WeaponType.HealGrenade,
  WeaponType.ProxyGrenade, WeaponType.SatchelCharge, WeaponType.Concussion,
  WeaponType.Hook, WeaponType.EMP, WeaponType.BeltDisc,
]);

/** Nuggets charged per belt toss — heavy ordnance costs more than a
 *  nade. Server deducts this on the spawn claim; client gates on it. */
const BELT_THROW_COSTS = new Map<number, number>([
  [WeaponType.SatchelCharge, 2],
]);
export function beltThrowCost(weaponType: number): number {
  return BELT_THROW_COSTS.get(weaponType) ?? BELT_THROW_COST;
}

/** Hold-out sidearms — derived from the stats row's `sidearm` marker,
 *  same pattern as BELT_THROW_WEAPONS: one flag on the row replaces the
 *  menu list, the bot pool, and the def's sidearm opt. */
export const SIDEARM_WEAPONS = new Set<number>(
  Object.entries(WEAPONS).filter(([, w]): boolean => w.sidearm === true).map(([wt]): number => Number(wt)));
export function isSidearm(weaponType: number | undefined): boolean {
  return weaponType !== undefined && SIDEARM_WEAPONS.has(weaponType);
}

/** Ammo economy for non-belt shots (energyCost today — the pattern any
 *  future tank-paid weapon rides). ONE formula for all three gates:
 *  server intent (CombatHandler), bot fire (botArsenal), client
 *  prediction (fire.ts) — they passed different tank accessors but must
 *  never disagree on the bill or the dry check.
 *  Returns true and debits when the tank covers the cost; zero-cost
 *  weapons always pass. */
export function payShotCost(
  weaponType: number | undefined,
  id: string,
  energyOf: (playerId: string) => number | null,
  drainEnergy: (playerId: string, amount: number) => void,
): boolean {
  const cost = weaponType === undefined ? 0 : (WEAPONS[weaponType]?.energyCost ?? 0);
  if (cost <= 0) {return true;}
  if ((energyOf(id) ?? 0) < cost) {return false;}
  drainEnergy(id, cost);
  return true;
}

/** Biggest legal single damage claim vs a creature: table max
 *  (direct+splash) with perk headroom. creatureHit/crawlerHit claims
 *  carry no weapon ref, so this is the widest honest ceiling — anything
 *  above it is doctored. */
export const MAX_HIT_CLAIM_DMG = Math.ceil(
  Math.max(...Object.entries(WEAPONS).map(([wt, w]): number =>
    w.directDamage * (AIRTIME_SCALED.has(Number(wt)) ? AIRTIME_DMG_CAP : 1) + w.aoeDamage)) * 1.4);

export function getWeaponStats(weaponType: number | undefined): WeaponStats {
  return WEAPONS[weaponType ?? WeaponType.BoltLauncher] ?? WEAPONS[WeaponType.BoltLauncher]!;
}

/** Legal fire cadence per primary/sidearm (s between shots) — the same
 *  numbers the client trigger enforces. Server bots gate on this so a
 *  drawn weapon can't out-cadence a human with the same gun (a mortar
 *  brain at 0.45s cadence would otherwise out-shoot a player's 2.0s). */
// Belt throws: THROW_TOTAL (0.7 release + 0.3 raise) gates the human
// toss — 1.0s mirrors it so a bot that somehow draws a belt weapon in a
// combat slot obeys the same ceremony instead of defaulting to 0.1s.
// Auto-generated from WEAPONS where fireInterval is set; fallback for legacy.
const _autoFireIntervals: Record<number, number> = {};
for (const [wt, w] of Object.entries(WEAPONS)) {
  if (w.fireInterval !== undefined) { _autoFireIntervals[Number(wt)] = w.fireInterval; }
}
export const WEAPON_FIRE_INTERVAL_S: Partial<Record<WeaponType, number>> = {
  [WeaponType.BoltLauncher]: 1,
  [WeaponType.Disc]: 1,
  [WeaponType.Chaingun]: 0.09,
  [WeaponType.Mortar]: 2,
  [WeaponType.GrenadeLauncher]: 0.5,
  [WeaponType.Flak]: 1.2,
  [WeaponType.PlasmaCannon]: 0.28,
  [WeaponType.Railgun]: 1.5,
  [WeaponType.Lightning]: 0.05,
  [WeaponType.Shotgun]: 0.7,
  [WeaponType.Cannon]: 1.1,
  [WeaponType.Gonne]: 1, // lightest gun, fastest refire of the arc family
  [WeaponType.Basilisk]: 1.2, // heaviest bore, slowest refire
  [WeaponType.RocketLauncher]: 2.5, // A/B'd 2.0: more volume but same kills — dodge-window is the constraint, not cadence
  [WeaponType.Pistol]: 0.22,
  [WeaponType.Revolver]: 0.6,
  [WeaponType.Sticky]: 0.6,
  [WeaponType.PlasmaGun]: 0.1,
  [WeaponType.Sprinkler]: 0.1,
  [WeaponType.HealBeam]: 0.1, // heal ticks like the repair beam — cadence IS the heal rate
  [WeaponType.Melee]: 0.5,
  [WeaponType.Shocklance]: LANCE_CADENCE_S, // one zap per pull-out cycle — the cycle IS the cadence
  [WeaponType.MRVLauncher]: 2.4, // slower than the mortar — one trigger = a whole volley
  [WeaponType.Bombard]: 1.6, // slower than the cannon — 160dmg can't ride a 0.55s cadence
  // Belt throws: THROW_TOTAL (0.7 release + 0.3 raise) gates the human
  // toss — 1.0s mirrors it so a bot that somehow draws a belt weapon in a
  // combat slot obeys the same ceremony instead of defaulting to 0.1s.
  [WeaponType.Grenade]: 1, [WeaponType.Implodisc]: 1, [WeaponType.ClusterBomb]: 1,
  [WeaponType.Javelin]: 1, [WeaponType.ImpactGrenade]: 1, [WeaponType.RemoteRailgun]: 1,
  [WeaponType.ArmorGrenade]: 1, [WeaponType.HealGrenade]: 1, [WeaponType.ProxyGrenade]: 1,
  [WeaponType.Concussion]: 1, [WeaponType.BeltSticky]: 1, [WeaponType.Hook]: 1, [WeaponType.BeltDisc]: 1,
  [WeaponType.SatchelCharge]: 1.9, // deliberate two-beat plant (BELT_THROW_TIME.satchel)
  [WeaponType.EMP]: 1, // belt throw: EMP grenade — 2s fuse, timer detonation
  ..._autoFireIntervals,
};

/** Belt-sticky ride: which shells may HOST a caught bomb. Only deliberate
 *  heavy shots qualify — a chaingun tick or shotgun pellet vacuuming the
 *  sticky reads as a bug, not a skill shot. Gate = slow cadence AND a
 *  real direct-hit payload; belt throws (no cadence entry) can't host. */
export const RIDE_HOST_MIN_INTERVAL_S = 0.7;
export const RIDE_HOST_MIN_DIRECT = 45;
export function canHostRide(weaponType: number, stats: { directDamage: number }): boolean {
  // MRV exemption: the carrier's small pop is delivery, not the payload —
  // it airbursts mid-flight anyway, so a hitchhiker adds spectacle, not
  // a damage exploit the gate exists to prevent.
  if (weaponType === WeaponType.MRVLauncher) {return true;}
  return (WEAPON_FIRE_INTERVAL_S[weaponType as WeaponType] ?? 0) >= RIDE_HOST_MIN_INTERVAL_S
    && stats.directDamage >= RIDE_HOST_MIN_DIRECT;
}
