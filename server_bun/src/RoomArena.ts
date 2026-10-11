/**
 * RoomArena — the dome boundary layer. The client renders the shell
 * itself; this sim watches positions and warns violators. There is no
 * physical enforcement: an earlier pull-back shove was removed (it read
 * as getting grabbed by nothing). Bots respect it implicitly (their roam
 * targets come from inside the arena).
 */
import type { Room } from './Room.ts';

const GRACE_OUTSIDE_S = 1.5;   // brief spillover (knockback through it) before the warning

export class RoomArena {
  private outsideSince = new Map<string, number>();
  // Ids already banner-warned on this excursion — re-arms on return.
  private warned = new Set<string>();
  // Sim-time, not wall time: deterministic under test stepping AND a
  // frozen/paused sim can't silently drain the grace window.
  private t = 0;

  constructor(
    private room: Room,
    private arena: { x: number; z: number; radius: number },
  ) {}

  tick(dt: number): void {
    this.t += dt;
    const { x: cx, z: cz, radius: r } = this.arena;
    const now = this.t;
    for (const p of this.room.players.getAllPlayers().values()) {
      if (p.isDead) { this.outsideSince.delete(p.id); this.warned.delete(p.id); continue; }
      const dx = p.position.x - cx, dz = p.position.z - cz;
      const d = (dx * dx + dz * dz) ** 0.5;
      if (d <= r) { this.outsideSince.delete(p.id); this.warned.delete(p.id); continue; }
      const since = this.outsideSince.get(p.id);
      if (since === undefined) { this.outsideSince.set(p.id, now); continue; }
      if (now - since < GRACE_OUTSIDE_S || this.warned.has(p.id)) { continue; }
      this.warned.add(p.id);
      this.room.connections.sendToPlayer(p.id, { type: 'serverWarn', text: 'RETURN TO THE ARENA — outside the dome' });
    }
    // Gone players can't self-clean — they never appear in the iteration
    // above, so a leaver's entry would sit in the map for the room's life.
    for (const id of this.outsideSince.keys()) {
      if (!this.room.players.getPlayer(id)) { this.outsideSince.delete(id); this.warned.delete(id); }
    }
  }
}
