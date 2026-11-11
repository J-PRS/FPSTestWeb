import type { ServerMessage } from '../../shared/protocol.ts';
import type { ModeSpec, TeamScores } from '../../shared/teams.ts';
import type { MapSpec } from '../../shared/mapSpec.ts';
import { simNow } from './simClock.ts';
import { setMatchMuted } from '../../shared/botTaunts.ts';
import type { ResultToken } from '../../shared/resultToken.ts';
import type { ResultSigner, MatchRecord } from './resultSigner.ts';

/** The pieces of Room the match lifecycle touches — typed as an
 *  interface so RoomMatchClock stays a leaf (no Room import cycle). */
export interface MatchHost {
  readonly room: string;
  readonly mode: string;
  readonly modeSpec: ModeSpec | null;
  readonly scores: TeamScores;
  readonly ffaScores: Map<string, number>;
  getHumanCount(): number;
  matchPlayers(): { id: string; team?: string; kills: number; deaths: number }[];
  broadcast(msg: ServerMessage): void;
  resultSigner?: ResultSigner | null;
  mapSrc?: string;
  endCleanup(): void;          // flags/pickups/deployables/stats reset
  rotate(): MapSpec | null;    // next same-mode spec, or null to replay
  applySpec(spec: MapSpec): void;
  reshuffleBots?(): void;      // re-deal bot team assignments for the next match
  respawnAll?(): void;         // fresh round = fresh bodies on the new spec
  gunGameReset?(): void;       // gungame rooms: ladders back to rung 0
  onMatchEnd?: (record: MatchRecord & { token?: ResultToken }) => void;
  onEnded?: (winner: string) => void;  // the horn fired — bots get their 'gg' beat
  onStarted?(): void;                  // a match went live — bots get their gl-hf beat
  /** Intermission edge: true when the standings window opens, false as
   *  the next match resets — Room gates the damage funnel on it. */
  setIntermission?(on: boolean): void;
}

/**
 * Match lifecycle — clock, warnings, overtime, winner resolution, and
 * the endMatch reset funnel. Split out of Room so room.ts stays about
 * wiring sims together; every end path (score cap, flag cap, horn)
 * funnels through endMatch here. 'draw' is a legal winner (tied clock).
 */
export class MatchClock {
  /** ms timestamps; 0 = not armed (first human join starts the clock). */
  private endsAt = 0;
  private warned = false;    // 60s warning — once per match
  private overtime = false;  // tied horn → next score wins
  /** Intermission deadline — end broadcast fired, reset+matchStart
   *  waits here so clients can sit on the standings (T:A's podium beat). */
  private intermissionAt = 0;
  private static readonly INTERMISSION_MS = 15_000;

  constructor(private host: MatchHost) {}

  /** ms until the horn; 0 when the clock isn't armed. */
  timeLeftMs(): number {
    return this.endsAt ? Math.max(0, this.endsAt - simNow()) : 0;
  }

  /** `now` is a simClock stamp — callers must pass simNow(), never a
   *  wall clock (mixing domains shifts the horn by the warp offset). */
  tick(now: number): void {
    const spec = this.host.modeSpec;
    if (!spec) {return;}
    // Intermission owns the tick: nothing else may re-arm or re-end
    // until the standings window has played out.
    if (this.intermissionAt) {
      if (now >= this.intermissionAt) {this.startNext();}
      return;
    }
    if (this.endsAt === 0) {
      if (this.host.getHumanCount() > 0) {
        this.endsAt = now + spec.timeLimitS * 1000;
        this.host.onStarted?.();
      }
      return;
    }
    if (!this.warned && this.endsAt - now <= 60_000) {
      this.warned = true;
      this.host.broadcast({ type: 'matchNotice', text: '60 seconds left' });
    }
    // In overtime the horn is already past — any lead ends it instantly.
    if (this.overtime) {
      const w = this.leader();
      if (w !== null) { this.end(w); return; }
    }
    if (now < this.endsAt) {return;}
    const w = this.leader();
    if (w === null) {
      if (this.overtime) { this.end('draw'); return; } // OT window spent
      this.overtime = true;
      this.endsAt = now + 120_000; // OT cap: still tied → draw
      this.host.broadcast({ type: 'matchNotice', text: 'OVERTIME — next score wins' });
      return;
    }
    this.end(w);
  }

  /** Current match leader: team id / playerId, or null when tied. */
  private leader(): string | null {
    const spec = this.host.modeSpec!;
    if (spec.teams) {
      const s = this.host.scores;
      if (s.alpha === s.bravo) {return null;}
return s.alpha > s.bravo ? 'alpha' : 'bravo';
    }
    let top: string | null = null, topPts = -1, tied = false;
    for (const [id, pts] of this.host.ffaScores) {
      if (pts > topPts) { top = id; topPts = pts; tied = false; }
      else if (pts === topPts) {tied = true;}
    }
    return top && !tied ? top : null;
  }

