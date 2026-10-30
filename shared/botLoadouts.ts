import { WeaponType, getWeaponStats, SIDEARM_WEAPONS } from './weapons.ts';
import { SELF_SPLASH_MAX } from './combat.ts';
import type { PerkId } from './perks.ts';
import { HEAVY_ONLY_WEAPONS, MEDIUM_ONLY_WEAPONS, LIGHT_ONLY_WEAPONS, classCanFire, type ArmorClass } from './botClasses.ts';

const beltOut = (w: WeaponType, fb: WeaponType): WeaponType =>
  w === WeaponType.HealBeam || w === WeaponType.Repair ? fb : w;


/** A bot's kit — weapon picked by engagement range, perk set at spawn so
 *  maxHealth and the move shadow's jet economy match a real loadout.
 *  Shared by the server roster and offline GameBots so both sides field
 *  the same arsenal. */
export interface BotLoadout { perk: PerkId; near: WeaponType; mid: WeaponType; far: WeaponType; belt: WeaponType; side: WeaponType }

// 15 read as knife-only: the force-matrix band table says 'near' guns
// (shotgun/flak peak at 10-25m, chaingun at 25-60) live well past it.
export const BOT_NEAR_M = 25, BOT_FAR_M = 40;
export const BOT_MELEE_M = 4.5;   // fist reach — brains press inside CLOSE_PRESS_M
// and two capsule bodies hover ~1-2m apart, so the honest closest gap in a
// chase sits ~4m; 3.0 never opened in soak ledgers (0 w10 rows).
export const BOT_SIDEARM_M = 8; // knife range: the hold-out draw is faster than tracking a long gun

/** Kit → armor tier. Ordnance decides first — a bot lugging a mortar or
 *  rocket rack IS a heavy regardless of perk; then armored anchors heavy
 *  and featherjets flies light. Everything else runs medium. Role
 *  weighting (CLASS_FITNESS) reads this — kit picks the body before the
 *  squad picks the job. */
export function botClassForLoadout(lo: BotLoadout): ArmorClass {
  const kit = [lo.near, lo.mid, lo.far, lo.belt, lo.side];
  // Light-frame guns (Railgun/Lightning) pick the body outright — a kit
  // built around them can't ride a heavier chassis.
  if (kit.some((w): boolean => LIGHT_ONLY_WEAPONS.has(w))) {return 'light';}
  // Any ordnance slot can carry the tier-lock — authored kits keep it in
  // far/belt, but the bombard lives in mid and a hidden heavy pick would
  // shoulder it on a medium body that can't legally fire it.
  if (kit.some((w): boolean => HEAVY_ONLY_WEAPONS.has(w))) {return 'heavy';}
  if (lo.perk === 'armored') {return 'heavy';}
  // featherjets wants light, but a kit carrying medium-locked ordnance
  // (Flak/PlasmaGun) can't shoulder it on a light frame — the class gate
  // outranks the perk's silhouette.
  if (lo.perk === 'featherjets') {
    return kit.some((w): boolean => MEDIUM_ONLY_WEAPONS.has(w)) ? 'medium' : 'light';
  }
  return 'medium';
}

export const BOT_LOADOUTS: BotLoadout[] = [
  { perk: 'featherjets', near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // chaser — light frame, so no medium-locked PlasmaGun
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // siege
  { perk: 'armored',      near: WeaponType.Chaingun, mid: WeaponType.PlasmaCannon, far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.Revolver }, // anchor — heavies can't shoulder medium-only Cannon either
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // skirmisher
  { perk: 'lifesteal',    near: WeaponType.Chaingun, mid: WeaponType.Sprinkler, far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // hose — area denial
  { perk: 'armored',      near: WeaponType.Shotgun,  mid: WeaponType.Bombard,   far: WeaponType.BoltLauncher,       belt: WeaponType.Javelin,       side: WeaponType.Revolver }, // bruiser — big slugs (Railgun is light-frame gear, Cannon medium)
  { perk: 'featherjets', near: WeaponType.Flak,     mid: WeaponType.GrenadeLauncher, far: WeaponType.BoltLauncher, belt: WeaponType.ImpactGrenade, side: WeaponType.Pistol }, // skirmisher — shove tools; Flak forces medium, so no heavy RL
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.PlasmaCannon, far: WeaponType.Mortar,     belt: WeaponType.ClusterBomb,   side: WeaponType.Pistol   }, // artillery
  { perk: 'overcharge',  near: WeaponType.Lightning, mid: WeaponType.Disc,     far: WeaponType.Railgun,       belt: WeaponType.Implodisc,      side: WeaponType.Pistol   }, // beam rider
  { perk: 'lifesteal',    near: WeaponType.Shotgun,  mid: WeaponType.Sticky,    far: WeaponType.RocketLauncher, belt: WeaponType.ClusterBomb,   side: WeaponType.Revolver }, // trapper
  { perk: 'lifesteal',    near: WeaponType.Shotgun,  mid: WeaponType.PlasmaGun, far: WeaponType.Disc,          belt: WeaponType.ArmorGrenade,  side: WeaponType.Pistol   }, // support — plates the push
  { perk: 'lifesteal',    near: WeaponType.HealBeam, mid: WeaponType.Disc,      far: WeaponType.Disc,          belt: WeaponType.HealGrenade,   side: WeaponType.Pistol   }, // medic — beam on the push, burst for the pack
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.BoltLauncher,        belt: WeaponType.HealGrenade,   side: WeaponType.Pistol   }, // field medic — fighter first, heals what it walks past
  { perk: 'lifesteal',    near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.HealBeam }, // pocket beam — fighter with a zap for hurt allies
];

