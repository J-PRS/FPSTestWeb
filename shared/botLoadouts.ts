import { WeaponType, getWeaponStats } from './weapons.ts';
import { SELF_SPLASH_MAX } from './combat.ts';
import type { PerkId } from './perks.ts';
import { HEAVY_ONLY_WEAPONS, MEDIUM_ONLY_WEAPONS, LIGHT_ONLY_WEAPONS, classCanFire, type ArmorClass } from './botClasses.ts';

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

/** Kit → armor tier. Ordnance decides first — a bot lugging a mortar or
 *  rocket rack IS a heavy regardless of perk; then plated anchors heavy
 *  and featherjets flies light. Everything else runs medium. Role
 *  weighting (CLASS_FITNESS) reads this — kit picks the body before the
 *  squad picks the job. */
export function botClassForLoadout(lo: BotLoadout): ArmorClass {
  const kit = [lo.near, lo.mid, lo.far, lo.belt, lo.side];
  // Light-frame guns (Railgun/Lightning) pick the body outright — a kit
  // built around them can't ride a heavier chassis.
  if (kit.some((w) => LIGHT_ONLY_WEAPONS.has(w))) return 'light';
  if (HEAVY_ONLY_WEAPONS.has(lo.far) || HEAVY_ONLY_WEAPONS.has(lo.belt)) return 'heavy';
  if (lo.perk === 'plated') return 'heavy';
  // featherjets wants light, but a kit carrying medium-locked ordnance
  // (Flak/PlasmaGun) can't shoulder it on a light frame — the class gate
  // outranks the perk's silhouette.
  if (lo.perk === 'featherjets') {
    return kit.some((w) => MEDIUM_ONLY_WEAPONS.has(w)) ? 'medium' : 'light';
  }
  return 'medium';
}

export const BOT_LOADOUTS: BotLoadout[] = [
  { perk: 'featherjets', near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // chaser — light frame, so no medium-locked PlasmaGun
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // siege
  { perk: 'plated',      near: WeaponType.Chaingun, mid: WeaponType.Cannon,    far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.Revolver }, // anchor — heavies can't shoulder medium-only PlasmaGun
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.BoltLauncher,        belt: WeaponType.RemoteRailgun, side: WeaponType.Pistol   }, // skirmisher
  { perk: 'vitality',    near: WeaponType.Chaingun, mid: WeaponType.Sprinkler, far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.Pistol   }, // hose — area denial
  { perk: 'plated',      near: WeaponType.Shotgun,  mid: WeaponType.Cannon,    far: WeaponType.BoltLauncher,       belt: WeaponType.Javelin,       side: WeaponType.Revolver }, // bruiser — big slugs (Railgun is light-frame gear now)
  { perk: 'featherjets', near: WeaponType.Flak,     mid: WeaponType.GrenadeLauncher, far: WeaponType.BoltLauncher, belt: WeaponType.ImpactGrenade, side: WeaponType.Pistol }, // skirmisher — shove tools; Flak forces medium, so no heavy RL
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.PlasmaCannon, far: WeaponType.Mortar,     belt: WeaponType.ClusterBomb,   side: WeaponType.Pistol   }, // artillery
  { perk: 'overcharge',  near: WeaponType.Lightning, mid: WeaponType.Disc,     far: WeaponType.Railgun,       belt: WeaponType.DiscPull,      side: WeaponType.Pistol   }, // beam rider
  { perk: 'vitality',    near: WeaponType.Shotgun,  mid: WeaponType.Sticky,    far: WeaponType.RocketLauncher, belt: WeaponType.ClusterBomb,   side: WeaponType.Revolver }, // trapper
  { perk: 'vitality',    near: WeaponType.Shotgun,  mid: WeaponType.PlasmaGun, far: WeaponType.Disc,          belt: WeaponType.ArmorGrenade,  side: WeaponType.Pistol   }, // support — plates the push
  { perk: 'vitality',    near: WeaponType.HealBeam, mid: WeaponType.Disc,      far: WeaponType.Disc,          belt: WeaponType.HealGrenade,   side: WeaponType.Pistol   }, // medic — beam on the push, burst for the pack
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.BoltLauncher,        belt: WeaponType.HealGrenade,   side: WeaponType.Pistol   }, // field medic — fighter first, heals what it walks past
  { perk: 'vitality',    near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.Disc,          belt: WeaponType.Grenade,       side: WeaponType.HealBeam }, // pocket beam — fighter with a zap for hurt allies
];

export type LoadoutSlot = 'near' | 'mid' | 'far' | 'belt' | 'side';
const SLOTS: readonly LoadoutSlot[] = ['near', 'mid', 'far', 'belt', 'side'];

