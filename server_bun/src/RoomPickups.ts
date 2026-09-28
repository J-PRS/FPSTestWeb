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

const PICKUP_R = 2.2;   // planar grab radius, same feel as flag pickup
const PICKUP_TTL_S = 30; // dropped loot decays — no infinite accumulation
const MAX_PICKUPS = 64;  // cap so a ball-farm can't flood the room

export class RoomPickups {
  private pickups = new Map<number, { id: number; pos: Vec3; ttl: number }>();
  private nextId = 1;
  /** Set by the room — banks the point for the collector's team. */
  onCollect: ((playerId: string) => void) | null = null;

  constructor(private room: Room) {}

  spawn(pos: Vec3): void {
    if (this.pickups.size >= MAX_PICKUPS) return;
    const id = this.nextId++;
    this.pickups.set(id, { id, pos: { ...pos }, ttl: PICKUP_TTL_S });
    this.room.broadcast({ type: 'pickupSpawn', id, pos: { ...pos } });
  }

  /** Match reset — clear the field and tell clients to drop the gems. */
  clear(): void {
    for (const id of this.pickups.keys()) {
      this.room.broadcast({ type: 'pickupGone', id, by: null });
    }
    this.pickups.clear();
  }

  snapshot(): { id: number; pos: Vec3 }[] {
    return [...this.pickups.values()].map((p) => ({ id: p.id, pos: { ...p.pos } }));
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

  private remove(id: number, by: string | null): void {
    if (!this.pickups.delete(id)) return;
    this.room.broadcast({ type: 'pickupGone', id, by });
  }

  tick(dt: number): void {
    if (this.pickups.size === 0) return;
    const players = [...this.room.players.getAllPlayers().values()];
    for (const p of this.pickups.values()) {
      p.ttl -= dt;
      if (p.ttl <= 0) {
        this.remove(p.id, null);
        continue;
      }
      for (const pl of players) {
        if (pl.isDead || !pl.team) continue;
        // Planar grab — a jump shouldn't put a nugget out of reach,
        // but a jetpack flyover isn't a pickup.
        const dy = Math.abs(pl.position.y - p.pos.y);
        if (dy > 6) continue;
        const dx = pl.position.x - p.pos.x, dz = pl.position.z - p.pos.z;
        if (dx * dx + dz * dz > PICKUP_R * PICKUP_R) continue;
        this.remove(p.id, pl.id);
        this.onCollect?.(pl.id);
        break;
      }
    }
  }
}