export type LoadoutSlot = 'near' | 'mid' | 'far' | 'belt' | 'side';
const SLOTS: readonly LoadoutSlot[] = ['near', 'mid', 'far', 'belt', 'side'];

/** Per-slot alternates per BOT_LOADOUTS row (same order) — every slot
 *  carries candidates so the whole kit can drift; the picks run through
 *  the skill matrix (adaptLoadout), not flat luck. The base weapon
 *  stays in the candidate pool implicitly, and kitConsistent rejects
 *  anything the derived class can't shoulder. */
export const BOT_ALT_SLOTS: Partial<Record<LoadoutSlot, WeaponType[]>>[] = [
  { near: [WeaponType.Shotgun], mid: [WeaponType.Cannon, WeaponType.Gonne], far: [WeaponType.Railgun], belt: [WeaponType.ImpactGrenade], side: [WeaponType.Revolver] }, // chaser
  { near: [WeaponType.Shotgun], mid: [WeaponType.Cannon, WeaponType.Basilisk, WeaponType.GrenadeLauncher], far: [WeaponType.Mortar], belt: [WeaponType.ClusterBomb], side: [WeaponType.Revolver] }, // siege
  { near: [WeaponType.Shotgun], mid: [WeaponType.PlasmaCannon], far: [WeaponType.Mortar, WeaponType.RocketLauncher, WeaponType.MRVLauncher], belt: [WeaponType.ClusterBomb], side: [WeaponType.Pistol] }, // anchor
  { near: [WeaponType.Shotgun], mid: [WeaponType.PlasmaGun, WeaponType.Cannon, WeaponType.Gonne], far: [WeaponType.Disc], belt: [WeaponType.Implodisc, WeaponType.Javelin], side: [WeaponType.Revolver] }, // skirmisher
  { near: [WeaponType.Flak], mid: [WeaponType.PlasmaGun, WeaponType.GrenadeLauncher], far: [WeaponType.BoltLauncher], belt: [WeaponType.ImpactGrenade, WeaponType.ClusterBomb], side: [WeaponType.Revolver] }, // hose
  { near: [WeaponType.Chaingun], mid: [WeaponType.PlasmaCannon, WeaponType.Bombard, WeaponType.Basilisk], far: [WeaponType.Mortar, WeaponType.MRVLauncher], belt: [WeaponType.ClusterBomb, WeaponType.MRVLauncher], side: [WeaponType.Pistol] }, // bruiser
  { near: [WeaponType.Chaingun, WeaponType.Shotgun], mid: [WeaponType.PlasmaGun], far: [WeaponType.Disc], belt: [WeaponType.Grenade, WeaponType.ClusterBomb], side: [WeaponType.Revolver] }, // flak skirmisher
  { near: [WeaponType.Shotgun], mid: [WeaponType.Cannon, WeaponType.Bombard, WeaponType.Basilisk], far: [WeaponType.MRVLauncher, WeaponType.RocketLauncher, WeaponType.BoltLauncher], belt: [WeaponType.MRVLauncher, WeaponType.RemoteRailgun], side: [WeaponType.Revolver] }, // artillery
  { near: [WeaponType.Chaingun], mid: [WeaponType.Cannon, WeaponType.Gonne], far: [WeaponType.BoltLauncher], belt: [WeaponType.Javelin], side: [WeaponType.Revolver] }, // beam rider
  { near: [WeaponType.Chaingun], mid: [WeaponType.Cannon, WeaponType.Basilisk], far: [WeaponType.Mortar, WeaponType.MRVLauncher], belt: [WeaponType.Javelin, WeaponType.RemoteRailgun], side: [WeaponType.Pistol] }, // trapper
  { near: [WeaponType.Chaingun], mid: [WeaponType.GrenadeLauncher, WeaponType.Sprinkler], far: [WeaponType.BoltLauncher], belt: [WeaponType.Grenade, WeaponType.Javelin], side: [WeaponType.Revolver] }, // support
  { near: [WeaponType.Shotgun], mid: [WeaponType.PlasmaGun], far: [WeaponType.BoltLauncher], belt: [WeaponType.ArmorGrenade], side: [WeaponType.Revolver] }, // medic — near's HealBeam stays: a medic that never zaps still heals
  { near: [WeaponType.Shotgun, WeaponType.Flak], mid: [WeaponType.Disc], far: [WeaponType.Disc], belt: [WeaponType.ArmorGrenade], side: [WeaponType.Revolver] }, // field medic
  { near: [WeaponType.Shotgun, WeaponType.Flak], mid: [WeaponType.Cannon, WeaponType.GrenadeLauncher], far: [WeaponType.BoltLauncher], belt: [WeaponType.ClusterBomb, WeaponType.ArmorGrenade], side: [WeaponType.Pistol] }, // pocket beam — side's HealBeam stays
];

