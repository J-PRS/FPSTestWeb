import type { Vec3, PlayerState } from './types.ts';
import { wallNow } from './wallClock.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 250;

export function clampPing(ping: number): number {
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
export function rewindPos(target: PlayerState, backMs: number): { x: number; y: number; z: number } {
  const h = target.history;
  if (h.length === 0) return target.position;
  const tAt = wallNow() - backMs;
  if (tAt <= h[0]!.t) return h[0]!;
  const last = h[h.length - 1]!;
  if (tAt >= last.t) return target.position;
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1]!.t <= tAt) {
      const a = h[i - 1]!, b = h[i]!;
      const f = (tAt - a.t) / Math.max(b.t - a.t, 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  return last;
}

// The shooter's view is stale by ping + jitter + interp buffer, so an
// honest claim can land where the target WAS anywhere across the lag
// window, not only at the rewound instant. Nearest point on the
// target's recorded path in [now-backMs-extraMs, now] bounds the error
// by the target's own measured motion instead of a flat slack.
export function rewindNearest(target: PlayerState, backMs: number, extraMs: number, pt: Vec3): Vec3 {
  const floor = wallNow() - backMs - extraMs;
  let best = rewindPos(target, backMs);
  let bestD = dist3(best, pt);
  for (const s of target.history) {
    if (s.t < floor) continue;
    const d = dist3(s, pt);
    if (d < bestD) { bestD = d; best = s; }
  }
  const d = dist3(target.position, pt);
  if (d < bestD) best = target.position;
  return best;
}

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
