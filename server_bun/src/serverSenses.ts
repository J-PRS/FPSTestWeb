/**
 * ServerBotSenses — the brain's sensorium for a server-driven bot.
 * Every channel a legal client could read from the wire: positions,
 * pickups, inbound shells, noises, wall occlusion, the move shadow's
 * honest energy tank. Split out of ServerBots so that file stays about
 * driving bodies; this one only builds what the brain is allowed to see.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { losClear, BRAWL_RANGE, FOE_CONE_MIN_DOT, type BotEnemy, type BotVec, type BrainCtx } from '../../shared/botBrain.ts';
import type { ChatterKind } from '../../shared/botTaunts.ts';
import { STATUS } from '../../shared/status.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { dist3 } from '../../shared/botVec.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { roleObjective, type BotRole, type FlagSituation } from '../../shared/flagGoals.ts';
import { TeamCommand, type CommandMember } from './botCommand.ts';
import { DEPLOY_HP } from '../../shared/deployables.ts';
import type { TeamId } from '../../shared/teams.ts';
import { simNow } from './simClock.ts';
import { botRand } from '../../shared/botRand.ts';
import { TerrainFlow } from '../../shared/botGraph.ts';

export class ServerBotSenses {
  constructor(
    private readonly room: Room,
    private readonly field: Heightfield | null,
    private readonly loadouts: Map<string, BotLoadout>,
    private readonly roles: Map<string, BotRole>,
    /** Visible-enemy-present flags (epoch ms expiry) — markFoeNear writes,
     *  ServerBots reads for the sheep charge. */
    private readonly foeNear: Map<string, number>,
  ) {}

  /** A room event the squad may react to — delivered to each bot on its
   *  OWN think phase (phases are offset across the squad), so reactions
   *  scatter naturally; the taunt cooldown+dice thin out who speaks.
   *  Nothing dispatches "a crowd" — the chattiness is emergent. */
  private pendingNotice: { kind: ChatterKind; actorId: string; actorTeam?: string; stamp: number } | null = null;
  private noticed = new Map<string, number>();
  private routeHold = new Map<string, { stand: BotVec; pos: BotVec; at: number; minD?: number }>();
  // Entries that were chased and failed: without this memory a dead
  // incumbent is re-elected by the very next probe (it scores best on
  // the same terms it died on), and the bot orbits it forever —
  // raindance's pit orbit was exactly this loop.
  private routeFailed = new Map<string, { pos: BotVec; at: number }>();
  /** Squad push-call: a capper within ETA of the enemy stand posts it
   *  here; teammates' goal ladders read it for a few seconds so the
   *  stand floods BEFORE the runner lands — the same "capper's 10 out"
   *  call humans make on comms. Legal: the caller's own ETA, not intel. */
  private pushAt = new Map<TeamId, { pos: BotVec; at: number }>();
  private routePrefs = new Map<string, number>();
  /** A bot's habitual route lean — a bearing offset around its own
   *  approach side, stable per id, no RNG draw. */
  private routePref(id: string): number {
    let a = this.routePrefs.get(id);
    if (a === undefined) {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      a = ((h % 1000) / 1000 - 0.5) * 1.8;
      this.routePrefs.set(id, a);
    }
    return a;
  }
  /** Times each team's push-call was (re)posted — soak visibility into
   *  how often the flood call actually fires. */
  readonly pushCalls = new Map<TeamId, number>();
  // The call has to outlive the flood's transit: wave members tasked
  // from midfield start ~180m out — an 8s window dies ~5s before they
  // land, which reads as a call that summons nobody.
  // The call must lead the flood's transit, not the capper's: members
  // spawn ~500m+ from the enemy stand and transit at ~15-20m/s — a 45s
  // ETA window has them landing ~25s after the capper is already dead
  // at the ring (soak: 6 calls, 0 grabs, wave near0%). 75s posts the
  // moment a committed runner could plausibly arrive, which is when the
  // escorts need to leave.
  private static readonly PUSH_ETA_S = 75;
  private static readonly PUSH_HOLD_MS = 14000;
  /** Once a ring entry is reached the press is committed, not re-probed:
   *  at the lip the straight-line wall check reads the crest the entry
   *  was picked to avoid, bounces the bot back out, and the same entry
   *  wins the next fresh pick — consume→re-pick→consume orbit (kata
   *  probe: capper lapped ~150m off the stand for 100s). 8s covers the
   *  ~80m run-in at a walk; expiry falls back to a normal re-pick. */
  private static readonly PRESS_MS = 8000;
  /** Meters past the flag a capper aims on the committed run — the
   *  pass-through aim that makes the approach wrap to the home-side
   *  exit instead of beeline-and-stop. */
  private static readonly PASS_M = 40;
  /** Carrier wait-circuit waypoint, re-rolled on a TTL so the orbit
   *  wanders its own mini-route instead of parking. */
  private waitSpot = new Map<string, { pos: BotVec; at: number }>();
  private static readonly WAIT_TTL_MS = 15_000;
  /** Per-team commander — names responders for contested jobs so one
   *  thief doesn't empty the home defense (botCommand.ts). */
  private commands = new Map<TeamId, TeamCommand>();
  /** Shared leg-scale router — one flow field serves the whole squad;
   *  built on first route query so botless rooms never pay the grid. */
  private flow: TerrainFlow | null = null;
  private routeOf() {
    if (!this.field) return undefined;
    this.flow ??= new TerrainFlow((x, z) => hmHeight(this.field!, x, z));
    const flow = this.flow;
    return (fx: number, fz: number, tx: number, tz: number, ahead: number) =>
      flow.route(fx, fz, tx, tz, ahead);
  }

  /** Neutron shell around home for a flag carrier waiting out a stolen
   *  flag: ~50% of rolls land inside 50m of the stand, ~10% reach the
   *  50-100m sweep, a rare ~1% pulls a big 200m patrol. Azimuth is free
   *  — the bot picks its own circuit. */
  private waitSpotFor(id: string, home: BotVec, duty: number): BotVec {
    const now = simNow();
    const cur = this.waitSpot.get(id);
    if (cur && now - cur.at < ServerBotSenses.WAIT_TTL_MS) return cur.pos;
    const u = botRand();
    const slack = 1 + (1 - duty);               // slack carriers roam wider
    const r = u < 0.5 ? (15 + botRand() * 35)
      : u < 0.6 ? (50 + botRand() * 50)
      : u < 0.61 ? (100 + botRand() * 100)
      : (20 + botRand() * 40);
    const a = botRand() * Math.PI * 2;
    const x = home.x + Math.cos(a) * r * slack;
    const z = home.z + Math.sin(a) * r * slack;
    const y = this.field ? hmHeight(this.field, x, z) : home.y;
    const pos = { x, y, z };
    this.waitSpot.set(id, { pos, at: now });
    return pos;
  }

  /** Bot left the room — drop its notice receipt so the map can't grow
   *  one entry per retired bot for the room's life. */
  forget(id: string): void {
    this.noticed.delete(id);
    this.routeHold.delete(id);
    this.routeFailed.delete(id);
    this.routePrefs.delete(id);
    this.waitSpot.delete(id);
  }

  /** Mark an entry position as failed-to-reach so the next probe can't
   *  re-elect it — bounded memory (a few recent failures per bot). */
  private failRoute(id: string, pos: BotVec): void {
    const f = this.routeFailed.get(id) ?? { pos, at: 0 };
    f.pos = pos;
    f.at = simNow();
    this.routeFailed.set(id, f);
  }

  /** Room code reports an event worth a reaction (flag cap/grab/return/
   *  drop). Actor's own line is separate — the actor never gets a notice. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string): void {
    this.pendingNotice = { kind, actorId, actorTeam, stamp: simNow() };
  }

  /** Translate the pending event into THIS bot's side of it — allies
   *  cheer their team's score, enemies groan, defenders get the alert. */
  private noticeFor(id: string, team: string | undefined, now: number): { kind: ChatterKind; actor: string } | undefined {
    const n = this.pendingNotice;
    if (!n) return undefined;
    if (now - n.stamp > 2000) { this.pendingNotice = null; return undefined; }
    if (n.actorId === id || (this.noticed.get(id) ?? 0) >= n.stamp) return undefined;
    this.noticed.set(id, n.stamp);
    const mine = n.actorTeam !== undefined && n.actorTeam === team;
    switch (n.kind) {
      case 'flagcap': case 'flagreturn': return { kind: mine ? 'cheer' : 'groan', actor: n.actorId };
      case 'flaggrab': return { kind: mine ? 'cheer' : 'alert', actor: n.actorId };
      case 'flagdrop': return { kind: mine ? 'groan' : 'cheer', actor: n.actorId };
      default: return { kind: n.kind, actor: n.actorId };
    }
  }

  /** One pass producing every per-think roster view — flagGoal and
   *  build() each scanned the player map for their own channel (foes,
   *  stand threats, enemies/allies/others); callers share one pass per
   *  think so the bot tick stays O(players), not O(players × channels). */
  partiesOf(p: { id: string; team?: string }): { enemies: BotEnemy[]; allies: Vec3[]; others: Vec3[]; roster: { id: string; pos: Vec3; team?: string }[] } {
    const shared = this.tickParties();
    const enemies: BotEnemy[] = [], allies: Vec3[] = [], others: Vec3[] = [];
    const teams = !!this.room.modeSpec?.teams;
    for (const q of shared.players) {
      if (q.id === p.id || q.dead) continue;
      others.push(q.pos);
      // Same rule as enemiesOf: teamless modes are open season on every
      // other live body — bot or human makes no difference to the gun.
      if (teams ? q.team !== p.team : true) {
        if (!q.cloaked) enemies.push(q.en);
      } else if (p.team && q.team === p.team) allies.push(q.pos);
    }
    for (const b of shared.bodies) enemies.push(b);
    return { enemies, allies, others, roster: shared.roster };
  }

  /** Roster + non-player bodies, cached per tickSeq — several bots think
   *  in the same tick (staggered buckets) and each used to rebuild the
   *  identical roster plus call ballSim/creatureSim roster() (both
   *  allocate). Positions are live refs, so the cached list stays
   *  correct within the tick. */
  private tickPartiesCache: { seq: number; players: { id: string; pos: Vec3; vel: Vec3; team?: string; dead: boolean; cloaked: boolean; aimY: number; en: BotEnemy }[]; bodies: BotEnemy[]; roster: { id: string; pos: Vec3; team?: string }[] } = { seq: -1, players: [], bodies: [], roster: [] };
  private tickParties(): typeof this.tickPartiesCache {
    const c = this.tickPartiesCache;
    // Keyed on the sim clock, not room.tickSeq: bots think at their own
    // cadence and scenario steps advance simNow without bumping tickSeq
    // — a tickSeq key left cloak/death/beast edges stale between thinks.
    const seq = simNow();
    if (c.seq === seq) return c;
    c.seq = seq;
    c.players.length = 0; c.bodies.length = 0; c.roster.length = 0;
    for (const q of this.room.players.getAllPlayers().values()) {
      c.players.push({ id: q.id, pos: q.position, vel: q.velocity, team: q.team, dead: q.isDead, cloaked: !!(q.status & STATUS.CLOAK), aimY: classCapsule(q.armorClass).centerOff,
        en: { id: q.id, pos: q.position, vel: q.velocity, alive: true, aimY: classCapsule(q.armorClass).centerOff } });
      if (!q.isDead) c.roster.push({ id: q.id, pos: q.position, team: q.team });
    }
    for (const b of this.room.ballSim.roster())
      c.bodies.push({ id: `b:${b.id}`, pos: b.position, vel: b.velocity, alive: true, aimY: 0 });
    for (const cr of this.room.creatureSim.roster())
      c.bodies.push({ id: `c:${cr.id}`, pos: cr.position, vel: cr.velocity, alive: true, aimY: 0 });
    return c;
  }

  /** Hostile emplacement the bot can legally see — a turret/mine/drone
   *  owned by the other team, near the bot and near what it's after.
   *  The stand's kill-zone is knowledge the room advertises anyway. */
  hostileGear(p: { id: string; team?: string; position: Vec3 }, goal: BotVec | null, sabotage = false): Vec3 | null {
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

  /** Friendly gear that needs a weld — nearest damaged item within the
   *  reach a builder would reasonably walk to. Deployables broadcast
   *  their state to every client, so a bot noticing a hurt turret is
   *  reading public info, same as a human watching the stand. */
  repairJob(p: { id: string; team?: string; position: Vec3 }): { key: string; pos: BotVec; frac: number } | null {
    let best: { key: string; pos: BotVec; frac: number } | null = null;
    let bestD = 45;
    for (const d of this.room.deployables.items.values()) {
      const cap = DEPLOY_HP[d.kind];
      if (d.hp >= cap) continue;
      if (d.owner !== p.id) {
        const owner = this.room.players.getPlayer(d.owner);
        if (!p.team || owner?.team !== p.team) continue;
      }
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      if (bd < bestD) { bestD = bd; best = { key: String(d.id), pos: d.pos, frac: d.hp / cap }; }
    }
    return best;
  }

  /** Ignoring-the-enemy evidence for the sheep meter: a live visible
   *  enemy PLAYER within 60m while the brain elects not to fire is the
   *  fastest cowardice tell there is. Creatures don't count — walking
   *  past wildlife isn't fear. Computed at think cadence; the flag
   *  decays in half a second so a bot that out-skis a duel isn't
   *  re-charged while it's gone. */
  markFoeNear(id: string, ctx: BrainCtx, pos: Vec3, yaw: number, now: number): void {
    for (const e of ctx.enemies) {
      if (e.id.startsWith('b:') || e.id.startsWith('c:')) continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      const d = Math.hypot(dx, e.pos.y - pos.y, dz);
      // Brawl range, not spotting range — a foe it can't reach yet is a
      // marching target, not an ignored duel.
      if (d < BRAWL_RANGE && losClear(ctx, pos, e.pos)) {
        // Only counts when the bot is actually LOOKING at the foe —
        // an enemy outside the ~113° view cone is invisible to it, so
        // "ignoring" it is a false positive that maxes out honest bots.
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        const gd = Math.hypot(dx, dz) || 1;
        if ((dx * fx + dz * fz) / gd < FOE_CONE_MIN_DOT) continue;
        this.foeNear.set(id, now + 500);
        return;
      }
    }
    this.foeNear.set(id, 0);
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  carried off → run down the carrier (the carrier's position IS known —
   *  tickUpdate streams it, this is a legal pursuit not a wallhack); own
   *  flag dropped → touch it home; a teammate carrying → escort them;
   *  enemy flag reachable → go grab it. Defenders invert it: their flag
   *  recovery/intercept outranks pressing the enemy stand. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1, parties?: ReturnType<ServerBotSenses['partiesOf']>): { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null {
    const flags = this.room.flags;
    if (!flags) return null;
    // Rabbit: no teams, one neutral flag. Hunters converge on the flag
    // itself (stand or loose drop) or the carrier's live beacon — the
    // rabbit keeps moving on a defensive circuit instead of sitting.
    if (this.room.mode === 'rabbit') {
      const flag = flags.flags.get('alpha');
      if (!flag || flag.state === 'unspawned') return null;
      if (flag.state === 'carried' && flag.carrier === p.id) {
        return { pos: this.waitSpotFor(p.id, flag.home, duty), infiltrating: false, running: true, runner: true };
      }
      const rabbitP = flag.carrier ? this.room.players.getPlayer(flag.carrier) : null;
      const pos = flag.state === 'carried' && rabbitP ? rabbitP.position : flag.pos;
      return { pos, infiltrating: false, running: true };
    }
    if (!p.team) return null;
    const me = p.team as TeamId;
    const enemy = flags.flags.get(me === 'alpha' ? 'bravo' : 'alpha');
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) {
      // Own flag dropped in the field: touching it home re-opens the
      // cap window — a carrier that can reach it goes for the touch.
      if (own.state === 'dropped') return { pos: own.pos, infiltrating: false, running: true, runner: true };
      // The cap line is blocked while our own flag is in the field —
      // standing on the stand just paints a target. Hover a defensive
      // circuit around home instead: re-roll a wait waypoint every
      // ~15s on a neutron shell — mostly tight orbits over the stand,
      // occasional wide sweeps — so the carrier keeps moving, stays a
      // hard target, and is close enough to dive in the moment our
      // flag returns. A slack carrier draws the wider shells.
      if (own.state === 'carried') {
        const w = this.waitSpotFor(p.id, own.home, duty);
        return { pos: w, infiltrating: false, running: true, runner: true };
      }
      return { pos: own.home, infiltrating: false, running: true, runner: true };
    }

    const enemyStand = enemy.state !== 'carried' ? enemy.pos : null;
    const sit: FlagSituation = {
      home: own.home,
      // Own flag's carrier — chase the thief, not the base.
      thief: this.thiefOf(me)?.pos ?? null,
      // Own flag dropped — anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
      threat: this.standThreat(own.home, me, (parties ?? this.partiesOf(p)).roster),
      push: this.pushFor(me),
      me: p.position,
    };
    // The commander names responders for contested jobs before the role
    // table runs — staffed slots are hidden from everyone else so the
    // squad splits its attention instead of lemming one stimulus.
    let cmd = this.commands.get(me);
    if (!cmd) { cmd = new TeamCommand(); this.commands.set(me, cmd); }
    const members: CommandMember[] = [];
    for (const [id, role] of this.roles) {
      const mp = this.room.players.getPlayer(id);
      if (!mp || mp.team !== me) continue;
      members.push({ id, role, pos: mp.position, carrier: enemy.carrier === id });
    }
    cmd.update(simNow(), sit, members);
    const task = cmd.taskFor(p.id);
    if (!task) {
      if (cmd.staffed(p.id, 'chase')) sit.thief = null;
      if (cmd.staffed(p.id, 'return')) sit.dropped = null;
      if (cmd.staffed(p.id, 'escort')) sit.escort = null;
      if (cmd.staffed(p.id, 'push')) sit.push = null;
    }
    // The task names WHICH job, not WHERE: re-resolve its slot live so
    // a named chaser tracks the carrier's beacon between the commander's
    // 2s reassigns instead of running at the position it was posted.
    const taskGoal = task && ({ chase: sit.thief, return: sit.dropped, escort: sit.escort, push: sit.push }[task.kind]
      // The push call ages out mid-transit while the task persists —
      // its stored stand goal keeps the flood running.
      ?? (task.kind === 'push' ? task.goal : null));
    // One role table for both runtimes — shared/flagGoals.ts.
    const pick = taskGoal ?? roleObjective(this.roles.get(p.id) ?? 'offense', sit, duty);
    const role = this.roles.get(p.id);
    // Post the push-call when THIS bot is the capper closing in. ETA
    // prices actual ground speed (floor 12 m/s — a bot standing still
    // next to the stand shouldn't keep re-announcing); posted early so
    // the squad's response travels ahead of the runner's arrival.
    // The push slot is a COPY of the stand pos ({...enemyStand}) — a
    // tasked wave member's pick never satisfies reference equality, so
    // it skipped the whole entry probe and beelined into walls
    // (katabatic: members stalled ~290m out, near0%). A goal parked on
    // the stand is stand-bound regardless of which object holds it.
    const standBound = enemyStand !== null && pick !== null &&
      (pick === enemyStand || dist3(pick, enemyStand) < 8);
    // The call also posts off the approach leg: standBound only arms
    // inside ~80m where the pick snaps to the raw stand — by then the
    // wave's transit is already late. Any stand-committed route posts:
    // members' full-map transit is ~60-70s against a ~14s call TTL and
    // the 45s ETA gate, so waiting for a nearer radius guarantees the
    // flood arrives after the capper dies (soak: wave near0%, every
    // push dying alone at the ring). The ETA check below is the honest
    // constraint — distance isn't.
    const approachBound = !standBound && enemyStand !== null && pick !== null;
    if (role === 'capper' && (standBound || approachBound) && enemyStand) {
      const qp = this.room.players.getPlayer(p.id);
      const spd = qp ? Math.hypot(qp.velocity.x, qp.velocity.z) : 0;
      const eta = Math.hypot(enemyStand.x - p.position.x, enemyStand.z - p.position.z) / Math.max(12, spd);
      if (eta < ServerBotSenses.PUSH_ETA_S) {
        const prev = this.pushAt.get(me);
        if (!prev || simNow() - prev.at > ServerBotSenses.PUSH_HOLD_MS) {
          this.pushCalls.set(me, (this.pushCalls.get(me) ?? 0) + 1);
        }
        this.pushAt.set(me, { pos: { ...enemyStand }, at: simNow() });
      }
    }
    // A presser doesn't beeline to the stand — it attacks from a side
    // the terrain actually opens on. Cappers want the high side for a
    // downhill graze at speed; everyone pressing a rimmed stand still
    // needs a reachable entry or they die on the wall below the lip.
    // The entry is probed live off the terrain every goal cycle: no
    // baked routes, and it re-plans as the bot moves (the arc emerges
    // per-mountain).
    let goalPos: BotVec = pick;
    if (standBound && enemyStand !== null && this.field) {
      const capper = role === 'capper';
      const dStand = Math.hypot(enemyStand.x - p.position.x, enemyStand.z - p.position.z);
      // Live enemy positions are already on the wire — a human reads the
      // same board and flanks the blob. Charged per entry candidate so a
      // route through the DMZ loses to a wide arc around it.
      const foes: { x: number; z: number }[] = [];
      for (const q of (parties ?? this.partiesOf(p)).roster) {
        if (q.team && q.team !== me) foes.push({ x: q.pos.x, z: q.pos.z });
      }
      // Stay live until the last hop: snapping the goal to the raw
      // stand at 90m beelines the bot into the rim wall it probed its
      // way around — presses end 8m below the flag at the wall's foot.
      if (dStand > (capper ? 25 : 20)) {
        const inc = this.routeHold.get(p.id);
        const incLive = inc && dist3(inc.stand, enemyStand) < 1 ? inc : null;
        // A pressed-in record (pos≈stand) short-circuits the whole entry
        // probe for its window — see PRESS_MS.
        const pressing = incLive && dist3(incLive.pos, enemyStand) < 1
          && simNow() - incLive.at < ServerBotSenses.PRESS_MS;
        if (incLive && dist3(incLive.pos, enemyStand) < 1 && !pressing) {
          this.routeHold.delete(p.id); // stale press — re-probe
        }
        let routed = false;
        if (pressing) {
          goalPos = { ...enemyStand };
          routed = true;
        } else if (incLive) {
          // An incumbent entry is a commitment, not a suggestion: chase
          // it to arrival. Re-probing the wall every think let the
          // verdict oscillate as the bot moved through a valley —
          // stand/entry flip-flops had it orbiting 150m out (kata
          // probe). Arrival can't be exact — ring points land on faces
          // the bot can't occupy — so it is consumed into a press at the
          // face base. The bail is progress, not time: a detour chase
          // legitimately outlasts any short fuse (timing out into a
          // press recreates the same stand/entry orbit one level up),
          // but an entry the bot hasn't approached in 30s is a wall.
          const dEntry = Math.hypot(incLive.pos.x - p.position.x, incLive.pos.z - p.position.z);
          if (dEntry < 45) {
            this.routeHold.set(p.id, { stand: enemyStand, pos: { ...enemyStand }, at: simNow() });
            goalPos = { ...enemyStand };
          } else if (incLive.minD === undefined || dEntry < incLive.minD - 20) {
            incLive.minD = dEntry;
            incLive.at = simNow();
            goalPos = { ...incLive.pos };
          } else if (simNow() - incLive.at > 30_000) {
            this.routeHold.delete(p.id);
            this.failRoute(p.id, incLive.pos);
          } else {
            goalPos = { ...incLive.pos };
          }
          routed = goalPos !== pick;
        }
        if (!routed) {
        // …unless the straight line to the stand is already open. Ring
        // entries only earn their detour when terrain actually rises
        // into the approach; without this check a bot on the anchor
        // ring hops entry-to-entry ~60m out forever, never taking the
        // last hop that was clean all along.
        let wall = 0;
        for (let s = 1; s < 8; s++) {
          const t = s / 8;
          wall = Math.max(wall, hmHeight(this.field, p.position.x + (enemyStand.x - p.position.x) * t,
            p.position.z + (enemyStand.z - p.position.z) * t)
            - (p.position.y + (enemyStand.y - p.position.y) * t));
        }
        // Inside the DMZ a capper must keep pressing in: far ring entries
        // are exits there, and a lip it can jet over is no wall. Without
        // this the probe kept re-picking entries behind the bot — cappers
        // entered the 80m ring, rerouted outward, and left ungrazed.
        // Inside the DMZ a tasked wave member presses in too — untasked
        // pressers re-route to ring entries, but a named flood member
        // orbiting the ring is exactly the "wave at d183m" the soak
        // probe caught: tasked, committed, never inside.
        const waveTask = task?.kind === 'push' || task?.kind === 'escort';
        const committed = (capper || waveTask) && dStand < 80 && wall < 12;
        // A tasked member still presses the straight line over rolling
        // ground — the flood's job is arriving, and entry detours for
        // every 8m swell read worse than the beeline they replace
        // (peaks soak: routing dropped near% 3->1). Only a real wall
        // face earns the detour.
        if (wall < 6 || committed || (waveTask && wall < 20)) {
          // Two human corrections on the final run:
          // - Altitude pull: a ballistic runner can't dive, so aim the
          //   landing short of the flag and skim through it at grab height.
          // - Track lead: momentum lags yaw, so the velocity ray misses
          //   the pole by meters. Shift the aim point by the measured
          //   miss vector so the converged path crosses the flag.
          const dy = p.position.y - enemyStand.y;
          const pull = Math.max(0, Math.min(24, (dy - 5) * 1.6));
          const ux = (enemyStand.x - p.position.x) / dStand;
          const uz = (enemyStand.z - p.position.z) / dStand;
          const vel = this.room.players.getPlayer(p.id)?.velocity;
          const spd = vel ? Math.hypot(vel.x, vel.z) : 0;
          let mx = 0, mz = 0;
          if (vel && spd > 6) {
            const t = Math.max(0, ((enemyStand.x - p.position.x) * vel.x +
              (enemyStand.z - p.position.z) * vel.z) / spd);
            mx = enemyStand.x - (p.position.x + (vel.x / spd) * t);
            mz = enemyStand.z - (p.position.z + (vel.z / spd) * t);
            const mLen = Math.hypot(mx, mz), cap = 15;
            if (mLen > cap) { mx *= cap / mLen; mz *= cap / mLen; }
          }
          // The grab is a pass-through, not an arrival: a human capper
          // flanks so his momentum exits toward home, and that whole
          // shape falls out of aiming at a point PAST the flag on the
          // home side — the approach wraps to the far side for free.
          let px2 = 0, pz2 = 0;
          if (capper && this.field) {
            const hx = own.home.x - enemyStand.x, hz = own.home.z - enemyStand.z;
            const hd = Math.hypot(hx, hz) || 1;
            const cx = enemyStand.x + (hx / hd) * ServerBotSenses.PASS_M;
            const cz = enemyStand.z + (hz / hd) * ServerBotSenses.PASS_M;
            // …only when the pass point is open airspace — on rim maps
            // the home-side wrap point sits inside the crater wall and
            // aiming there buries the run in rock (kata no-grab).
            if (hmHeight(this.field, cx, cz) - enemyStand.y < 15) {
              px2 = cx - enemyStand.x; pz2 = cz - enemyStand.z;
            }
          }
          goalPos = { x: enemyStand.x + mx + px2 - ux * pull,
                      y: enemyStand.y,
                      z: enemyStand.z + mz + pz2 - uz * pull };
        } else {
        const inside = dStand < 80;
        // Re-scored EVERY think — the route stays live to foe movement —
        // but switching is expensive: the incumbent only loses when a
        // challenger beats it by a decisive gap, not when scores jitter
        // a few meters. 12 was too thin (foe toll + detour swings ~50+),
        // so goals teleported 100-300m sideways every second and every
        // bot's net progress read zero. The gap scales with the stand
        // distance: far out, a re-route is cheap and the bar is lower;
        // close in, flipping entries costs a mountain.
        const scoreEntry = (ex: number, ey: number, ez: number): number => {
          const high = ey - enemyStand.y;
          const detour = Math.hypot(ex - p.position.x, ez - p.position.z) - dStand;
          let score = high * (capper ? 1.2 : 0.3) - Math.max(0, ey - p.position.y) * 2 - Math.max(0, detour) * 0.8;
          let ridge = 0;
          let prevH = p.position.y;
          let climb = 0;
          for (let s = 1; s < 8; s++) {
            const t = s / 8;
            const lx = p.position.x + (ex - p.position.x) * t;
            const lz = p.position.z + (ez - p.position.z) * t;
            const lh = hmHeight(this.field!, lx, lz);
            ridge = Math.max(ridge, lh - (p.position.y + (ey - p.position.y) * t));
            if (lh > prevH) climb += lh - prevH;
            prevH = lh;
          }
          score -= ridge * 2.5;
          // Climb budget: ridge prices the tallest hump, but a wall of
          // rolling +10m ascents drains the tank just the same — the
          // massif face reads ~50m cumulative, more than a light kit's
          // full burn, so the capper Sisyphus-orbits it for the match.
          // Tax total ascent: a saddle route that spreads the same
          // climb over dips beats the sheer face.
          score -= climb * 2;
          let lip = 0;
          for (let s = 1; s < 8; s++) {
            const t = s / 8;
            const lx = ex + (enemyStand.x - ex) * t;
            const lz = ez + (enemyStand.z - ez) * t;
            lip = Math.max(lip, hmHeight(this.field!, lx, lz) - (ey + (enemyStand.y - ey) * t));
          }
          score -= lip * 3;
          // A run-in that drops pays speed on the table: the leg that
          // ends the push is where m/s actually buys survival — pushes
          // were arriving at ~16m/s and dying to interceptors at the
          // ring edge, so elevated entries earn their climb back here.
          // Score the NET drop — descent minus the climb it has to
          // undo: a moat-rim entry drops 50m into the trench then walls
          // back up, and scoring the drop alone made that trap outrank
          // the saddle (capRun katabatic bisect: green→red at cfe341d).
          if (capper) {
            let drop = 0, rise = 0;
            prevH = ey;
            for (let s = 1; s < 8; s++) {
              const t = s / 8;
              const lx = ex + (enemyStand.x - ex) * t;
              const lz = ez + (enemyStand.z - ez) * t;
              const lh = hmHeight(this.field!, lx, lz);
              if (lh < prevH) drop += prevH - lh; else rise += lh - prevH;
              prevH = lh;
            }
            score += (drop - rise) * 1.5;
          }
          for (const e of foes) {
            for (let s = 1; s < 8; s++) {
              const t = s / 8;
              const lx = p.position.x + (ex - p.position.x) * t - e.x;
              const lz = p.position.z + (ez - p.position.z) * t - e.z;
              const ed = Math.hypot(lx, lz);
              if (ed < 80) { score -= (80 - ed) * 0.05; break; }
            }
          }
          // Graveyard penalty: an entry the bot already failed to reach
          // loses by a landslide — without memory the probe re-elects
          // the same unreachable point every re-score (raindance orbit).
          const fr = this.routeFailed.get(p.id);
          if (fr && simNow() - fr.at < 90_000
            && Math.hypot(fr.pos.x - ex, fr.pos.z - ez) < 80) score -= 400;
          return score;
        };
        // Route temperament: two runners reading the same terrain pick
        // the same entry — mirrored runs joust head-on mid-field (the
        // capper autopsy: enemy cappers are each other's top killer).
        // A stable per-bot bearing OFFSET fans them out around their
        // own approach side — a fixed world bearing sent runners
        // around the massif to a far-side entry they could never reach
        // (the bravo capper's 750m contour orbit).
        // The flood's own near-stand route point joins the ring as a
        // scored candidate — the saddle the cheapest path funnels
        // through. It goes through the same reachability/foe/graveyard
        // scoring as the ring points, so it wins only where the ring's
        // fixed radii are blind to it; on maps where the ring already
        // sees the saddle, nothing changes.
        const flowEntry = this.flow
          ? this.flow.routeNearGoal(p.position.x, p.position.z, enemyStand.x, enemyStand.z, 90)
          : null;
        const pref = Math.atan2(p.position.z - enemyStand.z, p.position.x - enemyStand.x)
          + this.routePref(p.id);
        const prefW = process.env.FPS_NOPREF ? 0 : 18;
        let best = enemyStand, bestScore = -Infinity;
        if (flowEntry) {
          const score = scoreEntry(flowEntry.x, flowEntry.y, flowEntry.z)
            + Math.cos(Math.atan2(flowEntry.z - enemyStand.z, flowEntry.x - enemyStand.x) - pref) * prefW;
          if (score > bestScore) { bestScore = score; best = flowEntry; }
        }
        for (let a = 0; a < 24; a++) {
          // Three radii: close entries are cheap, a closed rim wall
          // only breaks further out — a plateau stand needs the far
          // rings to find the saddle where its massif opens.
          const ring = a < 8 ? 85 : a < 16 ? 170 : 300;
          if (inside && ring > dStand + 20) continue;
          const ang = ((a % 8) / 8) * Math.PI * 2 + (a < 8 ? 0 : (a < 16 ? Math.PI / 8 : Math.PI / 4));
          const ex = enemyStand.x + Math.cos(ang) * ring;
          const ez = enemyStand.z + Math.sin(ang) * ring;
          const ey = hmHeight(this.field, ex, ez);
          const score = scoreEntry(ex, ey, ez) + Math.cos(ang - pref) * prefW;
          if (score > bestScore) { bestScore = score; best = { x: ex, y: ey, z: ez }; }
        }
        // No incumbent here — incumbents are chased to arrival, so this
        // branch only runs on a fresh pick or after a stale record died.
        this.routeHold.set(p.id, { stand: enemyStand, pos: best, at: simNow() });
        goalPos = best;
        }
        }
      }
    }
    // Cloak intent only for the infiltrator: the drain is speed-scaled,
    // so a light capper burning RMB-to-stand empties its tank mid-route
    // and arrives with no jet fuel — infiltration is the saboteur's job.
    // Posted roles (HoF, home defense) hold a leash instead of chasing
    // every contact they can see — 300m sight pulling feet off the
    // stand is how the anchor ends up wandering midfield. The leash
    // widens once our flag is already gone: no stand to guard means
    // the defender roams the counter-attack.
    const anchored = role === 'hof' || role === 'ldefense' || role === 'defense' || role === 'technician';
    let posted = 0;
    if (anchored && Math.hypot(pick.x - own.home.x, pick.z - own.home.z) < 15) {
      const base = own.state === 'carried'
        ? (role === 'hof' ? 20 : 200)
        : (role === 'hof' ? 3 : 90);
      posted = base * (1.35 - 0.5 * duty);
    }
    return { pos: goalPos, infiltrating: enemyStand !== null && pick !== null &&
      // dist<8 like the push-call check — a goal parked on the stand is
      // stand-bound regardless of which object holds it; ref equality
      // silently failed for entry-probe picks (cloak read 0%).
      dist3(pick, enemyStand) < 8 &&
      // Cappers infiltrate too — the approach IS a covert run (T2 jammer
      // pack); he dies ~150m out every soak because the whole transit
      // runs visible. The intent still prices the tank — cloak only
      // when energy ≥ cloakCost+15, so a dry runner stays loud.
      (role === 'infiltrator' || role === 'capper'), runner: role === 'capper',
      // Named wave member (push/escort): his feet are committed to the
      // flood like a runner's — untasked attackers let every midfield
      // contact steal the stand run (soak: sup@0 — the called wave
      // never once arrived). Staging/propel stay capper-only.
      wave: task?.kind === 'push' || task?.kind === 'escort',
      // Push-only: the member mass-orbits ~110m out until the flood is
      // actually converging. Escorts share wave's committed feet but
      // must never hold off a moving carrier — that's just losing him.
      marshal: task?.kind === 'push', posted };
  }

  /** Test hook — live command task list for a team (soak wave probe). */
  debugTasks(team: string): { id: string; kind: string; goal: BotVec }[] {
    const cmd = this.commands.get(team as TeamId);
    if (!cmd) return [];
    // taskFor is per-id; the map lives inside the commander — expose via
    // its own debug view.
    return cmd.debugTasks();
  }

  /** The team's active push target for non-goal consumers (the stand
   *  bombardment volley in ServerBots reads it directly). */
  pushTarget(me: string | undefined): BotVec | null {
    return me ? this.pushFor(me as TeamId) : null;
  }

  /** Live push-call for this team, or null once it ages out — the
   *  window is short so a dead capper's call doesn't trap the squad
   *  on a stand press long after the run collapsed. */
  private pushFor(me: TeamId): BotVec | null {
    const c = this.pushAt.get(me);
    if (!c) return null;
    if (simNow() - c.at > ServerBotSenses.PUSH_HOLD_MS) { this.pushAt.delete(me); return null; }
    return c.pos;
  }

  /** A teammate carrying the enemy flag is the escort point — the
   *  carrier's position is already on the wire, no wallhack needed. */
  private escortSpot(carrier: string | null | undefined, me: TeamId): (Vec3 & { vx?: number; vz?: number }) | null {
    const escortP = carrier ? this.room.players.getPlayer(carrier) : null;
    if (!escortP || escortP.team !== me) return null;
    return { ...escortP.position, vx: escortP.velocity.x, vz: escortP.velocity.z };
  }

  /** Closest hostile pressing our stand — the HoF body-block anchor.
   *  Only counts enemies inside the ring so a fighter out in the field
   *  doesn't drag the anchor off the flag. */
  private standThreat(home: Vec3, me: TeamId, roster: { pos: Vec3; team?: string }[]): Vec3 | null {
    let best: Vec3 | null = null, bestD = 26;
    for (const q of roster) {
      if (q.team === me) continue;
      const d = Math.hypot(q.pos.x - home.x, q.pos.z - home.z);
      if (d < bestD) { bestD = d; best = q.pos; }
    }
    return best;
  }

  /** Who's carrying OUR flag — pos+vel are beacon info (the wire streams
   *  the carrier anyway), so returning them to the brain is not a wallhack.
   *  pickHunt consumes this to actually ENGAGE the thief, not just run at
   *  the flag's old stand position. */
  private thiefOf(team: string): BotEnemy | null {
    const flags = this.room.flags;
    if (!flags || (team !== 'alpha' && team !== 'bravo')) return null;
    const own = flags.flags.get(team);
    if (!own || own.state !== 'carried' || !own.carrier) return null;
    const t = this.room.players.getPlayer(own.carrier);
    if (!t || t.isDead) return null;
    return { id: t.id, pos: t.position, vel: t.velocity, alive: true,
      aimY: classCapsule(t.armorClass).centerOff };
  }

  /** The sensorium for one think tick — see file header for what's legal
   *  on each channel. */
  build(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number }, goal: { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null, now: number, skill?: BotSkill, sharedParties?: ReturnType<ServerBotSenses['partiesOf']>): BrainCtx {
    // Competence-biased draw: the weapon pick and the aim error read
    // the same matrix, so a phenom both reaches for its gun and lands it.
    const bias = skill ? (t: number) => aimSkillFor(skill, t, 0) : undefined;
    const parties = sharedParties ?? this.partiesOf(p);
    const ctx: BrainCtx = {
      id: p.id,
      pos: p.position,
      vel: p.velocity,
      enemies: parties.enemies,
      objective: goal?.pos ?? null,
      infiltrating: goal?.infiltrating ?? false,
      running: goal?.running ?? false,
      runner: goal?.runner ?? false,
      wave: goal?.wave ?? false,
      marshal: goal?.marshal ?? false,
      posted: goal?.posted ?? 0,
      // Team rooms drop nuggets on creature kills — bots farm them too,
      // which is what keeps a bot-filled match's scoreboard moving. The
      // chase is weighed like a player weighs it: only gems in real
      // reach, and a contested gem costs a hurt bot nothing but a death
      // walk — a healthy one fights through for it.
      pickup: this.pickupFor(p, parties.enemies) ?? undefined,
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
      route: this.routeOf(),
      others: parties.others,
      allies: parties.allies,
      // Mortar heavies acquire siege-range targets; everyone else holds
      // the duel band. The shared brain takes max(FIRE_RANGE, this).
      engageRange: this.loadouts.get(id)?.far === WeaponType.Mortar ? 95 : undefined,
      thief: this.thiefOf(p.team ?? ''),
      // Aim lead uses the muzzle speed of the weapon this bot would
      // pick at that range — same band select fireAt runs.
      weaponSpeed: (d) => {
        const w = pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage);
        return getWeaponStats(w).speed || 60;
      },
      // Lobbed shells need the arc's drop added back on the aim point.
      weaponGravity: (d) =>
        getWeaponStats(pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage)).gravity,
      // Blast geometry of the same pick — the self-splash read prices
      // what this shell would do to its own shooter.
      weaponAoe: (d) => {
        const w = getWeaponStats(pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage));
        return { r: w.aoeRadius ?? 0, dmg: w.aoeDamage ?? 0 };
      },
      // The bot's skill matrix scored against the weapon it would
      // actually draw at that range — pick and aim stay consistent.
      ...(skill ? {
        aimSkill: (d: number, targetSpeed: number) =>
          aimSkillFor(skill, pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage), targetSpeed),
      } : {}),
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
      // Influence reads are team-relative: the quiet dir flees toward
      // where THIS side isn't bleeding; the hot cell is shared scent.
      imapQuietDir: (v: BotVec) =>
        this.room.influence.quietestDir(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),
      imapHottest: (v: BotVec) => this.room.influence.hottestNear(v, 'opportunity'),
      imapDanger: (v: BotVec) =>
        this.room.influence.value(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),
      notice: this.noticeFor(id, p.team, now),
      repair: this.repairJob(p),
      now,
    };
    // Squad spot-report: this bot's own eye line feeds the shared board
    // before its brain reads it — a spot is as legal as the thief beacon
    // (you only ever report what you can see; staleness decays it).
    this.updateSpots(ctx, p);
    ctx.spots = this.spotsFor(p.team, now);
    return ctx;
  }

  /** Shared spotting board — per enemy: the last team that had real
   *  eyes on it, where it was, and when. A Tribes sightline is ~300m,
   *  not the 45m duel band: within SPOT_M a bot spots what it sees for
   *  the whole squad, and the report decays in a few seconds. */
  private spots = new Map<string, { e: BotEnemy; team?: string; at: number }>();
  private static readonly SPOT_M = 320;
  private static readonly SPOT_MS = 5000;

  private updateSpots(ctx: BrainCtx, p: { team?: string; position: Vec3 }): void {
    // Cloaking burns your callout — the whole point of the shimmer is
    // that every eye loses you at once, so a stale spot can't keep
    // feeding lastSeen to a squad that no longer sees anything.
    for (const [id, s] of this.spots) {
      const q = this.room.players.getPlayer(s.e.id.replace(/^p:/, ''));
      if (q?.status && (q.status & STATUS.CLOAK)) this.spots.delete(id);
    }
    for (const e of ctx.enemies) {
      if (!e.alive || e.id.startsWith('b:') || e.id.startsWith('c:') || dist3(p.position, e.pos) >= ServerBotSenses.SPOT_M) continue;
      if (!losClear(ctx, p.position, e.pos)) continue;
      this.spots.set(e.id, { e, team: p.team, at: ctx.now });
    }
  }

  /** Which gem to chase: nearest within real reach, unless the bot is so
   *  hurt the contested walk is suicide. Enemies near the GEM camp the
   *  grab — a healthy bot accepts that trade, a wounded one doesn't. */
  private pickupFor(p: { id: string; team?: string; position: Vec3; health: number; maxHealth: number }, foes: BotEnemy[]): BotVec | null {
    const snaps = this.room.pickups?.snapshot();
    if (!snaps?.length) return null;
    // Greedy like the capper's roam shell, not a wall: close gems always
    // pull, far ones only sometimes — acceptance odds fall with distance
    // so a nuggets map spreads the fleet over the field instead of every
    // brain locking the same nearest gem. Elsewhere it's opportunism.
    const nuggets = this.room.mode === 'nuggets';
    const worthIt = (d: number) => nuggets
      ? d < 160 || botRand() < (d < 260 ? 0.6 : d < 320 ? 0.3 : 0.08)
      : d < 140;
    let best: BotVec | null = null, bestD = Infinity;
    for (const g of snaps) {
      const d = dist3(p.position, g.pos);
      if (d >= bestD || !worthIt(d)) continue;
      const hurt = p.maxHealth > 0 && p.health / p.maxHealth < 0.4;
      if (hurt) {
        let camped = false;
        for (const f of foes) {
          if (!f.alive) continue;
          if (Math.hypot(f.pos.x - g.pos.x, f.pos.z - g.pos.z) < 35) { camped = true; break; }
        }
        if (camped && d > 12) continue; // close enough to sneeze on it anyway
      }
      bestD = d; best = g.pos;
    }
    return best;
  }

  private spotsFor(me: string | undefined, now: number): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, s] of this.spots) {
      if (now - s.at > ServerBotSenses.SPOT_MS) { this.spots.delete(id); continue; }
      if (s.team === me && s.e.alive) out.push(s.e);
    }
    return out;
  }
}
