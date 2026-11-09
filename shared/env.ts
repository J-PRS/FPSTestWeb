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
  /** Goal-pick decision trace in botGoals (BOTGOALS_DEBUG). */
  botGoalsDebug?: boolean;
  /** Wall perf clock for opt-in profiling inside shared sims — NOT the
   *  sim clock; seeded alongside setSharedNow where a real clock exists
   *  (FPS_THINK_PROF). */
  wallPerf?: () => number;
  /** think-stage cost accumulator (FPS_THINK_PROF) — presence enables
   *  the per-stage sampling in BotBrain.think. */
  thinkProf?: Map<string, number>;
  /** Set by deterministic harnesses: botRand() MUST have an injected
   *  stream — ambient Math.random under this flag throws instead of
   *  silently producing an unreproducible trajectory. */
  strictRng?: boolean;
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
let nowFn: () => number = (): number => 0;
export const sharedNow = (): number => nowFn();
export function setSharedNow(now: () => number): void { nowFn = now; }
