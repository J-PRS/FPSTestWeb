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
export function renderLagOf(p: { clientStats?: { renderLagMs?: number; at?: number } } | null | undefined): number {
  const st = p?.clientStats;
  // A report older than ~3 uplink windows describes a link state that
  // may no longer exist — fall back to the base constant rather than
  // let a stale (or dead-session) number steer validation forever.
  if (!st || st.renderLagMs == null || (st.at !== undefined && wallNow() - st.at > 30_000)) {return RENDER_LAG_MS;}
  // Client-claimed: Math.max(NaN,0)=NaN — a poisoned claim returns NaN,
  // the rewind target goes NaN, and every hit validation whiffs silently.
  if (!Number.isFinite(st.renderLagMs)) {return RENDER_LAG_MS;}
  return Math.min(Math.max(st.renderLagMs, 0), 800);
}

/** Per-victim render delay: the shooter's ghost lag for THIS target.
 *  A single max-across-remotes rewinds a fast victim ~500ms behind the
 *  ghost the shooter actually saw — the "damage numbers, no damage"
 *  class of miss. Falls back to the max when the map's absent (old
 *  client) or lacks the id (bot/creature/streamed late). */
export function renderLagOfTarget(
  p: { clientStats?: { renderLagMs?: number; renderLag?: Record<string, number>; at?: number } } | null | undefined,
  targetId: string,
): number {
  const st = p?.clientStats;
  if (st?.renderLag && !(st.at !== undefined && wallNow() - st.at > 30_000)) {
    const v = st.renderLag[targetId];
    if (v !== undefined && Number.isFinite(v)) {return Math.min(Math.max(v, 0), 800);}
  }
  return renderLagOf(p);
}

export function pushRewindSample(
  p: { history: { t: WallMs; x: number; y: number; z: number }[]; position: { x: number; y: number; z: number } },
  now: WallMs,
): void {
  // A non-finite position would rewind hit validation to a NaN ghost —
  // every check against this window whiffs. Skip the sample instead.
  if (!Number.isFinite(p.position.x + p.position.y + p.position.z)) {return;}
  p.history.push({ t: now, x: p.position.x, y: p.position.y, z: p.position.z });
  // Trim stale head entries with one scan + one splice — the old
  // per-push shift() loop was O(n²) over ~60 entries × ~25Hz/player.
  const h = p.history;
  let i = 0;
  while (i < h.length && h[i]!.t < now - REWIND_MS) {i += 1;}
  if (i > 0) {h.splice(0, i);}
}
