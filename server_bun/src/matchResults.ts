/** matchResults — one JSON file per game end / room close so balancing
 *  reads come from a pile of real outcomes, not memory. Server rooms
 *  dump on endMatch AND dispose (a room that never reached a finish
 *  still leaves its mid-match state); offline clients POST their local
 *  report to /results and land in the same pile. */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR } from './clientLogs.ts';
import { wallNow } from './wallClock.ts';

const RESULTS_DIR = join(LOGS_DIR, 'results');

export interface PlayerResult {
  id: string; name?: string; team?: string; bot?: boolean;
  armorClass?: string; weapon?: number; gunRung?: number;
  perk?: string;
  kills: number; deaths: number; streak?: number;
  health: number; maxHealth: number; heldTokens?: number;
  /** Bot brain spec (aim/move/courage/thrift + tier) - undefined on humans. */
  skill?: unknown;
  /** Energy economy read - drain/regen/max for jet-skill balance. */
  econ?: unknown;
  /** Movement signature - ski+air/air/jet % + pace + covered (bots;
   *  humans' loco rides the client scoreboard). */
  loco?: unknown;
}

export interface MatchResult {
  kind: 'server' | 'client';
  room: string; mode?: string; map?: string;
  endedAt: number; reason: string;
  /** Wall-clock room mint + lifetime - lets the pile answer "how long
   *  do matches actually run" and "which modes bleed longest". */
  startedAt?: number; durationMs?: number;
  winner?: string; scores?: Record<string, number>;
  /** Full replay flushed this room (FPS_DEMO) - result row names its
   *  demo so a balance read can jump straight to the footage. */
  demo?: string;
  players: PlayerResult[];
}

/** Per-room state readers the collector needs - kept structural so the
 *  Room dep surface stays unchanged. */
export interface ResultsHost {
  name: string; mode?: string; mapSrc?: string;
  createdAt?: number;
  spec?: { name?: string };
  scores?: unknown;
  ffaScores?: Map<string, number>;
  players: { getAllPlayers(): Map<string, { id: string; name?: string; team?: string; isBot?: boolean; armorClass?: string; weapon?: number; gunRung?: number; perk?: string; kills: number; deaths: number; streak?: number; health: number; maxHealth: number; heldTokens?: number }> };
}

/** File-per-result: <wallms>-<room>-<reason>.json in logs/results/. */
export function writeMatchResult(result: MatchResult, dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.endedAt}-${result.room.replace(/[^\w-]/g, '_')}-${result.reason}.json`);
  appendFileSync(path, JSON.stringify(result, null, 2));
  return path;
}

/** Server-side collect: room meta + every seat's outcome/skill/econ. */
export function collectServerResult(host: ResultsHost, reason: string, opts: { winner?: string; demo?: string; skillOf?: (id: string) => unknown; econOf?: (id: string) => unknown; locoOf?: (id: string) => unknown } = {}): MatchResult {
  const players: PlayerResult[] = [];
  for (const p of host.players.getAllPlayers().values()) {
    players.push({
      id: p.id, name: p.name, team: p.team, bot: p.isBot,
      armorClass: p.armorClass, weapon: p.weapon, gunRung: p.gunRung, perk: p.perk,
      kills: p.kills, deaths: p.deaths, streak: p.streak,
      health: p.health, maxHealth: p.maxHealth, heldTokens: p.heldTokens,
      skill: opts.skillOf?.(p.id), econ: opts.econOf?.(p.id), loco: opts.locoOf?.(p.id),
    });
  }
  return {
    kind: 'server', room: host.name, mode: host.mode,
    map: host.spec?.name ?? host.mapSrc,
    endedAt: wallNow(), reason,
    startedAt: host.createdAt,
    durationMs: host.createdAt !== undefined ? wallNow() - host.createdAt : undefined,
    winner: opts.winner, demo: opts.demo,
    scores: host.scores !== undefined ? Object.assign({}, host.scores) as Record<string, number>
      : (host.ffaScores ? Object.fromEntries(host.ffaScores) : undefined),
    players,
  };
}

/** POST /results - offline/local games ship their own match report;
 *  same pile as the server dumps so balance reads see both worlds.
 *  Body is the MatchResult JSON (kind 'client'); stamped/stored as-is. */
export async function matchResultsRoute(req: Request, cors: (body: BodyInit | null, init?: ResponseInit) => Response): Promise<Response> {
  try {
    const body = await req.text();
    if (body.length > 512 * 1024) {return cors('Too large', { status: 413 });}
    const parsed = JSON.parse(body) as Partial<MatchResult>;
    if (typeof parsed.room !== 'string' || !Array.isArray(parsed.players)) {
      return cors('Bad result', { status: 400 });
    }
    const result: MatchResult = {
      kind: 'client',
      room: parsed.room, mode: parsed.mode, map: parsed.map,
      endedAt: typeof parsed.endedAt === 'number' ? parsed.endedAt : wallNow(),
      startedAt: parsed.startedAt, durationMs: parsed.durationMs,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'client',
      winner: parsed.winner, scores: parsed.scores,
      players: parsed.players as PlayerResult[],
    };
    writeMatchResult(result);
    return cors('ok');
  } catch {
    return cors('Bad JSON', { status: 400 });
  }
}
