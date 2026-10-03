/**
 * shared/env — the ONLY host-environment seam shared code may touch.
 * Sims and shared modules never read process.env/Bun/fs/Date.now
 * directly: the host (server boot, test harness, browser entry) seeds
 * this once and shared code reads the snapshot. A browser bundle that
 * never calls setSharedEnv gets pure defaults — no `process` reference
 * can sneak into shared/ again.
 */

export interface SharedEnv {
  /** Substring match for the bot decision-chain trace (FPS_TRACE). */
  traceId?: string;
  /** Skip the muzzle-clearance probe in botHunt (FPS_NOMUZZLE). */
  noMuzzle?: boolean;
}

export const sharedEnv: SharedEnv = {};

export function setSharedEnv(env: SharedEnv): void {
  Object.assign(sharedEnv, env);
}

/**
 * sharedNow — the only clock shared code may read. Default = epoch-0
 * (deterministic under a host that forgot to seed it); the server
 * binds wallNow, browser binds performance.now-ish epoch mapping, and
 * scenario tests pin a fake. Cooldown-style uses get real ms once the
 * host seeds it — before that, quiet-by-default beats lying about time.
 */
let nowFn: () => number = () => 0;
export const sharedNow = (): number => nowFn();
export function setSharedNow(now: () => number): void { nowFn = now; }
