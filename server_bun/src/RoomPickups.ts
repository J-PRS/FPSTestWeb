/**
 * RoomPickups — server-authoritative nuggets. A creature kill drops a
 * gem at the corpse; the first living player to touch it banks a point
 * for their team via the room's score funnel. This is what makes
 * 'nuggets' mode trustworthy: the server sees the kill, the drop, and
 * the touch — no client claim involved; the old 'bank' claim message
 * was removed entirely since this path covers every legit bank.
 */
import type { Vec3, ServerMessage } from './types.ts';
import { WORLD_MODEL, spawnPayload, verbPayload, rosterRow } from '../../shared/worldModel.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { perkMods } from '../../shared/perks.ts';
import { aoeImpulse } from '../../shared/combat.ts';
import { hmHeight, hmChord, hmSettleWalkable } from '../../shared/heightfield.ts';
import { NUG_TUMBLE, type PickupKind } from '../../shared/pickups.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { inv } from '../../shared/invariants.ts';

const PICKUP_R = 2.2;   // planar grab radius, same feel as flag pickup
const PICKUP_TTL_S = 60; // dropped loot decays — no infinite accumulation
const MAX_PICKUPS = 64;  // cap so a ball-farm can't flood the room
const NUG_FRICTION = NUG_TUMBLE.friction;

export class RoomPickups {
  private pickups = new Map<number, { id: number; pos: Vec3; ttl: number; kind: PickupKind; vel: Vec3; armT: number }>();
  private nextId = 1;
  /** Last-tick positions for the sweep — a capper crosses the grab ring
   *  between two 20Hz frames at speed; same swept-capsule rule flags use,
   *  or fast grabs tunnel straight through the nugget. */
  private prevPos = new Map<string, Vec3>();
  /** Set by the room — banks the point or applies the powerup. */
  onCollect: ((playerId: string, kind: PickupKind) => void) | null = null;

  constructor(private room: Room) {}

  /** armS: collect grace — a pack-thrown nugget mints one of these at the
   *  thrower's feet-ish range; the beat keeps the toss from bank-to-self
   *  on the same frame it lands. */
  spawn(pos: Vec3, kind: PickupKind = 'gem', armS = 0): void {
    if (this.pickups.size >= MAX_PICKUPS) {
      // A saturated pool refusing the objective's income is invisible
      // without this — "kills stopped dropping nuggets" vs "pool full"
      // must be separable in the pickup tallies.
      weaponStats.recordPickup(this.room.mode, kind, 'refused');
      return;
    }
    const id = this.nextId++;
    const p = { id, pos: { ...pos }, ttl: PICKUP_TTL_S, kind, vel: { x: 0, y: 0, z: 0 }, armT: armS };
    this.settleReachable(p);
    // Drops spawn at the victim's eye height — hmSettleWalkable only
    // grounds pos.y when it slides, so a flat-ground death leaves the
    // tag hovering ~1.5m up. Ground it when the spot is over open
    // terrain; on a structure (>2.5m up) corpse height is the reachable
    // spot and grounding would sink the tag under the deck.
    if (this.room.field) {
      const ground = Math.max(hmHeight(this.room.field, p.pos.x, p.pos.z), hmChord(this.room.field, p.pos.x, p.pos.z)) + 0.5;
      if (p.pos.y - ground < 2.5) {p.pos.y = ground;}
    }
    this.pickups.set(id, p);
    logger.debug('Pickup spawned', { room: this.room.name, kind, id });
    weaponStats.recordPickup(this.room.mode, kind, 'spawned');
    this.room.broadcast(spawnPayload(WORLD_MODEL.pickup!, id, 'id', { pos: { ...p.pos }, kind }) as ServerMessage);
  }

  /** Match reset — clear the field and tell clients to drop the gems. */
  clear(): void {
    for (const id of this.pickups.keys()) {
      this.room.broadcast(verbPayload(WORLD_MODEL.pickup!, 'gone', 'id', id, { by: null }) as ServerMessage);
    }
    this.pickups.clear();
  }

  snapshot(): { id: number; pos: Vec3; kind: PickupKind }[] {
    // rosterRow pins the row shape to the declared rosterFields — a
    // snapshot field that drifts from the declaration warns at build
    // time instead of diffing silently on the client.
    return [...this.pickups.values()].map((p) => rosterRow(WORLD_MODEL.pickup!, 'id', p.id, { pos: { ...p.pos }, kind: p.kind }) as { id: number; pos: Vec3; kind: PickupKind });
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
  knock(at: Vec3, radius: number, force: number, pull = false): void {
    if (!Number.isFinite(at.x + at.y + at.z + radius + force)) {return;}
    const s = pull ? -1 : 1;
    for (const p of this.pickups.values()) {
      const dx = p.pos.x - at.x, dy = p.pos.y - at.y, dz = p.pos.z - at.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= radius) {continue;}
      const mag = aoeImpulse(force, d, radius) * 0.4 * s; // nugs are light but grounded — fraction of player shove
      p.vel.x += (dx / (d || 1)) * mag;
      p.vel.z += (dz / (d || 1)) * mag;
      p.vel.y += Math.abs(mag) * NUG_TUMBLE.upPop; // slight pop — tumble reads as a bounce, not a slide
    }
  }

  /** Gems decay by timeout, never by geography — see hmSettleWalkable. */
  private settleReachable(p: { pos: Vec3 }): void {
    if (this.room.field) {hmSettleWalkable(this.room.field, p.pos);}
  }

