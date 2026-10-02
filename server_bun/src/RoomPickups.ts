/**
 * RoomPickups — server-authoritative nuggets. A creature kill drops a
 * gem at the corpse; the first living player to touch it banks a point
 * for their team via the room's score funnel. This is what makes
 * 'nuggets' mode trustworthy: the server sees the kill, the drop, and
 * the touch — no client claim involved; the old 'bank' claim message
 * was removed entirely since this path covers every legit bank.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { perkMods } from '../../shared/perks.ts';
import { aoeImpulse } from '../../shared/combat.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import type { PickupKind } from '../../shared/pickups.ts';

const PICKUP_R = 2.2;   // planar grab radius, same feel as flag pickup
const PICKUP_TTL_S = 60; // dropped loot decays — no infinite accumulation
const MAX_PICKUPS = 64;  // cap so a ball-farm can't flood the room
const NUG_FRICTION = 4;  // tumble bleed per second — gems skid, not slide

export class RoomPickups {
  private pickups = new Map<number, { id: number; pos: Vec3; ttl: number; kind: PickupKind; vel: Vec3 }>();
  private nextId = 1;
  /** Set by the room — banks the point or applies the powerup. */
  onCollect: ((playerId: string, kind: PickupKind) => void) | null = null;

  constructor(private room: Room) {}

  spawn(pos: Vec3, kind: PickupKind = 'gem'): void {
    if (this.pickups.size >= MAX_PICKUPS) return;
    const id = this.nextId++;
    const p = { id, pos: { ...pos }, ttl: PICKUP_TTL_S, kind, vel: { x: 0, y: 0, z: 0 } };
    this.settleReachable(p);
    this.pickups.set(id, p);
    logger.debug('Pickup spawned', { room: this.room.name, kind, id });
    weaponStats.recordPickup(this.room.mode, kind, 'spawned');
    this.room.broadcast({ type: 'pickupSpawn', id, pos: { ...p.pos }, kind });
  }

  /** Match reset — clear the field and tell clients to drop the gems. */
  clear(): void {
    for (const id of this.pickups.keys()) {
      this.room.broadcast({ type: 'pickupGone', id, by: null });
    }
    this.pickups.clear();
  }

  snapshot(): { id: number; pos: Vec3; kind: PickupKind }[] {
    return [...this.pickups.values()].map((p) => ({ id: p.id, pos: { ...p.pos }, kind: p.kind }));
  }

  /** Nearest live pickup to a point — bots chase these. */
  nearest(pos: Vec3): Vec3 | null {
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const p of this.pickups.values()) {
      const d = (p.pos.x - pos.x) ** 2 + (p.pos.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = p.pos; }
    }
    return best;
  }

  /** A blast shoved a pickup — gems tumble like everything else, so a
   *  shot near a contested nug can punt it toward you or away from the
   *  camper. Server moves the truth spot AND rebroadcasts a spawn edge:
   *  clients had their own cosmetic knock, this snaps them to agreement. */
  knock(at: Vec3, radius: number, force: number): void {
    for (const p of this.pickups.values()) {
      const dx = p.pos.x - at.x, dy = p.pos.y - at.y, dz = p.pos.z - at.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= radius) continue;
      const mag = aoeImpulse(force, d, radius) * 0.4; // nugs are light but grounded — fraction of player shove
      p.vel.x += (dx / (d || 1)) * mag;
      p.vel.z += (dz / (d || 1)) * mag;
      p.vel.y += mag * 0.4; // slight pop — tumble reads as a bounce, not a slide
    }
  }

  /** Gems decay by timeout, never by geography: a tumble that ends on a
   *  cliff lip or a steep face is unreachable for every walker, so the
   *  rest spot slides downhill until the gradient is walkable. */
  private settleReachable(p: { pos: Vec3 }): void {
    const f = this.room.field;
    if (!f) return;
    for (let i = 0; i < 12; i++) {
      const h0 = hmHeight(f, p.pos.x, p.pos.z);
      const gxm = hmHeight(f, p.pos.x - 4, p.pos.z), gxp = hmHeight(f, p.pos.x + 4, p.pos.z);
      const gzm = hmHeight(f, p.pos.x, p.pos.z - 4), gzp = hmHeight(f, p.pos.x, p.pos.z + 4);
      const sx = (gxp - gxm) / 8, sz = (gzp - gzm) / 8;
      const slope = Math.hypot(sx, sz);
      if (slope < 0.8) break; // walkable grade
      const d = Math.hypot(sx, sz) || 1;
      p.pos.x -= (sx / d) * 6; p.pos.z -= (sz / d) * 6;
      p.pos.y = hmHeight(f, p.pos.x, p.pos.z) + 0.5;
      if (Math.abs(h0 - p.pos.y) < 0.5 && i > 4) break; // settled on a shelf
    }
  }

  private remove(id: number, by: string | null): void {
    if (!this.pickups.delete(id)) return;
    this.room.broadcast({ type: 'pickupGone', id, by });
  }

  tick(dt: number): void {
    if (this.pickups.size === 0) return;
    const players = [...this.room.players.getAllPlayers().values()];
    for (const p of this.pickups.values()) {
      p.ttl -= dt;
      if (p.vel.x !== 0 || p.vel.z !== 0 || p.vel.y !== 0) {
        const bleed = Math.max(0, 1 - NUG_FRICTION * dt);
        p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
        p.pos.y += p.vel.y * dt; p.vel.y -= 25 * dt;
        const gy = this.room.field ? hmHeight(this.room.field, p.pos.x, p.pos.z) + 0.5 : p.pos.y;
        if (p.pos.y < gy) { p.pos.y = gy; p.vel.y = 0; }
        p.vel.x *= bleed; p.vel.z *= bleed; p.vel.y *= bleed;
        if (Math.abs(p.vel.x) < 0.5 && Math.abs(p.vel.z) < 0.5 && Math.abs(p.vel.y) < 0.5) {
          p.vel.x = p.vel.y = p.vel.z = 0;
          this.settleReachable(p);
          // Resting spot is the new truth — one edge resyncs every client.
          this.room.broadcast({ type: 'pickupSpawn', id: p.id, pos: { ...p.pos }, kind: p.kind });
        }
      }
      if (p.ttl <= 0) {
        this.remove(p.id, null);
        weaponStats.recordPickup(this.room.mode, p.kind, 'decayed');
        continue;
      }
      for (const pl of players) {
        if (pl.isDead) continue;
        // Score pickups (gems/tags) only exist in team modes; powerups
        // are grab-able by anyone alive in any mode.
        if ((p.kind === 'gem' || p.kind === 'tag') && !pl.team) continue;
        // Planar grab — a jump shouldn't put a nugget out of reach,
        // but a jetpack flyover isn't a pickup.
        const dy = Math.abs(pl.position.y - p.pos.y);
        if (dy > 6) continue;
        const dx = pl.position.x - p.pos.x, dz = pl.position.z - p.pos.z;
        const reach = PICKUP_R * perkMods(pl.perk).pickupRadius;
        if (dx * dx + dz * dz > reach * reach) continue;
        this.remove(p.id, pl.id);
        weaponStats.recordPickup(this.room.mode, p.kind, 'banked');
        // Score touches are the money line — log them so a soak can prove
        // the kill→drop→touch→bank funnel end-to-end from the log alone.
        if (p.kind === 'gem' || p.kind === 'tag') {
          logger.info('Pickup banked', { room: this.room.name, kind: p.kind, by: pl.id });
        }
        this.onCollect?.(pl.id, p.kind);
        break;
      }
    }
  }
}
