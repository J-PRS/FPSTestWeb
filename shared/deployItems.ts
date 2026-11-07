// Belt-item registry — the ONE place a deployable's facts live. Before this
// table existed, adding a pack item meant editing kind lists, cap/hp/ttl
// tables, and label lists across shared/, server, and client separately;
// they drifted (drone cap 1 vs 2). Stats here are authoritative for BOTH
// sides: server reads cap/hp/ttlS/cost for the plant validator, client reads
// cap/label for the loadout menu and HUD. Per-kind behavior (throw visual,
// plant entity class, SFX) still lives with the entity — visuals can't be
// shared (three.js isn't importable here).
import { WeaponType } from './weaponTable.ts';
import { WEAPONS } from './weaponRows.ts';

export type DeployKind = 'turret' | 'mortar' | 'cgturret' | 'mine' | 'station' | 'drone' | 'shield' | 'nugget' | 'beacon' | 'watersphere' | 'tether' | 'pad' | 'loiter' | 'spider' | 'jammer' | 'motion'
  // Authored-only base assets — cap 0 means a player can never plant one;
  // they exist only via the map spec `deploys` block.
  | 'generator' | 'sensor' | 'baseturret';

export interface DeployItemDef {
  /** Menu + HUD name (title case; HUD uppercases where it wants caps). */
  label: string;
  /** Per-player live cap — server's plant check and the HUD counter both read this. */
  cap: number;
  /** Planted hp — server owns it; client mirrors it until the first hp tick. */
  hp: number;
  /** Server-side lifetime seconds; 0 = instantaneous (nugget mints a pickup).
   *  Client visuals read the SAME field for their self-destruct — a mine
   *  that fades early here would keep exploding invisibly on the server. */
  ttlS: number;
  /** Belt charges spent per plant. */
  cost: number;
  // Combat envelope — the behavior half both sims must agree on. These
  // used to live as private per-side constants ("mirrors client"); a
  // turret/drone range or mine fuse drifting shows up as ghost hits or
  // silent stands, so the numbers live here exactly once.
  /** Acquire/heal envelope radius (turret, drone, station). */
  range?: number;
  /** Seconds between shots / heal pulses (turret, drone, station). */
  fireInterval?: number;
  /** Per-shot damage (turret, drone). */
  damage?: number;
  /** Contact body radius — a blast centered inside this counts as a
   *  DIRECT hit (pays directDamage), outside pays the aoe splash line.
   *  Bigger assets are easier to glue a bomb onto. Also the collider's
   *  horizontal half-extent. */
  bodyR: number;
  /** Collider height — the solid box runs pos.y .. pos.y+bodyH. */
  bodyH: number;
  /** Arm/unfold delay before the item acts (turret, mine, station). */
  armS?: number;
  /** Proximity fuse radius (mine). */
  triggerDist?: number;
  /** Blast falloff radius (mine). */
  blastRadius?: number;
  /** Blast damage at zero distance (mine). */
  blastDamage?: number;
  /** Blast knockback speed (mine). */
  knockback?: number;
  /** Hover height above the owner (drone). */
  hoverUp?: number;
  /** Loiter patrol ring — radius (m) and angular rate (rad/s) the
   *  munition circles the plant anchor while it watches. */
  orbitR?: number;
  orbitRate?: number;
  /** Dome radius (shield). */
  shieldRadius?: number;
  /** Water-dome radius (watersphere) — the pocket of water's footprint on
   *  the ground. The dome's TOP is a hemisphere over this radius, so the
   *  water is deepest at the centre. */
  waterRadius?: number;
  /** Tether snare radius (tether) — enemies crossing it on the way OUT
   *  get their outward speed bled by the speed curve in movement.ts. */
  tetherRadius?: number;
  /** Jet energy an enemy loses on breaking free of a tether, at full hold. */
  tetherZap?: number;
  /** Heal fraction of maxHealth per second (station). */
  healRate?: number;
  /** Bolt speed m/s (baseturret — real leadable projectile, not hitscan). */
  projSpeed?: number;
  /** Dead-zone radius (mortar — it lobs, so point-blank is unreachable). */
  minRange?: number;
  /** Launch speed m/s along the surface normal (pad). */
  launchSpeed?: number;
}