/** Per-slot alternates per BOT_LOADOUTS row (same order) — a kit keeps
 *  its identity, but each listed slot may reroll to a sibling at spawn
 *  and drift toward the bot's best weapon on respawn. The base weapon
 *  stays in the candidate pool implicitly. */
export const BOT_ALT_SLOTS: Partial<Record<LoadoutSlot, WeaponType[]>>[] = [
  { near: [WeaponType.Shotgun], belt: [WeaponType.ImpactGrenade] },                        // chaser
  { far: [WeaponType.Mortar, WeaponType.RocketLauncher], belt: [WeaponType.ClusterBomb] }, // siege
  { far: [WeaponType.BoltLauncher], near: [WeaponType.Shotgun] },                          // anchor
  { belt: [WeaponType.DiscPull, WeaponType.Javelin] },                                     // skirmisher
  { near: [WeaponType.Flak] },                                                           // hose
  { belt: [WeaponType.ClusterBomb, WeaponType.MRVLauncher], mid: [WeaponType.PlasmaCannon] }, // bruiser
  { near: [WeaponType.Shotgun, WeaponType.Chaingun], belt: [WeaponType.Grenade] },         // flak skirmisher
  { far: [WeaponType.RocketLauncher, WeaponType.BoltLauncher], belt: [WeaponType.MRVLauncher] }, // artillery
  { mid: [WeaponType.PlasmaGun], belt: [WeaponType.Javelin] },                             // beam rider
  { mid: [WeaponType.PlasmaGun, WeaponType.GrenadeLauncher], belt: [WeaponType.MRVLauncher] }, // trapper
  { near: [WeaponType.Chaingun], belt: [WeaponType.Grenade] },                             // support
  { near: [WeaponType.Chaingun], mid: [WeaponType.Sprinkler] },                            // medic
  { near: [WeaponType.Shotgun], belt: [WeaponType.ClusterBomb] },                          // field medic
  { near: [WeaponType.Shotgun], belt: [WeaponType.ArmorGrenade] },                         // pocket beam
];

/** The wildcard pool — spawns that skip the authored table draw any
 *  class-legal weapon per slot (MRV only ever fields through this or
 *  an alternates slot above). Belt stays belt-throwable; HealBeam stays
 *  out of the combat draw — medics are authored kits, not luck. */
export const WILDCARD_SLOTS: Record<LoadoutSlot, WeaponType[]> = {
  // Heavy ordnance stays in far/belt — the class gate only reads those
  //  slots for tier-locks, so a mortar in `near` would be invisible to
  //  derivation (and the authored kits never put it there either).
  near: [WeaponType.Chaingun, WeaponType.Shotgun, WeaponType.Flak, WeaponType.Lightning],
  mid: [WeaponType.Disc, WeaponType.Cannon, WeaponType.GrenadeLauncher, WeaponType.Sprinkler, WeaponType.Sticky, WeaponType.PlasmaGun],
  far: [WeaponType.BoltLauncher, WeaponType.Disc, WeaponType.Mortar, WeaponType.Railgun, WeaponType.RocketLauncher, WeaponType.MRVLauncher],
  belt: [WeaponType.Grenade, WeaponType.RemoteRailgun, WeaponType.ImpactGrenade, WeaponType.ClusterBomb, WeaponType.Javelin, WeaponType.ArmorGrenade, WeaponType.DiscPull, WeaponType.MRVLauncher],
  side: [WeaponType.Pistol, WeaponType.Revolver],
};
const WILDCARD_PERKS: PerkId[] = ['vitality', 'overcharge', 'plated', 'bombardier', 'featherjets'];

/** Kit consistency gate: every slot must be fireable under the kit's
 *  own derived class — an MRV belt can land on a heavy kit, never on a
 *  beam-rider's light frame, and a reroll that drops the class (Mortar
 *  far out, ordnance mid still in) must not leave contraband behind. */
export function kitConsistent(lo: BotLoadout): boolean {
  const cls = botClassForLoadout(lo);
  return SLOTS.every((s) => classCanFire(cls, lo[s]));
}

/** Spawn-time reroll: each slot with candidates draws uniformly from
 *  the base weapon plus its alternates — kit identity preserved, but
 *  squads stop being 14 identical silhouettes. A draw that would leave
 *  the kit inconsistent keeps the base weapon instead. */
