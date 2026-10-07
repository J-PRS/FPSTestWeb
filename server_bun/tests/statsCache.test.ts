import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchJournal } from '../src/matchJournal.ts';

// /stats is a public route — the aggregate must not reparse the whole
// append-only journal per request. The cache is keyed on file size, so
// a poll storm reparses only when a match lands.
describe('MatchJournal stats cache', () => {
  it('serves repeat reads from cache while the file is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mjstats-'));
    const path = join(dir, 'matches.jsonl');
    try {
      writeFileSync(path, JSON.stringify({
        winner: 'red', players: [
          { id: 'p1', team: 'red', kills: 5, deaths: 1 },
          { id: 'p2', team: 'blu', kills: 1, deaths: 5 },
        ],
      }) + '\n');
      const mj = new MatchJournal(path);
      const a = await mj.stats();
      const b = await mj.stats();
      // Cache hit returns the same rows object — a reparse would re-sort
      // into a fresh array.
      expect(b).toBe(a);
      expect((a as { playerId: string; wins: number }[])[0]).toMatchObject({ playerId: 'p1', wins: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-aggregates when the journal grows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mjstats-'));
    const path = join(dir, 'matches.jsonl');
    try {
      writeFileSync(path, JSON.stringify({
        winner: 'red', players: [{ id: 'p1', team: 'red', kills: 5, deaths: 1 }],
      }) + '\n');
      const mj = new MatchJournal(path);
      await mj.stats();
      appendFileSync(path, JSON.stringify({
        winner: 'blu', players: [{ id: 'p2', team: 'blu', kills: 9, deaths: 0 }],
      }) + '\n');
      const rows = await mj.stats() as { playerId: string; wins: number }[];
      expect(rows.find(r => r.playerId === 'p2')?.wins).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
