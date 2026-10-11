/**
 * MatchJournal — match-end history: an in-memory ring (100 entries,
 * newest last) plus an append-only `logs/matches.jsonl` journal so the
 * leaderboard survives restarts. Split out of GameServer — it's a
 * self-contained reporting surface, no room coupling.
 */
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';
import { rotateLogIfBig } from './logRotate.ts';

interface MatchRec {
  t: number;
  room: string;
  mode: string;
  winner: string;
  scores: Record<string, number>;
  players?: { id: string; team?: string; kills: number; deaths: number }[];
}

const JOURNAL = join(import.meta.dir, '..', '..', 'logs', 'matches.jsonl');

export class MatchJournal {
  private ring: Omit<MatchRec, never>[] = [];

  /** Path injectable so tests aggregate in a tmp dir, not the live logs/. */
  constructor(private journalPath = JOURNAL) {}

  recordEnd(rec: {
    room: string; mode: string; winner: string; scores: Record<string, number>;
    players?: { id: string; team?: string; kills: number; deaths: number }[];
  }): void {
    const entry = { t: wallNow(), ...rec };
    this.ring.push(entry);
    if (this.ring.length > 100) {this.ring.shift();}
    try {
      mkdirSync(join(this.journalPath, '..'), { recursive: true });
      rotateLogIfBig(this.journalPath);
      appendFileSync(this.journalPath, `${JSON.stringify(entry)  }\n`);
    } catch (error) {
      logger.warn('Match journal write failed', { err: String(error) });
    }
  }

  /** Recent match results — newest last. */
  list(): unknown[] {
    return this.ring;
  }

  /** The journal only grows via recordEnd — cache the aggregate on file
   *  size so a /stats poll storm reparses only when a match lands, not
   *  per request. */
  private statsCache: { size: number; rows: unknown[] } | null = null;

  /** Lifetime leaderboard read off the match journal — survives restarts
   *  since matches.jsonl is append-only. */
  async stats(): Promise<unknown[]> {
    interface Row { playerId: string; matches: number; wins: number; kills: number; deaths: number }
    const file = Bun.file(this.journalPath);
    let size = -1;
    try { size = file.size; } catch { /* no journal yet */ }
    if (size >= 0 && this.statsCache?.size === size) {return this.statsCache.rows;}
    const agg = new Map<string, Row>();
    try {
      const text = await file.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) {continue;}
        let rec: { winner?: string; players?: { id: string; team?: string; kills?: number; deaths?: number }[] };
        try { rec = JSON.parse(line); } catch { continue; }
        for (const p of rec.players ?? []) {
          const row = agg.get(p.id) ?? { playerId: p.id, matches: 0, wins: 0, kills: 0, deaths: 0 };
row.matches += 1;
          row.kills += p.kills ?? 0;
          row.deaths += p.deaths ?? 0;
          // FFA records name the player; team records name the side.
          if (rec.winner === p.id || (p.team && rec.winner === p.team)) {row.wins += 1;}
          agg.set(p.id, row);
        }
      }
    } catch { /* no journal yet — empty leaderboard */ }
    const rows = [...agg.values()].toSorted((a, b) => b.wins - a.wins || b.kills - a.kills);
    if (size >= 0) {this.statsCache = { size, rows };}
    return rows;
  }
}
