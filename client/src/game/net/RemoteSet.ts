/**
 * Generic remote-entity set - ONE implementation of the networked-entity
 * lifecycle (spawn-on-first-sight, stale hiding, roster pruning) shared by
 * every entity kind the server can own. Map-compatible so existing call
 * sites keep working; the value is the centralized gate, not the map.
 *
 * History: the invisible-bots bug lived here — remotes.ts hid any remote
 * whose ping was null, and the server never sends ping for bots, so every
 * BOT-* rendered frozen and hidden while still shooting. Kind-specific
 * liveness rules belong in `isLive`, not re-implemented per entity type.
 */

export interface RemoteEntity {
  lastUpdateTime: number;
  /** Shrink-away cleanup: a fully shrunk entity is disposed on prune. */
  scale: number;
  setStaleHidden(hidden: boolean): void;
  dispose(): void;
}

export interface RemoteSetHooks<T extends RemoteEntity, S> {
  /** Spawn a new entity from first wire state. Return undefined to skip
   *  (e.g. a remote first heard about already dead). */
  create(id: string, state: S): T | undefined;
  /** Wire liveness — the entity has a live feed behind it (e.g. proven
   *  ping for humans; server bots exempt since they never ping). */
  isLive(id: string, state: S | undefined): boolean;
  /** Fire on dispose — HUD indicators, health bars, index cleanup. */
  onRemove?(id: string, ent: T, reason: 'gone' | 'shrunk'): void;
  /** Optional spawn notice — debug logging. */
  onCreate?(id: string, ent: T): void;
}

export class RemoteSet<T extends RemoteEntity, S> {
  private entities = new Map<string, T>();
  readonly staleMs = 10_000; // forceSend beats this by ~10x — 10s of silence is a dead feed, not a quiet player
  /** Mutable on purpose: the world owns the set before the module deps
   *  the hooks need (scene, terrain, nm) exist — createRemotes fills it. */
  hooks: RemoteSetHooks<T, S>;

  constructor(hooks: RemoteSetHooks<T, S>) { this.hooks = hooks; }

  // --- Map-compatible surface ---
  get size(): number { return this.entities.size; }
  get(id: string): T | undefined { return this.entities.get(id); }
  has(id: string): boolean { return this.entities.has(id); }
  set(id: string, ent: T): this { this.entities.set(id, ent); return this; } // Map-compatible return for structural assignability
  delete(id: string): boolean { return this.entities.delete(id); }
  values(): MapIterator<T> { return this.entities.values(); }
  keys(): MapIterator<string> { return this.entities.keys(); }
  entries(): MapIterator<[string, T]> { return this.entities.entries(); }
  forEach(fn: (v: T, k: string, m: Map<string, T>) => void): void { this.entities.forEach(fn); }
  clear(): void { this.entities.clear(); }
  get [Symbol.toStringTag](): string { return 'RemoteSet'; }
  [Symbol.iterator](): MapIterator<[string, T]> { return this.entities[Symbol.iterator](); }

  /** Spawn-on-first-sight. Returns the entity (new or existing). */
  ensure(id: string, state: S): T | undefined {
    let ent = this.entities.get(id);
    if (!ent) {
      ent = this.hooks.create(id, state);
      if (ent) { this.entities.set(id, ent); this.hooks.onCreate?.(id, ent); }
    }
    return ent;
  }

  /** A remote is renderable when its feed is live AND it was heard from
   *  within the stale window. The isLive hook owns kind-specific rules. */
  active(id: string, ent: T | undefined, state: S | undefined): boolean {
    if (!this.hooks.isLive(id, state)) {return false;}
    if (!ent) {return true;} // not yet instantiated — first record creates it
    return Date.now() - ent.lastUpdateTime <= this.staleMs;
  }

  /** Apply the stale gate: hidden entities skip their tick entirely. */
  setStale(ent: T, hidden: boolean): void { ent.setStaleHidden(hidden); }

  /** Register an entity built by its owner (local bots, respawn path) —
   *  fires onCreate so logging can't tell it apart from a wire spawn. */
  adopt(id: string, ent: T): T {
    this.entities.set(id, ent);
    this.hooks.onCreate?.(id, ent);
    return ent;
  }

  /** Owner-initiated teardown (playerLeft, bot squad dispose) — routes
   *  through onRemove exactly like a prune, so HUD/health-bar cleanup
   *  can't be forgotten at the call site. */
  remove(id: string): boolean {
    const ent = this.entities.get(id);
    if (!ent) {return false;}
    ent.dispose();
    this.entities.delete(id);
    this.hooks.onRemove?.(id, ent, 'gone');
    return true;
  }

  /** Re-key an owner-managed entity (bot jersey swap). No dispose, no
   *  hooks — it's the same body under a new name. */
  rename(oldId: string, newId: string): void {
    const ent = this.entities.get(oldId);
    if (!ent) {return;}
    this.entities.delete(oldId);
    this.entities.set(newId, ent);
  }

  /** Dispose every entity whose id is absent from the live roster, or
   *  which finished its death-shrink (scale === 0). Owner-managed bodies
   *  (local bots, debug dummies) pass `shrinkExempt` — their owner reuses
   *  the SAME entity on respawn, and a disposed/shrunk-reaped model would
   *  leave an invisible attacker still thinking and shooting. */
  prune(liveIds: (id: string) => boolean, shrinkExempt?: (id: string) => boolean): void {
    for (const [id, ent] of this.entities) {
      const gone = !liveIds(id);
      const shrunkAway = ent.scale === 0 && !(shrinkExempt?.(id));
      if (!gone && !shrunkAway) {continue;}
      ent.dispose();
      this.entities.delete(id);
      this.hooks.onRemove?.(id, ent, gone ? 'gone' : 'shrunk');
    }
  }
}
