// Leaderboard — the pilot service riding the demo-verification stack.
//
// Submission = one .demo file. The gates, cheapest first:
//   1. format     — deserializeDemo throws on anything malformed
//   2. receipt    — an embedded matchToken whose HMAC verifies under
//                   KRIBES_SIGN_KEY. This is THE gate: the server only
//                   attests matches it witnessed end-to-end, so a
//                   fabricated run can't mint a token at all.
//   3. recompute  — stats come from the event stream, never a claim:
//                   kills (Hit → ball lane), shots (Fired), spawns.
//
// Verdict rows append to logs/leaderboard.jsonl — the same append-only
// journal pattern as matchJournal. Rejections are logged too (appeals
// and tuning need the evidence), just not ranked.
//
// What this pilot does NOT verify: trajectory/event re-simulation lives
// in _tools/verify.ts and needs the hmap+sim harness — the receipt gate
// already covers "was this a real match", and a valid token means the
// server itself recorded these outcomes. The deep replay is the audit
// tier for disputed entries, not the submission path.

import { join } from 'node:path';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { deserializeDemo } from '../../client/src/demo/demoReader.ts';
import { verifyToken } from '../../shared/resultToken.ts';
import { ProjectileEventType, TargetEventType } from '../../client/src/demo/types.ts';
import { SIGN_SECRET } from './resultSigner.ts';
import { wallNow } from './wallClock.ts';
import { logger } from './logger.ts';

const BOARD = join(import.meta.dir, '..', '..', 'logs', 'leaderboard.jsonl');
mkdirSync(join(import.meta.dir, '..', '..', 'logs'), { recursive: true });

export interface BoardEntry {
  t: number;
  matchId: string;
  room: string;
  mode: string;
  player: string;
  kills: number;
  shots: number;
  spawns: number;
  durationS: number;
  ok: true;
}

export interface SubmitResult {
  ok: boolean;
  verdict: 'ranked' | 'bad-format' | 'no-token' | 'bad-token' | 'duplicate';
  entry?: BoardEntry;
  error?: string;
}

// Seen (matchId, player) pairs — resubmitting the same match can't
// double-post. Module-level: the jsonl is the source of truth on boot.
const seen = new Set<string>();
if (existsSync(BOARD)) {
  for (const line of readFileSync(BOARD, 'utf8').split('\n')) {
    if (!line.trim()) { continue; }
    try {
      const e = JSON.parse(line) as { ok?: boolean; matchId?: string; player?: string };
      if (e.ok && e.matchId) { seen.add(`${e.matchId}|${e.player}`); }
    } catch { /* corrupt line — skip, the file is append-only */ }
  }
}

export async function submitDemo(buf: ArrayBuffer): Promise<SubmitResult> {
  let demo;
  try {
    demo = deserializeDemo(buf);
  } catch (error) {
    return { ok: false, verdict: 'bad-format', error: (error as Error).message };
  }
  const tk = demo.matchToken;
  if (!tk) { return { ok: false, verdict: 'no-token' }; }
  if (!SIGN_SECRET) { return { ok: false, verdict: 'bad-token', error: 'server has no signing key — cannot attest' }; }
  if (!(await verifyToken(tk, SIGN_SECRET))) { return { ok: false, verdict: 'bad-token' }; }

  const player = demo.header.playerName || 'unknown';
  const key = `${tk.matchId}|${player}`;
  if (seen.has(key)) { return { ok: false, verdict: 'duplicate' }; }

  const shots = demo.projectileEvents.filter(e => e.eventType === ProjectileEventType.Fired).length;
  const kills = demo.projectileEvents.filter(e =>
    e.eventType === ProjectileEventType.Hit && e.targetId !== 0 && e.targetType < 64).length;
  const spawns = demo.targetEvents.filter(e => e.eventType === TargetEventType.Spawned).length;

  const entry: BoardEntry = {
    t: wallNow(),
    matchId: tk.matchId,
    room: tk.room,
    mode: tk.mode,
    player,
    kills, shots, spawns,
    durationS: Math.round(demo.header.duration * 10) / 10,
    ok: true,
  };
  seen.add(key);
  appendFileSync(BOARD, `${JSON.stringify(entry)}\n`);
  logger.info('Leaderboard ranked', { player, kills, matchId: tk.matchId });
  return { ok: true, verdict: 'ranked', entry };
}

// Board: best entry per player per mode, kills desc then accuracy desc.
export function board(mode?: string): BoardEntry[] {
  if (!existsSync(BOARD)) { return []; }
  const best = new Map<string, BoardEntry>();
  for (const line of readFileSync(BOARD, 'utf8').split('\n')) {
    if (!line.trim()) { continue; }
    try {
      const e = JSON.parse(line) as BoardEntry;
      if (!e.ok) { continue; }
      if (mode && e.mode !== mode) { continue; }
      const cur = best.get(`${e.mode}|${e.player}`);
      const acc = (x: BoardEntry): number => (x.shots > 0 ? x.kills / x.shots : 0);
      if (!cur || e.kills > cur.kills || (e.kills === cur.kills && acc(e) > acc(cur))) {
        best.set(`${e.mode}|${e.player}`, e);
      }
    } catch { /* skip corrupt lines */ }
  }
  return [...best.values()]
    .toSorted((a, b) => b.kills - a.kills || b.shots - a.shots)
    .slice(0, 50);
}