export const DEPLOY_ITEMS: Record<DeployKind, DeployItemDef> = {
  turret:  { label: 'Turret - Missile',  cap: 2, hp: 60,  ttlS: 180, cost: 5, range: 42, fireInterval: 1.25, damage: 14, armS: 0.45, bodyR: 0.9, bodyH: 1.7 },
  // Mortar turret — lobs REAL mortar shells (weapon row 4): arming fuse,
  // thud-bounce, the same 18m splash. Dead zone below minRange by design:
  // artillery can't depress to knife range. Shell damage/radius/knockback
  // come straight from WEAPONS[Mortar] so the two can never drift.
  mortar:  { label: 'Turret - Mortar', cap: 1, hp: 90,  ttlS: 240, cost: 5, range: 95, minRange: 20, fireInterval: 4, armS: 1.2, projSpeed: WEAPONS[WeaponType.Mortar]!.speed, damage: WEAPONS[WeaponType.Mortar]!.aoeDamage, blastRadius: WEAPONS[WeaponType.Mortar]!.aoeRadius, knockback: WEAPONS[WeaponType.Mortar]!.knockbackForce, bodyR: 1.1, bodyH: 1.5 },
  // Chaingun turret — suppression emplacement: sprays real CG bolts
  // (weapon row 3) at high cadence over a shorter, LOS-gated envelope.
  // Server pays damage as coarse pulses on the turretShot wire (~3 bolts
  // per pulse); the client paints/fires real 250 m/s bolts either way.
  cgturret: { label: 'Turret - Chaingun', cap: 2, hp: 50,  ttlS: 150, cost: 5, range: 36, fireInterval: 0.6, damage: WEAPONS[WeaponType.Chaingun]!.directDamage * 3, armS: 0.8, bodyR: 0.8, bodyH: 1.5 },
  mine:    { label: 'Mine',    cap: 6, hp: 20,  ttlS: 120, cost: 2, armS: 1, triggerDist: 3.2, blastRadius: 6, blastDamage: 22, knockback: 12, bodyR: 0.5, bodyH: 0.35 },
  station: { label: 'Healing Pad', cap: 1, hp: 80,  ttlS: 240, cost: 2, range: 9, fireInterval: 0.5, healRate: 0.09, bodyR: 1.4, bodyH: 1.1 },
  drone:   { label: 'Drone',   cap: 2, hp: 40,  ttlS: 90,  cost: 2, range: 35, fireInterval: 1.6, damage: 9, hoverUp: 2.5, bodyR: 0.7, bodyH: 0.6 },
  // Barrier: the dome is an energy FIELD — it stops shells, not bodies.
  // The bodyR/bodyH here is just the emitter post it unfolds from.
  shield:  { label: 'Barrier', cap: 1, hp: 120, ttlS: 120, cost: 2, shieldRadius: 6, bodyR: 0.7, bodyH: 1 },
  nugget:  { label: 'Nugget',  cap: 8, hp: 1,   ttlS: 0,   cost: 2, bodyR: 0.4, bodyH: 0.4 },
  // Water sphere: a pocket of sea dropped on the ground. It slows every
  // ENEMY wading through it (the sea's drag law + a speed cap) while the
  // planter and their team walk through dry. It has no damage — it is a
  // control tool, not a bomb. Short ttl: it is a roadblock, not a base.
  watersphere: { label: 'Water Sphere', cap: 2, hp: 30, ttlS: 45, cost: 2, armS: 0.6, waterRadius: 7, bodyR: 0.6, bodyH: 0.9 },
  beacon:  { label: 'Targeting Beacon', cap: 1, hp: 10,  ttlS: 300, cost: 2, bodyR: 0.6, bodyH: 2.4 },
  // Tether: a snare of black tendrils on the ground. Enemies walk into it
  // freely; on the way OUT their outward speed is bled by the speed curve
  // (a full stop below 20 m/s, nothing above 80), and breaking free zaps
  // their jet energy in proportion to how hard it held them.
  tether:  { label: 'Tether', cap: 2, hp: 30, ttlS: 150, cost: 2, tetherRadius: 6, tetherZap: 24, bodyR: 0.6, bodyH: 0.5 },
  // Jump pad: a throw-down launch plate. Lands, ~1s to arm, then ANY
  // body stepping in the ring rides the surface normal out - friendly
  // route boost or an enemy's free trip to orbit, no allegiance check.
  pad:     { label: 'Jump Pad', cap: 2, hp: 30, ttlS: 150, cost: 3, armS: 1, triggerDist: 2.6, launchSpeed: 30, bodyR: 0.9, bodyH: 0.3 },
  // Loiter munition: pops to a hover above the plant spot, circles until
  // a hostile enters the dive ring (LOS-gated like a sentry), then dives
  // and detonates where the dive ends. A mine waits - this CHASES; the
  // counter is that it's 10hp and audible while it loiters. One-shot:
  // the dive consumes the item. launchSpeed = dive speed, hoverUp =
  // loiter altitude, triggerDist = dive commit ring.
  loiter:  { label: 'Loiter Munition', cap: 2, hp: 10, ttlS: 90, cost: 3, armS: 1, triggerDist: 22, launchSpeed: 42, hoverUp: 8, orbitR: 9, orbitRate: 0.55, blastDamage: 65, blastRadius: 8, knockback: 14, bodyR: 0.9, bodyH: 1.2 },
  // Spider mine: the ground-bound sibling - a fast scuttler that chases
  // GROUNDED hostiles inside its ring and detonates in reach. Air is the
  // hard counter: a jetting or falling body never trips it (a hover is
  // genuinely safe over the skittering thing), and it dies cheap like
  // the loiter. launchSpeed = crawl speed.
  spider:  { label: 'Spider Mine', cap: 3, hp: 10, ttlS: 60, cost: 2, armS: 0.8, triggerDist: 24, launchSpeed: 14, blastDamage: 50, blastRadius: 7, knockback: 14, bodyR: 0.6, bodyH: 0.5 },
  // Jammer: an emitter bubble hiding its side from PULSE detection -
  // the base mast's sweep skips protected players inside the radius.
  // Personal-LOS sightings and motion sensors still read you: jammers
  // beat pulses, never eyeballs. range = bubble radius.
  jammer:  { label: 'Jammer', cap: 2, hp: 30, ttlS: 90, cost: 3, range: 18, armS: 1, bodyR: 0.8, bodyH: 1.4 },
  // Motion sensor: the deployable pack item - detects MOVING hostiles
  // in its ring with no LOS needed and THROUGH cloak (it reads
  // movement, not light). A body standing still drops off the net.
  // Feeds the same team intel feed the mast does.
  motion:  { label: 'Motion Sensor', cap: 2, hp: 20, ttlS: 90, cost: 3, range: 45, fireInterval: 1.5, armS: 1, bodyR: 0.7, bodyH: 1.1 },
  // Base assets are fat targets — a generator is the raid's main prize,
  // so it soaks far more splash than a field plant. Authored ttl is
  // ignored: base gear runs on the respawn clock, not the decay clock.
  generator: { label: 'Generator', cap: 0, hp: 400, ttlS: 0, cost: 0, bodyR: 2.8, bodyH: 4.4 },
  sensor:    { label: 'Sensor',    cap: 0, hp: 120, ttlS: 0, cost: 0, range: 120, fireInterval: 2, bodyR: 1.2, bodyH: 9.8 },
  // Base turret — heavier than a field turret: longer reach, and its
  // shell is a real traveling bolt the victim can dodge (lead computed
  // at fire time, blast lands where the aim point was). NOT homing.
  baseturret: { label: 'Base Turret', cap: 0, hp: 160, ttlS: 0, cost: 0, range: 55, fireInterval: 1.5, damage: 40, blastRadius: 3, knockback: 6, projSpeed: 80, bodyR: 1.3, bodyH: 3 },
};

// Solid kinds — drone and nugget are excluded on purpose: the drone
// chases its owner (a static hull would punt the owner it shadows) and
// the nugget never becomes an item. Everything else you can't walk
// through; the barrier's dome stays walk-through by design above.
const NOSOLID = new Set<DeployKind>(['drone', 'nugget', 'watersphere', 'tether', 'pad', 'loiter', 'spider']);
export function deploySolid(kind: DeployKind): boolean { return !NOSOLID.has(kind); }
