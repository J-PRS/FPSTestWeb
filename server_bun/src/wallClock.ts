/**
 * wallClock — the real-time source. Identity `Date.now()`.
 *
 * The ONLY wall-clock read on the server lives here (besides simClock's
 * un-warped base). Everything that windows a real client message —
 * claim ledgers, rate limits, session timeouts, resync bookkeeping,
 * tick pacing — calls wallNow() so the distinction from sim-time
 * (simClock) is enforced at the call site instead of by convention.
 * Game-lifetime reads (respawn lapses, spawn protection, flag/match
 * timers, bot housekeeping) belong to simNow — a fast-forwarded soak
 * must not accelerate real-client windows.
 */
import { type WallMs } from '../../shared/clockBrand.ts';
export { wallMs, type WallMs } from '../../shared/clockBrand.ts';

let impl: () => number = Date.now;

/** Test seam only — deterministic harnesses (net bridge, chaos) bind the
 *  sim clock so wall-windowed gates (correction throttle, reclaim TTL,
 *  rate limits) elapse on sim time exactly as production measures them
 *  on wall time. Production never calls this; tests must restore with
 *  setWallNow() when the run ends. */
export const setWallNow = (fn?: () => number): void => { impl = fn ?? Date.now; };
export const wallNow = (): WallMs => impl() as WallMs;
