/**
 * replicas — the one roster-reconcile lifecycle every server-driven
 * entity lane used to re-implement: build the live id set from the
 * roster, ensure missing replicas spawn, evict dead-but-registered
 * entries so they respawn, apply each row's authoritative state, then
 * reap whatever the server no longer lists. Membership is roster-owned:
 * spawn edges only create early, gone events only reap early — this
 * sweep heals both directions, so a lost edge converges on the next
 * roster instead of ghosting forever.
 */

export interface ReplicaHooks<T, R, K> {
  rowId: (r: R) => K;
  /** Returns true when the entry counts as alive-but-spawnable — a
   *  `dead` flag means the ctor failed or a gone edge landed and the
   *  roster must respawn it rather than skip forever. */
  isDead?: (e: T) => boolean;
  /** Create the replica for a missing row — the spawn edge and the
   *  roster converge on the SAME ensure path so a missed spawn edge
   *  heals identically to a live one. */
  ensure: (r: R) => T | undefined;
  /** Per-row authoritative state application (edge replay / demo
   *  record). Runs after ensure, so it sees the spawned entry. */
  apply?: (e: T, r: R) => void;
  /** Teardown for an entry the roster dropped — runs while the entry is
   *  still in the caller's hands; the map delete happens inside. */
  reap: (e: T, id: K) => void;
}

export function reconcileReplicas<T, R, K>(map: Map<K, T>, rows: R[], hooks: ReplicaHooks<T, R, K>): Set<K> {
  const live = new Set<K>();
  for (const r of rows) {
    const id = hooks.rowId(r);
    live.add(id);
    // A dead-but-registered entry wedges every later spawn — evict so
    // the ensure below actually creates it (the ctor-fail wedge).
    const held = map.get(id);
    if (held !== undefined && hooks.isDead?.(held)) map.delete(id);
    if (!map.has(id)) hooks.ensure(r);
    const e = map.get(id);
    if (e === undefined) continue; // ensure refused — next roster retries
    hooks.apply?.(e, r);
  }
  for (const [id, e] of map) {
    if (!live.has(id)) {
      map.delete(id);
      hooks.reap(e, id);
    }
  }
  return live;
}
