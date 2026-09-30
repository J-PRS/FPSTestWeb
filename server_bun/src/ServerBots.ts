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
import { BotBrain, type BotEnemy, type BotVec, type BrainCtx, type BrainOut } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';
import { pushRewindSample } from './rewind.ts';
import { STATUS, CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import type { MoveState } from '../../shared/movement.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { roleObjective, ROLE_PRIORITY, type BotRole } from '../../shared/flagGoals.ts';
import { BotWatchdog, type MobilitySample } from './botWatchdog.ts';
import { BotArsenal, isSuper } from './botArsenal.ts';

const SPEED = 14;          // m/s ground move

/** Tribes-flavored squad roles — the type and the objective rules live in
 *  shared/flagGoals.ts so offline CTF plays by the identical table. */


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
  /** Brains silenced for tests — the body stays in the sim, it just never
   *  thinks: no wander, no cloak, no shots. Production code never populates
   *  this; the scenario harness does. */
  readonly quiet = new Set<string>();
  /** Next allowed sentry-clearing lob per bot — keeps gear suppression
   *  on a human cadence instead of a per-tick mortar stream. */
  private gearLobT = new Map<string, number>();
  /** inputMove ordering key — the shadow drops non-increasing seqs. */
  private seq = 1;
  /** Sheep meter per bot: foot-slogging fills it, skiing/airborne/jetting
   *  drains it. At 100 the bot gets yeeted — a launch impulse plus an
   *  escape-jet burst, so the penalty for pedestrian play is literally
   *  becoming a Tribes player for a few seconds. */
  private sheepMeter = new Map<string, number>();
  /** Yeet hang-time — while set the bot's jet stays pinned so the launch
   *  carries through instead of being a single frame of thrust. */
  private yeetUntil = new Map<string, number>();
  /** Trigger discipline — own file (botArsenal.ts): weapon select,
   *  muzzle geometry, lobs, disc-jump propels. This file drives brains
   *  and bodies; the arsenal decides when and at what to fire. */
  private arsenal: BotArsenal;
  private readonly room: Room;
  private readonly field: Heightfield | null;
  /** Mobility watchdog — stuck + sheep alarms live in botWatchdog.ts so
   *  this file stays about driving bots, not auditing them. */
  private watchdog: BotWatchdog;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
    this.watchdog = new BotWatchdog(room.name);
    this.arsenal = new BotArsenal(room, this.loadouts, (id) => this.lastHuntId(id));
  }

  private nextIdx = 1;
  private maintainAt = 0;
  /** Brain cadence: senses+think+fire run every THINK_DIV tick per bot
   *  (phase-offset so the squad doesn't think in lockstep). 20Hz decisions
   *  cost O(bots × (players+creatures)) per tick; at 4Hz reaction is still
   *  faster than human perception while the move sim keeps integrating
   *  at full rate, so motion smoothness is unchanged. */
  private static readonly THINK_DIV = 5;
  private thinkPhase = new Map<string, number>();
  private lastOut = new Map<string, BrainOut>();
  private thinkCounter = 0;

  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Call once at room creation, before human joins, so
   *  team balancing lands humans on the emptier side. */
  populate(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = `BOT-${this.room.name}${this.nextIdx++}`;
      const loadout = BOT_LOADOUTS[(this.nextIdx - 2 + BOT_LOADOUTS.length) % BOT_LOADOUTS.length]!;
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
      this.thinkPhase.set(id, this.nextIdx % ServerBots.THINK_DIV);
      // Legal body: the bot gets a move shadow exactly like a human join —
      // brains emit inputs, the sim owns motion, energy model included.
      this.room.moveSim.track(id, p.position, p.rotation.yaw, p.perk);
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
  }

  get count(): number {
    return this.brains.size;
  }

  /** Prune a bot that was fully removed (room teardown / test hooks).
   *  EVERY keyed structure dies here — retire and teardown both funnel
   *  through, so a bot id must not outlive its roster entry in any map. */
  untrack(playerId: string): void {
    this.brains.delete(playerId);
    this.loadouts.delete(playerId);
    this.thinkPhase.delete(playerId);
    this.lastOut.delete(playerId);
    this.roles.delete(playerId);
    this.classes.delete(playerId);
    this.sheepMeter.delete(playerId);
    this.yeetUntil.delete(playerId);
    this.arsenal.untrack(playerId);
    this.gearLobT.delete(playerId);
    this.deadSet.delete(playerId);
    this.quiet.delete(playerId);
    this.watchdog.remove(playerId);
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
    const enemy = flags.flags.get(me === 'alpha' ? 'bravo' : 'alpha');
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) return { pos: own.home, infiltrating: false };

    const enemyStand = enemy.state !== 'carried' ? enemy.pos : null;
    // One role table for both runtimes — shared/flagGoals.ts.
    const pick = roleObjective(this.roles.get(p.id) ?? 'offense', {
      home: own.home,
      // Own flag's carrier — chase the thief, not the base.
      thief: own.state === 'carried' && own.carrier
        ? this.room.players.getPlayer(own.carrier)?.position ?? null : null,
      // Own flag dropped — anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
    });
    // Pressing the enemy stand is the infiltrate signal — the brain reads
    // it as cloak intent on the approach.
    return { pos: pick, infiltrating: pick === enemyStand && enemyStand !== null };
  }

  /** A teammate carrying the enemy flag is the escort point — the
   *  carrier's position is already on the wire, no wallhack needed. */
  private escortSpot(carrier: string | null | undefined, me: 'alpha' | 'bravo'): Vec3 | null {
    const escortP = carrier ? this.room.players.getPlayer(carrier) : null;
    return escortP && escortP.team === me ? escortP.position : null;
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
    // Heavies shoulder the mortar — tier-locked ordnance is what makes the
    // class read as an anchor instead of just a slower medium.
    if (cls === 'heavy') {
      const lo = this.loadouts.get(p.id);
      if (lo && lo.far !== WeaponType.Mortar) this.loadouts.set(p.id, { ...lo, far: WeaponType.Mortar });
    }
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
    for (const ids of byTeam.values()) this.rebalanceTeam(ids);
  }

  /** One team's role fill: walk ROLE_PRIORITY (capper@3 … infiltrator@7)
   *  so a 3-stack gets capper+LD and specialists only show once the
   *  lanes they free up are actually covered. */
  private rebalanceTeam(ids: string[]): void {
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
    const donors = free.filter((id) => !ROLE_PRIORITY.some((w) => this.roles.get(id) === w.role));
    for (const { role: want, want: need, minSquad } of ROLE_PRIORITY) {
      if (ids.length < minSquad) break;
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
    this.untrack(id);
    this.room.removePlayerCompletely(id, 'botFill', (m, o) => logger.info(m, o));
  }

  private checkStuck(id: string, p: { position: Vec3 }, brain: BotBrain, now: number): void {
    const carrying = this.room.flags?.snapshot().some(f => f.carrier === id) ?? false;
    this.watchdog.checkStuck(id, p.position, brain, carrying, now);
  }

  private checkSheep(id: string, p: { position: Vec3 }, m: MobilitySample, now: number): void {
    this.watchdog.checkSheep(id, p.position, m, now);
  }

  /** The brain's sensorium for one tick — every channel a legal client
   *  could read from the wire (positions, pickups, inbound shells,
   *  noises, wall occlusion, the move shadow's honest energy tank). */
  private senses(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number }, goal: { pos: BotVec; infiltrating: boolean } | null, now: number): BrainCtx {
    return {
      pos: p.position,
      vel: p.velocity,
      enemies: this.enemiesOf(p),
      objective: goal?.pos ?? null,
      infiltrating: goal?.infiltrating ?? false,
      // Team rooms drop nuggets on creature kills — bots farm them too,
      // which is what keeps a bot-filled match's scoreboard moving.
      pickup: this.room.pickups?.nearest(p.position) ?? undefined,
      // Gem-economy rooms make hunting creatures the actual objective;
      // on any map that spawns real creatures they're threats worth
      // shooting too. Structureless-free: pops is {} where spec doesn't
      // declare `creatures`.
      huntCreatures: this.room.mode === 'nuggets'
        || Object.values(this.room.creatureSim.pops).some((cap) => cap > 0),
      // Structures read as raised ground — brains route around walls
      // and onto platforms instead of pushing into solid geometry.
      groundY: (x, z) => Math.max(
        this.field ? hmHeight(this.field, x, z) : p.position.y,
        this.room.moveSim.structureTop(x, z),
      ),
      others: this.othersOf(p),
      // Aim lead uses the muzzle speed of the weapon this bot would
      // pick at that range — same band select fireAt runs.
      weaponSpeed: (d) => {
        const w = pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d);
        return getWeaponStats(w).speed || 60;
      },
      // Lobbed shells need the arc's drop added back on the aim point.
      weaponGravity: (d) =>
        getWeaponStats(pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d)).gravity,
      // Wall occlusion for the LOS sense — bots stop wasting ammo on
      // targets behind structures they'd never see through anyway.
      solids: this.room.ballSim.colliders,
      solidIndex: this.room.ballSim.colliderIndex,
      // The shadow tank is the truth — brains read it to gate jets,
      // shields, mends. Null field → undefined → full-tank behavior.
      energy: this.room.moveSim.energyOf(id) ?? undefined,
      healthFrac: p.maxHealth > 0 ? p.health / p.maxHealth : 1,
      // Inbound shells feed the dodge sense — bots sidestep rockets
      // like a human reading the arc instead of eating every volley.
      threats: this.room.projectiles.incomingNear(p.position, 12),
      sounds: this.room.noisesNear(p.position, 50),
      now,
    };
  }

  /** The brain's status intent IS the player's claim — same rising-edge
   *  antes + drains the human path models, applied via setInput below.
   *  Keep server-owned buff bits (REGEN/DD) — the brain only claims
   *  the toggle skills a client could legitimately hold. */
  private applyStatus(id: string, p: { status: number }, out: BrainOut): void {
    if (out.status === undefined) return;
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

  /** Everything the brain asked to shoot or plant this tick — primary
   *  trigger, belt throw, sentry-clearing lob on its slow cadence, and
   *  deploy claims re-validated through the human message path. */
  private firePhase(id: string, p: { id: string; position: Vec3; velocity: Vec3; team?: string }, out: BrainOut, goal: { pos: BotVec } | null, now: number, sh: MoveState | null): void {
    if (out.fire) this.arsenal.fireAt(p, out.fire.targetId, out.fire.aim);
    if (out.belt) this.arsenal.throwBelt(p);
    this.arsenal.tryPropel(id, p, out, goal, sh, now);
    // Sentry-clearing lob: hostile gear watching the objective gets a
    // grenade on its own slow cadence — the same legal path humans use
    // to soften a stand, not a wallhack aim-assist.
    const saboteur = this.roles.get(id) === 'infiltrator';
    const ready = (this.gearLobT.get(id) ?? 0) <= now;
    const gear = ready ? this.hostileGear(p, goal?.pos ?? null, saboteur) : null;
    if (gear) {
      this.arsenal.lobAt(p, gear);
      // 3s keeps a siege going: ~1.5-2s grenade flight + reload beat.
      // At 8s a turret effectively outlived the lobber's attention.
      // A saboteur pushes harder — wrecking gear IS its objective.
      this.gearLobT.set(id, now + (saboteur ? 1800 : 3000));
      logger.debug('Gear lob', { id, x: +gear.x.toFixed(1), z: +gear.z.toFixed(1) });
    }
    // Deploy claims run the same handleDeploy a human's message does —
    // kind, plant distance, and per-player cap are all re-validated.
    if (out.deploy) this.room.deployables.handleDeploy(id, out.deploy.kind, out.deploy.pos);
  }

  /** Legal path: convert the brain's destination into human inputs
   *  (heading → yaw, walk = forward key) and let the sim integrate.
   *  Commit happens on the NEXT tick — sims[] order puts moveSim.tick
   *  after bots.tick, so this reads the fresh post-step state. */
  private driveMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; status: number; skiing: number }, out: BrainOut, sh: MoveState, dt: number, now: number): void {
    const dx = out.dest.x - p.position.x;
    const dz = out.dest.z - p.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= 0.5) {
      // Wrist-speed turn — a snapped 180° reads as a fly-flick while an
      // arc at ~5 rad/s reads as a player swinging their view around.
      const want = Math.atan2(dx, dz);
      let dyaw = want - p.rotation.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yaw = p.rotation.yaw + Math.max(-5 * dt, Math.min(5 * dt, dyaw));
      this.room.moveSim.faceYaw(id, yaw);
      p.rotation.yaw = yaw;
      this.room.moveSim.setInput(id, {
        forward: 1, right: 0,
        jumpPressed: !!out.move?.jump, jumpHeld: !!out.move?.jump,
        skiHeld: !!out.move?.ski,
        jetHeld: !!out.move?.jet || (this.yeetUntil.get(id) ?? 0) > now
          || this.arsenal.jetPinUntil(id) > now,
      }, p.status, this.seq++);
    } else {
      this.room.moveSim.setInput(id, { forward: 0, right: 0, jumpHeld: false, skiHeld: false, jetHeld: false }, p.status, this.seq++);
    }
    this.checkSheep(id, p, { trying: dist >= 0.5, ski: !!out.move?.ski, airborne: !sh.onGround, jetting: !!out.move?.jet, dt }, now);
    this.checkSheepMeter(id, p, { out, airborne: !sh.onGround, hasDest: dist >= 0.5, dt }, now);
    p.position.x = sh.pos.x; p.position.y = sh.pos.y; p.position.z = sh.pos.z;
    p.velocity.x = sh.vel.x; p.velocity.y = sh.vel.y; p.velocity.z = sh.vel.z;
    // Ski bit rides the tick flag byte (bit 2) — drives remote dust.
    p.skiing = out.move?.ski ? 1 : 0;
  }

  /** No heightfield → no shadow → legacy direct-write fallback.
   *  Returns true when the parked case already finished the tick. */
  private legacyMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; lastSeq: number }, dest: Vec3, dt: number): boolean {
    const dx = dest.x - p.position.x;
    const dz = dest.z - p.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.5) { p.velocity.x = 0; p.velocity.z = 0; p.lastSeq++; return true; }
    const nx = dx / dist, nz = dz / dist;
    const speed = isSuper(id) ? SPEED * 3 : SPEED;
    p.velocity.x = nx * speed;
    p.velocity.z = nz * speed;
    const groundY = Math.max(
      this.field ? hmHeight(this.field, p.position.x, p.position.z) : p.position.y,
      this.room.moveSim.structureTop(p.position.x, p.position.z),
    );
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
    return false;
  }

  /** The meter the tick stream publishes — 0 for non-bots. */
  sheepOf(id: string): number {
    return Math.round(this.sheepMeter.get(id) ?? 0);
  }

  /** Test hook — seed the meter directly; accrual tests shouldn't need
   *  to park a bot for 30 simulated seconds to reach the yeet. */
  debugSetSheep(id: string, v: number): void {
    this.sheepMeter.set(id, v);
  }

  /** Test hook — whether the bot's jet is currently pinned by a yeet. */
  debugYeeted(id: string): boolean {
    return (this.yeetUntil.get(id) ?? 0) > Date.now();
  }

  /** Sheep meter accrual. Fills when the bot moves like a pedestrian —
   *  walking under ski speed or parked — and drains faster while it's
   *  doing Tribes things (covering ground, airborne, jetting). At 100
   *  the bot gets yeeted: an impulse launch plus pinned jets, so the
   *  penalty for sheepish play IS the cure. */
  private checkSheepMeter(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; airborne: boolean; hasDest: boolean; dt: number }, now: number): void {
    const speedXZ = Math.hypot(p.velocity.x, p.velocity.z);
    const jetting = !!m.out.move?.jet || (this.yeetUntil.get(id) ?? 0) > now;
    const tribesing = speedXZ > 8 || m.airborne || jetting;
    const prev = this.sheepMeter.get(id) ?? 0;
    let meter = prev + m.dt * (tribesing
      ? -(8 + speedXZ * 0.5 + (jetting ? 12 : 0))
      : m.hasDest ? 6 : 14);
    if (meter >= 100) {
      const yaw = Math.random() * Math.PI * 2;
      this.room.moveSim.applyImpulse(id, { x: Math.cos(yaw) * 12, y: 18, z: Math.sin(yaw) * 12 });
      this.yeetUntil.set(id, now + 1500);
      meter = 40;
      logger.warn('Sheep yeet', { room: this.room.name, bot: id });
    } else if (meter < 0) {
      meter = 0;
    } else if (prev < 60 && meter >= 60) {
      logger.info('Sheep meter high', { room: this.room.name, bot: id, meter: Math.round(meter) });
    }
    this.sheepMeter.set(id, meter);
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
      // Liveness upkeep like the heartbeat: must run before the quiet
      // skip or a silenced bot that dies and respawns keeps a stale
      // deadSet entry + corpse-spot shadow forever.
      const wasDead = this.deadSet.has(id);
      if (!p.isDead && wasDead) {
        this.deadSet.delete(id);
        this.sheepMeter.delete(id); // respawn is a fresh leash
        this.room.moveSim.resync(id, p.position, p.rotation.yaw, true);
      }

      // Test-silenced: heartbeat and shadow upkeep still run — only the
      // think/fire/move pipeline is skipped.
      if (this.quiet.has(id)) continue;

      // Think pipeline runs on the bot's slow cadence; between thinks the
      // previous decision is re-emitted so the move sim still gets inputs
      // every tick (a stale dest for 200ms beats idling the drive).
      this.thinkCounter = (this.thinkCounter + 1) % ServerBots.THINK_DIV;
      let out = this.lastOut.get(id);
      if (this.thinkCounter === (this.thinkPhase.get(id) ?? 0) || !out) {
        const goal = this.flagGoal(p);
        out = brain.think(dt * ServerBots.THINK_DIV, this.senses(id, p, goal, now));
        this.applyStatus(id, p, out);
        const sh0 = this.room.moveSim.simState(id);
        this.firePhase(id, p, out, goal, now, sh0);
        this.lastOut.set(id, out);
      }
      const sh = this.room.moveSim.simState(id);
      if (sh) this.driveMove(id, p, out, sh, dt, now);
      else if (this.legacyMove(id, p, out.dest, dt)) continue;

      this.checkStuck(id, p, brain, now);

      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq

      // Bots never send positions, so nothing else feeds their rewind
      // buffer — without samples, hit validation rewinds to the stale
      // spawn seed and legit shots at moving bots get rejected.
      pushRewindSample(p, now);
    }
  }
}
