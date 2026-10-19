/**
 * simRand — the seeded stream for SIM-TRUTH randomness that isn't bot
 * brains: wave-director picks, spawn placement, pellet spread, bomblet
 * children, ambient species. One stream, one owner per run — a verifier
 * (or a harness) that knows the seed replays the whole dice sequence and
 * any fabricated/missing event can't hide inside "random luck".
 *
 * Deliberately NOT botRand: bots draw from their own injectable stream —
 * sharing one stream would make consumer call-order part of the seed
 * (a new draw site silently re-sequences every downstream roll), and
 * cross-subsystem coupling is exactly what tauntRand was split off for.
 *
 * VFX/UI randomness must NOT draw here — cosmetic jitter that reads
 * nothing on the wire would only burn stream positions.
 *
 * Seed minting lives client-side (demoSeed.ts) — shared/ stays pure:
 * no wall clock, no ambient entropy in this file.
 */

import { botRand } from './botRand.ts';

/** A rewindable stream: the same call signature every existing consumer
 *  uses, plus state introspection for save/restore and the sync report —
 *  a draw-count mismatch fingerprints "consumed a random the other run
 *  didn't", the classic desync signature (OpenRA's SharedRandom model). */
export interface Lcg {
  (): number;
  /** Full stream position — save() then restore() resumes the exact
   *  sequence INCLUDING draw count; the pair {state, draws} fingerprints
   *  "a consumer drew a random the other run didn't" (the classic
   *  desync signature — OpenRA's SharedRandom model). */
  save(): { state: number; draws: number };
  restore(snap: { state: number; draws: number }): void;
  readonly draws: number;
}

// mulberry32 — 32-bit LCG-family, seedable, deterministic across engines
// (ambient dice aren't portable — seeding is the whole point).
export function lcg32(seed: number): Lcg {
  let s = seed >>> 0;
  let n = 0;
  const next = ((): number => {
    s = (s + 0x6D_2B_79_F5) >>> 0;
    n += 1;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }) as Lcg;
  next.save = (): { state: number; draws: number } => ({ state: s, draws: n });
  next.restore = (snap: { state: number; draws: number }): void => { s = snap.state >>> 0; n = snap.draws; };
  Object.defineProperty(next, 'draws', { get: (): number => n });
  return next;
}

let stream: (() => number) | null = null;

/** Bind the run's seed. Every offline match mints one at boot and stamps
 *  it into the demo header — replays that re-seed the same value walk
 *  the identical event stream. */
export function simRngSeed(seed: number): void { stream = lcg32(seed >>> 0); }

/** Test hook — inject any stream (determinism probes drive lcg32). */
export function simRng(r: () => number): void { stream = r; }

/** Unseeded draws fall through to the ambient dice (botRand) — every run
 *  seeds at entity mint, so a draw here before that is a bug worth being
 *  nondeterministic about rather than silently replayable. */
export function simRand(): number { return (stream ?? botRand)(); }
