// Deployable wire handlers — server-owned turrets/mines/stations/drones.
// The server tracks existence and (for sentries) drives combat; clients
// render dumb visuals keyed by the server id so deployGone can remove them.

import type { NetCtx } from './ctx.js';
import type { DeployKind } from '../../../../shared/deployables.js';

export function wireDeployables(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  const mgr = () => deps.entities().deployables;
  const localId = () => deps.lazyNetworkManager().getLocalPlayerId();

  networkManager.onDeploySpawn = (id, owner, kind, pos, team) => {
    if (owner === localId()) { mgr().ackLocal(id); return; } // pod path already rendered it
    mgr().remoteSpawn(id, { owner, kind, pos, team });
    // The pod lands at release — swing the owner's model so the deploy
    // reads as a throw, not a teleporting object.
    deps.world.remotePlayers.get(owner)?.playThrow();
  };
  networkManager.onDeployGone = (id) => mgr().remoteRemove(id);
  networkManager.onDeployDown = (id) => mgr().remoteDown(id);
  networkManager.onDeployUp = (id) => mgr().remoteUp(id);
  networkManager.onSensorPing = (id, team, targets) => mgr().sensorPing(id, team, targets);
  networkManager.onTurretShot = (id, _owner, targetId) => mgr().remoteTurretShot(id, targetId);
  networkManager.onSentryShot = (id, owner, x, y, z) => mgr().remoteSentryShot(id, owner, x, y, z);
  networkManager.onMineBoom = (id, pos) => mgr().remoteMineBoom(id, pos);
  networkManager.onDeployHp = (id, hp, armor, src) => {
    mgr().applyDeployHp(id, hp, armor);
    // A heal tick names its welder — draw the beam. The local player's
    // own weld is already rendered first-person by the repair tool.
    if (src && src !== localId()) {mgr().remoteWeld(src, id);}
  };
}

/** Join-time roster — same reconcile the pickups get: spawn what the
 *  snapshot lists, drop what it doesn't (deployGone missed while down). */
export function reconcileDeployables(ctx: NetCtx, roster: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }[] | undefined): void {
  const mgr = ctx.deps.entities().deployables;
  const live = new Set<number>();
  for (const d of roster ?? []) {
    live.add(d.id);
    if (d.owner !== ctx.deps.lazyNetworkManager().getLocalPlayerId()) {mgr.remoteSpawn(d.id, { owner: d.owner, kind: d.kind, pos: d.pos, hp: d.hp, armor: d.armor, team: d.team });}
    else if (d.hp !== undefined) {mgr.applyDeployHp(d.id, d.hp, d.armor ?? 0);}
  }
  for (const id of mgr.remoteIds()) {if (!live.has(id)) {mgr.remoteRemove(id);}}
}
