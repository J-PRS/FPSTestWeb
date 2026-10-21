import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';

/**
 * SessionRegistry — the single place that knows WHO each player is in
 * session terms. Adopted incrementally: the six existing stores keep their
 * data (this is the shadow-to-owner path), but every lifecycle transition
 * must pass through here so "the system decided a live player was dead"
 * has exactly one place to inspect — one greppable line per transition.
 *
 * States follow the yojimbo encoding discipline: a session moves forward
 * through an explicit edge list, 'reaped' is terminal, and no path reaches
 * 'active' without passing through 'connecting' — the invariant the
 * scattered stores could never express. Stale callbacks die by generation:
 * every re-seat bumps the session's gen, the socket carries the gen it was
 * seated under, and a callback whose ws.data.gen isn't current is a no-op.
 */
export type SessionState = 'connecting' | 'active' | 'spectating' | 'grace' | 'reaped';

const EDGES: Readonly<Record<SessionState, readonly SessionState[]>> = {
  connecting: ['active', 'spectating', 'reaped'],
  active: ['grace', 'reaped'],
  spectating: ['reaped'],
  grace: ['active', 'reaped'],
  reaped: [],
};

interface Session {
  state: SessionState;
  /** Latest seat generation — stale socket callbacks compare and die. */
  gen: number;
  /** Wall-clock ms of the last accepted transition (for the log line). */
  at: number;
  room: string;
  /** Grace-period expiry — armed on disconnect, cleared by reclaim/terminate.
   *  Owned here (not a parallel room map) so "the seat's countdown" can't
   *  outlive the session it counts down. */
  graceTimer?: ReturnType<typeof setTimeout>;
}

export class SessionRegistry {
  private sessions = new Map<string, Session>();
  /** room → live grace count. `graceInRoom` feeds Room.empty's per-tick
   *  ghost check — scanning the session table there would cost
   *  O(rooms × sessions) every tick. */
  private roomGrace = new Map<string, number>();
  private genCounter = 0;
  /** Since-boot per-edge totals + anomaly counts — the /metrics session
   *  rollup. Transitions log individually already; these answer "how
   *  much churn, which edges" for scrapes without log mining. */
  private edgeTotals = new Map<string, number>();
  private anomalies = { illegal: 0, rebegin: 0, seatWithoutBegin: 0, reclaimNonLive: 0 };

  /** The map is sparse — a room at zero ghosts gets its key back so the
   *  table can't accumulate one dead entry per room ever created. */
  private bumpGrace(room: string, d: number): void {
    const v = (this.roomGrace.get(room) ?? 0) + d;
    if (v <= 0) { this.roomGrace.delete(room); } else { this.roomGrace.set(room, v); }
  }

