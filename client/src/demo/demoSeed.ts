// demoSeed — the run's sim-RNG seed, stamped into the v7 demo header.
// Kept as a module slot so the recorder reads it lazily at record start
// (main.ts mints it at entity boot; a verifier reads the header field).

let runSeed = 0;

/** Wall-clock entropy is fine for seed CHOICE — the seed itself is what
 *  gets recorded and verified, not how it was picked. */
export const mintSeed = (): number => (Math.random() * 0xFF_FF_FF_FF) >>> 0;

export function setRunSeed(seed: number): void { runSeed = seed >>> 0; }
export function getRunSeed(): number { return runSeed; }

// Ranked-solo challenge — a server-minted seed the client binds runSeed
// to (GET /challenge). Fetched at boot; makeEntities uses it if it
// landed in time, else the run is unranked local mint. The challenge
// JSON itself rides along for the submit step (?chal=).
import type { Challenge } from '../../../shared/resultToken.ts';

let challenge: Challenge | null = null;
export const setChallenge = (c: Challenge | null): void => { challenge = c; };
export const getChallenge = (): Challenge | null => challenge;

export function fetchChallenge(httpUrl: string): void {
  fetch(`${httpUrl}/challenge`)
    .then(r => (r.ok ? r.json() : null))
    .then((c: Challenge | null) => { challenge = c; })
    .catch(() => { challenge = null; });
}
