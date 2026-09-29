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
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';

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

/** Tribes-flavored squad roles. capper runs the flag route, offense clears
 *  the stand / escorts, ldefense (light defense) holds home but chases the
 *  thief the moment the flag moves, hof is Heavy-on-Flag (parks ON the
 *  stand and never pursues), defense is a generic home guard, technician
 *  is home defense that emplaces gear, infiltrator cloaks deep and wrecks
 *  gear before grabbing. */
type BotRole = 'capper' | 'offense' | 'ldefense' | 'hof' | 'defense' | 'technician' | 'infiltrator';

/** Armor class follows the role — Tribes pacing lives on this: cappers
 *  and infiltrators fly light, HoF and technicians anchor heavy, the
 *  fighting middle wears medium. */
const ROLE_CLASS: Record<BotRole, ArmorClass> = {
  capper: 'light', infiltrator: 'light',
  offense: 'medium', ldefense: 'medium', defense: 'medium',
  hof: 'heavy', technician: 'heavy',
};

export class ServerBots {
  private brains = new Map<string, BotBrain>();
  private loadouts = new Map<string, BotLoadout>();
  /** Squad role — self-assigned and rebalanced by need (see
   *  rebalanceRoles): nobody scripts positions, the squad just notices
   *  a lane is empty and someone takes it. */
  private roles = new Map<string, BotRole>();
  /** Bots we saw dead — respawn transition resyncs the move shadow. */
  private deadSet = new Set<string>();
  /** Next allowed sentry-clearing lob per bot — keeps gear suppression
   *  on a human cadence instead of a per-tick mortar stream. */
  private gearLobT = new Map<string, number>();
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
  private sheep = new Map<string, { winStart: number; ticks: number; skiAir: number; air: number; jet: number; dist: number; lx: number; lz: number }>();
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
      // Seed roles from the loadout; the rebalancer shifts them as the
      // match's needs change. Plated anchors start as HoF candidates.
      this.roles.set(id, loadout.perk === 'plated' ? 'hof' : 'offense');
      this.applyClass(p, ROLE_CLASS[this.roles.get(id)!]);
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
    this.classes.delete(playerId);
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
    const hunt = this.room.players.getPlayer(this.lastHuntId(p.id) ?? '');
    if (hunt) this.lobAt(p, hunt.position);
  }

  /** Lob the belt weapon at an explicit point — used for hunt targets
   *  and for hostile emplacements blocking the bot's objective. */
  private lobAt(p: { id: string; position: Vec3; velocity: Vec3 }, aim: Vec3): void {
    const wt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) return;
    const dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    const d = Math.hypot(dx, dz) || 1;
    // Ballistic lob: range = v²·sin(2θ)/|g| — solve θ for the target's
    // distance instead of guessing a pitch, since the grenade's 13m
    // splash can't cover a 15m overshoot. Rails stay flat.
    let pitch: number;
    if (stats.rayDelay) {
      pitch = 0.15;
    } else {
      const g = Math.abs(stats.gravity) || 28;
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    // The throw inherits half the bot's velocity (see RoomProjectiles.spawn)
    // — a skiing bot's 10+ m/s of carry still swings a 40 m/s toss off
    // target, so aim the launch against it.
    const vx = (dir.x / len) * stats.speed - p.velocity.x * 0.5;
    const vy = (dir.y / len) * stats.speed - p.velocity.y * 0.5;
    const vz = (dir.z / len) * stats.speed - p.velocity.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    this.room.projectiles.spawn(p.id, wt,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: vx / vl, y: vy / vl, z: vz / vl }, p.velocity);
  }

  /** Hostile emplacement the bot can legally see — a turret/mine/drone
   *  owned by the other team, near the bot and near what it's after.
   *  The stand's kill-zone is knowledge the room advertises anyway. */
  private hostileGear(p: { id: string; team?: string; position: Vec3 }, goal: BotVec | null, sabotage = false): Vec3 | null {
    if (!goal && !sabotage) return null;
    let best: Vec3 | null = null;
    // Lob from the edge of turret sight (42m) — a bot that must first
    // survive to 30m never gets the shot off.
    let bestD = 40;
    for (const d of this.room.deployables.snapshot()) {
      if (d.kind === 'station') continue; // pads aren't a threat
      const owner = this.room.players.getPlayer(d.owner);
      if (p.team && owner?.team === p.team) continue;
      if (!p.team && d.owner === p.id) continue;
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      // A saboteur wrecks whatever gear it can reach — goal proximity
      // only gates the objective-driven lobbers.
      const gd = goal ? Math.hypot(d.pos.x - goal.x, d.pos.z - goal.z) : 0;
      if (bd < bestD && (sabotage || gd < 50)) { bestD = bd; best = d.pos; }
    }
    return best;
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
  private flagGoal(p: { id: string; team?: string; position: Vec3 }): { pos: BotVec; infiltrating: boolean } | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as 'alpha' | 'bravo';
    const enemyTeam = me === 'alpha' ? 'bravo' : 'alpha';
    const enemy = flags.flags.get(enemyTeam);
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    const homeward = { pos: own.home, infiltrating: false };
    if (enemy.carrier === p.id) return homeward;
    const role = this.roles.get(p.id) ?? 'offense';

    // Own flag's carrier — chase the thief, not the base.
    const thief = own.state === 'carried' && own.carrier
      ? this.room.players.getPlayer(own.carrier) : null;
    // Own flag dropped — anyone close enough touches it home; defenders
    // treat it as top priority, offenders only when it's convenient.
    const dropped = own.state === 'dropped' ? own.pos : null;
    const enemyStand = enemy.state !== 'carried'
      ? { pos: enemy.pos, infiltrating: true } : null;

    switch (role) {
      // HoF: planted on the stand, PERIOD — never chases a thief (that's
      // what LD exists for). Only leaves the ring for a flag dropped in
      // easy reach; anything else is someone else's job.
      case 'hof':
        if (dropped && Math.hypot(dropped.x - own.home.x, dropped.z - own.home.z) < 25)
          return { pos: dropped, infiltrating: false };
        return homeward;

      // Light defense / technician / generic defense: home-side
      // priorities — thief, dropped, then hold home in intercept range.
      case 'ldefense':
      case 'technician':
      case 'defense':
        if (thief) return { pos: thief.position, infiltrating: false };
        if (dropped) return { pos: dropped, infiltrating: false };
        return homeward;

      // Capper: the flag route is the job — chase a carrier teammate to
      // escort, otherwise press the stand. Only a dropped own flag on the
      // way home pulls it off-route.
      case 'capper':
        if (enemy.carrier) {
          const escort = this.room.players.getPlayer(enemy.carrier);
          if (escort && escort.team === me) return { pos: escort.position, infiltrating: false };
        }
        if (dropped) return { pos: dropped, infiltrating: false };
        if (enemyStand) return enemyStand;
        return homeward;

      // Infiltrator: slips in cloaked to wreck gear / grab — infiltrating
      // holds even at the stand so the cloak keeps covering the breach.
      case 'infiltrator':
        if (enemy.carrier) {
          const escort = this.room.players.getPlayer(enemy.carrier);
          if (escort && escort.team === me) return { pos: escort.position, infiltrating: false };
        }
        if (enemyStand) return enemyStand;
        if (thief) return { pos: thief.position, infiltrating: false };
        return homeward;

      // Offense (light offense in Tribes terms): escort a carrier, punish
      // a thief, else press the enemy stand to clear it for the capper.
      default:
        if (enemy.carrier) {
          const escort = this.room.players.getPlayer(enemy.carrier);
          if (escort && escort.team === me) return { pos: escort.position, infiltrating: false };
        }
        if (thief) return { pos: thief.position, infiltrating: false };
        if (dropped) return { pos: dropped, infiltrating: false };
        if (enemyStand) return enemyStand;
        return homeward; // flag's moving — defend home
    }
  }

  /** Apply the armor class to a live bot record: maxHealth shifts and
   *  current HP follows the delta (gaining plating grants the points,
   *  dropping it just clamps). The move shadow's ground scale makes the
   *  class legally different — a light capper really out-runs a heavy. */
  private classes = new Map<string, ArmorClass>();
  private applyClass(p: { id: string; maxHealth: number; health: number }, cls: ArmorClass): void {
    const prev = this.classes.get(p.id);
    if (prev === cls) return;
    const base = p.maxHealth - (prev ? CLASS_STATS[prev].maxHealth : 0);
    this.classes.set(p.id, cls);
    const delta = base + CLASS_STATS[cls].maxHealth - p.maxHealth;
    p.maxHealth += delta;
    p.health = Math.min(p.maxHealth, p.health + Math.max(0, delta));
    this.room.moveSim.setSpeedScale(p.id, CLASS_STATS[cls].speedScale);
  }

  /** Rebalance squad roles ~every 5s. Needs are computed per team: a flag
   *  mode wants a capper; a bigger squad earns a HoF anchor, a technician
   *  and an infiltrator; the rest split offense/defense. Reassignment
   *  skips carriers mid-run — the flagGoal carrier check owns them. */
  private roleT = 0;
  private rebalanceRoles(now: number): void {
    if (!this.room.flags || now < this.roleT) return;
    this.roleT = now + 5000;
    const byTeam = new Map<string, string[]>();
    for (const id of this.brains.keys()) {
      const p = this.room.players.getPlayer(id);
      if (!p?.team) continue;
      (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(id);
    }
    // Desired role counts by squad size — a duo can't afford specialists.
    const WANT: [BotRole, number][] = [
      ['capper', 1], ['ldefense', 1], ['hof', 1], ['technician', 1], ['infiltrator', 1],
    ];
    // Core before luxury: a 3-stack gets capper+LD, specialists only show
    // once the lanes they free up are actually covered.
    const MIN_SQUAD = [3, 4, 5, 6, 7]; // squad sizes unlocking each WANT row
    for (const ids of byTeam.values()) {
      // Never reassign a carrier — the flagGoal carrier check owns them.
      const free = ids.filter((id) => {
        const p = this.room.players.getPlayer(id);
        if (!p || p.isDead) return true; // corpses re-role freely on respawn
        for (const f of this.room.flags!.flags.values()) {
          if (f.carrier === id) return false;
        }
        return true;
      });
      // Specialists are sticky: donors only come from the generic pool
      // (offense/defense), and a bot is consumed once per cycle — else the
      // same body flip-flops capper→hof→technician on every pass.
      const isSpecial = (id: string) => WANT.some(([r]) => this.roles.get(id) === r);
      const donors = free.filter((id) => !isSpecial(id));
      for (let i = 0; i < WANT.length; i++) {
        const [want, need] = [WANT[i][0], WANT[i][1]];
        if (ids.length < MIN_SQUAD[i]) break;
        let have = 0;
        for (const id of ids) if (this.roles.get(id) === want) have++;
        while (have < need) {
          const donor = donors.shift();
          if (!donor) break;
          this.roles.set(donor, want);
          const donorP = this.room.players.getPlayer(donor);
          if (donorP) this.applyClass(donorP, ROLE_CLASS[want]);
          // Technician is the only role that promises the deploy kit —
          // pin its builder trait instead of trusting the spawn roll.
          if (want === 'technician') this.brains.get(donor)?.setBuilder(true);
          logger.info('Bot role', { id: donor, role: want, room: this.room.name });
          have++;
        }
      }
    }
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
    this.rebalanceRoles(now);
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
    // Stand-and-shoot is a legal pick — park the timer while the brain is
    // holding a combat spot or the warn is a false positive.
    if (!carrying && brain.holding) { w.since = now; return; }
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
  private checkSheep(id: string, p: { position: Vec3 }, trying: boolean, ski: boolean, airborne: boolean, jetting: boolean, dtRef: number, now: number): void {
    let s = this.sheep.get(id);
    if (!s) {
      this.sheep.set(id, { winStart: now, ticks: 0, skiAir: 0, air: 0, jet: 0, dist: 0, lx: p.position.x, lz: p.position.z });
      return;
    }
    const dx = p.position.x - s.lx, dz = p.position.z - s.lz;
    s.lx = p.position.x; s.lz = p.position.z;
    if (trying) {
      s.ticks++; s.dist += Math.hypot(dx, dz);
      if (ski || airborne) s.skiAir++;
      // airPct is the honest "dynamic Tribes bot" number — skiHeld on the
      // ground counts as ski, but only real altitude counts as air.
      if (airborne) s.air++;
      if (jetting) s.jet++;
    }
    const winMs = now - s.winStart;
    if (winMs < ServerBots.SHEEP_WIN_MS) return;
    if (s.ticks >= ServerBots.SHEEP_MIN_TICKS) {
      const frac = s.skiAir / s.ticks;
      const avgSpeed = s.dist / (s.ticks * dtRef); // per-tick distance → m/s
      const stats = {
        room: this.room.name, bot: id,
        skiAirPct: Math.round(frac * 100),
        airPct: Math.round((s.air / s.ticks) * 100),
        jetPct: Math.round((s.jet / s.ticks) * 100),
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
    s.winStart = now; s.ticks = 0; s.skiAir = 0; s.air = 0; s.jet = 0; s.dist = 0;
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

      const goal = this.flagGoal(p);
      const out = brain.think(dt, {
        pos: p.position,
        vel: p.velocity,
        enemies: this.enemiesOf(p),
        objective: goal?.pos ?? null,
        infiltrating: goal?.infiltrating ?? false,
        // Team rooms drop nuggets on creature kills — bots farm them too,
        // which is what keeps a bot-filled match's scoreboard moving.
        pickup: this.room.pickups?.nearest(p.position) ?? undefined,
        // Gem-economy rooms make hunting creatures the actual objective;
        // elsewhere food is just a distraction and this stays unset.
        huntCreatures: this.room.mode === 'nuggets',
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
        const claim = out.status & CLIENT_STATUS_MASK;
        // Rising-edge skill activation — the only place a bot's mend/
        // shield/cloak intent becomes visible in logs.
        const rising = claim & ~(p.status & CLIENT_STATUS_MASK);
        if (rising & (STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK)) {
          const names = ([
            [STATUS.MEND, 'MEND'], [STATUS.SHIELD, 'SHIELD'], [STATUS.CLOAK, 'CLOAK'],
          ] as const).filter(([bit]) => rising & bit).map(([, n]) => n);
          logger.info('Bot skill on', { id, skill: names.join('+') });
        }
        p.status = (p.status & ~CLIENT_STATUS_MASK) | claim;
      }
      if (out.fire) this.fireAt(p, out.fire.targetId, out.fire.aim);
      if (out.belt) this.throwBelt(p);
      // Sentry-clearing lob: hostile gear watching the objective gets a
      // grenade on its own slow cadence — the same legal path humans use
      // to soften a stand, not a wallhack aim-assist.
      {
        const saboteur = this.roles.get(id) === 'infiltrator';
        const ready = (this.gearLobT.get(id) ?? 0) <= now;
        const gear = ready ? this.hostileGear(p, goal?.pos ?? null, saboteur) : null;
        if (gear) {
          this.lobAt(p, gear);
          // 3s keeps a siege going: ~1.5-2s grenade flight + reload beat.
          // At 8s a turret effectively outlived the lobber's attention.
          // A saboteur pushes harder — wrecking gear IS its objective.
          this.gearLobT.set(id, now + (saboteur ? 1800 : 3000));
          logger.debug('Gear lob', { id, x: +gear.x.toFixed(1), z: +gear.z.toFixed(1) });
        }
      }
      // Deploy claims run the same handleDeploy a human's message does —
      // kind, plant distance, and per-player cap are all re-validated.
      if (out.deploy) this.room.deployables.handleDeploy(id, out.deploy.kind, out.deploy.pos);

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
        this.checkSheep(id, p, dist >= 0.5, !!out.move?.ski, !sh.onGround, !!out.move?.jet, dt, now);
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
