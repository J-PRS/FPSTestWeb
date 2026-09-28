/**
 * ServerBots — server-driven filler players. A bot is just a PlayerState
 * with no socket: it lives in the room's PlayerManager, so hit claims,
 * knockback, deaths, respawn timers and the tick fan-out all reuse the
 * real player machinery for free. The per-tick movement here writes
 * position/velocity the same place client position messages would.
 *
 * Brains are shared/botBrain.ts — the same decision core the offline
 * GameBot runs, so personality is tuned once and ships to both runtimes.
 * Movement rides the room's MoveSim shadow (same physics + energy tank as
 * humans) when a heightfield is attached; the legacy terrain-clamp hop is
 * the no-field fallback. Fire spawns real RoomProjectiles shells —
 * botFire's rolled tracer only remains as the creature path and the
 * fallback when a spawn is refused.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { EYE_OFFSET } from '../../shared/constants.ts';
import { BotBrain, type BotEnemy, type BotVec } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';
import { STATUS, CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import type { PerkId } from '../../shared/perks.ts';

/** A bot's kit — weapon picked by engagement range, perk set at spawn so
 *  maxHealth and the move shadow's jet economy match a real loadout. */
interface BotLoadout { perk: PerkId; near: WeaponType; mid: WeaponType; far: WeaponType; belt: WeaponType; }
const NEAR_M = 15, FAR_M = 40;
const BOT_LOADOUTS: BotLoadout[] = [
  { perk: 'featherjets', near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.Rocket,        belt: WeaponType.Grenade },       // chaser
  { perk: 'bombardier',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.Rocket,        belt: WeaponType.RemoteRailgun }, // siege
  { perk: 'plated',      near: WeaponType.Chaingun, mid: WeaponType.PlasmaGun, far: WeaponType.Disc,          belt: WeaponType.Grenade },       // anchor
  { perk: 'overcharge',  near: WeaponType.Chaingun, mid: WeaponType.Disc,      far: WeaponType.Rocket,        belt: WeaponType.RemoteRailgun }, // skirmisher
];

const SPEED = 14;          // m/s ground move
const BOLT_SPEED = 60;     // m/s visual bolt + hitscan travel is instant

// Demo/debug knob: FPS_SUPERBOT=<id-substring> gives the matching bot
// superpowers — 3× ground speed and a hit roll that never misses.
const SUPERBOT = process.env.FPS_SUPERBOT ?? '';
const isSuper = (id: string) => SUPERBOT !== '' && id.includes(SUPERBOT);

