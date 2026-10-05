// Per-sim determinism trace — the desync bisector. Instead of one room
// hash at tick end, canon() serializes each subsystem's *sim-relevant*
// state into a stable byte stream (id-sorted, insertion-order-free) and
// fnv1a-hashes it after EVERY sim tick in both lockstep rooms. A mismatch
// names (tick, sim, subsystem) directly, and dump() then diffs the two
// canonical trees field-by-field — the divergence names itself instead
// of a human bisecting by hand.
//
// Canonicalization rules (the lessons this encodes):
//  - Iterate by sorted key, never Map insertion order or pointer order.
//  - Skip wall-clock/cosmetic state: internalId, forceSendUntil, lastSeen,
//    journals, hint timestamps — none influence future sim state.
//  - Floats serialize via toPrecision(17) — bit-exact, round-trip safe.
//  - Anything not serialized is a blind spot: keep the skip list narrow.
import { botRng, tauntRng } from '../../../shared/botRand.ts';
import { simNowAdvance, simNowReset } from '../../src/simClock.ts';
import type { Room } from '../../src/Room.ts';

/** Fields that hold wall-clock or cosmetic state — never part of the
 *  sim's causal chain, always skipped. Additions belong ONLY for fields
 *  provably non-causal (a wrong skip hides a real leak). */
const SKIP = /^(internalId|forceSendUntil|lastSeen|correctionGraceUntil|lastImpulseAt|wallAge|lastStepAt|pendingRespawn|lastSeq|divergences|lastCorrection|seqStates|pending|jetWanted|lastInputSeq|resyncSeq|resyncAt|lastStatus|skillDrainPerSec|skillSuppressRegen|stageMs|stageBase|journal|connections|messages|metrics|log|listener|socket|stageProf|thinkProf|groundMemo|losMemo|routeMemo|spotMemo|prof|\w*Memo)$/;

/** Deterministic ordering of a subtree: numbers → 17-digit precision,
 *  objects → sorted keys, Maps/Sets → sorted serialized entries. */
function canon(v: unknown, seen: Set<unknown>, out: string[]): void {
  if (v === null || v === undefined) { out.push('n'); return; }
  const t = typeof v;
  if (t === 'number') { out.push(`d${(v as number).toPrecision(17)}`); return; }
  if (t === 'boolean') { out.push(v ? 'T' : 'F'); return; }
  if (t === 'string') { out.push(`s${v}`); return; }
  if (t === 'function' || t === 'symbol' || t === 'bigint') { out.push('x'); return; }
  const o = v as Record<string, unknown>;
  if (seen.has(o)) { out.push('c'); return; }
  seen.add(o);
  if (o instanceof Map) {
    const rows = [...o.entries()].map(([k, e]) => [ser(k, new Set()), e] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    out.push('M{');
    for (const [k, e] of rows) { out.push(k); canon(e, seen, out); }
    out.push('}');
    return;
  }
  if (o instanceof Set) {
    const rows = [...o.values()].map((e) => ser(e, new Set())).sort();
    out.push('S{');
    for (const r of rows) out.push(r);
    out.push('}');
    return;
  }
  if (Array.isArray(o)) {
    out.push('[');
    for (const e of o) canon(e, seen, out);
    out.push(']');
    return;
  }
  out.push('{');
  for (const k of Object.keys(o).sort()) {
    if (SKIP.test(k)) continue;
    out.push(`k${k}`);
    canon(o[k], seen, out);
  }
  out.push('}');
}

function ser(v: unknown, seen: Set<unknown>): string {
  const out: string[] = [];
  canon(v, seen, out);
  return out.join('');
}

export function hashStr(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16);
}

/** The divergent-field report: walk two canonical trees in parallel and
 *  list every leaf path whose serialized value differs. */
