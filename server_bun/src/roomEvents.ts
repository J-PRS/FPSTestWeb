/**
 * RoomEvents — the room's domain-event channel. Notifications that used
 * to live as five separate optional hooks on RoomInfo/CombatDeps
 * (onKill/onHit/onFire/onBotSpoke/onChat) are one typed stream now:
 * producers emit, the Room fans out to subscribers. New consumers
 * (influence writes, match journal, spectate feeds) subscribe without
 * another bespoke hook on the grab-bag interface.
 *
 * Events are notifications only — commands and queries (move claims,
 * claim verdicts, snapshot suppliers) stay direct calls; an event
 * never carries a verdict back to its producer.
 */
export type RoomEvent =
  | { type: 'kill'; targetId: string; shooterId: string }
  | { type: 'hit'; targetId: string; shooterId: string }
  | { type: 'fire'; playerId: string }
  | { type: 'botSpoke'; id: string }
  | { type: 'chat'; id: string; text: string };

export type RoomEventSink = (e: RoomEvent) => void;

/** Minimal fan-out — subscribers run in subscribe order; a throwing
 *  subscriber doesn't take the rest of the room down. */
export class EventBus {
  private subs = new Set<RoomEventSink>();
  on(cb: RoomEventSink): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  readonly emit: RoomEventSink = (e) => {
    for (const cb of this.subs) {
      try { cb(e); } catch (err) { console.error('[EventBus] subscriber threw', err); }
    }
  };
}
