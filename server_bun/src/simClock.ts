/**
 * simClock — the room's game-time source. Identity `Date.now()` when
 * unwarped, so live play is byte-identical; an un-networked driver can
 * set/advance it to run sim-time faster than wall time (bots-only
 * fast-forward soaks — wire claims stay on real Date.now() since client
 * pings/latency are real-time concepts).
 *
 * Only sim-lifetime reads use this: respawn lapses, spawn protection,
 * flag/match timers, powerup durations, bot housekeeping. Anything that
 * windows a real client message (claim ledgers, rate limits, session
 * timeouts) must keep Date.now().
 */
let warpOffsetMs = 0;
let frozenBaseMs: number | null = null;

export const simNow = (): number =>
  frozenBaseMs !== null ? frozenBaseMs + warpOffsetMs : Date.now() + warpOffsetMs;
export const simNowAdvance = (ms: number): void => { warpOffsetMs += ms; };
/** Reset starts a frozen clock: sim time then moves ONLY via
 *  simNowAdvance — wall-time gaps between step() calls can't leak into
 *  brain cooldowns or timers, which is what made harness runs
 *  non-deterministic. Production never calls this (identity path). */
export const simNowReset = (base: number = Date.now()): void => {
  frozenBaseMs = base;
  warpOffsetMs = 0;
};