  /** Admin force-end: resolve with the current leader (or draw) and run
   *  the normal reset funnel. No-op in rooms without a mode. */
  forceEnd(): boolean {
    const spec = this.host.modeSpec;
    if (!spec) {return false;}
    let w = 'draw';
    if (spec.teams) {
      const s = this.host.scores;
      if (s.alpha === s.bravo) {w = 'draw';}
else {w = s.alpha > s.bravo ? 'alpha' : 'bravo';}
    } else {
      let best = -Infinity;
      for (const [id, s] of this.host.ffaScores) {
        if (s > best) { best = s; w = id; }
      }
    }
    this.end(w);
    return true;
  }

  /** Phase 1: end broadcast + record. The reset waits INTERMISSION_MS —
   *  clients pin the scoreboard on matchEnd and get their standings
   *  window before the world wipes. */
  end(w: string): void {
    // A second end during the standings window (admin force, late score
    // cap) must not re-fire the broadcast or restart the countdown.
    if (this.intermissionAt) {return;}
    const {host} = this;
    host.setIntermission?.(true); // godmode for the standings window — the world runs on, nobody can kill
    // Standings window is for the gg beat only — kills/contacts past the
    // horn shouldn't keep barking over the scoreboard.
    setMatchMuted(true);
    const spec = host.modeSpec!;
    const scores = (spec.teams ? Object.assign({}, host.scores) : Object.fromEntries(host.ffaScores)) as Record<string, number>;
    host.broadcast({ type: spec.teams ? 'matchEnd' : 'ffaMatchEnd', winner: w, scores } as ServerMessage);
    const rec: MatchRecord & { token?: ResultToken } = { room: host.room, mode: host.mode, winner: w, scores, players: host.matchPlayers() };
    // Signed leaderboard receipt: mint carries the whole match's
    // outcome-event hash — async (crypto.subtle) so the token broadcast +
    // journal record land a microtask late. Unsigned dev rooms skip the
    // round trip entirely.
    if (host.resultSigner) {
      // The room's own clock stamps the receipt — same grid the event
      // hashes are stamped on, so a verifier replaying this match
      // re-derives byte-identical bytes (wall Date.now() here made the
      // signed payload depend on when the microtask happened to run).
      void host.resultSigner.mint(rec, host.mapSrc, simNow()).then((token): void => {
        rec.token = token;
        host.broadcast({ type: 'matchToken', token });
        host.onMatchEnd?.(rec);
      });
    } else {
      host.onMatchEnd?.(rec);
    }
    host.onEnded?.(w);
    this.intermissionAt = simNow() + MatchClock.INTERMISSION_MS;
  }

  /** Phase 2 (post-intermission): field reset, journal, matchStart.
   *  Rotation lands between reset and matchStart so players spawn onto
   *  the NEW map (applySpec re-points spawnPoints) rather than eating
   *  one old-map spawn before mapUpdate lands. */
  private startNext(): void {
    const {host} = this;
    const spec = host.modeSpec!;
    this.intermissionAt = 0;
    host.setIntermission?.(false);
    setMatchMuted(false);
    host.scores.alpha = 0;
    host.scores.bravo = 0;
    host.ffaScores.clear();
    host.endCleanup();
    // Reshuffle bot teams each match — persistent sides bake one spawn's
    // skill draw into a permanent advantage, and mixing is what lets
    // per-bot skill→outcome regression mean anything later. Humans keep
    // their picked team; only bot assignments churn.
    host.reshuffleBots?.();
    const next = host.rotate();
    if (next) {host.applySpec(next);}
    host.gunGameReset?.();
    // Fresh round = fresh bodies — dead players (and everyone standing on
    // the old layout) respawn onto the NEW spec's spawn points. Without
    // this a corpse's respawn timer outlives the reset and they join the
    // round already behind.
    host.respawnAll?.();
    // Re-arm only with an audience: an empty room's clock should stay
    // unarmed (endsAt=0) so the next joiner gets a fresh match instead
    // of inheriting whatever an unwatched countdown burned down to.
    this.endsAt = host.getHumanCount() > 0 ? simNow() + spec.timeLimitS * 1000 : 0;
    this.warned = false;
    this.overtime = false;
    host.broadcast({ type: 'matchStart', mode: host.mode, scores: Object.assign({}, host.scores) });
    host.onStarted?.();
  }
}