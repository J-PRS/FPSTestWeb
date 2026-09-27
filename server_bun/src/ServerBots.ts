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
const SIGHT = 70;          // engage range — beyond this bots roam blind
const FIRE_MS = 1100;      // base refire; ±400ms jitter per shot
const BOLT_SPEED = 60;     // m/s visual bolt + hitscan travel is instant
const AIM_ERR = 0.18;      // radians of cone error — misses look like misses

export class ServerBots {
  private waypoints = new Map<string, Vec3>();
  private lastFire = new Map<string, number>();
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
    this.lastFire.delete(playerId);
  }

  /** Nearest living enemy in sight. Team modes fight the other side; FFA
   *  bots pick any non-bot (fighting filler-vs-filler burns ticks nobody
   *  asked for). */
  private nearestEnemy(p: { id: string; position: Vec3; team?: string }): { id: string; position: Vec3; dist: number } | null {
    let best: { id: string; position: Vec3; dist: number } | null = null;
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead) continue;
      if (this.room.modeSpec?.teams) {
        if (q.team === p.team) continue;
      } else if (q.isBot) continue;
      const dx = q.position.x - p.position.x;
      const dz = q.position.z - p.position.z;
      const dy = q.position.y - p.position.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      if (dist < SIGHT && (!best || dist < best.dist)) best = { id: q.id, position: q.position, dist };
    }
    return best;
  }

  private tryFire(p: { id: string; position: Vec3; team?: string }, now: number): void {
    const last = this.lastFire.get(p.id) ?? 0;
    if (now - last < FIRE_MS) return;
    const target = this.nearestEnemy(p);
    if (!target) return;
    this.lastFire.set(p.id, now + (Math.random() * 800 - 400));

    // Bolt direction: aim at target chest with a cone of error; whether the
    // roll hits decides damage, the visible bolt follows the error so a
    // miss reads as a miss.
    const dx = target.position.x - p.position.x;
    const dy = target.position.y + 1 - (p.position.y + 1.4);
    const dz = target.position.z - p.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const err = AIM_ERR;
    const ax = dx / len + (Math.random() * 2 - 1) * err;
    const ay = dy / len + (Math.random() * 2 - 1) * err;
    const az = dz / len + (Math.random() * 2 - 1) * err;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const hit = Math.random() < Math.max(0.15, 0.6 - target.dist / 200);
    this.room.messages.botFire(
      p.id, hit ? target.id : null,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: (ax / alen) * BOLT_SPEED, y: (ay / alen) * BOLT_SPEED, z: (az / alen) * BOLT_SPEED },
      3, // Chaingun — cheap tracer, readable hit
      hit,
    );
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  dropped → touch it home; enemy flag reachable → go grab it. */
  private flagGoal(p: { id: string; team?: string }): { x: number; z: number } | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as 'alpha' | 'bravo';
    const enemyTeam = me === 'alpha' ? 'bravo' : 'alpha';
    const enemy = flags.flags.get(enemyTeam);
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) return { x: own.home.x, z: own.home.z };
    if (own.state === 'dropped') return { x: own.pos.x, z: own.pos.z };
    if (enemy.state !== 'carried') return { x: enemy.pos.x, z: enemy.pos.z };
    return { x: own.home.x, z: own.home.z }; // flag's moving — defend home
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

      this.tryFire(p, now);
      // In flag rooms the objective outranks a distant skirmish: run the
      // enemy flag, or touch a dropped own flag home, unless an enemy is
      // already in sight (fight first, objective after).
      const foe = this.nearestEnemy(p);
      const objective = this.flagGoal(p);
      const goal: { x: number; z: number } = foe ? foe.position : objective ?? wp;
      const dx = goal.x - p.position.x;
      const dz = goal.z - p.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (!foe && !objective && dist < WP_REACH) { this.waypoint(p); continue; }
      // In a fight, hold a loose orbit instead of hugging the target.
      if (foe && dist < 12) { p.velocity.x = 0; p.velocity.z = 0; p.lastSeq++; continue; }

      const nx = dx / (dist || 1), nz = dz / (dist || 1);
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
