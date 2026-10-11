// Belt-item registry — the ONE place a deployable's facts live. Before this
// table existed, adding a pack item meant editing kind lists, cap/hp/ttl
// tables, and label lists across shared/, server, and client separately;
// they drifted (drone cap 1 vs 2). Stats here are authoritative for BOTH
// sides: server reads cap/hp/ttlS/cost for the plant validator, client reads
// cap/label for the loadout menu and HUD. Per-kind behavior (throw visual,
// plant entity class, SFX) still lives with the entity — visuals can't be
// shared (three.js isn't importable here).
export type DeployKind = 'turret' | 'mine' | 'station' | 'drone' | 'shield' | 'nugget' | 'beacon'
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
  /** Dome radius (shield). */
  shieldRadius?: number;
  /** Heal fraction of maxHealth per second (station). */
  healRate?: number;
  /** Bolt speed m/s (baseturret — real leadable projectile, not hitscan). */
  projSpeed?: number;
}

export const DEPLOY_ITEMS: Record<DeployKind, DeployItemDef> = {
  turret:  { label: 'Sentry',  cap: 2, hp: 60,  ttlS: 180, cost: 2, range: 42, fireInterval: 1.25, damage: 14, armS: 0.45, bodyR: 0.9, bodyH: 1.7 },
  mine:    { label: 'Mine',    cap: 6, hp: 20,  ttlS: 120, cost: 2, armS: 1, triggerDist: 3.2, blastRadius: 6, blastDamage: 22, knockback: 12, bodyR: 0.5, bodyH: 0.35 },
  station: { label: 'Pad',     cap: 1, hp: 80,  ttlS: 240, cost: 2, range: 9, fireInterval: 0.5, healRate: 0.09, bodyR: 1.4, bodyH: 1.1 },
  drone:   { label: 'Drone',   cap: 2, hp: 40,  ttlS: 90,  cost: 2, range: 35, fireInterval: 1.6, damage: 9, hoverUp: 2.5, bodyR: 0.7, bodyH: 0.6 },
  // Barrier: the dome is an energy FIELD — it stops shells, not bodies.
  // The bodyR/bodyH here is just the emitter post it unfolds from.
  shield:  { label: 'Barrier', cap: 1, hp: 120, ttlS: 120, cost: 2, shieldRadius: 6, bodyR: 0.7, bodyH: 1 },
  nugget:  { label: 'Nugget',  cap: 8, hp: 1,   ttlS: 0,   cost: 2, bodyR: 0.4, bodyH: 0.4 },
  beacon:  { label: 'Beacon',  cap: 1, hp: 10,  ttlS: 300, cost: 2, bodyR: 0.6, bodyH: 2.4 },
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
const NOSOLID = new Set<DeployKind>(['drone', 'nugget']);
export function deploySolid(kind: DeployKind): boolean { return !NOSOLID.has(kind); }
