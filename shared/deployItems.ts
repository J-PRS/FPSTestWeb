// Belt-item registry — the ONE place a deployable's facts live. Before this
// table existed, adding a pack item meant editing kind lists, cap/hp/ttl
// tables, and label lists across shared/, server, and client separately;
// they drifted (drone cap 1 vs 2). Stats here are authoritative for BOTH
// sides: server reads cap/hp/ttlS/cost for the plant validator, client reads
// cap/label for the loadout menu and HUD. Per-kind behavior (throw visual,
// plant entity class, SFX) still lives with the entity — visuals can't be
// shared (three.js isn't importable here).
export type DeployKind = 'turret' | 'mine' | 'station' | 'drone' | 'shield' | 'nugget' | 'beacon';

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
}

export const DEPLOY_ITEMS: Record<DeployKind, DeployItemDef> = {
  turret:  { label: 'Sentry',  cap: 2, hp: 60,  ttlS: 180, cost: 2, range: 42, fireInterval: 1.25, damage: 14, armS: 0.45 },
  mine:    { label: 'Mine',    cap: 6, hp: 20,  ttlS: 120, cost: 2, armS: 1.0, triggerDist: 3.2, blastRadius: 6.0, blastDamage: 22, knockback: 12 },
  station: { label: 'Pad',     cap: 1, hp: 80,  ttlS: 240, cost: 2, range: 9, fireInterval: 0.5, healRate: 0.09 },
  drone:   { label: 'Drone',   cap: 2, hp: 40,  ttlS: 90,  cost: 2, range: 35, fireInterval: 1.6, damage: 9, hoverUp: 2.5 },
  shield:  { label: 'Barrier', cap: 1, hp: 120, ttlS: 120, cost: 2, shieldRadius: 6 },
  nugget:  { label: 'Nugget',  cap: 8, hp: 1,   ttlS: 0,   cost: 2 },
  beacon:  { label: 'Beacon',  cap: 1, hp: 10,  ttlS: 300, cost: 2 },
};
