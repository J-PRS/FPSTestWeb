import type { Vec3, PlayerState } from './types.ts';
import { wallNow } from './wallClock.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 400;

export function clampPing(ping: number): number {
  // NaN ping: Math.max(NaN,0)=NaN — rewindPos then walks history with a
  // NaN target and validates against a garbage sample. No ping = 0.
  if (!Number.isFinite(ping)) {return 0;}
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

/** The shooter's one-way uplink transit. transitOf already IS one-way
 *  (feedTransit stores rtt/2; feedUplink stores arrival−fireAt) — it
 *  passes through verbatim. Only the cold-probe fallback is an RTT and
 *  earns the halve. (A blanket /2 here under-rewound every lag-comp
 *  ghost by half the real uplink — the same class as the 0.35·RTT
 *  client mirror.) */
export function shooterTransitMs(transitOf: ((playerId: string) => number) | undefined, shooterId: string, fallbackPingRtt: number): number {
  const t = transitOf?.(shooterId) ?? 0;
  return t > 0 ? t : clampPing(fallbackPingRtt) / 2;
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
export function rewindPos(target: PlayerState, backMs: number): { x: number; y: number; z: number } {
  const h = target.history;
  // NaN backMs: every t-comparison below is false — the walk returns a
  // garbage sample instead of the present. Present is the safe answer.
  if (h.length === 0 || !Number.isFinite(backMs)) {return target.position;}
  const tAt = wallNow() - backMs;
  if (tAt <= h[0]!.t) {return h[0]!;}
  const last = h[h.length - 1]!;
  if (tAt >= last.t) {return target.position;}
  for (let i = h.length - 1; i > 0; i -= 1) {
    if (h[i - 1]!.t <= tAt) {
      const a = h[i - 1]!, b = h[i]!;
      const f = (tAt - a.t) / Math.max(b.t - a.t, 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  return last;
}

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
    if (s.t < floor) {continue;}
    const d = dist3(s, pt);
    if (d < bestD) { bestD = d; best = s; }
  }
  const d = dist3(target.position, pt);
  if (d < bestD) {best = target.position;}
  return best;
}