/** The wildcard pool — spawns that skip the authored table draw any
 *  class-legal weapon per slot (MRV only ever fields through this or
 *  an alternates slot above). Belt stays belt-throwable; HealBeam stays
 *  out of the combat draw — medics are authored kits, not luck. */
export const WILDCARD_SLOTS: Record<LoadoutSlot, WeaponType[]> = {
  // Heavy ordnance stays in far/belt — the class gate only reads those
  //  slots for tier-locks, so a mortar in `near` would be invisible to
  //  derivation (and the authored kits never put it there either).
  // Slot pools follow the measured range curves (teamSoak --force band
  // table, 2026-10): chaingun peaks at 25-60m, lightning dies past 60m,
  // rocket connects best at 25-60 — all mid-band guns, not near/far.
  near: [WeaponType.Shotgun, WeaponType.Flak],
  // Bombard lives in mid — a 160dmg... a direct-hit slug has no business
  // in the far band where only splash reach matters.
  mid: [WeaponType.Chaingun, WeaponType.Lightning, WeaponType.Disc, WeaponType.Cannon, WeaponType.Gonne, WeaponType.Basilisk, WeaponType.GrenadeLauncher, WeaponType.Sprinkler, WeaponType.Sticky, WeaponType.PlasmaGun, WeaponType.Bombard, WeaponType.RocketLauncher],
  far: [WeaponType.BoltLauncher, WeaponType.Disc, WeaponType.Mortar, WeaponType.Railgun, WeaponType.MRVLauncher],
  // Every player belt throw + every player sidearm — parity both ways:
  // a wildcard bot can field anything a player can legally equip.
  belt: [WeaponType.Grenade, WeaponType.RemoteRailgun, WeaponType.ImpactGrenade, WeaponType.ClusterBomb, WeaponType.Javelin, WeaponType.ArmorGrenade, WeaponType.Implodisc, WeaponType.MRVLauncher, WeaponType.Hook,
    WeaponType.BeltDisc, WeaponType.BeltSticky, WeaponType.ProxyGrenade, WeaponType.SatchelCharge, WeaponType.Concussion, WeaponType.EMP, WeaponType.HealGrenade],
  // Shocklance rides the speed-0 beam lane (fireSpeedless/botFire) — the
  // same honest-ray path Lightning already takes, no projectile needed.
  side: [...SIDEARM_WEAPONS],
};
const WILDCARD_PERKS: PerkId[] = ['lifesteal', 'overcharge', 'armored', 'bombardier', 'featherjets'];

/** Kit consistency gate: every slot must be fireable under the kit's
 *  own derived class — an MRV belt can land on a heavy kit, never on a
 *  beam-rider's light frame, and a reroll that drops the class (Mortar
 *  far out, ordnance mid still in) must not leave contraband behind. */
export function kitConsistent(lo: BotLoadout): boolean {
  const cls = botClassForLoadout(lo);
  return SLOTS.every((s): boolean => classCanFire(cls, lo[s]));
}

/** Spawn-time reroll: each slot with candidates draws uniformly from
 *  the base weapon plus its alternates — kit identity preserved, but
 *  squads stop being 14 identical silhouettes. A draw that would leave
 *  the kit inconsistent keeps the base weapon instead. */