  private clearGrace(s: Session): void {
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = undefined; }
  }

  private transition(playerId: string, s: Session, to: SessionState, reason: string): boolean {
    if (!EDGES[s.state].includes(to)) {
      // Loud, not fatal — the caller's flow continues but the rejected edge
      // names the site where lifecycle logic disagrees with the machine.
this.anomalies.illegal += 1;
      logger.error('illegal session transition', { playerId, from: s.state, to, reason, gen: s.gen, room: s.room });
      return false;
    }
    const wallAge = wallNow() - s.at;
    const from = s.state;
    if (from === 'grace') {this.bumpGrace(s.room, -1);}
    if (to === 'grace') {this.bumpGrace(s.room, +1);}
    s.state = to;
    s.at = wallNow();
    const edge = `${from}->${to}`;
    this.edgeTotals.set(edge, (this.edgeTotals.get(edge) ?? 0) + 1);
    logger.info('session transition', { playerId, t: edge, reason, gen: s.gen, room: s.room, wallAgeMs: wallAge });
    // Leaving grace for any reason retires the countdown — reclaim clears
    // it in-place, terminate deletes the session below.
    if (from === 'grace' || to === 'reaped') {this.clearGrace(s);}
    if (to === 'reaped') {this.sessions.delete(playerId);}
    return true;
  }

  /** Begin a session at 'connecting' — called once the join handshake has
   *  produced a validated playerId, before the seat itself. Re-beginning an
   *  existing id replaces the session with a fresh generation (room hop =
   *  a new session, not a transition). */
  begin(playerId: string, room: string): void {
    const prior = this.sessions.get(playerId);
    if (prior) {
this.anomalies.rebegin += 1;
      logger.warn('session re-begin over live state', { playerId, from: prior.state, gen: prior.gen, room: prior.room });
      // Overwriting drops the prior record — its grace seat must come off
      // the room's count or the replacement's room inherits a phantom ghost.
      if (prior.state === 'grace') {
        this.bumpGrace(prior.room, -1);
      }
      // And its countdown must die with it: an orphaned timer fires the
      // old session's onExpire against the NEW session's playerId —
      // reaping a just-seated player out of their new room.
      this.clearGrace(prior);
    }
    this.sessions.set(playerId, { state: 'connecting', gen: (this.genCounter += 1), at: wallNow(), room });
  }

  /** connecting → active|spectating. Returns the seat generation — stamp it
   *  on the socket so its later callbacks are gen-checked. */
  seat(playerId: string, spectator: boolean, reason: string): number {
    const s = this.sessions.get(playerId);
    if (!s) {
this.anomalies.seatWithoutBegin += 1;
      logger.error('seat without begin', { playerId });
      this.sessions.set(playerId, { state: 'connecting', gen: (this.genCounter += 1), at: wallNow(), room: '' });
      return this.sessions.get(playerId)!.gen;
    }
    this.transition(playerId, s, spectator ? 'spectating' : 'active', reason);
    return s.gen;
  }

  /** grace → active (real reclaim) or active → active (zombie re-seat).
   *  Either way the seat generation bumps so the evicted socket's pending
   *  callbacks die against the gen check. Returns undefined when there is
   *  no live session to reclaim (caller rejects). */
  reclaim(playerId: string, reason: string): number | undefined {
    const s = this.sessions.get(playerId);
    if (!s) {return undefined;}
    if (s.state === 'grace') {this.transition(playerId, s, 'active', reason);}
    else if (s.state === 'active') {
      logger.info('session reseat', { playerId, gen: s.gen, room: s.room, reason });
    } else {
this.anomalies.reclaimNonLive += 1;
      logger.error('reclaim on non-live session', { playerId, from: s.state, reason });
      return undefined;
    }
    this.genCounter += 1;
    s.gen = this.genCounter;
    s.at = wallNow();
    return s.gen;
  }

  /** active → grace: the socket died, the seat stays warm. False when the
   *  player wasn't active (e.g. spectator close, never-seated socket).
   *  The grace countdown arms here — onExpire runs exactly once when the
   *  timer wins; a reclaim or terminate clears it. */
  disconnect(playerId: string, reason: string, graceMs?: number, onExpire?: () => void): boolean {
    const s = this.sessions.get(playerId);
    if (!s) {return false;}
    const ok = this.transition(playerId, s, 'grace', reason);
    if (ok && graceMs !== undefined && onExpire) {
      this.clearGrace(s);
      // onExpire runs the full teardown funnel — if it throws, the
      // player is never reaped (ghost session + leaked slot). Wrap so
      // the failure logs with the victim instead of going unhandled.
      s.graceTimer = setTimeout((): void => {
        try { onExpire(); }
        catch (error) { logger.error('Grace expiry failed', { playerId, err: error instanceof Error ? error.message : String(error) }); }
      }, graceMs);
    }
    return ok;
  }

  /** Dev-restart restore: a process respawn rebuilds the orphaned seat
   *  directly at 'grace' — same expiry a live disconnect would arm, so a
   *  reclaimer gets the reclaim path and a no-show still reaps. */
  seedGrace(playerId: string, room: string, graceMs: number, onExpire: () => void): void {
    const s: Session = { state: 'grace', gen: (this.genCounter += 1), at: wallNow(), room };
    this.sessions.set(playerId, s);
    this.bumpGrace(room, +1);
    s.graceTimer = setTimeout((): void => {
      try { onExpire(); }
      catch (error) { logger.error('Grace expiry failed', { playerId, err: error instanceof Error ? error.message : String(error) }); }
    }, graceMs);
  }

  /** any → reaped: grace expiry, idle reap, kick, admin remove. Every
   *  lifecycle teardown funnels through removePlayerCompletely → here. */
  terminate(playerId: string, reason: string): boolean {
    const s = this.sessions.get(playerId);
    if (!s) {return false;} // never a session (pre-seat reject, bot, double remove)
    return this.transition(playerId, s, 'reaped', reason);
  }

  /** Latest seat generation for a player — GameServer.onClose compares
   *  against ws.data.gen: a stale socket's close dies here instead of
   *  detaching a re-seated session. */
  gen(playerId: string): number | undefined {
    return this.sessions.get(playerId)?.gen;
  }

  state(playerId: string): SessionState | undefined {
    return this.sessions.get(playerId)?.state;
  }

  /** Re-aim a still-connecting session at a different room — a mid-load
   *  room hop before the first seat. Not a lifecycle edge (no begin/seat
   *  transition happened yet), so it moves no anomaly counters. */
  retarget(playerId: string, room: string): boolean {
    const s = this.sessions.get(playerId);
    if (!s || s.state !== 'connecting') {return false;}
    s.room = room;
    return true;
  }

  /** The room the session's latest begin targeted — deferred joins check
   *  this at fire time so a terrain-load deferral can't seat a socket into
   *  a room a newer join already superseded (hop-during-load race). */
  roomOf(playerId: string): string | undefined {
    return this.sessions.get(playerId)?.room;
  }

  /** Census for /metrics — sessions by state. */
  census(): Record<SessionState, number> {
    const c: Record<SessionState, number> = { connecting: 0, active: 0, spectating: 0, grace: 0, reaped: 0 };
    for (const s of this.sessions.values()) {c[s.state] += 1;}
    return c;
  }

  /** Grace seats parked in a room — Room.empty's "no ghosts left" test.
   *  O(1): maintained per transition above, since Room.empty asks it of
   *  every room every tick. */
  graceInRoom(room: string): number {
    return this.roomGrace.get(room) ?? 0;
  }

  /** /metrics session rollup — live census + since-boot edge totals +
   *  anomaly counters. Anomalies > 0 is a paging condition: they mean
   *  lifecycle code disagreed with the state machine. */
  metrics(): { census: Record<SessionState, number>; transitions: Record<string, number>; anomalies: { illegal: number; rebegin: number; seatWithoutBegin: number; reclaimNonLive: number } } {
    return { census: this.census(), transitions: Object.fromEntries(this.edgeTotals), anomalies: Object.assign({}, this.anomalies) };
  }
}
