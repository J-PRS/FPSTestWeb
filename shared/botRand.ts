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
import { sharedEnv } from './env.ts';

// Ambient release gets a tagged wrapper: harnesses/tests restore ambient
// dice BETWEEN seeded windows on purpose (zombie timers from another
// room must not eat this room's sequence). strictRng therefore rejects
// only UNMARKED ambient — `rand === Math.random` identity or a never-
// bound stream — so "forgot to seed" throws while a blessed release
// still draws silently.
const AMBIENT: () => number = () => Math.random();
let rand: (() => number) | null = null;
export function botRng(r: () => number): void { rand = r; }
export function botRngRelease(): void { rand = AMBIENT; }
export function botRand(): number {
  if (sharedEnv.strictRng && (rand === null || rand === Math.random)) {
    throw new Error('botRand drew ambient Math.random under strictRng — inject botRng(lcg) or release with botRngRelease()');
  }
  return (rand ?? Math.random)();
}

/** Chat/taunt flavor gets its own stream — the taunt cooldown ring is
 *  process-global, so when it gates a line the SPEAK rolls still fire on
 *  whatever room happens to be stepping, and drawing them from the
 *  behavior stream would let one room's chatter re-sequence every
 *  downstream decision roll in another (cross-room nondeterminism, plus
 *  lockstep desyncs in tests). */
let trand: (() => number) | null = null;
export function tauntRng(r: () => number): void { trand = r; }
export function tauntRand(): number { return (trand ?? Math.random)(); }
