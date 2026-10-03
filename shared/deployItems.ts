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
  /** Server-side lifetime seconds; 0 = instantaneous (nugget mints a pickup). */
  ttlS: number;
  /** Belt charges spent per plant. */
  cost: number;
}

export const DEPLOY_ITEMS: Record<DeployKind, DeployItemDef> = {
  turret:  { label: 'Sentry',  cap: 2, hp: 60,  ttlS: 180, cost: 2 },
  mine:    { label: 'Mine',    cap: 6, hp: 20,  ttlS: 120, cost: 2 },
  station: { label: 'Pad',     cap: 1, hp: 80,  ttlS: 240, cost: 2 },
  drone:   { label: 'Drone',   cap: 2, hp: 40,  ttlS: 90,  cost: 2 },
  shield:  { label: 'Barrier', cap: 1, hp: 120, ttlS: 120, cost: 2 },
  nugget:  { label: 'Nugget',  cap: 8, hp: 1,   ttlS: 0,   cost: 2 },
  beacon:  { label: 'Beacon',  cap: 1, hp: 10,  ttlS: 300, cost: 2 },
};