export class ServerBots {
  private brains = new Map<string, BotBrain>();
  private loadouts = new Map<string, BotLoadout>();
  /** CTF role: plated anchors hold the stand, the rest press. */
  private roles = new Map<string, 'offense' | 'defense'>();
  /** Bots we saw dead — respawn transition resyncs the move shadow. */
  private deadSet = new Set<string>();
  /** inputMove ordering key — the shadow drops non-increasing seqs. */
  private seq = 1;
  private readonly room: Room;
  private readonly field: Heightfield | null;
  /** Stuck watchdog — last-seen position + when it last moved. A bot that
   *  doesn't cover ground is a bug worth a log line, not silent scenery. */
  private watchdog = new Map<string, { x: number; z: number; since: number; warned: boolean }>();
  /** Sheep detector — rolling window of mobility stats. A Tribes bot
   *  that never skis and never leaves the ground isn't fighting, it's
   *  grazing: warn on low ski/air fraction or walking-pace travel.
   *  Only ticks where the brain pushes a destination count, so anchor
   *  defenders holding a stand stay legitimately still. */
  private sheep = new Map<string, { winStart: number; ticks: number; skiAir: number; dist: number; lx: number; lz: number }>();
  private static readonly SHEEP_WIN_MS = 10000;
  private static readonly SHEEP_MIN_TICKS = 60;
  private static readonly SHEEP_SKIAIR = 0.5;
  private static readonly SHEEP_SPEED = 4;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
  }

  private nextIdx = 1;
  private maintainAt = 0;

  // Warn when an alive bot hasn't moved ~2m in this window; flag carriers
  // get the tighter leash since a parked carrier stalls the whole match.
  private static STUCK_MS = 5000;
  private static STUCK_MS_FLAG = 2500;
  private static STUCK_DIST = 2;

  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Call once at room creation, before human joins, so
   *  team balancing lands humans on the emptier side. */
  populate(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = `BOT-${this.room.name}${this.nextIdx++}`;
      const loadout = BOT_LOADOUTS[(this.nextIdx - 2 + BOT_LOADOUTS.length) % BOT_LOADOUTS.length];
      const p = this.room.players.addPlayer(id, undefined, loadout.perk);
      this.loadouts.set(id, loadout);
      // CTF role from the loadout: plated anchors hold home, everyone else
      // presses. A whole team grabbing leaves the stand unguarded.
      this.roles.set(id, loadout.perk === 'plated' ? 'defense' : 'offense');
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
    this.loadouts.delete(playerId);
    this.roles.delete(playerId);
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
  private fireAt(p: { id: string; position: Vec3; velocity: Vec3 }, targetId: string, aim: Vec3): void {
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
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dx0 = aim.x - muzzle.x, dy0 = aim.y - muzzle.y, dz0 = aim.z - muzzle.z;
    const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0) || 1;
    // Range-band weapon select — same judgment a player makes: hitscan
    // up close, the loadout's primary mid-band, rockets at standoff.
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0];
    const wt = dist < NEAR_M ? lo.near : dist > FAR_M ? lo.far : lo.mid;
    const stats = getWeaponStats(wt);
    // Lead the target by its velocity over the shell's flight time —
    // without it every bolt lands behind a skiing player forever.
    const lead = isSuper(p.id) ? dist / stats.speed : (dist / stats.speed) * 0.8;
    const ax = aim.x + target.velocity.x * lead - muzzle.x;
    const ay = aim.y + target.velocity.y * lead - muzzle.y;
    const az = aim.z + target.velocity.z * lead - muzzle.z;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const dir = { x: ax / alen, y: ay / alen, z: az / alen };
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      // Spawn refused (owner gone / hitscan stat line like Chaingun) —
      // rolled-tracer fallback keeps the bot armed rather than disarmed.
      const hit = isSuper(p.id) || Math.random() < Math.max(0.15, 0.6 - dist / 200);
      this.room.messages.botFire(
        p.id, hit ? targetId : null, muzzle,
        { x: dir.x * BOLT_SPEED, y: dir.y * BOLT_SPEED, z: dir.z * BOLT_SPEED },
        wt, hit,
      );
    }
  }

  /** Belt throw — a lobbed grenade at the hunt's last-seen spot. Same
   *  spawn path as the plasma bolt: RoomProjectiles owns the flight. */
  private throwBelt(p: { id: string; position: Vec3; velocity: Vec3 }): void {
    const wt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) return;
    const hunt = this.room.players.getPlayer(this.lastHuntId(p.id) ?? '');
    const aim = hunt?.position;
    if (!aim) return;
    const dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    const d = Math.hypot(dx, dz) || 1;
    // Grenade: lob the arc that lands ~d out. Remote railgun: throw
    // nearly flat — the beam discharges along the velocity line, so a
    // steep pitch aims the rail at the sky.
    const pitch = stats.rayDelay ? 0.15 : Math.min(0.7, d / stats.speed);
    const dir = { x: dx / d, y: pitch, z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    this.room.projectiles.spawn(p.id, wt,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: dir.x / len, y: dir.y / len, z: dir.z / len }, p.velocity);
  }

  /** The brain's current hunt target id — needed by throwBelt since the
   *  belt intent carries no aim point of its own. */
  private lastHuntId(botId: string): string | null {
    const brain = this.brains.get(botId);
    return brain?.currentHuntId ?? null;
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  carried off → run down the carrier (the carrier's position IS known —
   *  tickUpdate streams it, this is a legal pursuit not a wallhack); own
   *  flag dropped → touch it home; a teammate carrying → escort them;
   *  enemy flag reachable → go grab it. Defenders invert it: their flag
   *  recovery/intercept outranks pressing the enemy stand. */
  private flagGoal(p: { id: string; team?: string; position: Vec3 }): BotVec | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as 'alpha' | 'bravo';
    const enemyTeam = me === 'alpha' ? 'bravo' : 'alpha';
    const enemy = flags.flags.get(enemyTeam);
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) return own.home;
    const role = this.roles.get(p.id) ?? 'offense';

    // Own flag's carrier — chase the thief, not the base.
    const thief = own.state === 'carried' && own.carrier
      ? this.room.players.getPlayer(own.carrier) : null;
    // Own flag dropped — anyone close enough touches it home; defenders
    // treat it as top priority, offenders only when it's convenient.
    const dropped = own.state === 'dropped' ? own.pos : null;

    if (role === 'defense') {
      if (thief) return thief.position;
      if (dropped) return dropped;
      // Guard the stand — a defender parked on the stand ring stays in
      // intercept range of anyone who comes for it.
      return own.home;
    }

    // Carrier escort: a teammate has the enemy flag — bodyguard them home
    // rather than crowd the now-empty enemy stand.
    if (enemy.carrier) {
      const escort = this.room.players.getPlayer(enemy.carrier);
      if (escort && escort.team === me) return escort.position;
    }
    if (thief) return thief.position;
    if (dropped) return dropped;
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
    this.loadouts.delete(id);
    this.roles.delete(id);
    this.watchdog.delete(id);
    this.sheep.delete(id);
    this.room.moveSim.untrack(id);
    this.room.removePlayerCompletely(id, 'botFill', (m, o) => logger.info(m, o));
  }

  /** Stuck watchdog: warn when an alive bot hasn't covered ~2m in a few
   *  seconds (shorter leash for flag carriers — a parked carrier stalls
   *  the match). Re-arms each time the bot actually moves, so the log
   *  line marks the stall boundary rather than spamming every tick. */
  private checkStuck(id: string, p: { position: Vec3 }, brain: BotBrain, now: number): void {
    let w = this.watchdog.get(id);
    if (!w) {
      this.watchdog.set(id, { x: p.position.x, z: p.position.z, since: now, warned: false });
      return;
    }
    const dx = p.position.x - w.x, dz = p.position.z - w.z;
    if (dx * dx + dz * dz >= ServerBots.STUCK_DIST * ServerBots.STUCK_DIST) {
      w.x = p.position.x; w.z = p.position.z; w.since = now; w.warned = false;
      return;
    }
    const carrying = this.room.flags?.snapshot().some(f => f.carrier === id) ?? false;
    const leash = carrying ? ServerBots.STUCK_MS_FLAG : ServerBots.STUCK_MS;
    if (!w.warned && now - w.since > leash) {
      w.warned = true;
      logger.warn('Bot stuck', {
        room: this.room.name, bot: id,
        ms: now - w.since, carrying,
        hunting: brain.currentHuntId !== null,
        pos: { x: +p.position.x.toFixed(1), y: +p.position.y.toFixed(1), z: +p.position.z.toFixed(1) },
      });
    }
  }

  /** Rolling mobility audit. 'trying' = the brain has a destination this
   *  tick — defenders parked on a stand don't accrue. Warns once per
   *  10s window when a mobile bot stays flat-footed: under half its
   *  travel ticks skiing/airborne, or averaging walking pace. */
  private checkSheep(id: string, p: { position: Vec3 }, trying: boolean, skiAir: boolean, dtRef: number, now: number): void {
    let s = this.sheep.get(id);
    if (!s) {
      this.sheep.set(id, { winStart: now, ticks: 0, skiAir: 0, dist: 0, lx: p.position.x, lz: p.position.z });
      return;
    }
    const dx = p.position.x - s.lx, dz = p.position.z - s.lz;
    s.lx = p.position.x; s.lz = p.position.z;
    if (trying) { s.ticks++; s.dist += Math.hypot(dx, dz); if (skiAir) s.skiAir++; }
    const winMs = now - s.winStart;
    if (winMs < ServerBots.SHEEP_WIN_MS) return;
    if (s.ticks >= ServerBots.SHEEP_MIN_TICKS) {
      const frac = s.skiAir / s.ticks;
      const avgSpeed = s.dist / (s.ticks * dtRef); // per-tick distance → m/s
      const stats = {
        room: this.room.name, bot: id,
        skiAirPct: Math.round(frac * 100),
        avgSpeed: +avgSpeed.toFixed(1),
        covered: +s.dist.toFixed(1),
      };
      // Always-on record: healthy mobility is logged too so a regression
      // back to flat-footed bots is visible in review, not just failures.
      logger.info('Bot mobility', stats);
      if (frac < ServerBots.SHEEP_SKIAIR || avgSpeed < ServerBots.SHEEP_SPEED) {
        logger.warn('Bot sheeping', stats);
      }
    }
    s.winStart = now; s.ticks = 0; s.skiAir = 0; s.dist = 0;
  }

  tick(dt: number): void {
    this.maintain(Date.now());
    if (this.brains.size === 0) return;
    const now = Date.now();
    for (const [id, brain] of this.brains) {
      const p = this.room.players.getPlayer(id);
      if (!p) continue;
      if (p.isDead) {
        // First sighting of this corpse — the brain keeps the spot as a
        // death memory so its wander goals sour on kill zones.
        if (!this.deadSet.has(id)) brain.markDeath(p.position);
        this.deadSet.add(id);
        continue;
      }
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
        // The shadow tank is the truth — brains read it to gate jets,
        // shields, mends. Null field → undefined → full-tank behavior.
        energy: this.room.moveSim.energyOf(id) ?? undefined,
        healthFrac: p.maxHealth > 0 ? p.health / p.maxHealth : 1,
        // Inbound shells feed the dodge sense — bots sidestep rockets
        // like a human reading the arc instead of eating every volley.
        threats: this.room.projectiles.incomingNear(p.position, 12),
        sounds: this.room.noisesNear(p.position, 50),
        now,
      });
      // The brain's status intent IS the player's claim — same rising-edge
      // antes + drains the human path models, applied via setInput below.
      // Keep server-owned buff bits (REGEN/DD) — the brain only claims
      // the toggle skills a client could legitimately hold.
      if (out.status !== undefined) {
        p.status = (p.status & ~CLIENT_STATUS_MASK) | (out.status & CLIENT_STATUS_MASK);
      }
      if (out.fire) this.fireAt(p, out.fire.targetId, out.fire.aim);
      if (out.belt) this.throwBelt(p);

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
        this.checkSheep(id, p, dist >= 0.5, !!out.move?.ski || !sh.onGround, dt, now);
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
        // p.position is EYE-height (the wire convention — clients render
        // feet at pos.y - EYE_OFFSET); groundY+0.1 parked the model 1.7m
        // underground.
        const targetY = Math.max(groundY + EYE_OFFSET, p.position.y - 9 * dt);
        const hopping = p.position.y > groundY + EYE_OFFSET + 1.1;
        p.velocity.y = hopping ? p.velocity.y - 30 * dt : 0;
        p.position.x += p.velocity.x * dt;
        p.position.z += p.velocity.z * dt;
        p.position.y += p.velocity.y * dt;
        if (p.position.y < targetY) { p.position.y = targetY; p.velocity.y = 0; }
        p.rotation.yaw = Math.atan2(nx, nz);
      }

      this.checkStuck(id, p, brain, now);

      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq
    }
  }
}
