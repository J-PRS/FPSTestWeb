// The wire's desync checksum: an order-insensitive FNV-1a over quantized
// player state, shared verbatim by server (TickLoop) and client
// (stateDebug). Both ends MUST hash identical inputs — id chars, then
// rounded x/y/z, health, isDead — or the check reports phantom desyncs.
// (The client's old djb2-over-a-string hash could never equal this one,
// which is exactly what produced the 0% match-rate warning spam.)

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
      Math.round(p.health), p.isDead ? 1 : 0,
    ]) {
      ph ^= v & 0xffff; ph = Math.imul(ph, 0x01000193) >>> 0;
    }
    h = (h + ph) >>> 0;
  }
  return h.toString(16);
}