export function rollLoadout(lo: BotLoadout, alts: Partial<Record<LoadoutSlot, WeaponType[]>> | undefined, rng: () => number): BotLoadout {
  if (!alts) {return lo;}
  const out = Object.assign({}, lo);
  for (const slot of SLOTS) {
    const cands = alts[slot];
    if (!cands?.length) {continue;}
    const pool = [lo[slot], ...cands];
    const w = pool[Math.floor(rng() * pool.length)] ?? lo[slot];
    if (w === lo[slot]) {continue;}
    out[slot] = w;
    if (!kitConsistent(out)) {out[slot] = lo[slot];}
  }
  return out;
}

/** A wildcard kit — every slot draws from the full combat pool; the
 *  class gate still derives the body from whatever it rolled. */
export function rollWildcard(rng: () => number): BotLoadout {
  // Class first, then only weapons that body can legally shoulder —
  // a light wildcard keeps light-locked guns, a heavy may draw MRV, and
  // no roll can mix tiers (Railgun + Mortar) no class would fire. Perk
  // is gated last: armored on a light-locked kit would derail the body.
  let cls: ArmorClass = 'heavy';
  if (rng() < 0.25) {cls = 'light';}
  else if (rng() < 0.67) {cls = 'medium';}
  const pick = (pool: WeaponType[], fb: WeaponType): WeaponType => {
    const legal = pool.filter((w): boolean => classCanFire(cls, w));
    return (legal.length > 0 ? legal : [fb])[Math.floor(rng() * (legal.length || 1))] ?? fb;
  };
  const kit = {
    near: pick(WILDCARD_SLOTS.near, WeaponType.Chaingun), mid: pick(WILDCARD_SLOTS.mid, WeaponType.Disc),
    far: pick(WILDCARD_SLOTS.far, WeaponType.BoltLauncher), belt: pick(WILDCARD_SLOTS.belt, WeaponType.Grenade),
    side: pick(WILDCARD_SLOTS.side, WeaponType.Pistol),
  };
  const perks = WILDCARD_PERKS.filter((p): boolean => kitConsistent(Object.assign({}, kit, {perk: p})));
  return Object.assign({}, kit, {perk: perks[Math.floor(rng() * perks.length)] ?? 'lifesteal'});
}

/** Respawn adaptation: for each slot the bot can reroll, keep whichever
 *  weapon its skill matrix scores highest — competence drifts the kit
 *  toward what this bot actually hits with. */
export function adaptLoadout(lo: BotLoadout, alts: Partial<Record<LoadoutSlot, WeaponType[]>> | undefined, skill: (w: number) => number, rng?: () => number): BotLoadout {
  if (!alts) {return lo;}
  const out = Object.assign({}, lo);
  const r = rng ?? ((): number => 0.5);
  for (const slot of SLOTS) {
    const cands = alts[slot];
    if (!cands?.length) {continue;}
    let best = lo[slot];
    let bs = skill(best);
    for (const w of cands) {
      // Aptitude first, seeded noise second — two bots with the same
      // matrix don't march in lockstep, but the pick still leans to
      // what this one actually hits with.
      const s = skill(w) * (0.7 + 0.6 * r());
      if (s > bs && kitConsistent(Object.assign({}, out, {[slot]: w}))) { bs = s; best = w; }
    }
    out[slot] = best;
  }
  return out;
}

/** Range-band weapon select — shared by player and creature targets so
 *  the visible tracer reads as the kit the bot would really draw.
 *  `skill` (from the bot's matrix) lets competence bias the draw: a
 *  chaingun phenom reaches for it even at the band's edge, while the
 *  utility of a splash weapon still wins at clearly right ranges —
 *  specialists use their best gun MOST of the time, not always. */
