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
export const wallNow = (): number => Date.now();
