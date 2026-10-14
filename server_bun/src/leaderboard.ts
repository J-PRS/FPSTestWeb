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
import { verifyToken, verifyChallenge, signChallenge, type Challenge } from '../../shared/resultToken.ts';
import { ProjectileEventType, TargetEventType } from '../../client/src/demo/types.ts';
import { SIGN_SECRET } from './resultSigner.ts';
import { wallNow } from './wallClock.ts';
import { verifySolo } from './verifySolo.ts';
import { logger } from './logger.ts';

const BOARD = join(import.meta.dir, '..', '..', 'logs', 'leaderboard.jsonl');
mkdirSync(join(import.meta.dir, '..', '..', 'logs'), { recursive: true });

export interface BoardEntry {
  t: number;
  attest: 'token' | 'seed';   // token = server-witnessed match; seed = challenge-bound solo run
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
  verdict: 'ranked' | 'bad-format' | 'no-token' | 'bad-token' | 'duplicate' | 'event-mismatch' | 'impossible-trajectory';
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

// Challenge mint — one call = one seed the client must bind runSeed to.
// Short expiry: hoarded seeds would let a client precompute legal runs.
const CHALLENGE_TTL_MS = 30 * 60_000;
export async function mintChallenge(): Promise<Challenge | null> {
  if (!SIGN_SECRET) {return null;}   // keyless server can't attest anything
  const seed = (Math.random() * 0xFF_FF_FF_FF) >>> 0;
  const exp = wallNow() + CHALLENGE_TTL_MS;
  return { seed, exp, sig: await signChallenge(seed, exp, SIGN_SECRET) };
}

export async function submitDemo(buf: ArrayBuffer, challenge?: Challenge | null): Promise<SubmitResult> {
  let demo;
  try {
    demo = deserializeDemo(buf);
  } catch (error) {
    return { ok: false, verdict: 'bad-format', error: (error as Error).message };
  }
  const tk = demo.matchToken;
  let attest: BoardEntry['attest'] = 'token';
  if (!SIGN_SECRET) { return { ok: false, verdict: 'bad-token', error: 'server has no signing key — cannot attest' }; }
  if (tk) {
    if (!(await verifyToken(tk, SIGN_SECRET))) { return { ok: false, verdict: 'bad-token' }; }
  } else {
    // Solo path — no server witnessed the run, so the runSeed must bind
    // to a challenge this server minted: the client couldn't pick the
    // dice stream, which is what makes the spawn-dice gates meaningful.
    attest = 'seed';
    if (!challenge || !(await verifyChallenge(challenge, SIGN_SECRET, wallNow()))) {
      return { ok: false, verdict: 'no-token', error: 'solo submissions need a live challenge seed (GET /challenge)' };
    }
    if (challenge.seed !== demo.header.runSeed) {
      return { ok: false, verdict: 'bad-token', error: 'runSeed does not match the minted challenge' };
    }
    if (!demo.header.runSeed) { return { ok: false, verdict: 'bad-token', error: 'unseeded demo' }; }
    // The seed binding alone is cosmetic — replay the dice stream and
    // require the recorded events to land on it before ranking.
    const sv = verifySolo(demo);
    if (!sv.ok) {
      return { ok: false,
        verdict: sv.reason?.startsWith('impossible-trajectory') ? 'impossible-trajectory' : 'event-mismatch',
        error: sv.reason };
    }
  }

  const player = demo.header.playerName || 'unknown';
  const matchId = tk?.matchId ?? `solo-${demo.header.runSeed.toString(16)}`;
  const key = `${matchId}|${player}`;
  if (seen.has(key)) { return { ok: false, verdict: 'duplicate' }; }

  const shots = demo.projectileEvents.filter(e => e.eventType === ProjectileEventType.Fired).length;
  const kills = demo.projectileEvents.filter(e =>
    e.eventType === ProjectileEventType.Hit && e.targetId !== 0 && e.targetType < 64).length;
  const spawns = demo.targetEvents.filter(e => e.eventType === TargetEventType.Spawned).length;

  const entry: BoardEntry = {
    t: wallNow(),
    matchId,
    room: tk ? tk.room : demo.header.room,
    mode: tk ? tk.mode : demo.header.mode,
    player,
    kills, shots, spawns,
    durationS: Math.round(demo.header.duration * 10) / 10,
    attest,
    ok: true,
  };
  seen.add(key);
  appendFileSync(BOARD, `${JSON.stringify(entry)}\n`);
  logger.info('Leaderboard ranked', { player, kills, matchId });
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
