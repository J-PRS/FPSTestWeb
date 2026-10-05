/**
 * One injectable random source for every bot-side heuristic in shared/ —
 * brains, hunts, goals, dispositions, taunts. Bot decisions run on ONE side
 * only (server online, client solo), so the stream never crosses the wire;
 * seeding is purely for scenario-test reproducibility — harness injects an
 * lcg stream so a staged squad replays identically instead of flaking on
 * ambient dice.
 */
// Read Math.random lazily so tests can still spyOn(Math,'random') when no
// stream is injected — only an explicit botRng() call overrides it.
let rand: (() => number) | null = null;
export function botRng(r: () => number): void { rand = r; }
export function botRand(): number { return (rand ?? Math.random)(); }

/** Chat/taunt flavor gets its own stream — the taunt cooldown ring is
 *  process-global, so when it gates a line the SPEAK rolls still fire on
 *  whatever room happens to be stepping, and drawing them from the
 *  behavior stream would let one room's chatter re-sequence every
 *  downstream decision roll in another (cross-room nondeterminism, plus
 *  lockstep desyncs in tests). */
let trand: (() => number) | null = null;
export function tauntRng(r: () => number): void { trand = r; }
export function tauntRand(): number { return (trand ?? Math.random)(); }
