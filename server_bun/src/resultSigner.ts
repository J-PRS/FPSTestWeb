/**
 * resultSigner.ts — per-room receipt minter. Subscribes to the room's
 * event bus, accumulates a rolling eventHash over every bus event, and
 * mints a signed ResultToken at matchEnd. Reset happens inside mint so
 * the next match starts a fresh chain.
 *
 * The hash covers the WHOLE bus stream, not a curated subset — every
 * event the room fanned out is an outcome the demo must account for.
 * Sim-time stamps are quantized to 50ms so a verifier replaying at the
 * same grid re-derives byte-identical records.
 */
import { fnv1a, signToken, type ResultToken } from '../../shared/resultToken.ts';
import type { RoomEvent } from './roomEvents.ts';
import { simNow } from './simClock.ts';

/** Deterministic stringify: object keys sorted at every depth, functions
 *  dropped, floats quantized to 1e-3 (positions only need mm precision —
 *  coarser just invites float-format drift between writer and verifier). */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number') {return Number.isFinite(v) ? v.toFixed(3) : 'x';}
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {return `[${v.map(canon).join(',')}]`;}
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

export interface MatchRecord {
  room: string; mode: string; winner: string;
  scores: Record<string, number>;
  players: { id: string; team?: string; kills: number; deaths: number }[];
}

export class ResultSigner {
  private hash = 0x811C9DC5;
  private n = 0;
  private seq = 0;
  constructor(
    private readonly secret: string | null,
    private readonly matchIdOf: () => string,
  ) {}

  feed(e: RoomEvent): void {
    this.seq += 1;
    this.hash = fnv1a(this.hash, `${this.seq}|${Math.round(simNow() / 50)}|${canon(e)}`);
    this.n += 1;
  }

  /** Mint the signed receipt; resets the chain for the next match. */
  async mint(rec: MatchRecord, mapId?: string): Promise<ResultToken> {
    const token: ResultToken = {
      v: 1,
      matchId: this.matchIdOf(),
      room: rec.room,
      mode: rec.mode,
      mapId,
      endedAtMs: Date.now(),
      winner: rec.winner,
      scores: rec.scores,
      players: (rec.players ?? []).map((p) => ({ id: p.id, team: p.team, kills: p.kills, deaths: p.deaths })),
      eventHash: `${this.n}:${this.hash.toString(16).padStart(8, '0')}`,
      sig: null,
    };
    this.hash = 0x811C9DC5;
    this.n = 0;
    this.seq = 0;
    if (this.secret) {token.sig = await signToken(token, this.secret);}
    return token;
  }
}

/** Env key — absent means unsigned dev tokens (shape-verifiable but not
 *  forgery-proof; the leaderboard rejects unsigned in prod). */
export const SIGN_SECRET = process.env.KRIBES_SIGN_KEY ?? null;
let seq = 0;
export const nextMatchId = (room: string): string => `${room}-${Date.now().toString(36)}-${(seq += 1)}`;
