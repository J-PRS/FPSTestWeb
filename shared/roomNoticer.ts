import type { ChatterKind } from './botTaunts.ts';

/** Room-event → chatter sense, shared by the server senses and the
 *  offline brain feed so both hears the same pings. `notice` stamps
 *  the latest event; `for` translates it into THIS bot's side — allies
 *  cheer their team's score, enemies groan, defenders get the alert.
 *  Both timestamps come from the caller's own clock. */
export class RoomNoticer {
  private pending: { kind: ChatterKind; actorId: string; actorTeam?: string; stamp: number;
    goal?: { x: number; y: number; z: number }; goalSide?: 'same' | 'other' } | null = null;
  private readonly seen = new Map<string, number>();

  /** An event worth a reaction (flag cap/grab/return/drop, gg, a bot's
   *  own line). The actor never receives their own notice. `goal` is the
   *  position a same-team radio command implies — already side-resolved
   *  by the host, so every hearing teammate shares one pin. */
  notice(kind: ChatterKind, actorId: string, actorTeam: string | undefined, stamp: number,
    goal?: { x: number; y: number; z: number }, goalSide: 'same' | 'other' = 'same'): void {
    this.pending = { kind, actorId, actorTeam, stamp, goal, goalSide };
  }

  /** This bot's side of the pending event — once per bot per event,
   *  fresh for 2s after it happened. */
  for(id: string, team: string | undefined, now: number): { kind: ChatterKind; actor: string; goal?: { x: number; y: number; z: number } } | undefined {
    const n = this.pending;
    if (!n) return undefined;
    if (now - n.stamp > 2000) { this.pending = null; return undefined; }
    if (n.actorId === id || (this.seen.get(id) ?? 0) >= n.stamp) return undefined;
    this.seen.set(id, n.stamp);
    const mine = n.actorTeam !== undefined && n.actorTeam === team;
    // 'same' pins belong to the caller's squad (an enemy's radio isn't
    // your order); 'other' pins are for the OPPOSING side — a flag grab
    // pins the carrier for the defenders, not for the grabber's escort.
    const goal = n.goal && (n.goalSide === 'other' ? !mine : mine) ? n.goal : undefined;
    switch (n.kind) {
      case 'flagcap': case 'flagreturn': return { kind: mine ? 'cheer' : 'groan', actor: n.actorId, goal };
      case 'flaggrab': return { kind: mine ? 'cheer' : 'alert', actor: n.actorId, goal };
      case 'flagdrop': return { kind: mine ? 'groan' : 'cheer', actor: n.actorId, goal };
      default: return { kind: n.kind, actor: n.actorId, goal };
    }
  }

  /** Bot left the room — drop its receipt so the map can't grow one
   *  entry per retired bot for the room's life. */
  forget(id: string): void {
    this.seen.delete(id);
  }

  /** Jersey swap / id change — carry the receipt so a rekeyed bot can't
   *  react twice to the same event, and re-point a pending actor id. */
  rekey(oldId: string, newId: string): void {
    const stamp = this.seen.get(oldId);
    if (stamp !== undefined) { this.seen.delete(oldId); this.seen.set(newId, stamp); }
    if (this.pending?.actorId === oldId) this.pending.actorId = newId;
  }
}
