/**
 * Lag-compensation rewind buffer — how far back hit validation may
 * place a target. The position-report path and the server-bot feeder
 * MUST agree on the window or they rewind different pasts for the
 * same check.
 */
export const REWIND_MS = 400;

/** Client remote-render delay: SnapshotBuffer holds ~BASE(100) +
 *  arrival interval (~50 at 20Hz) + jitter headroom (~50) behind the
 *  newest snapshot before interpolating — every visible ghost rides
 *  ~200ms of simulation behind what the broadcast emitted. Anything
 *  validating against what the shooter SAW (blast sweeps, beam rays)
 *  must rewind ping + this, minus the broadcast lead. */
export const RENDER_LAG_MS = 200;

export function pushRewindSample(
  p: { history: { t: number; x: number; y: number; z: number }[]; position: { x: number; y: number; z: number } },
  now: number,
): void {
  p.history.push({ t: now, x: p.position.x, y: p.position.y, z: p.position.z });
  while (p.history.length > 0 && p.history[0]!.t < now - REWIND_MS) p.history.shift();
}
