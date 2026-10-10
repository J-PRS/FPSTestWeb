/**
 * ballSpawn — BallSim's spawn + targeting family, split out so BallSim
 * stays about tick/segment cadence. Everything here answers "where does
 * a new ball appear" and "who is it pulling toward" — including the
 * committed target snapshot that keeps server and client replays on the
 * same aim point.
 */
import { type SimBall, type SimVec, type BallVariant, makeSimBall } from '../../shared/ballSim.ts';
import { WORLD_MODEL } from '../../shared/worldModel.ts';
import { type Heightfield, hmHeight } from '../../shared/heightfield.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';
import { simNow } from './simClock.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { ServerMessage } from './types.ts';

// 5% elite, otherwise weighted fodder sizes (v0 common, v1/v2 rare).
// Weights are cumulative so a map spec can override the whole table.
export const DEFAULT_MIX: readonly number[] = [0.84, 0.07, 0.04, 0.05];
export function rollVariant(mix: readonly number[] = DEFAULT_MIX, rng: () => number = Math.random): BallVariant {
  const total = mix[0]! + mix[1]! + mix[2]! + mix[3]!;
  let r = rng() * total;
  for (let i = 0; i < 4; i++) {
    r -= mix[i]!;
    if (r <= 0) return i as BallVariant;
  }
  return 0;
}

export function alivePlayers(players: PlayerManager): { id: string; pos: SimVec }[] {
  const out: { id: string; pos: SimVec }[] = [];
  for (const [id, p] of players.getAllPlayers()) {
    // Firing decloaks: a shot stamps the reveal window, so a cloaked
    // player who just shot is fodder again like everyone else.
    if (!p.isDead && (!(p.status & STATUS.CLOAK) || shootRevealed(p.lastFireSim, simNow()))) out.push({ id, pos: p.position });
  }
  return out;
}

/** Nearest alive, uncloaked player — the fodder target rule. */
export function nearestPlayer(b: SimBall, alive: { id: string; pos: SimVec }[]): { id: string; pos: SimVec } | null {
  let best: { id: string; pos: SimVec } | null = null;
  let bestD = Infinity;
  for (const p of alive) {
    const dx = p.pos.x - b.x;
    const dz = p.pos.z - b.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

export interface SpawnHost {
  field: Heightfield | null;
  rng: () => number;
  simTime: number;
  broadcast: (msg: ServerMessage) => void;
  players: PlayerManager;
  nextId: number;
  readonly balls: Map<number, SimBall>;
  readonly retargetAcc: Map<number, number>;
  readonly resyncAcc: Map<number, number>;
  snapTarget(b: SimBall): void;
  targetSnap(b: SimBall): SimVec | null;
}

export const RETARGET_INTERVAL = 2.0;  // seconds between nearest-player re-evals
export const RESYNC_INTERVAL = 1.2;
/** Worst-case replay drift tolerated before a resync heartbeat — the
 *  per-ball interval is min(RESYNC_INTERVAL, budget/speed). */
export const DIVERGENCE_BUDGET_M = 8;
/** Enraged legs replay off a stale aim snapshot while pulling hard at a
 *  moving target — divergence compounds faster than speed alone says,
 *  so they get a tighter budget. Inert legs stay on the flat one. */
export const ENRAGED_DIVERGENCE_BUDGET_M = 6;
export const BRAIN_BUCKETS = 8;

/** Create + broadcast a ball. near = spawn near a player (drip-feed);
 *  posOverride = splitter children at a corpse. */
export function spawnBall(h: SpawnHost, variant: BallVariant, near?: SimVec, posOverride?: SimVec): SimBall {
  const field = h.field!;
  let x: number, z: number;
  if (posOverride) {
    x = posOverride.x; z = posOverride.z;
  } else {
    const cx = near ? near.x : 0;
    const cz = near ? near.z : 0;
    const ang = h.rng() * Math.PI * 2;
    const dist = 60 + h.rng() * 60;
    x = cx + Math.cos(ang) * dist;
    z = cz + Math.sin(ang) * dist;
  }
  const y = posOverride ? posOverride.y : hmHeight(field, x, z) + 40 + h.rng() * 40;
  const ang = h.rng() * Math.PI * 2;
  const spd = h.rng() * 20;
  const b = makeSimBall(
    // Wrap below the demo format's lane base: demo targetIds are u16 and
    // 0x4000+ belongs to the deployable/creature/flag/pickup namespaces —
    // an uncapped counter leaks ball ids into those lanes in a long sim.
    (h.nextId = h.nextId % 0x3fff + 1), variant, Math.floor(h.rng() * 8),
    { x, y, z },
    { x: Math.cos(ang) * spd, y: -2, z: Math.sin(ang) * spd },
  );
  b.targetId = nearestPlayer(b, alivePlayers(h.players))?.id ?? null;
  h.snapTarget(b);
  h.retargetAcc.set(b.id, -RETARGET_INTERVAL * ((b.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
  h.resyncAcc.set(b.id, -RESYNC_INTERVAL * ((b.id % BRAIN_BUCKETS) / BRAIN_BUCKETS));
  h.balls.set(b.id, b);
  // The payload's field names come from the declaration — adding a wire
  // field means adding it to the table, so a spawn can't drift a key the
  // client never consumes.
  const spawnMsg: Record<string, unknown> = { type: 'ballSpawn', id: b.id };
  const fieldVals: Record<string, unknown> = {
    variant: b.variant, colorIdx: b.colorIdx,
    position: { x: b.x, y: b.y, z: b.z },
    velocity: { x: b.vx, y: b.vy, z: b.vz },
    targetId: b.targetId, tp: h.targetSnap(b),
    t: h.simTime,
  };
  for (const f of WORLD_MODEL.ball!.spawnFields!) spawnMsg[f.name] = fieldVals[f.name];
  h.broadcast(spawnMsg as ServerMessage);
  return b;
}

/** Freeze the pull/lunge aim into the sim ball. stepBall reads the
 *  snapshot, the wire carries it — both sides integrate the same input.
 *  (If the predictor aimed at the LIVE local player pos while the server
 *  aimed at its last-received pos, arcs diverged ~100m per segment.) */
export function snapTarget(players: PlayerManager, b: SimBall): void {
  const p = b.targetId ? players.getPlayer(b.targetId) : null;
  if (p && !p.isDead && (!(p.status & STATUS.CLOAK) || shootRevealed(p.lastFireSim, simNow()))) {
    b.tx = p.position.x; b.ty = p.position.y; b.tz = p.position.z;
    b.tgtValid = true;
  } else {
    b.tgtValid = false;
  }
}

export function targetSnap(b: SimBall): SimVec | null {
  return b.tgtValid ? { x: b.tx, y: b.ty, z: b.tz } : null;
}