export function rollLoadout(lo: BotLoadout, alts: Partial<Record<LoadoutSlot, WeaponType[]>> | undefined, rng: () => number): BotLoadout {
  if (!alts) return lo;
  const out = { ...lo };
  for (const slot of SLOTS) {
    const cands = alts[slot];
    if (!cands?.length) continue;
    const pool = [lo[slot], ...cands];
    const w = pool[Math.floor(rng() * pool.length)] ?? lo[slot];
    if (w === lo[slot]) continue;
    out[slot] = w;
    if (!kitConsistent(out)) out[slot] = lo[slot];
  }
  return out;
}

/** A wildcard kit — every slot draws from the full combat pool; the
 *  class gate still derives the body from whatever it rolled. */
export function rollWildcard(rng: () => number): BotLoadout {
  // Class first, then only weapons that body can legally shoulder —
  // a light wildcard keeps light-locked guns, a heavy may draw MRV, and
  // no roll can mix tiers (Railgun + Mortar) no class would fire. Perk
  // is gated last: plated on a light-locked kit would derail the body.
  const cls: ArmorClass = rng() < 0.25 ? 'light' : rng() < 0.67 ? 'medium' : 'heavy';
  const pick = (pool: WeaponType[], fb: WeaponType) => {
    const legal = pool.filter((w) => classCanFire(cls, w));
    return (legal.length ? legal : [fb])[Math.floor(rng() * (legal.length || 1))] ?? fb;
  };
  const kit = {
    near: pick(WILDCARD_SLOTS.near, WeaponType.Chaingun), mid: pick(WILDCARD_SLOTS.mid, WeaponType.Disc),
    far: pick(WILDCARD_SLOTS.far, WeaponType.BoltLauncher), belt: pick(WILDCARD_SLOTS.belt, WeaponType.Grenade),
    side: pick(WILDCARD_SLOTS.side, WeaponType.Pistol),
  };
  const perks = WILDCARD_PERKS.filter((p) => kitConsistent({ ...kit, perk: p }));
  return { ...kit, perk: perks[Math.floor(rng() * perks.length)] ?? 'vitality' };
}

/** Respawn adaptation: for each slot the bot can reroll, keep whichever
 *  weapon its skill matrix scores highest — competence drifts the kit
 *  toward what this bot actually hits with. */
export function adaptLoadout(lo: BotLoadout, alts: Partial<Record<LoadoutSlot, WeaponType[]>> | undefined, skill: (w: number) => number): BotLoadout {
  if (!alts) return lo;
  const out = { ...lo };
  for (const slot of SLOTS) {
    const cands = alts[slot];
    if (!cands?.length) continue;
    let best = lo[slot];
    let bs = skill(best);
    for (const w of cands) {
      const s = skill(w);
      if (s > bs && kitConsistent({ ...out, [slot]: w })) { bs = s; best = w; }
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
  if (distXZ < BOT_MELEE_M) return WeaponType.Melee;
  // Heal slots never feed a combat draw — the med kit fires its beam at
  // ALLIES through the support path; picking it at an enemy is a dry pull.
  const beltOut = (w: WeaponType, fb: WeaponType) => w === WeaponType.HealBeam ? fb : w;
  if (!skill) return beltOut(dist < BOT_SIDEARM_M ? lo.side : dist < BOT_NEAR_M ? lo.near : dist > BOT_FAR_M ? lo.far : lo.mid, lo.mid);
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
  // First combat-usable non-explosive — the `nonAoeOnly` fallback when
  // every band score is 0, so the gate can't hand back a launcher it
  // was asked to holster.
  let safeW = lo.mid;
  for (const slot of ['side', 'near', 'mid', 'far'] as const) {
    const w = lo[slot];
    if (w !== WeaponType.HealBeam && getWeaponStats(w).aoeRadius <= 0) { safeW = w; break; }
  }
  for (const slot of ['side', 'near', 'mid', 'far'] as const) {
    const w = lo[slot];
    if (w === WeaponType.HealBeam) continue; // healing is aimed at allies, not drawn for a fight
    // Self-splash pricing: an enemy already inside this weapon's blast
    // means the shell costs the shooter too — the cautious draw the
    // sidearm, the bold keep the launcher (a mutual splash is still a
    // play). Dist-scaled so the rule fades in as the foe closes.
    const aoe = getWeaponStats(w).aoeRadius;
    if (aoe > 0 && nonAoeOnly) continue;
    let s = fit(slot) * Math.max(0.1, skill(w));
    if (aoe > 0 && dist < aoe * 0.8) s *= 0.08 + courage * 0.5;
    if (s > best.s) best = { w, s };
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
  if (!woundedGate) return wt;
  const alt = pickBotWeapon(lo, distXZ, dist, skill, courage, true);
  return alt !== wt ? alt : wt;
}
