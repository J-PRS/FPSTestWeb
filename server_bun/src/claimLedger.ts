import type { Vec3, PlayerState } from './types.ts';
import type { TrackedProjectile } from '../../shared/combat.ts';
import { wallNow } from './wallClock.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 250;
// A resolved (spent) projectile's id can still bind late or reordered
// claims this long — past it the shell is provably dead and its id is
// recycled garbage.
const SPENT_CLAIM_MS = 5_000;
const SPENT_SWEEP_MS = 10_000;
const MAX_SPENT = 512;

/** Budget for a deferred claim (CombatHandler.pendingClaims): how many
 *  more register-flushes it may survive plus when it first waited — a
 *  spawn that never lands expires the claim loudly instead of holding
 *  it forever. */
export interface ClaimDefer { at: number; left: number }
export const CLAIM_DEFER_TRIES = 3;
export const CLAIM_DEFER_MS = 600;
export function freshDefer(): ClaimDefer {
  return { at: wallNow(), left: CLAIM_DEFER_TRIES };
}
export function clampPing(ping: number): number {
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
export function rewindPos(target: PlayerState, backMs: number): { x: number; y: number; z: number } {
  const h = target.history;
  if (h.length === 0) return target.position;
  const tAt = wallNow() - backMs;
  if (tAt <= h[0]!.t) return h[0]!;
  const last = h[h.length - 1]!;
  if (tAt >= last.t) return target.position;
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1]!.t <= tAt) {
      const a = h[i - 1]!, b = h[i]!;
      const f = (tAt - a.t) / Math.max(b.t - a.t, 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  return last;
}

// The shooter's view is stale by ping + jitter + interp buffer, so an
// honest claim can land where the target WAS anywhere across the lag
// window, not only at the rewound instant. Nearest point on the
// target's recorded path in [now-backMs-extraMs, now] bounds the error
// by the target's own measured motion instead of a flat slack.
export function rewindNearest(target: PlayerState, backMs: number, extraMs: number, pt: Vec3): Vec3 {
  const floor = wallNow() - backMs - extraMs;
  let best = rewindPos(target, backMs);
  let bestD = dist3(best, pt);
  for (const s of target.history) {
    if (s.t < floor) continue;
    const d = dist3(s, pt);
    if (d < bestD) { bestD = d; best = s; }
  }
  const d = dist3(target.position, pt);
  if (d < bestD) best = target.position;
  return best;
}

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

interface SpentRecord {
  proj: TrackedProjectile;
  shot: boolean;
  aoe: boolean;
  at: number;
}

/** Claim identity — an explicit server id, the client's spawn nonce, or
 *  nothing (falls back to the shooter's oldest live shell of the type). */
export interface ClaimRef {
  projectileId?: string | null;
  clientShotId?: string;
  weaponType?: number;
  claim: 'shot' | 'aoe';
}

/**
 * The claim ledger: every in-flight projectile the server knows about,
 * plus "spent" tombstones so a detonating shell can satisfy BOTH its
 * paired claims (a rocket's direct `shot` AND its blast `aoeShot` name
 * the same id — deleting on the first claim bounced the second with
 * "no known projectile" and splash silently never applied). Each spent
 * id fuels one claim of each kind, so a cheater can't double-dip.
 */
export class ClaimLedger {
  private counter = 0;
  private projectiles: Map<string, TrackedProjectile> = new Map();
  private spent = new Map<string, SpentRecord>();
  /** `${ownerId}|${clientShotId}` → proj_N — lets claims name the shell
   *  before the projectileCreated echo lands (or instead of it). */
  private clientIds = new Map<string, string>();

  /** Track a newly spawned projectile; returns the server-assigned id.
   *  Idempotent on (ownerId, clientShotId): a client on a lossy transport
   *  retransmits unacked spawns, and without this dedup each resend
   *  registers a phantom twin (and trips the fire-window gate). */
  register(ownerId: string, weaponType: number, position: Vec3, velocity: Vec3, clientShotId?: string): string {
    if (clientShotId) {
      // Live OR spent id both dedup — a spent id binds to the tombstone
      // (claims still resolve per-kind consumed), a live id to the shell;
      // only a fully swept record may re-register.
      const existing = this.idForClientShot(ownerId, clientShotId);
      if (existing) return existing;
    }
    const id = `proj_${++this.counter}`;
    this.projectiles.set(id, {
      ownerId,
      weaponType,
      origin: { ...position },
      velocity: { ...velocity },
      spawnAt: wallNow(),
      clientShotId,
    });
    if (clientShotId) this.clientIds.set(`${ownerId}|${clientShotId}`, id);
    // A live game never has >512 in-flight projectiles — the cap bounds
    // memory if clients never send destroys. Eviction tombstones like
    // destroy() does: a pellet-fan flood could push a still-flying shell
    // over the cap, and deleting it bare would hard-bounce its later
    // hit claim 'gone' even though it legitimately flew.
    if (this.projectiles.size > MAX_SPENT) {
      const oldest = this.projectiles.keys().next().value;
      if (oldest) {
        const proj = this.projectiles.get(oldest)!;
        this.projectiles.delete(oldest);
        this.spent.set(oldest, { proj, shot: false, aoe: false, at: wallNow() });
        this.sweepSpent();
      }
    }
    return id;
  }

  /** proj_N for a client's spawn nonce — live or spent, still indexed. */
  idForClientShot(playerId: string, clientShotId: string): string | undefined {
    const id = this.clientIds.get(`${playerId}|${clientShotId}`);
    if (!id) return undefined;
    // Lazily reap index entries whose record was swept — the map would
    // otherwise grow one entry per shot for the life of the session.
    if (!this.projectiles.has(id) && !this.spent.has(id)) {
      this.clientIds.delete(`${playerId}|${clientShotId}`);
      return undefined;
    }
    return id;
  }

  /**
   * Find the tracked projectile a claim refers to. Binding precedence:
   * explicit server id → the spawn-claim nonce → the shooter's oldest
   * live shell of the claimed type (a claim that outraced its echo).
   */
  resolve(playerId: string, ref: ClaimRef): TrackedProjectile | undefined {
    const pid = ref.projectileId
      ?? (ref.clientShotId ? this.idForClientShot(playerId, ref.clientShotId) : undefined);
    if (pid) return this.resolveById(playerId, pid, ref.claim);
    // A claim that NAMES a shell (server id or spawn nonce) may only bind
    // that shell — falling through to resolveLatest would bind a sibling
    // and burn its claim slot when the named shell's spawn is simply in
    // flight on an unordered transport. undefined → caller defers.
    if (ref.projectileId || ref.clientShotId) return undefined;
    return this.resolveLatest(playerId, ref.weaponType, ref.claim);
  }

  /** A tombstone fuels one claim of each kind — a rocket's direct `shot`
   *  AND its blast `aoeShot` name the same id; consume-per-kind or the
   *  second claim bounces (or a cheater double-dips one shell twice). */
  private take(rec: SpentRecord, claim: 'shot' | 'aoe'): TrackedProjectile | undefined {
    if (claim === 'shot' ? rec.shot : rec.aoe) return undefined;
    if (claim === 'shot') rec.shot = true; else rec.aoe = true;
    return rec.proj;
  }

  private resolveById(playerId: string, projectileId: string, claim: 'shot' | 'aoe'): TrackedProjectile | undefined {
    const live = this.projectiles.get(projectileId);
    if (live) {
      if (live.ownerId !== playerId) return undefined;
      this.projectiles.delete(projectileId);
      const rec: SpentRecord = { proj: live, shot: false, aoe: false, at: wallNow() };
      this.spent.set(projectileId, rec);
      this.sweepSpent();
      return this.take(rec, claim);
    }
    const rec = this.spent.get(projectileId);
    if (rec && rec.proj.ownerId === playerId && wallNow() - rec.at < SPENT_CLAIM_MS) {
      return this.take(rec, claim);
    }
    return undefined;
  }

  /** Null-id fallback (claim outraced projectileCreated): the shooter's
   *  latest projectile of the claimed type — live first, then spent.
   *  Every matching live shell is tombstoned, not just the resolved one:
   *  with an unordered transport there's no telling which shell a claim
   *  means, and leaving siblings live would let each claim mint hits off
   *  a projectile that already detonated. */
  private resolveLatest(playerId: string, weaponType: number | undefined, claim: 'shot' | 'aoe'): TrackedProjectile | undefined {
    // The claim outraced its projectileCreated echo — the shell that
    // detonated is one of the OLDEST live matches (spawn order ≈
    // detonation order), never the one fired last. Resolving the newest
    // systematically failed airtime-vs-age by exactly one fire interval.
    let claimable: SpentRecord | undefined;
    for (const [id, proj] of this.projectiles) {
      if (!this.matches(proj, playerId, weaponType)) continue;
      this.projectiles.delete(id);
      const rec: SpentRecord = { proj, shot: false, aoe: false, at: wallNow() };
      this.spent.set(id, rec);
      if (!claimable) claimable = rec; // first live match = oldest
    }
    if (claimable) {
      // This path mints tombstones without passing through sweepSpent —
      // unbounded growth under sustained fire on unordered transports.
      this.sweepSpent();
      return this.take(claimable, claim);
    }
    // Spent fallback: first matching tombstone whose claim-kind is still
    // free — taking a consumed rec would just bounce the claim.
    for (const rec of this.spent.values()) {
      if (!this.matches(rec.proj, playerId, weaponType)) continue;
      if (wallNow() - rec.at >= SPENT_CLAIM_MS) continue;
      const t = this.take(rec, claim);
      if (t) return t;
    }
    return undefined;
  }

  private matches(proj: TrackedProjectile, playerId: string, weaponType: number | undefined): boolean {
    return proj.ownerId === playerId && (weaponType === undefined || proj.weaponType === weaponType);
  }

  /** Who owns an id, live or spent — callers check this BEFORE destroy. */
  ownerOf(projectileId: string): string | undefined {
    return this.projectiles.get(projectileId)?.ownerId
      ?? this.spent.get(projectileId)?.proj.ownerId;
  }

  /** Owner lookup by spawn nonce — same check for shotId-keyed destroys. */
  ownerOfClientShot(playerId: string, clientShotId: string): string | undefined {
    const id = this.idForClientShot(playerId, clientShotId);
    return id ? this.ownerOf(id) : undefined;
  }

  /**
   * Destroy acknowledgement. A still-live projectile gets a spent
   * tombstone here because on unordered transports (WT/RTC datagram
   * lanes) this destroy can land BEFORE the shot/aoeShot it pairs
   * with — the tombstone is the only thing resolving those reordered
   * claims.
   */
  destroy(projectileId: string): void {
    const proj = this.projectiles.get(projectileId);
    this.projectiles.delete(projectileId);
    if (proj) {
      this.spent.set(projectileId, { proj, shot: false, aoe: false, at: wallNow() });
      this.sweepSpent();
    }
  }

  /** Drop a player's live projectiles on full removal (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  removePlayer(playerId: string): void {
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === playerId) this.projectiles.delete(id);
    }
    for (const [id, rec] of this.spent) {
      if (rec.proj.ownerId === playerId) this.dropSpent(id, rec);
    }
    for (const key of this.clientIds.keys()) {
      if (key.startsWith(`${playerId}|`)) this.clientIds.delete(key);
    }
  }

  get size(): number { return this.projectiles.size; }

  /** Bound the spent map — same cap as live projectiles, plus a lazy
   *  age sweep so stale ids can't resolve hours later. */
  private sweepSpent(): void {
    const now = wallNow();
    for (const [id, rec] of this.spent) {
      if (now - rec.at > SPENT_SWEEP_MS) this.dropSpent(id, rec);
    }
    while (this.spent.size > MAX_SPENT) {
      const [id, rec] = this.spent.entries().next().value!;
      this.dropSpent(id, rec);
    }
  }

  /** Spent eviction also drops the nonce index so a swept shell's
   *  clientShotId can't bind a claim hours later (or leak the entry). */
  private dropSpent(id: string, rec: SpentRecord): void {
    this.spent.delete(id);
    const sid = rec.proj.clientShotId;
    if (sid !== undefined) {
      const key = `${rec.proj.ownerId}|${sid}`;
      if (this.clientIds.get(key) === id) this.clientIds.delete(key);
    }
  }
}
