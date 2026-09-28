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
import { STATUS } from '../../shared/status.ts';

const SPEED = 14;          // m/s ground move
const BOLT_SPEED = 60;     // m/s visual bolt + hitscan travel is instant

// Demo/debug knob: FPS_SUPERBOT=<id-substring> gives the matching bot
// superpowers — 3× ground speed and a hit roll that never misses.
const SUPERBOT = process.env.FPS_SUPERBOT ?? '';
const isSuper = (id: string) => SUPERBOT !== '' && id.includes(SUPERBOT);

export class ServerBots {
  private brains = new Map<string, BotBrain>();
  /** Bots we saw dead — respawn transition resyncs the move shadow. */
  private deadSet = new Set<string>();
  /** inputMove ordering key — the shadow drops non-increasing seqs. */
  private seq = 1;
  private readonly room: Room;
  private readonly field: Heightfield | null;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
  }

  private nextIdx = 1;
  private maintainAt = 0;

  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Call once at room creation, before human joins, so
   *  team balancing lands humans on the emptier side. */
  populate(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = `BOT-${this.room.name}${this.nextIdx++}`;
      const p = this.room.players.addPlayer(id);
      p.isBot = true;
      if (isSuper(id)) p.health = 400; // superbot tanks a beating
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
      // Legal body: the bot gets a move shadow exactly like a human join —
      // brains emit inputs, the sim owns motion, energy model included.
      this.room.moveSim.track(id, p.position, p.rotation.yaw, p.perk);
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
  }

  get count(): number {
    return this.brains.size;
  }

  /** Prune a bot that was fully removed (room teardown / test hooks). */
  untrack(playerId: string): void {
    this.brains.delete(playerId);
    this.room.moveSim.untrack(playerId);
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
      if (q.status & STATUS.CLOAK) continue; // bots can't aim what they can't see
      out.push({ id: q.id, pos: q.position, vel: q.velocity, alive: !q.isDead });
    }
    // Creatures are huntable too — in nuggets rooms they're the whole
    // objective (each kill drops the gem that scores), and shooting
    // hunters off your back is correct behavior in every mode.
    for (const b of this.room.ballSim.roster()) {
      out.push({ id: `b:${b.id}`, pos: b.position, vel: b.velocity, alive: true });
    }
    return out;
  }

  /** Positions of every other live player — the brain's separation
   *  sense, so a squad spreads instead of stacking on one slot. */
  private othersOf(p: { id: string }): Vec3[] {
    const out: Vec3[] = [];
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead) continue;
      out.push(q.position);
    }
    return out;
  }

  /** Translate the brain's fire command into the wire broadcast — the
   *  distance roll decides damage, the visible bolt follows the aim error
   *  so a miss reads as a miss. */
  private fireAt(p: { id: string; position: Vec3 }, targetId: string, aim: Vec3): void {
    // Creature targets route through the same claim funnel a client's
    // creatureHit uses — plausibility check and all — so a bot kill drops
    // its gem/FFA point identically.
    if (targetId.startsWith('b:')) {
      const ball = Number(targetId.slice(2));
      const dxb = aim.x - p.position.x;
      const dyb = aim.y - p.position.y;
      const dzb = aim.z - p.position.z;
      const lenb = Math.sqrt(dxb * dxb + dyb * dyb + dzb * dzb) || 1;
      this.room.messages.botFire(
        p.id, null,
        { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
        { x: (dxb / lenb) * BOLT_SPEED, y: (dyb / lenb) * BOLT_SPEED, z: (dzb / lenb) * BOLT_SPEED },
        3, false,
      );
      if (isSuper(p.id) || Math.random() < Math.max(0.15, 0.6 - lenb / 200)) {
        this.room.ballSim.handleHit(p.id, ball, isSuper(p.id) ? 30 : 8);
      }
      return;
    }
    const target = this.room.players.getPlayer(targetId);
    if (!target || target.isDead) return;
    const dx = aim.x - p.position.x;
    const dy = aim.y - (p.position.y + 1.4);
    const dz = aim.z - p.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const hit = isSuper(p.id) || Math.random() < Math.max(0.15, 0.6 - len / 200);
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

  /** botFill floor — once a second, top up or retire bots so the room
   *  holds `spec.botFill` total bodies. Retirees prefer a dead bot
   *  (popping a live one mid-fight reads as a vanish). */
  private maintain(now: number): void {
    const fill = this.room.spec.botFill;
    if (!fill || now < this.maintainAt) return;
    this.maintainAt = now + 1000;
    const humans = this.room.playerCount() - this.brains.size;
    const want = Math.max(0, Math.min(16, fill - humans));
    if (this.brains.size < want) {
      this.populate(want - this.brains.size);
      return;
    }
    let excess = this.brains.size - want;
    if (excess <= 0) return;
    // Map iterators tolerate mid-loop delete — no snapshot needed.
    for (const id of this.brains.keys()) {
      if (excess <= 0) break;
      const p = this.room.players.getPlayer(id);
      if (p && !p.isDead) continue; // keep live bots, kill the corpse queue first
      this.retire(id);
      excess--;
    }
    for (const id of this.brains.keys()) {
      if (excess <= 0) break;
      this.retire(id);
      excess--;
    }
  }

  private retire(id: string): void {
    this.brains.delete(id);
    this.room.moveSim.untrack(id);
    this.room.removePlayerCompletely(id, 'botFill', (m, o) => logger.info(m, o));
  }

  tick(dt: number): void {
    this.maintain(Date.now());
    if (this.brains.size === 0) return;
    const now = Date.now();
    for (const [id, brain] of this.brains) {
      const p = this.room.players.getPlayer(id);
      if (!p) continue;
      if (p.isDead) { this.deadSet.add(id); continue; }
      p.lastSeen = now; // bots never send positions — heartbeat manually
        // or the idle reaper would cull them on schedule

      // Respawn moved the body — reseat the shadow or the sim keeps
      // integrating from the corpse spot and every tick diverges.
      const wasDead = this.deadSet.has(id);
      if (!p.isDead && wasDead) {
        this.deadSet.delete(id);
        this.room.moveSim.resync(id, p.position, p.rotation.yaw);
      }

      const out = brain.think(dt, {
        pos: p.position,
        vel: p.velocity,
        enemies: this.enemiesOf(p),
        objective: this.flagGoal(p),
        // Team rooms drop nuggets on creature kills — bots farm them too,
        // which is what keeps a bot-filled match's scoreboard moving.
        pickup: this.room.pickups?.nearest(p.position) ?? undefined,
        groundY: (x, z) => (this.field ? hmHeight(this.field, x, z) : p.position.y),
        others: this.othersOf(p),
        now,
      });
      if (out.fire) this.fireAt(p, out.fire.targetId, out.fire.aim);

      const dx = out.dest.x - p.position.x;
      const dz = out.dest.z - p.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      const sh = this.room.moveSim.simState(id);
      if (sh) {
        // Legal path: convert the brain's destination into human inputs
        // (heading → yaw, walk = forward key) and let the sim integrate.
        // Commit happens on the NEXT tick — sims[] order puts moveSim.tick
        // after bots.tick, so this reads the fresh post-step state.
        if (dist >= 0.5) {
          const yaw = Math.atan2(dx, dz);
          this.room.moveSim.faceYaw(id, yaw);
          p.rotation.yaw = yaw;
          this.room.moveSim.setInput(id, {
            forward: 1, right: 0,
            jumpPressed: !!out.move?.jump, jumpHeld: !!out.move?.jump,
            skiHeld: !!out.move?.ski, jetHeld: !!out.move?.jet,
          }, p.status, this.seq++);
        } else {
          this.room.moveSim.setInput(id, { forward: 0, right: 0, jumpHeld: false, skiHeld: false, jetHeld: false }, p.status, this.seq++);
        }
        p.position.x = sh.pos.x; p.position.y = sh.pos.y; p.position.z = sh.pos.z;
        p.velocity.x = sh.vel.x; p.velocity.y = sh.vel.y; p.velocity.z = sh.vel.z;
        // Ski bit rides the tick flag byte (bit 2) — drives remote dust.
        p.skiing = out.move?.ski ? 1 : 0;
      } else {
        // No heightfield → no shadow → legacy direct-write fallback.
        if (dist < 0.5) { p.velocity.x = 0; p.velocity.z = 0; p.lastSeq++; continue; }
        const nx = dx / dist, nz = dz / dist;
        const speed = isSuper(id) ? SPEED * 3 : SPEED;
        p.velocity.x = nx * speed;
        p.velocity.z = nz * speed;
        const groundY = this.field ? hmHeight(this.field, p.position.x, p.position.z) : p.position.y;
        const targetY = Math.max(groundY + 0.1, p.position.y - 9 * dt);
        const hopping = p.position.y > groundY + 1.2;
        p.velocity.y = hopping ? p.velocity.y - 30 * dt : 0;
        p.position.x += p.velocity.x * dt;
        p.position.z += p.velocity.z * dt;
        p.position.y += p.velocity.y * dt;
        if (p.position.y < targetY) { p.position.y = targetY; p.velocity.y = 0; }
        p.rotation.yaw = Math.atan2(nx, nz);
      }

      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq
    }
  }
}
