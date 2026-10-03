// Deployable kinds + per-player caps shared by the client pack UI and
// the server's authoritative plant check — two private copies once let
// the drone cap drift (client 1 vs server 2).
export type DeployKind = 'turret' | 'mine' | 'station' | 'drone' | 'shield' | 'nugget' | 'beacon';
export const DEPLOY_KINDS: readonly DeployKind[] = ['turret', 'mine', 'station', 'drone', 'shield', 'nugget', 'beacon'];
export const DEPLOY_MAX: Record<DeployKind, number> = { turret: 2, mine: 6, station: 1, drone: 2, shield: 1, nugget: 8, beacon: 1 };
// Planted hp — server owns it, client mirrors it for local visuals until
// the first deployHp tick lands. (nugget never plants an item — it mints
// a pickup — so its cap/hp entries are table-fillers for the Record.)
export const DEPLOY_HP: Record<DeployKind, number> = { turret: 60, mine: 20, station: 80, drone: 40, shield: 120, nugget: 1, beacon: 10 };