const didIds = new WeakMap<object, number>();
let didCounter = 0;
const did = (o: object): number => { let n = didIds.get(o); if (n === undefined) { n = ++didCounter; didIds.set(o, n); } return n; };
export function diffTrees(x0: unknown, y0: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: [unknown, unknown, string][] = [[x0, y0, '$']];
  while (stack.length && out.length < 60) {
    const [x, y, path] = stack.pop()!;
    if (x === y) continue;
    const tx = x === null ? 'null' : Array.isArray(x) ? 'array' : x instanceof Map ? 'map' : x instanceof Set ? 'set' : typeof x;
    const ty = y === null ? 'null' : Array.isArray(y) ? 'array' : y instanceof Map ? 'map' : y instanceof Set ? 'set' : typeof y;
    if (tx === 'function' || ty === 'function') continue; // code isn't state
    if (tx !== ty) { out.push(`${path}: type ${tx} vs ${ty}`); continue; }
    if (tx !== 'object' && tx !== 'array' && tx !== 'map' && tx !== 'set') { out.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); continue; }
    // Guard on the PAIR identity — self-loops would recirculate forever,
    // and tagging live objects would itself leak into the sim.
    const pk = `${did(x as object)}|${did(y as object)}`;
    if (seen.has(pk)) continue;
    seen.add(pk);
    if (x instanceof Map && y instanceof Map) {
      for (const k of new Set([...x.keys(), ...y.keys()])) {
        if (!x.has(k)) { out.push(`${path}.${String(k)}: missing in A`); continue; }
        if (!y.has(k)) { out.push(`${path}.${String(k)}: missing in B`); continue; }
        stack.push([x.get(k), y.get(k), `${path}.${String(k)}`]);
      }
      continue;
    }
    if (x instanceof Set && y instanceof Set) {
      const sx = [...x].map((v) => JSON.stringify(v)).sort(), sy = [...y].map((v) => JSON.stringify(v)).sort();
      if (sx.join('') !== sy.join('')) out.push(`${path}: set ${sx.join(',')} vs ${sy.join(',')}`);
      continue;
    }
    const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
    for (const k of keys) {
      if (SKIP.test(k)) continue;
      stack.push([(x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`]);
    }
  }
  return out;
}

export interface TraceHit { tick: number; sim: string; diffs: string[] }

/** Lockstep two rooms sim-by-sim. On the first hash divergence inside a
 *  tick, dumps a field-level diff of the whole room state — the report
 *  answers WHERE before anyone has to guess. */
const mkStream = (seed: number) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; };

/** One room tick at fixed dt under per-room seeded streams; `one`
 *  ticks a single sim index instead of the whole list. */
function tickRoom(r: Room, dt: number, rng: () => number, trng: () => number, one = -1): void {
  const n = one >= 0 ? 1 : r.sims.length;
  const i0 = one >= 0 ? one : 0;
  for (let k = 0; k < n; k++) {
    botRng(rng); tauntRng(trng);
    try { r.sims[i0 + k]!.tick(dt); } finally { botRng(Math.random); tauntRng(Math.random); }
  }
}

/** Lockstep two rooms — two passes: a cheap per-TICK hash locates the
 *  first divergent tick; a per-SIM re-run to that tick names the
 *  subsystem. Deterministic streams make the replay bit-identical. */
export function traceLockstep(a: Room, b: Room, ticks: number, dt = 0.05, rebuild?: () => [Room, Room]): TraceHit | null {
  const sa = mkStream(1340), sb = mkStream(1340), ta = mkStream(1344), tb = mkStream(1344);
  let bad = -1;
  for (let i = 0; i < ticks; i++) {
    tickRoom(a, dt, sa, ta); tickRoom(b, dt, sb, tb);
    if (hashStr(ser(a, new Set())) !== hashStr(ser(b, new Set()))) { bad = i; break; }
    simNowAdvance(dt * 1000);
  }
  if (bad < 0 || !rebuild)
    return bad < 0 ? null : { tick: bad, sim: '?', diffs: diffTrees(a, b).slice(0, 40) };
  // Bisect pass: rebuild, fast-forward to the bad tick, then step the
  // sims one at a time until the hash first breaks — that sim did it.
  simNowReset(1_700_000_000_000);
  const [a2, b2] = rebuild();
  const sa2 = mkStream(1340), sb2 = mkStream(1340), ta2 = mkStream(1344), tb2 = mkStream(1344);
  for (let i = 0; i < bad; i++) { tickRoom(a2, dt, sa2, ta2); tickRoom(b2, dt, sb2, tb2); simNowAdvance(dt * 1000); }
  for (let s = 0; s < a2.sims.length; s++) {
    tickRoom(a2, dt, sa2, ta2, s); tickRoom(b2, dt, sb2, tb2, s);
    if (hashStr(ser(a2, new Set())) !== hashStr(ser(b2, new Set())))
      return { tick: bad, sim: a2.sims[s]!.name ?? `sim${s}`, diffs: diffTrees(a2, b2).slice(0, 40) };
  }
  return { tick: bad, sim: '?', diffs: diffTrees(a2, b2).slice(0, 40) };
}
