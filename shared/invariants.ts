/**
 * shared/invariants — correctness-by-construction: the truths a system
 * must always satisfy, stated ONCE at the boundary that can violate
 * them, so a regression fires a named violation instead of a symptom
 * hunt weeks later.
 *
 * Contract: `inv(name, holds, ctx?)`.
 *   - Test/deterministic harnesses (strictInvariants): throws — a broken
 *     invariant fails the test that let it happen.
 *   - Production: counted once per name via the host sink (server
 *     healthBump / client glitch census) — a violated invariant must be
 *     loud but never crash the match.
 *
 * Rules for adding one:
 *   - Assert TRUTH, not representation: "this body rests above the
 *     surface it renders on", never "field equals field".
 *   - Name the class, not the call site: 'bot-below-ground' so the dump
 *     reads the bug, not the line number.
 *   - ctx carries the diff that diagnoses it (pos, expected, actual).
 */

export type InvariantSink = (name: string, ctx?: Record<string, unknown>) => void;

let sink: InvariantSink | null = null;
let strict = false;
const fired = new Set<string>();
/** Per-name flood cap — a hot-path violation still gets counted every
 *  hit via the sink, but the dedup set stays small; the sink itself is
 *  rate-limited by the host (health counters aggregate anyway). */

export function setInvariantSink(s: InvariantSink): void { sink = s; }
/** Deterministic harnesses: every violation is a thrown test failure. */
export function setStrictInvariants(on: boolean): void { strict = on; }
export function clearInvariantDedup(): void { fired.clear(); }

export function inv(name: string, holds: boolean, ctx?: Record<string, unknown>): boolean {
  if (holds) {return true;}
  const detail = ctx ? ` ${JSON.stringify(ctx)}` : '';
  if (strict) {throw new Error(`INVARIANT ${name}${detail}`);}
  const key = `${name}${detail}`;
  if (!fired.has(key)) {
    fired.add(key);
    if (fired.size > 500) {fired.clear();} // an unbounded keyset is its own leak
    sink?.(name, ctx);
  }
  return false;
}

/** Measure-with-one-reference helper: the recurring bug class is two
 *  sides of a comparison disagreeing on the unit (sim eye vs class eye,
 *  field vs chord). Sites that compare against ground/eye must read the
 *  SAME accessor the mover used — this is that accessor's loud form. */
export function invEq(name: string, a: number, b: number, eps: number, ctx?: Record<string, unknown>): boolean {
  return inv(name, Math.abs(a - b) <= eps, { a: Number(a.toFixed(3)), b: Number(b.toFixed(3)), eps, ...ctx });
}
