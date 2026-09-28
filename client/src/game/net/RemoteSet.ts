/**
 * Generic remote-entity set — ONE implementation of the networked-entity
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
  readonly staleMs = 60_000;
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
  values(): IterableIterator<T> { return this.entities.values(); }
  keys(): IterableIterator<string> { return this.entities.keys(); }
  entries(): IterableIterator<[string, T]> { return this.entities.entries(); }
  forEach(fn: (v: T, k: string, m: Map<string, T>) => void): void { this.entities.forEach(fn); }
  clear(): void { this.entities.clear(); }
  get [Symbol.toStringTag](): string { return 'RemoteSet'; }
  [Symbol.iterator](): IterableIterator<[string, T]> { return this.entities[Symbol.iterator](); }

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
    if (!this.hooks.isLive(id, state)) return false;
    if (!ent) return true; // not yet instantiated — first record creates it
    return Date.now() - ent.lastUpdateTime <= this.staleMs;
  }

  /** Apply the stale gate: hidden entities skip their tick entirely. */
  setStale(ent: T, hidden: boolean): void { ent.setStaleHidden(hidden); }

  /** Dispose every entity whose id is absent from the live roster, or
   *  which finished its death-shrink (scale === 0). */
  prune(liveIds: (id: string) => boolean): void {
    for (const [id, ent] of this.entities) {
      const gone = !liveIds(id);
      const shrunkAway = ent.scale === 0;
      if (!gone && !shrunkAway) continue;
      ent.dispose();
      this.entities.delete(id);
      this.hooks.onRemove?.(id, ent, gone ? 'gone' : 'shrunk');
    }
  }
}
