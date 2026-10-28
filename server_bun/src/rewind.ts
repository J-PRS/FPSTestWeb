/**
 * Lag-compensation rewind buffer — how far back hit validation may
 * place a target. The position-report path and the server-bot feeder
 * MUST agree on the window or they rewind different pasts for the
 * same check.
 */
import { wallNow, type WallMs } from './wallClock.ts';

// Depth covers the worst rewind envelope: clampPing(~400) + adaptive
// render lag (~800) — a shorter buffer would clamp deep rewinds to the
// oldest sample and validate arbitrarily far behind the real ghost.
export const REWIND_MS = 1200;

/** Client remote-render delay: SnapshotBuffer holds ~BASE(100) +
 *  arrival interval (~50 at 20Hz) + jitter headroom (~50) behind the
 *  newest snapshot before interpolating — every visible ghost rides
 *  ~200ms of simulation behind what the broadcast emitted. Anything
 *  validating against what the shooter SAW (blast sweeps, beam rays)
 *  must rewind ping + this, minus the broadcast lead. */
export const RENDER_LAG_MS = 200;

/** The client's remote-render delay adapts to the observed link — the
 *  snapshot buffer stretches to ~800ms under heavy jitter/suppression,
 *  so a fixed 200ms understates the ghost lag exactly where links are
 *  bad. The client reports its worst-case delay via clientStats; this
 *  clamps it to the buffer's own ceiling (SnapshotBuffer.MAX_INTERP_DELAY
 *  mirrored — a bigger claim can't rewind past the buffer anyway). */
export function renderLagOf(p: { clientStats?: { renderLagMs?: number; at?: number } } | null | undefined, bound = 800): number {
  const st = p?.clientStats;
  // A report older than ~3 uplink windows describes a link state that
  // may no longer exist — fall back to the base constant rather than
  // let a stale (or dead-session) number steer validation forever.
  if (!st || st.renderLagMs == null || (st.at !== undefined && wallNow() - st.at > 30_000)) {return Math.min(RENDER_LAG_MS, bound);}
  // Client-claimed: Math.max(NaN,0)=NaN — a poisoned claim returns NaN,
  // the rewind target goes NaN, and every hit validation whiffs silently.
  if (!Number.isFinite(st.renderLagMs)) {return Math.min(RENDER_LAG_MS, bound);}
  return Math.min(Math.max(st.renderLagMs, 0), bound);
}

/** Server-observed ceiling for a shooter's claimed render lag. The
 *  claim is a hint, not evidence: a low-ping client claiming 800ms of
 *  staleness buys rewind their link never justified (the classic
 *  favor-the-cheater window). The bound is the base delay the interp
 *  buffer always carries plus 2× measured uplink + 3× measured jitter —
 *  uplink transit/variance proxies the downlink behavior on the same
 *  path, and no honest claim can outgrow what the path actually does. */
export function renderLagBoundOf(
  transitOf: ((playerId: string) => number) | undefined,
  transitVarOf: ((playerId: string) => number) | undefined,
  playerId: string,
): number {
  const transit = transitOf?.(playerId) ?? 0;
  const jit = transitVarOf?.(playerId) ?? 0;
  // Casual-floor: every player gets a fair hit-what-you-see window even on
  // a perfect link — the exploit case is the ceiling, not the floor.
  return Math.min(Math.max(RENDER_LAG_MS + 2 * transit + 3 * jit, 350), 800);
}

/** Per-victim render delay: the shooter's ghost lag for THIS target.
 *  A single max-across-remotes rewinds a fast victim ~500ms behind the
 *  ghost the shooter actually saw — the "damage numbers, no damage"
 *  class of miss. Falls back to the max when the map's absent (old
 *  client) or lacks the id (bot/creature/streamed late). */
export function renderLagOfTarget(
  p: { clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number } } | null | undefined,
  targetId: string,
  bound = 800,
): number {
  const st = p?.clientStats;
  if (st?.renderLag && !(st.at !== undefined && wallNow() - st.at > 30_000)) {
    const v = st.renderLag[targetId];
    if (v !== undefined && Number.isFinite(v)) {return Math.min(Math.max(v, 0), bound);}
  }
  return renderLagOf(p, bound);
}

/** Sample-object freelist — pushRewindSample runs ~25Hz/player, so the
 *  {t,x,y,z} alloc was ~2.5K objects/s at a full room. Trims recycle
 *  into the pool; consumers read sample fields transiently, never
 *  retain the object past the call, so reuse can't leak stale reads. */
const samplePool: { t: WallMs; x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
const SAMPLE_POOL_MAX = 8192;

export function pushRewindSample(
  p: { history: { t: WallMs; x: number; y: number; z: number; vx: number; vy: number; vz: number }[]; position: { x: number; y: number; z: number }; velocity?: { x: number; y: number; z: number } },
  now: WallMs,
): void {
  // A non-finite position would rewind hit validation to a NaN ghost —
  // every check against this window whiffs. Skip the sample instead.
  if (!Number.isFinite(p.position.x + p.position.y + p.position.z)) {return;}
  const v = p.velocity ?? { x: 0, y: 0, z: 0 };
  const s = samplePool.pop() ?? { t: 0 as WallMs, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  s.t = now; s.x = p.position.x; s.y = p.position.y; s.z = p.position.z;
  s.vx = v.x; s.vy = v.y; s.vz = v.z;
  p.history.push(s);
  // Trim stale head entries with one scan + one splice — the old
  // per-push shift() loop was O(n²) over ~60 entries × ~25Hz/player.
  const h = p.history;
  let i = 0;
  while (i < h.length && h[i]!.t < now - REWIND_MS) {i += 1;}
  if (i > 0) {
    for (let j = 0; j < i; j += 1) {if (samplePool.length < SAMPLE_POOL_MAX) {samplePool.push(h[j]!);}}
    h.splice(0, i);
  }
}
