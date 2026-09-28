// Deployable wire handlers — server-owned turrets/mines/stations/drones.
// The server tracks existence and (for sentries) drives combat; clients
// render dumb visuals keyed by the server id so deployGone can remove them.

import type { NetCtx } from './ctx.js';

export function wireDeployables(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  const mgr = () => deps.entities().deployables;
  const localId = () => deps.lazyNetworkManager().getLocalPlayerId();

  networkManager.onDeploySpawn = (id, owner, kind, pos) => {
    if (owner === localId()) { mgr().ackLocal(id); return; } // pod path already rendered it
    mgr().remoteSpawn(id, owner, kind, pos);
  };
  networkManager.onDeployGone = (id) => mgr().remoteRemove(id);
  networkManager.onTurretShot = (id, _owner, targetId) => mgr().remoteTurretShot(id, targetId);
  networkManager.onMineBoom = (id, pos) => mgr().remoteMineBoom(id, pos);
}

/** Join-time roster — same reconcile the pickups get: spawn what the
 *  snapshot lists, drop what it doesn't (deployGone missed while down). */
export function reconcileDeployables(ctx: NetCtx, roster: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: { x: number; y: number; z: number } }[] | undefined): void {
  const mgr = ctx.deps.entities().deployables;
  const live = new Set<number>();
  for (const d of roster ?? []) {
    live.add(d.id);
    if (d.owner !== ctx.deps.lazyNetworkManager().getLocalPlayerId()) mgr.remoteSpawn(d.id, d.owner, d.kind, d.pos);
  }
  for (const id of mgr.remoteIds()) if (!live.has(id)) mgr.remoteRemove(id);
}
