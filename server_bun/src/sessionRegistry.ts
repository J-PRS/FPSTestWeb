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
}

export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private genCounter = 0;
  /** Since-boot per-edge totals + anomaly counts — the /metrics session
   *  rollup. Transitions log individually already; these answer "how
   *  much churn, which edges" for scrapes without log mining. */
  private edgeTotals = new Map<string, number>();
  private anomalies = { illegal: 0, rebegin: 0, seatWithoutBegin: 0, reclaimNonLive: 0 };

  private transition(playerId: string, s: Session, to: SessionState, reason: string): boolean {
    if (!EDGES[s.state].includes(to)) {
      // Loud, not fatal — the caller's flow continues but the rejected edge
      // names the site where lifecycle logic disagrees with the machine.
      this.anomalies.illegal++;
      logger.error('illegal session transition', { playerId, from: s.state, to, reason, gen: s.gen, room: s.room });
      return false;
    }
    const wallAge = wallNow() - s.at;
    const from = s.state;
    s.state = to;
    s.at = wallNow();
    const edge = `${from}->${to}`;
    this.edgeTotals.set(edge, (this.edgeTotals.get(edge) ?? 0) + 1);
    logger.info('session transition', { playerId, t: edge, reason, gen: s.gen, room: s.room, wallAgeMs: wallAge });
    if (to === 'reaped') this.sessions.delete(playerId);
    return true;
  }

  /** Begin a session at 'connecting' — called once the join handshake has
   *  produced a validated playerId, before the seat itself. Re-beginning an
   *  existing id replaces the session with a fresh generation (room hop =
   *  a new session, not a transition). */
  begin(playerId: string, room: string): void {
    const prior = this.sessions.get(playerId);
    if (prior) {
      this.anomalies.rebegin++;
      logger.warn('session re-begin over live state', { playerId, from: prior.state, gen: prior.gen, room: prior.room });
    }
    this.sessions.set(playerId, { state: 'connecting', gen: ++this.genCounter, at: wallNow(), room });
  }

  /** connecting → active|spectating. Returns the seat generation — stamp it
   *  on the socket so its later callbacks are gen-checked. */
  seat(playerId: string, spectator: boolean, reason: string): number {
    const s = this.sessions.get(playerId);
    if (!s) {
      this.anomalies.seatWithoutBegin++;
      logger.error('seat without begin', { playerId });
      this.sessions.set(playerId, { state: 'connecting', gen: ++this.genCounter, at: wallNow(), room: '' });
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
    if (!s) return undefined;
    if (s.state === 'grace') this.transition(playerId, s, 'active', reason);
    else if (s.state !== 'active') {
      this.anomalies.reclaimNonLive++;
      logger.error('reclaim on non-live session', { playerId, from: s.state, reason });
      return undefined;
    } else {
      logger.info('session reseat', { playerId, gen: s.gen, room: s.room, reason });
    }
    s.gen = ++this.genCounter;
    s.at = wallNow();
    return s.gen;
  }

  /** active → grace: the socket died, the seat stays warm. False when the
   *  player wasn't active (e.g. spectator close, never-seated socket). */
  disconnect(playerId: string, reason: string): boolean {
    const s = this.sessions.get(playerId);
    if (!s) return false;
    return this.transition(playerId, s, 'grace', reason);
  }

  /** any → reaped: grace expiry, idle reap, kick, admin remove. Every
   *  lifecycle teardown funnels through removePlayerCompletely → here. */
  terminate(playerId: string, reason: string): boolean {
    const s = this.sessions.get(playerId);
    if (!s) return false; // never a session (pre-seat reject, bot, double remove)
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

  /** Census for /metrics — sessions by state. */
  census(): Record<SessionState, number> {
    const c: Record<SessionState, number> = { connecting: 0, active: 0, spectating: 0, grace: 0, reaped: 0 };
    for (const s of this.sessions.values()) c[s.state]++;
    return c;
  }

  /** /metrics session rollup — live census + since-boot edge totals +
   *  anomaly counters. Anomalies > 0 is a paging condition: they mean
   *  lifecycle code disagreed with the state machine. */
  metrics(): { census: Record<SessionState, number>; transitions: Record<string, number>; anomalies: { illegal: number; rebegin: number; seatWithoutBegin: number; reclaimNonLive: number } } {
    return { census: this.census(), transitions: Object.fromEntries(this.edgeTotals), anomalies: { ...this.anomalies } };
  }
}
