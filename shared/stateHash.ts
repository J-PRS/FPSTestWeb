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

/** Replica-fidelity checksum for non-player state (balls): identity +
 *  mirrored lifecycle fields only — variant/enraged/targetId ride the
 *  same edge events, so wire latency can't phantom this channel the way
 *  a raw-position hash would (100ms × 40m/s = a permanent ~4m false
 *  diff). A stranded, dropped, duplicated, or stale replica reads here;
 *  trajectory drift stays the fleet rubberband metric's job. Same
 *  commutative FNV-sum so roster order can't alias. */
export interface HashableReplica {
  variant: number;
  enraged: boolean;
  targetId: string | null;
}

export function computeReplicaHash(replicas: Iterable<[number, HashableReplica]>): string {
  let h = 0;
  for (const [id, r] of replicas) {
    let ph = 0x811c9dc5;
    for (const v of [id, r.variant, r.enraged ? 1 : 0]) {
      ph ^= v & 0xffff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    const t = r.targetId ?? '';
    for (let i = 0; i < t.length; i++) {
      ph ^= t.charCodeAt(i); ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}

/** Creature replicas hash the same way — identity + mirrored lifecycle:
 *  species/state/uber/targetId all ride wire edges or the seeded spawn,
 *  so a stranded or stale-state crawler replica surfaces here while
 *  position drift stays invisible to the check (the shared sim replays
 *  it identical by construction). */
export interface HashableCreature {
  species: string;
  state: string;
  uber: boolean;
  targetId: string | null;
}

export function computeCreatureHash(replicas: Iterable<[number, HashableCreature]>): string {
  let h = 0;
  for (const [id, r] of replicas) {
    let ph = 0x811c9dc5;
    for (const v of [id, r.uber ? 1 : 0]) {
      ph ^= v & 0xffff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    // Field separator byte — concatenated strings alone can't tell
    // ('chase','r') from ('cha','ser').
    for (const s of [r.species, r.state, r.targetId ?? '']) {
      for (let i = 0; i < s.length; i++) {
        ph ^= s.charCodeAt(i); ph = Math.imul(ph, 0x01000193) >>> 0;
      }
      ph ^= 0xff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}

/** Deployables (turrets/stations/shields/mines) hash identity edges only:
 *  kind/owner/team arrive on spawn edges; hp and armor lag on the echo
 *  channel (deployHp ticks) so they stay OUT — a phantom-desync at heal
 *  cadence is exactly the failure this checksum exists to avoid. What
 *  it catches: a deploySpawn or deployGone edge that never landed. */
export interface HashableDeploy {
  kind: string;
  owner: string;
  team: string;
}

export function computeDeployHash(replicas: Iterable<[number, HashableDeploy]>): string {
  let h = 0;
  for (const [id, r] of replicas) {
    let ph = 0x811c9dc5;
    ph ^= id & 0xffff; ph = Math.imul(ph, 0x01000193) >>> 0;
    for (const s of [r.kind, r.owner, r.team]) {
      for (let i = 0; i < s.length; i++) {
        ph ^= s.charCodeAt(i); ph = Math.imul(ph, 0x01000193) >>> 0;
      }
      ph ^= 0xff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}