export function pickBotWeapon(lo: BotLoadout, distXZ: number, dist: number, skill?: (w: number) => number, courage = 0.5, nonAoeOnly = false): number {
  if (distXZ < BOT_MELEE_M) {return WeaponType.Melee;}
  // Heal slots never feed a combat draw — the med kit fires its beam at
  // ALLIES through the support path; picking it at an enemy is a dry pull.
  if (!skill) {
    let slotPick = lo.mid;
    if (dist < BOT_SIDEARM_M) {slotPick = lo.side;}
    else if (dist < BOT_NEAR_M) {slotPick = lo.near;}
    else if (dist > BOT_FAR_M) {slotPick = lo.far;}
    return beltOut(slotPick, lo.mid);
  }
  // Triangular band fit: a slot scores 1 dead-center of its range,
  // decaying to 0 one band away — then multiplied by how good the bot
  // is with that gun. Utility (right range) and skill (right weapon)
  // trade off instead of the band being a hard wall.
  const fit = (slot: 'side' | 'near' | 'mid' | 'far'): number => {
    switch (slot) {
      case 'side': { return Math.max(0, 1 - dist / (BOT_NEAR_M * 1.2));
      }
      case 'near': {
        // Plateau-then-fall, not a triangle: near guns don't decay going
        // closer (shotgun/flak/CG all convert point-blank per the band
        // table) — the falloff only exists toward mid.
        const c = BOT_NEAR_M * 0.7;
        return dist <= c ? 1 : Math.max(0, 1 - (dist - c) / 14);
      }
      case 'mid': { return Math.max(0, 1 - Math.abs(dist - (BOT_NEAR_M + BOT_FAR_M) / 2) / 25);
      }
      case 'far': { return dist < BOT_NEAR_M ? Math.max(0, dist / BOT_NEAR_M - 0.4) : Math.min(1, dist / BOT_FAR_M);
      }
          default: { const _exhaustive: never = slot; return _exhaustive; }
}
  };
  let best: { w: number; s: number } = { w: lo.mid, s: 0 };
  // First combat-usable non-explosive — the `nonAoeOnly` fallback when
  // every band score is 0, so the gate can't hand back a launcher it
  // was asked to holster.
  let safeW = lo.mid;
  for (const slot of ['side', 'near', 'mid', 'far'] as const) {
    const w = lo[slot];
    if (w !== WeaponType.HealBeam && w !== WeaponType.Repair && getWeaponStats(w).aoeRadius <= 0) { safeW = w; break; }
  }
  for (const slot of ['side', 'near', 'mid', 'far'] as const) {
    const w = lo[slot];
    if (w === WeaponType.HealBeam || w === WeaponType.Repair) {continue;} // healing is aimed at allies/deployables, not drawn for a fight
    // Self-splash pricing: an enemy already inside this weapon's blast
    // means the shell costs the shooter too — the cautious draw the
    // sidearm, the bold keep the launcher (a mutual splash is still a
    // play). Dist-scaled so the rule fades in as the foe closes.
    const aoe = getWeaponStats(w).aoeRadius;
    if (aoe > 0 && nonAoeOnly) {continue;}
    // Floor, not a rule: band fit decays to 0 one band out, which made a
    // bot NEVER draw its best gun off-band — chaingun was un-drawable at
    // 40m despite still converting there (force-matrix band data). 0.08
    // keeps off-band picks rare but possible; skill decides if it leaks.
    let s = Math.max(fit(slot), 0.08) * Math.max(0.1, skill(w));
    if (aoe > 0 && dist < aoe * 0.8) {s *= 0.08 + courage * 0.5;}
    if (s > best.s) {best = { w, s };}
  }
  return nonAoeOnly && getWeaponStats(best.w).aoeRadius > 0 ? safeW : best.w;
}

/** Weapon pick with self-preservation, shared by wire and offline bots.
 *  A blast inside its own radius can cost up to SELF_SPLASH_MAX health,
 *  and a stray shell popped early (terrain lip, wandering ball, body
 *  block) lands inside the blast edge regardless of target range — so
 *  below roughly one self-blast's price, ANY aoe primary is a loaded
 *  gun pointed at the holster and the bot redraws inside the non-
 *  explosive shelf by the same band fit. Nerve scales the floor:
 *  heroes fly launchers into the grave. The swap only matters where a
 *  blast can still reach back: a shell landing 60m+ away can't splash
 *  the shooter, so holstering at standoff just spams the sidearm at
 *  enemies it can't touch. */
export function pickBotWeaponSafe(lo: BotLoadout, distXZ: number, dist: number, hp: number, skill?: (w: number) => number, courage = 0.5): number {
  const wt = pickBotWeapon(lo, distXZ, dist, skill, courage);
  const wstats = getWeaponStats(wt);
  const woundedGate = wstats.aoeRadius > 0 && (
    (dist < wstats.aoeRadius && hp <= (1 - courage) * (SELF_SPLASH_MAX * 2 + 15)) ||
    (dist < 60 && hp <= SELF_SPLASH_MAX * (1.5 - courage)));
  if (!woundedGate) {return wt;}
  const alt = pickBotWeapon(lo, distXZ, dist, skill, courage, true);
  return alt === wt ? wt : alt;
}
