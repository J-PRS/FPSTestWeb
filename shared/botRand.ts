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
