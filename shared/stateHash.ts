// The wire's desync checksum: an order-insensitive FNV-1a over quantized
// player state, shared verbatim by server (TickLoop) and client
// (stateDebug). Both ends MUST hash identical inputs — id chars, then
// rounded x/y/z, health, isDead — or the check reports phantom desyncs.
// (The client's old djb2-over-a-string hash could never equal this one,
// which is exactly what produced the 0% match-rate warning spam.)

/** Every hashed field declares its sync channel — how the client's value
 *  reaches parity with the server's:
 *
 *    sim  — deterministic/replicated state the wire streams per tick
 *           (position). Freshness is bounded by frame latency; hash at
 *           ~1m granularity so interpolation slop can't trip it while a
 *           stranded replica still reads as a mismatch.
 *    edge — reliable atomic events (liveness). Rare and discrete; exact
 *           comparison — a missed edge event IS the desync we want.
 *    echo — server-owned continuous state the client NEVER predicts
 *           (health: heal channels tick server-side but echo at ~2Hz).
 *           The client is always up to one echo-interval stale, so this
 *           channel hashes at bucket granularity: lag can't cross a
 *           bucket, a dropped hit always can.
 *
 *  New fields MUST be registered here — hashing a lagged channel at fine
 *  granularity is precisely the phantom-desync bug this checksum kept
 *  firing (regen windows produced ~0% match rates).
 */
export type SyncChannel = 'sim' | 'edge' | 'echo';

export const FIELD_CHANNELS: Record<keyof HashablePlayer, SyncChannel> = {
  x: 'sim', y: 'sim', z: 'sim',
  health: 'echo',
  isDead: 'edge',
};

/** Echo granularity — 4hp buckets: above max heal-rate × echo interval
 *  (regen ~8hp/s at ~2Hz echoes ⇒ ≤4hp of lag), far below the smallest
 *  real hit. */
const ECHO_QUANTUM = 4;

export interface HashablePlayer {
  x: number; y: number; z: number;
  health: number;
  isDead: boolean;
}

export function computeStateHash(players: Iterable<[string, HashablePlayer]>): string {
  // Sum of per-player FNVs — addition is commutative, so roster order
  // (which differs across a reconnect) can't alias. A single rolling
  // hash over [A,B] vs [B,A] would read the same players as different
  // state, the exact false-positive this check exists to avoid.
  let h = 0;
  for (const [id, p] of players) {
    let ph = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      ph ^= id.charCodeAt(i); ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    for (const v of [
      Math.round(p.x), Math.round(p.y), Math.round(p.z),
      Math.floor(p.health / ECHO_QUANTUM),
      p.isDead ? 1 : 0,
    ]) {
      ph ^= v & 0xffff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}

/* ── Replica hashes — generated from the world model ──────────────────
 * Every non-player kind hashes identity + the lifecycle fields it
 * declares in shared/worldModel.ts (`kind.fields`). One mixer walks the
 * declaration, so adding a hashed field is a one-line declaration —
 * five near-identical bodies used to re-declare the same list and any
 * skew between them was a silent phantom-desync. The player lane keeps
 * its own hasher above: its hash shape (quantized sim/echo channels)
 * isn't the declared `fields` list. */

import type { WorldKindDecl } from './worldModel.ts';

function mixValue(ph: number, v: unknown): number {
  // null/undefined and '' mix identically (separator only) — an unset
  // edge field and an empty one must not read as different state.
  if (v == null) { ph ^= 0xff; return Math.imul(ph, 0x01000193) >>> 0; }
  if (typeof v === 'number') { ph ^= v & 0xffff; return Math.imul(ph, 0x01000193) >>> 0; }
  if (typeof v === 'boolean') { ph ^= v ? 1 : 0; return Math.imul(ph, 0x01000193) >>> 0; }
  const s = String(v);
  for (let i = 0; i < s.length; i++) {
    ph ^= s.charCodeAt(i); ph = Math.imul(ph, 0x01000193) >>> 0;
  }
  // Field separator — concatenated strings alone can't tell
  // ('chase','r') from ('cha','ser').
  ph ^= 0xff; return Math.imul(ph, 0x01000193) >>> 0;
}

/** Identity + declared lifecycle fields, per kind. Hash inputs ride
 *  edge events or the seeded spawn — wire latency can't phantom them;
 *  a stranded/stale replica is exactly what surfaces. Echo-channel
 *  fields (hp) stay OUT of `fields` by declaration, so nothing lagged
 *  is ever hashed. Same commutative FNV-sum so roster order can't
 *  alias. */
export function replicaHash(kind: WorldKindDecl, replicas: Iterable<[number | string, Record<string, unknown>]>): string {
  let h = 0;
  for (const [id, r] of replicas) {
    let ph = 0x811c9dc5;
    ph = mixValue(ph, id);
    for (const f of kind.fields) ph = mixValue(ph, r[f.name]);
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}
