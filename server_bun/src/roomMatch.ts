import type { ServerMessage } from '../../shared/protocol.ts';
import type { ModeSpec, TeamScores } from '../../shared/teams.ts';
import type { MapSpec } from '../../shared/mapSpec.ts';

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
  endCleanup(): void;          // flags/pickups/deployables/stats reset
  rotate(): MapSpec | null;    // next same-mode spec, or null to replay
  applySpec(spec: MapSpec): void;
  onMatchEnd?: (record: { room: string; mode: string; winner: string; scores: Record<string, number>; players: { id: string; team?: string; kills: number; deaths: number }[] }) => void;
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

  constructor(private host: MatchHost) {}

  /** ms until the horn; 0 when the clock isn't armed. */
  timeLeftMs(): number {
    return this.endsAt ? Math.max(0, this.endsAt - Date.now()) : 0;
  }

  tick(now: number): void {
    const spec = this.host.modeSpec;
    if (!spec) return;
    if (this.endsAt === 0) {
      if (this.host.getHumanCount() > 0) {
        this.endsAt = now + spec.timeLimitS * 1000;
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
    if (now < this.endsAt) return;
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
      return s.alpha === s.bravo ? null : s.alpha > s.bravo ? 'alpha' : 'bravo';
    }
    let top: string | null = null, topPts = -1, tied = false;
    for (const [id, pts] of this.host.ffaScores) {
      if (pts > topPts) { top = id; topPts = pts; tied = false; }
      else if (pts === topPts) tied = true;
    }
    return top && !tied ? top : null;
  }

  /** Admin force-end: resolve with the current leader (or draw) and run
   *  the normal reset funnel. No-op in rooms without a mode. */
  forceEnd(): boolean {
    const spec = this.host.modeSpec;
    if (!spec) return false;
    let w = 'draw';
    if (spec.teams) {
      const s = this.host.scores;
      w = s.alpha === s.bravo ? 'draw' : s.alpha > s.bravo ? 'alpha' : 'bravo';
    } else {
      let best = -Infinity;
      for (const [id, s] of this.host.ffaScores) {
        if (s > best) { best = s; w = id; }
      }
    }
    this.end(w);
    return true;
  }

  /** The reset funnel: end broadcast, journal, field reset, matchStart.
   *  Rotation lands between reset and matchStart so players spawn onto
   *  the NEW map (applySpec re-points spawnPoints) rather than eating
   *  one old-map spawn before mapUpdate lands. */
  end(w: string): void {
    const host = this.host;
    const spec = host.modeSpec!;
    const scores = spec.teams ? { ...host.scores } : Object.fromEntries(host.ffaScores);
    host.broadcast({ type: spec.teams ? 'matchEnd' : 'ffaMatchEnd', winner: w, scores } as ServerMessage);
    host.onMatchEnd?.({ room: host.room, mode: host.mode, winner: w, scores, players: host.matchPlayers() });
    host.scores.alpha = 0;
    host.scores.bravo = 0;
    host.ffaScores.clear();
    host.endCleanup();
    const next = host.rotate();
    if (next) host.applySpec(next);
    this.endsAt = Date.now() + spec.timeLimitS * 1000;
    this.warned = false;
    this.overtime = false;
    host.broadcast({ type: 'matchStart', mode: host.mode, scores: { ...host.scores } });
  }
}
