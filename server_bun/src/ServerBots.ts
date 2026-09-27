/**
 * ServerBots — server-driven filler players. A bot is just a PlayerState
 * with no socket: it lives in the room's PlayerManager, so hit claims,
 * knockback, deaths, respawn timers and the tick fan-out all reuse the
 * real player machinery for free. The per-tick movement here writes
 * position/velocity the same place client position messages would.
 *
 * Movement is deliberately simple (waypoint wander with terrain clamp +
 * occasional hop) — these are match filler, not the skilled pvptest bot.
 * Perception/behavior upgrades belong in shared/ so offline bots and
 * server bots can share one brain eventually.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { logger } from './logger.ts';

const SPEED = 14;          // m/s ground wander
const WP_REACH = 4;        // waypoint arrival distance
const WP_RANGE = 60;       // new waypoint radius around current pos
const HOP_CHANCE = 0.004;  // per-tick (50ms) — a hop every ~4s

export class ServerBots {
  private waypoints = new Map<string, Vec3>();
  private readonly room: Room;
  private readonly field: Heightfield | null;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
  }

  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Call once at room creation, before human joins, so
   *  team balancing lands humans on the emptier side. */
  populate(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = `BOT-${this.room.name}${i + 1}`;
      const p = this.room.players.addPlayer(id);
      p.isBot = true;
      p.lastSeen = Date.now();
      this.room.assignTeam(p);
      this.room.broadcast({
        type: 'playerJoined',
        playerId: id,
        internalId: p.internalId,
        position: p.position,
        rotation: p.rotation,
        team: p.team,
      });
      this.waypoint(p);
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
  }

  get count(): number {
    return this.waypoints.size;
  }

  /** Prune a bot that was fully removed (room teardown / test hooks). */
  untrack(playerId: string): void {
    this.waypoints.delete(playerId);
  }

  private waypoint(p: { id: string; position: Vec3 }): void {
    // Roam around own position — keeps bots spread, no homing beacons.
    this.waypoints.set(p.id, {
      x: p.position.x + (Math.random() * 2 - 1) * WP_RANGE,
      y: 0,
      z: p.position.z + (Math.random() * 2 - 1) * WP_RANGE,
    });
  }

  tick(dt: number): void {
    if (this.waypoints.size === 0) return;
    const now = Date.now();
    for (const [id, wp] of this.waypoints) {
      const p = this.room.players.getPlayer(id);
      if (!p || p.isDead) continue;
      p.lastSeen = now; // bots never send positions — heartbeat manually
        // or the idle reaper would cull them on schedule

      const dx = wp.x - p.position.x;
      const dz = wp.z - p.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < WP_REACH) { this.waypoint(p); continue; }

      const nx = dx / dist, nz = dz / dist;
      p.velocity.x = nx * SPEED;
      p.velocity.z = nz * SPEED;
      // Terrain clamp — bots are ground walkers; a hop pops them over bumps
      const groundY = this.field ? hmHeight(this.field, p.position.x, p.position.z) : p.position.y;
      const targetY = Math.max(groundY + 0.1, p.position.y - 9 * dt);
      const hopping = p.position.y > groundY + 1.2;
      p.velocity.y = hopping ? p.velocity.y - 30 * dt : 0;
      p.position.x += p.velocity.x * dt;
      p.position.z += p.velocity.z * dt;
      p.position.y += p.velocity.y * dt;
      if (p.position.y < targetY) { p.position.y = targetY; p.velocity.y = 0; }
      if (!hopping && Math.random() < HOP_CHANCE) p.velocity.y = 12;

      p.rotation.yaw = Math.atan2(nx, nz);
      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq
    }
  }
}
