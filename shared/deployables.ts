// Deployable kinds + per-player caps shared by the client pack UI and
// the server's authoritative plant check — two private copies once let
// the drone cap drift (client 1 vs server 2).
// Facts live in deployItems.ts; these derived views stay for existing call sites.
import { DEPLOY_ITEMS, type DeployKind } from './deployItems.ts';
export type { DeployKind } from './deployItems.ts';

export const DEPLOY_KINDS: readonly DeployKind[] = Object.keys(DEPLOY_ITEMS) as DeployKind[];
export const DEPLOY_MAX: Record<DeployKind, number> = Object.fromEntries(
  Object.entries(DEPLOY_ITEMS).map(([k, d]): [string, number] => [k, d.cap]),
) as Record<DeployKind, number>;
// Planted hp — server owns it, client mirrors it for local visuals until
// the first deployHp tick lands. (nugget never plants an item — it mints
// a pickup — so its cap/hp entries are table-fillers for the Record.)
export const DEPLOY_HP: Record<DeployKind, number> = Object.fromEntries(
  Object.entries(DEPLOY_ITEMS).map(([k, d]): [string, number] => [k, d.hp]),
) as Record<DeployKind, number>;
