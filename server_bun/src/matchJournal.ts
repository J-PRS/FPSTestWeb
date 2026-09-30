/**
 * MatchJournal — match-end history: an in-memory ring (100 entries,
 * newest last) plus an append-only `logs/matches.jsonl` journal so the
 * leaderboard survives restarts. Split out of GameServer — it's a
 * self-contained reporting surface, no room coupling.
 */
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { logger } from './logger.ts';

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

  recordEnd(rec: {
    room: string; mode: string; winner: string; scores: Record<string, number>;
    players?: { id: string; team?: string; kills: number; deaths: number }[];
  }): void {
    const entry = { t: Date.now(), ...rec };
    this.ring.push(entry);
    if (this.ring.length > 100) this.ring.shift();
    try {
      mkdirSync(join(JOURNAL, '..'), { recursive: true });
      appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');
    } catch (e) {
      logger.warn('Match journal write failed', { err: String(e) });
    }
  }

  /** Recent match results — newest last. */
  list(): unknown[] {
    return this.ring;
  }

  /** Lifetime leaderboard read off the match journal — survives restarts
   *  since matches.jsonl is append-only. Read-per-request is fine at this
   *  scale; cache it if the file ever grows past a few MB. */
  async stats(): Promise<unknown[]> {
    interface Row { playerId: string; matches: number; wins: number; kills: number; deaths: number }
    const agg = new Map<string, Row>();
    try {
      const file = Bun.file(JOURNAL);
      const text = await file.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec: { winner?: string; players?: { id: string; team?: string; kills?: number; deaths?: number }[] };
        try { rec = JSON.parse(line); } catch { continue; }
        for (const p of rec.players ?? []) {
          const row = agg.get(p.id) ?? { playerId: p.id, matches: 0, wins: 0, kills: 0, deaths: 0 };
          row.matches++;
          row.kills += p.kills ?? 0;
          row.deaths += p.deaths ?? 0;
          // FFA records name the player; team records name the side.
          if (rec.winner === p.id || (p.team && rec.winner === p.team)) row.wins++;
          agg.set(p.id, row);
        }
      }
    } catch { /* no journal yet — empty leaderboard */ }
    return [...agg.values()].toSorted((a, b) => b.wins - a.wins || b.kills - a.kills);
  }
}
