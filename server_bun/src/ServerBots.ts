/**
 * ServerBots — server-driven filler players. A bot is just a PlayerState
 * with no socket: it lives in the room's PlayerManager, so hit claims,
 * knockback, deaths, respawn timers and the tick fan-out all reuse the
 * real player machinery for free. The per-tick movement here writes
 * position/velocity the same place client position messages would.
 *
 * Brains are shared/botBrain.ts — the same decision core the offline
 * GameBot runs, so personality is tuned once and ships to both runtimes.
 * This class owns locomotion (terrain clamp + hop) and turns the brain's
 * fire command into a botFire broadcast with a distance-based hit roll.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { BotBrain, type BotEnemy, type BotVec } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';

const SPEED = 14;          // m/s ground move
const BOLT_SPEED = 60;     // m/s visual bolt + hitscan travel is instant

export class ServerBots {
  private brains = new Map<string, BotBrain>();
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
      this.brains.set(id, new BotBrain(p.position));
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
  }

  get count(): number {
    return this.brains.size;
  }

  /** Prune a bot that was fully removed (room teardown / test hooks). */
  untrack(playerId: string): void {
    this.brains.delete(playerId);
  }

  /** Hostiles this bot may hunt. Team modes fight the other side; FFA
   *  bots pick any non-bot (fighting filler-vs-filler burns ticks nobody
   *  asked for). */
  private enemiesOf(p: { id: string; team?: string }): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead) continue;
      if (this.room.modeSpec?.teams) {
        if (q.team === p.team) continue;
      } else if (q.isBot) continue;
      out.push({ id: q.id, pos: q.position, vel: q.velocity, alive: !q.isDead });
    }
    return out;
  }

  /** Translate the brain's fire command into the wire broadcast — the
   *  distance roll decides damage, the visible bolt follows the aim error
   *  so a miss reads as a miss. */
  private fireAt(p: { id: string; position: Vec3 }, targetId: string, aim: Vec3): void {
    const target = this.room.players.getPlayer(targetId);
    if (!target || target.isDead) return;
    const dx = aim.x - p.position.x;
    const dy = aim.y - (p.position.y + 1.4);
    const dz = aim.z - p.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const hit = Math.random() < Math.max(0.15, 0.6 - len / 200);
    this.room.messages.botFire(
      p.id, hit ? targetId : null,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: (dx / len) * BOLT_SPEED, y: (dy / len) * BOLT_SPEED, z: (dz / len) * BOLT_SPEED },
      3, // Chaingun — cheap tracer, readable hit
      hit,
    );
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  dropped → touch it home; enemy flag reachable → go grab it. */
  private flagGoal(p: { id: string; team?: string; position: Vec3 }): BotVec | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as 'alpha' | 'bravo';
    const enemyTeam = me === 'alpha' ? 'bravo' : 'alpha';
    const enemy = flags.flags.get(enemyTeam);
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) return own.home;
    if (own.state === 'dropped') return own.pos;
    if (enemy.state !== 'carried') return enemy.pos;
    return own.home; // flag's moving — defend home
  }

  /** Getting shot makes the brain recoil — called from the combat funnel. */
  flinch(targetId: string, shooterId: string): void {
    const brain = this.brains.get(targetId);
    const shooter = this.room.players.getPlayer(shooterId);
    if (brain && shooter) brain.takeHit(shooter.position);
  }

  tick(dt: number): void {
    if (this.brains.size === 0) return;
    const now = Date.now();
    for (const [id, brain] of this.brains) {
      const p = this.room.players.getPlayer(id);
      if (!p || p.isDead) continue;
      p.lastSeen = now; // bots never send positions — heartbeat manually
        // or the idle reaper would cull them on schedule

      const out = brain.think(dt, {
        pos: p.position,
        enemies: this.enemiesOf(p),
        objective: this.flagGoal(p),
        // Team rooms drop nuggets on creature kills — bots farm them too,
        // which is what keeps a bot-filled match's scoreboard moving.
        pickup: this.room.pickups?.nearest(p.position) ?? undefined,
        groundY: (x, z) => (this.field ? hmHeight(this.field, x, z) : p.position.y),
        now,
      });
      if (out.fire) this.fireAt(p, out.fire.targetId, out.fire.aim);

      const dx = out.dest.x - p.position.x;
      const dz = out.dest.z - p.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.5) { p.velocity.x = 0; p.velocity.z = 0; p.lastSeq++; continue; }

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

      p.rotation.yaw = Math.atan2(nx, nz);
      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq
    }
  }
}
