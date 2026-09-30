/**
 * Lag-compensation rewind buffer — how far back hit validation may
 * place a target. The position-report path and the server-bot feeder
 * MUST agree on the window or they rewind different pasts for the
 * same check.
 */
export const REWIND_MS = 400;

export function pushRewindSample(
  p: { history: { t: number; x: number; y: number; z: number }[]; position: { x: number; y: number; z: number } },
  now: number,
): void {
  p.history.push({ t: now, x: p.position.x, y: p.position.y, z: p.position.z });
  while (p.history.length > 0 && p.history[0]!.t < now - REWIND_MS) p.history.shift();
}
