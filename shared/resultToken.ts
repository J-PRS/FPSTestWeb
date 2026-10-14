/**
 * resultToken.ts — the leaderboard receipt. The server signs a match's
 * outcome record at matchEnd; a leaderboard submission is the demo file
 * plus this token. Verification replays the demo (shared sims) and
 * checks both the signature and the event-hash chain.
 *
 * Signing is HMAC-SHA256 via crypto.subtle — available in Bun AND the
 * browser, so clients can self-verify a receipt. Symmetric by design
 * for the pilot: the leaderboard service holds the same key. (Upgrade
 * path to ed25519 later if third-party verification ever matters —
 * same payload shape, different sig codec.)
 *
 * `eventHash` is the binding piece: a rolling FNV-1a over the room's
 * outcome event stream (kills, caps, banks, end). A submission can't
 * just claim a matching final score — the demo's events must re-derive
 * the same chain.
 */

export interface ResultPlayer {
  id: string;
  name?: string;
  team?: string;
  kills: number;
  deaths: number;
  score?: number;
}

export interface ResultToken {
  v: 1;
  matchId: string;
  room: string;
  mode: string;
  mapId?: string;
  endedAtMs: number; // wall clock
  winner: string;
  scores: Record<string, number>;
  players: ResultPlayer[];
  /** FNV-1a (hex) of the match's outcome-event stream — see feed(). */
  eventHash: string;
  sig: string | null; // hex HMAC-SHA256 over canonical bytes; null = unsigned dev mode
}

/** Deterministic byte form for signing — fixed field order, no
 *  incidental JSON key permutations. */
export function canonicalTokenBytes(t: Omit<ResultToken, 'sig'>): string {
  const players = t.players
    .map((p) => `${p.id}|${p.name ?? ''}|${p.team ?? ''}|${p.kills}|${p.deaths}|${p.score ?? ''}`)
    .join(';');
  const scores = Object.keys(t.scores).sort().map((k) => `${k}:${t.scores[k]}`).join(',');
  return `kribes-result/1|${t.matchId}|${t.room}|${t.mode}|${t.mapId ?? ''}|${t.endedAtMs}|${t.winner}|${scores}|${players}|${t.eventHash}`;
}

/** FNV-1a 32-bit over UTF-8 — the event-hash chain feed. Deterministic,
 *  cheap, dependency-free; collisions only matter if an attacker can
 *  also control the outcome stream, at which point the demo replay is
 *  the gate anyway. */
export function fnv1a(seed: number, text: string): number {
  let h = seed;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93) >>> 0;
  }
  return h >>> 0;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(token: Omit<ResultToken, 'sig'>, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(canonicalTokenBytes(token)));
  return hex(sig);
}

export async function verifyToken(token: ResultToken, secret: string): Promise<boolean> {
  if (token.sig === null) {return false;}
  const expected = await signToken(token, secret);
  // Constant-length compare — sigs are fixed-size hex, so equality is fine.
  return expected === token.sig;
}

export type VerifyVerdict =
  | 'valid' | 'bad-token' | 'bad-format' | 'impossible-trajectory'
  | 'event-mismatch' | 'hash-mismatch' | 'stale-version';
