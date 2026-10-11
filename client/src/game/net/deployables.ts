// Deployable wire handlers — server-owned turrets/mines/stations/drones.
// The server tracks existence and (for sentries) drives combat; clients
// render dumb visuals keyed by the server id so deployGone can remove them.

import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import type { DeployKind } from '../../../../shared/deployables.js';

export function wireDeployables(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  const mgr = () => deps.entities().deployables;
  const localId = () => deps.lazyNetworkManager().getLocalPlayerId();

  networkManager.onDeploySpawn = (id, owner, kind, pos, team) => {
    deps.lazyDemoManager?.()?.recordDeploySpawned(id, kind, pos);
    if (owner === localId()) { mgr().ackLocal(id); return; } // pod path already rendered it
    mgr().remoteSpawn(id, { owner, kind, pos, team });
    // The pod lands at release — swing the owner's model so the deploy
    // reads as a throw, not a teleporting object.
    deps.world.remotePlayers.get(owner)?.playThrow();
  };
  networkManager.onDeployGone = (id) => {
    mgr().remoteRemove(id);
    deps.lazyDemoManager?.()?.recordDeployGone(id);
  };
  networkManager.onDeployDown = (id) => {
    mgr().remoteDown(id);
    deps.lazyDemoManager?.()?.recordDeployHp(id, 0);
  };
  networkManager.onDeployUp = (id) => {
    mgr().remoteUp(id);
    deps.lazyDemoManager?.()?.recordDeployHp(id, 1);
  };
  networkManager.onSensorPing = (id, team, targets) => mgr().sensorPing(id, team, targets);
  networkManager.onTurretShot = (id, _owner, targetId) => {
    mgr().remoteTurretShot(id, targetId);
    const target = targetId === localId() ? deps.lazyPlayer().pos
      : deps.world.remotePlayers.get(targetId)?.position;
    if (target) {deps.lazyDemoManager?.()?.recordDeployShot(id, target);}
  };
  networkManager.onSentryShot = (id, owner, x, y, z) => {
    mgr().remoteSentryShot(id, owner, x, y, z);
    deps.lazyDemoManager?.()?.recordDeployShot(id, { x, y, z });
  };
  networkManager.onMineBoom = (id, pos) => {
    mgr().remoteMineBoom(id, pos);
    deps.lazyDemoManager?.()?.recordDeployBoom(id, pos);
  };
  networkManager.onDeployHp = (id, hp, armor, src) => {
    if (!Number.isFinite(hp + (armor ?? 0))) return;
    mgr().applyDeployHp(id, hp, armor);
    deps.lazyDemoManager?.()?.recordDeployHp(id, hp);
    // A heal tick names its welder — draw the beam. The local player's
    // own weld is already rendered first-person by the repair tool.
    if (src && src !== localId()) {mgr().remoteWeld(src, id);}
  };
}

/** Join-time roster — same reconcile the pickups get: spawn what the
 *  snapshot lists, drop what it doesn't (deployGone missed while down). */
export function reconcileDeployables(ctx: NetCtx, roster: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; hp?: number; armor?: number; team?: string }[] | undefined): void {
  const mgr = ctx.deps.entities().deployables;
  const localId = ctx.deps.lazyNetworkManager().getLocalPlayerId();
  // Deploy ids are per-room counters — a stale replica from the previous
  // room can sit on a reused id. reconcileReplicas only ensures absent
  // ids, so evict kind/owner mismatches before it runs or they ghost
  // the roster forever (the deploy-hash desync loop).
  for (const d of roster ?? []) {
    const e = mgr.remoteReplicas().get(d.id);
    if (e && (e.kind !== d.kind || e.owner !== d.owner)) {mgr.remoteRemove(d.id);}
  }
  const live = reconcileReplicas(mgr.remoteReplicas(), roster ?? [], {
    rowId: (d) => d.id,
    ensure: (d) => {
      // Deployables that predate the record window get adopted here — same
      // trick the creature roster lane uses.
      ctx.deps.lazyDemoManager?.()?.recordDeploySpawned(d.id, d.kind, d.pos);
      // Our own plants already exist as local items keyed by serverId —
      // the roster only carries their hp, not a second visual.
      if (d.owner === localId) {
        if (d.hp !== undefined) {mgr.applyDeployHp(d.id, d.hp, d.armor ?? 0);}
        return undefined;
      }
      mgr.remoteSpawn(d.id, { owner: d.owner, kind: d.kind, pos: d.pos, hp: d.hp, armor: d.armor, team: d.team });
      return mgr.remoteReplicas().get(d.id);
    },
    reap: (_e, id) => {
      mgr.remoteRemove(id);
      ctx.deps.lazyDemoManager?.()?.recordDeployGone(id);
    },
  });
  // The own lane needs the same cull — remotes don't cover it.
  mgr.cullOwn(live);
}