  private remove(id: number, by: string | null): void {
    if (!this.pickups.delete(id)) {return;}
    this.room.broadcast(verbPayload(WORLD_MODEL.pickup!, 'gone', 'id', id, { by }) as ServerMessage);
  }

  tick(dt: number): void {
    if (this.pickups.size === 0) {
      // Stale sweep anchors would span idle time — a fresh nugget must
      // start each segment from the current frame, not an hour-old spot.
      if (this.prevPos.size > 0) {this.prevPos.clear();}
      return;
    }
    const players = this.room.players.getAllPlayers(); // live map — re-iterated, no roster copy per tick
    for (const p of this.pickups.values()) {
      p.ttl -= dt;
      if (p.vel.x !== 0 || p.vel.z !== 0 || p.vel.y !== 0) {
        const bleed = Math.max(0, 1 - NUG_FRICTION * dt);
        p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
        p.pos.y += p.vel.y * dt; p.vel.y += GRAVITY * dt; // world gravity — no soft loose-object fork
        // Ground truth is the drawn chord, not the smooth field — on
        // convex ground the flat triangles dip below the bilinear patch,
        // so a field-rested gem hangs visibly midair (JP's report).
        const gy = this.room.field ? Math.max(hmHeight(this.room.field, p.pos.x, p.pos.z), hmChord(this.room.field, p.pos.x, p.pos.z)) + NUG_TUMBLE.groundLift : p.pos.y;
        if (p.pos.y < gy) { p.pos.y = gy; p.vel.y = 0; }
        p.vel.x *= bleed; p.vel.z *= bleed; p.vel.y *= bleed;
        if (Math.abs(p.vel.x) < NUG_TUMBLE.settle && Math.abs(p.vel.z) < NUG_TUMBLE.settle && Math.abs(p.vel.y) < NUG_TUMBLE.settle) {
          p.vel.x = p.vel.y = p.vel.z = 0;
          this.settleReachable(p);
          // The rest spot is what every client draws — under the drawn
          // surface is the nugget-burial class, not a cosmetic offset.
          const dg = this.room.field
            ? Math.max(hmHeight(this.room.field, p.pos.x, p.pos.z), hmChord(this.room.field, p.pos.x, p.pos.z))
            : Number.NaN;
          inv('pickup-below-ground', !Number.isFinite(dg) || p.pos.y >= dg - 0.5,
            { id: p.id, y: Number(p.pos.y.toFixed(1)) });
          // Resting spot is the new truth — one edge resyncs every client.
          this.room.broadcast(spawnPayload(WORLD_MODEL.pickup!, p.id, 'id', { pos: { ...p.pos }, kind: p.kind }) as ServerMessage);
        }
      }
      if (p.ttl <= 0) {
        this.remove(p.id, null);
        weaponStats.recordPickup(this.room.mode, p.kind, 'decayed');
        continue;
      }
      if (p.armT > 0) { p.armT -= dt; continue; } // still flying — no grabs
      for (const pl of players.values()) {
        if (pl.isDead) {continue;}
        // Score pickups (gems/tags) only exist in team modes; powerups
        // are grab-able by anyone alive in any mode.
        if ((p.kind === 'gem' || p.kind === 'tag') && !pl.team) {continue;}
        // Swept grab: closest point on this tick's path segment — a
        // point check lets a full-speed ski skip the ring entirely.
        const a = this.prevPos.get(pl.id) ?? pl.position;
        const b = pl.position;
        const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
        const len2 = abx * abx + aby * aby + abz * abz;
        let t = 0;
        if (len2 > 0) {
          t = Math.min(1, Math.max(0,
            ((p.pos.x - a.x) * abx + (p.pos.y - a.y) * aby + (p.pos.z - a.z) * abz) / len2));
        }
        const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
        // Planar grab — a jump shouldn't put a nugget out of reach,
        // but a jetpack flyover isn't a pickup.
        if (Math.abs(cy - p.pos.y) > 6) {continue;}
        const dx = cx - p.pos.x, dz = cz - p.pos.z;
        const reach = PICKUP_R * perkMods(pl.perk).pickupRadius;
        if (dx * dx + dz * dz > reach * reach) {continue;}
        this.remove(p.id, pl.id);
        weaponStats.recordPickup(this.room.mode, p.kind, 'banked');
        // Score touches are the money line — log them so a soak can prove
        // the kill→drop→touch→bank funnel end-to-end from the log alone.
        if (p.kind === 'gem' || p.kind === 'tag') {
          logger.debug('Pickup banked', { room: this.room.name, kind: p.kind, by: pl.id });
        }
        this.onCollect?.(pl.id, p.kind);
        break;
      }
    }
    // Snapshot AFTER the touch pass — next tick's segment starts where
    // this one ended (same ordering RoomFlags uses for its sweep).
    // Reuse the stored Vec3 (it must be a snapshot, not an alias — the
    // live position mutates next tick): field writes kill N allocs/tick.
    for (const pl of players.values()) {
      const prev = this.prevPos.get(pl.id);
      if (prev) { prev.x = pl.position.x; prev.y = pl.position.y; prev.z = pl.position.z; }
      else {this.prevPos.set(pl.id, { ...pl.position });}
    }
    for (const id of this.prevPos.keys()) {
      if (!this.room.players.getPlayer(id)) {this.prevPos.delete(id);}
    }
  }
}
