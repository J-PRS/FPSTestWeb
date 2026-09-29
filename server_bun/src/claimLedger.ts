import type { Vec3, PlayerState } from './types.ts';
import type { TrackedProjectile } from '../../shared/combat.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 250;
export function clampPing(ping: number): number {
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
export function rewindPos(target: PlayerState, backMs: number): { x: number; y: number; z: number } {
  const h = target.history;
  if (h.length === 0) return target.position;
  const tAt = Date.now() - backMs;
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

interface SpentRecord {
  proj: TrackedProjectile;
  shot: boolean;
  aoe: boolean;
  at: number;
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

  /** Track a newly spawned projectile; returns the server-assigned id. */
  register(ownerId: string, weaponType: number, position: Vec3, velocity: Vec3): string {
    const id = `proj_${++this.counter}`;
    this.projectiles.set(id, {
      ownerId,
      weaponType,
      origin: { ...position },
      velocity: { ...velocity },
      spawnAt: Date.now(),
    });
    // A live game never has >512 in-flight projectiles — the cap bounds
    // memory if clients never send destroys.
    if (this.projectiles.size > 512) {
      const oldest = this.projectiles.keys().next().value;
      if (oldest) this.projectiles.delete(oldest);
    }
    return id;
  }

  /**
   * Find the tracked projectile a hit claim refers to. The client echoes
   * the server-assigned id when it has it; when the hit outraced the
   * projectileCreated reply it can't, so we fall back to the shooter's
   * most recently spawned projectile of the claimed weapon type.
   */
  resolve(
    playerId: string,
    projectileId: string | null | undefined,
    weaponType: number | undefined,
    claim: 'shot' | 'aoe',
  ): TrackedProjectile | undefined {
    return projectileId
      ? this.resolveById(playerId, projectileId, claim)
      : this.resolveLatest(playerId, weaponType, claim);
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
      const rec: SpentRecord = { proj: live, shot: false, aoe: false, at: Date.now() };
      this.spent.set(projectileId, rec);
      this.sweepSpent();
      return this.take(rec, claim);
    }
    const rec = this.spent.get(projectileId);
    if (rec && rec.proj.ownerId === playerId && Date.now() - rec.at < 5000) {
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
    let latest: SpentRecord | undefined;
    for (const [id, proj] of this.projectiles) {
      if (!this.matches(proj, playerId, weaponType)) continue;
      this.projectiles.delete(id);
      latest = { proj, shot: false, aoe: false, at: Date.now() };
      this.spent.set(id, latest);
    }
    if (latest) return this.take(latest, claim);
    for (const rec of this.spent.values()) {
      if (!this.matches(rec.proj, playerId, weaponType)) continue;
      if (Date.now() - rec.at >= 5000) continue;
      latest = rec;
    }
    return latest ? this.take(latest, claim) : undefined;
  }

  private matches(proj: TrackedProjectile, playerId: string, weaponType: number | undefined): boolean {
    return proj.ownerId === playerId && (weaponType === undefined || proj.weaponType === weaponType);
  }

  /** Who owns an id, live or spent — callers check this BEFORE destroy. */
  ownerOf(projectileId: string): string | undefined {
    return this.projectiles.get(projectileId)?.ownerId
      ?? this.spent.get(projectileId)?.proj.ownerId;
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
      this.spent.set(projectileId, { proj, shot: false, aoe: false, at: Date.now() });
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
      if (rec.proj.ownerId === playerId) this.spent.delete(id);
    }
  }

  get size(): number { return this.projectiles.size; }

  /** Bound the spent map — same 512 cap as live projectiles, plus a lazy
   *  age sweep so stale ids can't resolve hours later. */
  private sweepSpent(): void {
    const now = Date.now();
    for (const [id, rec] of this.spent) {
      if (now - rec.at > 10000) this.spent.delete(id);
    }
    while (this.spent.size > 512) {
      this.spent.delete(this.spent.keys().next().value!);
    }
  }
}
