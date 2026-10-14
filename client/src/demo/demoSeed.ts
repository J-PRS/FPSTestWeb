// demoSeed — the run's sim-RNG seed, stamped into the v7 demo header.
// Kept as a module slot so the recorder reads it lazily at record start
// (main.ts mints it at entity boot; a verifier reads the header field).

let runSeed = 0;

/** Wall-clock entropy is fine for seed CHOICE — the seed itself is what
 *  gets recorded and verified, not how it was picked. */
export const mintSeed = (): number => (Math.random() * 0xFF_FF_FF_FF) >>> 0;

export function setRunSeed(seed: number): void { runSeed = seed >>> 0; }
export function getRunSeed(): number { return runSeed; }
