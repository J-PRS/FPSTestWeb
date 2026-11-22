import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { dist3, type BotVec } from '../../shared/botVec.ts';
import { TeamCommand, type CommandMember, type CommandTask } from './botCommand.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import type { TeamId } from '../../shared/teams.ts';
import { simNow } from './simClock.ts';
import { botRand } from '../../shared/botRand.ts';
import { TerrainFlow } from '../../shared/botGraph.ts';
import type { Vec3 } from './types.ts';
import type { BotEnemy } from '../../shared/botBrain.ts';
import { roleObjective, roleSide, wantKOut, type BotRole, type FlagSituation } from '../../shared/flagGoals.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { FLAG_STAND_LIFT } from '../../shared/mapSpec.ts';
import type { ServerParties } from './serverParties.ts';
import { BotEntry } from './botEntry.ts';



/**
 * BotRouting - the squad's persistent movement memory: incumbent ring
 * entries, failed-entry graveyard, habitual route leans, the shared
 * TerrainFlow, carrier wait spots, team push-calls, and the per-team
 * commanders. All of it is per-bot/per-team state that must live
 * longer than one think tick; one owner means forget(id) prunes a bot's
 * whole routing footprint in one place instead of a map-per-field audit.
 */
export class BotRouting {
  constructor(
    readonly room: Room,
    readonly field: Heightfield | null,
    private readonly parties: ServerParties,
    private readonly roles: Map<string, BotRole>,
  ) {}

  readonly routeHold = new Map<string, { stand: BotVec; pos: BotVec; at: number; minD?: number }>();
  // Entries that were chased and failed: without this memory a dead
  // incumbent is re-elected by the very next probe (it scores best on
  // the same terms it died on), and the bot orbits it forever -
  // raindance's pit orbit was exactly this loop.
  readonly routeFailed = new Map<string, { pos: BotVec; at: number; stand?: BotVec; n?: number }>();
  /** Squad push-call: a capper within ETA of the enemy stand posts it
   *  here; teammates' goal ladders read it for a few seconds so the
   *  stand floods BEFORE the runner lands - the same "capper's 10 out"
   *  call humans make on comms. Legal: the caller's own ETA, not intel. */
  private pushAt = new Map<TeamId, { pos: BotVec; at: number }>();
  private routePrefs = new Map<string, number>();
  /** A bot's habitual route lean - a bearing offset around its own
   *  approach side, stable per id, no RNG draw. */
  routePref(id: string): number {
    let a = this.routePrefs.get(id);
    if (a === undefined) {
      let h = 0;
      for (let i = 0; i < id.length; i += 1) {h = (h * 31 + id.charCodeAt(i)) >>> 0;}
      a = ((h % 1000) / 1000 - 0.5) * 1.8;
      this.routePrefs.set(id, a);
    }
    return a;
  }
  /** Times each team's push-call was (re)posted - soak visibility into
   *  how often the flood call actually fires. */
  readonly pushCalls = new Map<TeamId, number>();
  // The call has to outlive the flood's transit: wave members tasked
  // from midfield start ~180m out - an 8s window dies ~5s before they
  // land, which reads as a call that summons nobody.
  // The call must lead the flood's transit, not the capper's: members
  // spawn ~500m+ from the enemy stand and transit at ~15-20m/s - a 45s
  // ETA window has them landing ~25s after the capper is already dead
  // at the ring (soak: 6 calls, 0 grabs, wave near0%). 75s posts the
  // moment a committed runner could plausibly arrive, which is when the
  // escorts need to leave.
  static readonly PUSH_ETA_S = 75;
  static readonly PUSH_HOLD_MS = 14_000;
  /** Once a ring entry is reached the press is committed, not re-probed:
   *  at the lip the straight-line wall check reads the crest the entry
   *  was picked to avoid, bounces the bot back out, and the same entry
   *  wins the next fresh pick - consume→re-pick→consume orbit (kata
   *  probe: capper lapped ~150m off the stand for 100s). 8s covers the
   *  ~80m run-in at a walk; expiry falls back to a normal re-pick. */
  static readonly PRESS_MS = 8000;
  /** A capper's bounce-out excursion after a missed grab runs 15-25s -
   *  an 8s press memory expires mid-orbit and the ring router re-picks
   *  a hilltop entry ~100m out, which is the stand/entry yo-yo the
   *  probes keep catching. Cappers keep their press for the whole
   *  go-around instead. */
  static readonly CAP_PRESS_MS = 30_000;
  /** Outside this stand distance ring entries don't run at all - see
   *  the gate comment where it's used. */
  static readonly RING_MAX = 150;
  /** Carrier wait-circuit waypoint, re-rolled on a TTL so the orbit
   *  wanders its own mini-route instead of parking. */
  private waitSpot = new Map<string, { pos: BotVec; at: number }>();
  static readonly WAIT_TTL_MS = 15_000;
  /** Capper pass-through commitment - set the moment an approach is fast
   *  and open, held until the run dies. Without it the final aim flips
   *  between the pole and a point past it as speed/distance cross the
   *  14/20 gates, and that flip is a limit cycle in the last 40m
   *  (katabatic 9002: 20s parked 12-25m out, hop-churning at v~0). */
  readonly passCommit = new Map<string, number>();
  /** Latched descent-head pick - a fan re-scan electing a different
   *  bearing every think is the same goal-flap disease passCommit
   *  exists to kill. Held while the bot is outside the head; dropped
   *  once it crests into the run (its stand distance shrinks under
   *  the head's) or the pick goes stale. */
  readonly headHold = new Map<string, { pos: BotVec; standD: number; at: number }>();
  /** Per-team commander - names responders for contested jobs so one
   *  thief doesn't empty the home defense (botCommand.ts). */
  private commands = new Map<TeamId, TeamCommand>();
  /** Shared leg-scale router - one flow field serves the whole squad;
   *  built on first route query so botless rooms never pay the grid. */
  flow: TerrainFlow | null = null;
  /** Approach election (entry scoring, head scans, committed presses)
   *  lives in botEntry.ts; it reads the maps above through `this`. */
  private readonly entry = new BotEntry(this);
  routeOf(p: { team?: string }) {
    if (!this.field) {return undefined;}
    this.flow ??= new TerrainFlow((x, z): number => hmHeight(this.field!, x, z),
      BOT_TUNING.graph.extent, BOT_TUNING.graph.cell, this.room.ballSim.colliders);
    const {flow} = this;
    // Danger feed is per-team and live: the walk deflects around cells
    // where THIS side keeps dying, so two rooms' routes diverge without
    // a second flood.
    const danger = (x: number, z: number): number =>
      this.room.influence.value({ x, y: 0, z }, this.room.influence.dangerLayer(p.team ?? 'alpha'));
    return (fx: number, fz: number, tx: number, tz: number, ahead: number): BotVec | null =>
      flow.route(fx, fz, tx, tz, ahead, danger, p.team);
  }

  /** Neutron shell around home for a flag carrier waiting out a stolen
   *  flag: ~50% of rolls land inside 50m of the stand, ~10% reach the
   *  50-100m sweep, a rare ~1% pulls a big 200m patrol. Azimuth is free
   *  - the bot picks its own circuit. */
  waitSpotFor(id: string, home: BotVec, duty: number): BotVec {
    const now = simNow();
    const cur = this.waitSpot.get(id);
    if (cur && now - cur.at < BotRouting.WAIT_TTL_MS) {return cur.pos;}
    const u = botRand();
    const slack = 1 + (1 - duty);               // slack carriers roam wider
    let r = 20 + botRand() * 40;
    if (u < 0.5) { r = 15 + botRand() * 35; }
    else if (u < 0.6) { r = 50 + botRand() * 50; }
    else if (u < 0.61) { r = 100 + botRand() * 100; }
    const a = botRand() * Math.PI * 2;
    const x = home.x + Math.cos(a) * r * slack;
    const z = home.z + Math.sin(a) * r * slack;
    const y = this.field ? hmHeight(this.field, x, z) : home.y;
    const pos = { x, y, z };
    this.waitSpot.set(id, { pos, at: now });
    return pos;
  }

  /** Bot left the room - drop every routing trace so no map grows one
   *  entry per retired bot for the room's life. */
  forget(id: string): void {
    this.routeHold.delete(id);
    this.routeFailed.delete(id);
    this.routePrefs.delete(id);
    this.waitSpot.delete(id);
    this.passCommit.delete(id);
    this.headHold.delete(id);
  }

  /** Mark an entry position as failed-to-reach so the next probe can't
   *  re-elect it - bounded memory (a few recent failures per bot).
   *  Failures also count per stand: a presser that burned two dead
   *  entries on the same stand is probing a wall the ring can't see -
   *  it stops detouring and beelines (the jet-escape stack forces the
   *  face better than a third orbit that dies the same way). */
  failRoute(id: string, pos: BotVec, stand?: BotVec): void {
    const f = this.routeFailed.get(id) ?? { pos, at: 0 };
    f.pos = pos;
    f.n = stand !== undefined && f.stand !== undefined && dist3(f.stand, stand) < 1
      ? (f.n ?? 0) + 1 : 1;
    if (stand !== undefined) {f.stand = Object.assign({}, stand);}
    f.at = simNow();
    this.routeFailed.set(id, f);
  }

  /** The team's commander, created on first contested job - the caller
   *  (flagGoal) runs update() against it each cycle. */
  command(team: TeamId): TeamCommand {
    let cmd = this.commands.get(team);
    if (!cmd) { cmd = new TeamCommand(); this.commands.set(team, cmd); }
    return cmd;
  }

  /** The named responder's task, whichever team owns him - spawn
   *  scoring reads this so a tasked member materializes toward his
   *  job instead of hiking 500m back through the kill zone. */
  taskGoalFor(id: string): CommandTask | undefined {
    for (const cmd of this.commands.values()) {
      const t = cmd.taskFor(id);
      if (t) {return t;}
    }
    return undefined;
  }

  /** Test hook - live command task list for a team (soak wave probe). */
  debugTasks(team: string): { id: string; kind: string; goal: BotVec }[] {
    const cmd = this.commands.get(team as TeamId);
    if (!cmd) {return [];}
    // taskFor is per-id; the map lives inside the commander - expose via
    // its own debug view.
    return cmd.debugTasks();
  }

  /** The team's active push target for non-goal consumers (the stand
   *  bombardment volley in ServerBots reads it directly). */
  pushTarget(me: string | undefined): BotVec | null {
    return me ? this.pushFor(me as TeamId) : null;
  }

  /** Post the capper's push-call - the re-post throttle and the
   *  pushCalls counter move together so they can't disagree. */
  postPush(me: TeamId, pos: BotVec): void {
    const prev = this.pushAt.get(me);
    if (!prev || simNow() - prev.at > BotRouting.PUSH_HOLD_MS) {
      this.pushCalls.set(me, (this.pushCalls.get(me) ?? 0) + 1);
    }
    this.pushAt.set(me, { pos: Object.assign({}, pos), at: simNow() });
  }

  /** Live push-call for this team, or null once it ages out - the
   *  window is short so a dead capper's call doesn't trap the squad
   *  on a stand press long after the run collapsed. */
  pushFor(me: TeamId): BotVec | null {
    const c = this.pushAt.get(me);
    if (!c) {return null;}
    if (simNow() - c.at > BotRouting.PUSH_HOLD_MS) { this.pushAt.delete(me); return null; }
    return c.pos;
  }


  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  carried off → run down the carrier (the carrier's position IS known -
   *  tickUpdate streams it, this is a legal pursuit not a wallhack); own
   *  flag dropped → touch it home; a teammate carrying → escort them;
   *  enemy flag reachable → go grab it. Defenders invert it: their flag
   *  recovery/intercept outranks pressing the enemy stand. */
  /** Paired-run read: a second capper's route lands within ~15s of
   *  mine. Humans time arrivals together - two runners hitting the
   *  ring seconds apart is unguardable where one every 90s feeds the
   *  defense a drip. The staging orbit holds a beat longer while the
   *  pair's ETAs line up, then they land as a pair. */
  capSyncFor(p: { id: string; team?: string; position: Vec3 }): boolean {
    const {flags} = this.room;
    if (!flags || !p.team || this.roles.get(p.id) !== 'capper') {return false;}
    const stand = flags.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha');
    if (!stand || stand.state !== 'home') {return false;}
    const mine = Math.hypot(p.position.x - stand.pos.x, p.position.z - stand.pos.z) / 24;
    for (const [id, role] of this.roles) {
      if (id === p.id || role !== 'capper') {continue;}
      const q = this.room.players.getPlayer(id);
      if (!q || q.isDead || q.team !== p.team) {continue;}
      const theirs = Math.hypot(q.position.x - stand.pos.x, q.position.z - stand.pos.z) / 24;
      if (Math.abs(theirs - mine) < 15) {return true;}
    }
    return false;
  }

  // oxlint-disable-next-line max-lines-per-function, complexity -- the CTF goal decision body; its branches are tuned as one surface
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1, parties?: ReturnType<ServerParties['of']>): { pos: BotVec; flagPos?: BotVec | null; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number; kout?: boolean } | null {
    const {flags} = this.room;
    if (!flags) {return null;}
    // Rabbit: no teams, one neutral flag. Hunters converge on the flag
    // itself (stand or loose drop) or the carrier's live beacon - the
    // rabbit keeps moving on a defensive circuit instead of sitting.
    if (this.room.mode === 'rabbit') {
      const flag = flags.flags.get('alpha');
      if (!flag || flag.state === 'unspawned') {return null;}
      if (flag.state === 'carried' && flag.carrier === p.id) {
        // A hold-circuit isn't a committed run - the waitSpot re-rolls
        // ~15s, so arming mpc here pays a deep solve per orbit for
        // nothing the reactive stack can't already do.
        return { pos: this.waitSpotFor(p.id, flag.home, duty), infiltrating: false, running: true, runner: false };
      }
      const rabbitP = flag.carrier ? this.room.players.getPlayer(flag.carrier) : null;
      const pos = flag.state === 'carried' && rabbitP ? rabbitP.position : flag.pos;
      // Runner commitment: the flag IS rabbit - without it the objective
      // bids 1.0 against pickups/heard fights and loses, which is why the
      // flag sat loose untouched for minutes. flagPos rides along so the
      // mpc arm sees the carried flag as a moving target and skips the
      // re-solve-per-think churn (the >30m retarget kills it - rabbit
      // measured 31 solves/sim-s vs ~2 on ctf).
      return { pos, flagPos: pos, infiltrating: false, running: true, runner: true };
    }
    if (!p.team) {return null;}
    const me = p.team as TeamId;
    const enemy = flags.flags.get(me === 'alpha' ? 'bravo' : 'alpha');
    const own = flags.flags.get(me);
    if (!enemy || !own) {return null;}
    if (enemy.carrier === p.id) {
      // Own flag dropped in the field: touching it home re-opens the
      // cap window - a carrier that can reach it goes for the touch.
      if (own.state === 'dropped') {return { pos: own.pos, infiltrating: false, running: true, runner: true };}
      // The cap line is blocked while our own flag is in the field -
      // standing on the stand just paints a target. Hover a defensive
      // circuit around home instead: re-roll a wait waypoint every
      // ~15s on a neutron shell - mostly tight orbits over the stand,
      // occasional wide sweeps - so the carrier keeps moving, stays a
      // hard target, and is close enough to dive in the moment our
      // flag returns. A slack carrier draws the wider shells.
      if (own.state === 'carried') {
        const w = this.waitSpotFor(p.id, own.home, duty);
        // Same hold-circuit: the orbit re-rolls ~15s - mpc's deep solve
        // per re-roll is wasted compute on a defensive hold.
        return { pos: w, infiltrating: false, running: true, runner: false };
      }
      // The home run is the map's most predictable line - scent the
      // approach around the intercept blob when far out; only dive
      // once the ring entry is near (~150m). The old 200m dive spent
      // the most-contested stretch on the readable straight line -
      // chasers intercepted exactly there (flagrun: 15 grabs, 0
      // conversions; ctf contested seeds: carry deaths mid-line).
      // No post-grab coast waypoint: the carrier aims at home and the
      // steerer carves. Coast waypoints are map-tuned (help complex
      // terrain, hurt open) - a universal bot navigates by heightmap
      // and physics, not per-map turnaround hacks. Momentum through
      // the turn comes from the carve suppressor (no jet into reversals)
      // and ski retention, not from scripted overshoots.
      if (this.room.influence && dist3(p.position, own.home) > 150) {
        const w = this.room.influence.quietApproach(p.position, own.home, this.room.influence.dangerLayer(me), 140);
        return { pos: w, infiltrating: false, running: true, runner: true };
      }
      return { pos: own.home, infiltrating: false, running: true, runner: true };
    }

    // Home flag sits at the skirt's center inside a solid ~3m dais -
    // a ground-level goal pins pressers against the hull face. Lift the
    // goal to deck height so the climb/jet gates mount it; the touch
    // check still reads the real flag pos. Dropped flags stay at
    // ground level - they're sitting in the open.
    let enemyStand: BotVec | null = enemy.pos;
    if (enemy.state === 'home') { enemyStand = { x: enemy.pos.x, y: enemy.pos.y + FLAG_STAND_LIFT, z: enemy.pos.z }; }
    else if (enemy.state === 'carried') { enemyStand = null; }
    // The touch aim must stay at the flag's real height - the lifted
    // goal is only the mount target; fly-throughs aimed at the lift
    // ride ~3m high and graze past outside the 6m grab window.
    const enemyFlagY = enemy.pos.y;
    const thief = this.thiefOf(me);
    const sit: FlagSituation = {
      sweat: this.sweatOf(p.id),
      home: own.home,
      // Own flag's carrier - chase the thief, not the base; velocity
      // rides along so the pick can lead the run, not the wake.
      thief: thief ? Object.assign({}, thief.pos, {vx: thief.vel.x, vz: thief.vel.z}) : null,
      // Own flag dropped - anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
      threat: this.standThreat(own.home, me),
      push: this.pushFor(me),
      // Called E-grab: the thief is inside the deny ring and their flag
      // is still home - taking it off the stand removes the cap
      // condition outright, which no chase can guarantee. Raised while
      // the threat is in the ring; the role table decides who turns.
      deny: thief && enemy.state === 'home'
        && Math.hypot(thief.pos.x - own.home.x, thief.pos.z - own.home.z) < 150
        ? enemyStand : null,
      me: p.position,
    };
    // The commander names responders for contested jobs before the role
    // table runs - staffed slots are hidden from everyone else so the
    // squad splits its attention instead of lemming one stimulus.
    const cmd = this.command(me);
    const members: CommandMember[] = [];
    for (const [id, role] of this.roles) {
      const mp = this.room.players.getPlayer(id);
      if (!mp || mp.team !== me) {continue;}
      members.push({ id, role, pos: mp.position, carrier: enemy.carrier === id,
        hpFrac: mp.maxHealth > 0 ? Math.max(0, mp.health / mp.maxHealth) : 1 });
    }
    // Sizing the flood against defenders posted at the ring tried and
    // reverted: same-seed soak 14g/8c -> 4g/4c. A bigger call pulls
    // members off the role table earlier and they trickle as feeders;
    // the converged release wins by TIMING, not by body count.
    // A live enemy generator is the standing siege order - killing it
    // drops every powered shield/turret in the base, which is worth
    // more than any single breach attempt against a sealed fortress.
    let siege: BotVec | null = null;
    for (const d of this.room.deployables.items.values()) {
      if (d.base && d.kind === 'generator' && d.team && d.team !== me && d.hp > 0) { siege = d.pos; break; }
    }
    cmd.update(simNow(), sit, members, siege);
    const task = cmd.taskFor(p.id);
    // K-out reads the world state BEFORE the staffing block masks
    // slots - a named task always means there's still a job, and a
    // masked thief is still a flag in play.
    const kout = !task && wantKOut(this.roles.get(p.id) ?? 'offense', sit);
    if (!task) {
      if (cmd.staffed(p.id, 'chase')) {sit.thief = null;}
      if (cmd.staffed(p.id, 'return')) {sit.dropped = null;}
      if (cmd.staffed(p.id, 'escort')) {sit.escort = null;}
      if (cmd.staffed(p.id, 'push')) {sit.push = null;}
    }
    // The task names WHICH job, not WHERE: re-resolve its slot live so
    // a named chaser tracks the carrier's beacon between the commander's
    // 2s reassigns instead of running at the position it was posted.
    const taskGoal = task && ({ chase: sit.thief, return: sit.dropped, escort: sit.escort, push: sit.push, siege: task.goal }[task.kind]
      // The push call ages out mid-transit while the task persists -
      // its stored stand goal keeps the flood running.
      ?? (task.kind === 'push' ? task.goal : null));
    // One role table for both runtimes - shared/flagGoals.ts.
    let pick = taskGoal ?? roleObjective(this.roles.get(p.id) ?? 'offense', sit, duty, roleSide(p.id));
    // Return-on-demand: guarding the drop while our carrier is still
    // inbound - a touch now re-homes our flag while theirs is out,
    // which just hands them a fresh grab on the stand. The returner
    // holds ~12m off toward the enemy approach and takes the touch
    // when the runner's ETA lands - the cap window opens as he arrives,
    // not a minute early.
    if (task?.kind === 'return' && pick === taskGoal && enemy.carrier && sit.dropped) {
      const c = this.room.players.getPlayer(enemy.carrier);
      const eta = c ? dist3(c.position, own.home) / 24 : 0;
      if (eta > 8) {
        const ax = enemy.home.x - sit.dropped.x, az = enemy.home.z - sit.dropped.z;
        const al = Math.hypot(ax, az) || 1;
        pick = { x: sit.dropped.x + (ax / al) * 12, y: sit.dropped.y, z: sit.dropped.z + (az / al) * 12 };
      }
    }
    // A moving-target pick aims at where it will BE: chasing the raw
    // position means following the wake of a 30m/s+ run forever - the
    // slots' velocity rides along for exactly this lead (escort's slot
    // documented the intent; nobody consumed it, and chases had the
    // same wake-chase until now).
    let lead: (Vec3 & { vx?: number; vz?: number }) | null = null;
    if (pick !== null && pick === sit.escort) { lead = sit.escort; }
    else if (pick !== null && pick === sit.thief) { lead = sit.thief; }
    if (lead) {
      const eta = Math.min(10, Math.hypot(lead.x - p.position.x, lead.z - p.position.z) / 24);
      pick = { x: lead.x + (lead.vx ?? 0) * eta, y: lead.y, z: lead.z + (lead.vz ?? 0) * eta };
    }
    const role = this.roles.get(p.id);
    // Post the push-call when THIS bot is the capper closing in. ETA
    // prices actual ground speed (floor 12 m/s - a bot standing still
    // next to the stand shouldn't keep re-announcing); posted early so
    // the squad's response travels ahead of the runner's arrival.
    // The push slot is a COPY of the stand pos ({...enemyStand}) - a
    // tasked wave member's pick never satisfies reference equality, so
    // it skipped the whole entry probe and beelined into walls
    // (katabatic: members stalled ~290m out, near0%). A goal parked on
    // the stand is stand-bound regardless of which object holds it.
    const standBound = enemyStand !== null && pick !== null &&
      (pick === enemyStand || dist3(pick, enemyStand) < 8);
    // The call also posts off the approach leg: standBound only arms
    // inside ~80m where the pick snaps to the raw stand - by then the
    // wave's transit is already late. Any stand-committed route posts:
    // members' full-map transit is ~60-70s against a ~14s call TTL and
    // the 45s ETA gate, so waiting for a nearer radius guarantees the
    // flood arrives after the capper dies (soak: wave near0%, every
    // push dying alone at the ring). The ETA check below is the honest
    // constraint - distance isn't.
    const approachBound = !standBound && enemyStand !== null && pick !== null;
    if (role === 'capper' && (standBound || approachBound) && enemyStand) {
      const qp = this.room.players.getPlayer(p.id);
      const spd = qp ? Math.hypot(qp.velocity.x, qp.velocity.z) : 0;
      const eta = Math.hypot(enemyStand.x - p.position.x, enemyStand.z - p.position.z) / Math.max(12, spd);
      if (eta < BotRouting.PUSH_ETA_S) {
        this.postPush(me, enemyStand);
      }
    }
    // A presser doesn't beeline to the stand - it attacks from a side
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
      // Live enemy positions are already on the wire - a human reads the
      // same board and flanks the blob. Charged per entry candidate so a
      // route through the DMZ loses to a wide arc around it.
      const foes: { x: number; z: number }[] = [];
      for (const q of (parties ?? this.parties.of(p)).roster) {
        if (q.team && q.team !== me) {foes.push({ x: q.pos.x, z: q.pos.z });}
      }
      // Ring routing exists to get AROUND a wall: once the lane to the
      // stand is clear at body height (breached the compound, open
      // approach), pressing the flag IS the route - chasing a ring
      // entry beside it just adds a waypoint to fly past (bastion: a
      // capper inside the courtyard chased an entry 52m off and died
      // at the lip 27m from the flag). Probe 6m short of the socket so
      // the stand's own plinth collider can't veto the lane.
      const laneBlocked = dStand > 0 && Boolean(segSolidHit(
        { x: p.position.x, y: p.position.y + 1, z: p.position.z },
        {
          x: enemyStand.x - (enemyStand.x - p.position.x) / dStand * 6,
          y: enemyStand.y + 1,
          z: enemyStand.z - (enemyStand.z - p.position.z) / dStand * 6,
        },
        this.room.ballSim.colliders, this.room.ballSim.colliderIndex ?? undefined, me));
      const laneClear = dStand < 60 && !laneBlocked;
      // Stay live until the last hop: snapping the goal to the raw
      // stand at 90m beelines the bot into the rim wall it probed its
      // way around - presses end 8m below the flag at the wall's foot.
      // Ring entries are a TERMINAL-sector tool: they exist to breach
      // the stand's rim wall, which is only a decision worth making
      // once the press is inside RING_MAX - firing them at 200-300m
      // keeps re-electing hilltop saddles a full excursion away, and
      // each chase is a massif-belt yo-yo against the next press
      // (katabatic 9001: four 30s entry detours, zero net progress).
      // Far out the flow-field router owns the approach; its whole job
      // IS terrain-aware routing around exactly these ridges.
      //
      // Descent-head sense - evaluated BEFORE the press/entry split: a
      // basin approach reads 'no wall' and never reaches entry election,
      // while the only fast line is over the rim the basin hides
      // (katabatic 9002: every pass arrived dy +10..+18 and popped over
      // the pole, grabbed crawling at 6.9). Per bearing, the crest is
      // the TALLEST ground within 250m - a stand-side apron dip doesn't
      // end the search. Price of the run: net drop minus the climb-back
      // (a crest that sheds into a basin then re-climbs the apron pays
      // that rise twice) minus the detour. An off-axis head must beat
      // the direct line, so it only detours for real drop.
      let headGoal: BotVec | null = null;
      if (capper && !this.passCommit.has(p.id) && dStand > 45) {
        const held = this.headHold.get(p.id);
        if (held && (simNow() - held.at >= 30_000 || dStand <= held.standD)) {
          // Stale, or the bot crested and is now INSIDE the run -
          // releasing the head is what lets it dive the face.
          this.headHold.delete(p.id);
        } else if (held) {
          // Latched while the head is still ahead - a fan re-scan
          // electing a different bearing every think is the same
          // goal-flap disease passCommit exists to kill.
          if (Math.hypot(held.pos.x - p.position.x, held.pos.z - p.position.z) > 15) {
            headGoal = held.pos;
          } else { this.headHold.delete(p.id); }
        }
        if (!headGoal) {
          // One drive, one currency: projected arrival speed at the stand.
          // Each candidate is a two-seg route pos→via→stand integrated as
          // a point mass on the terrain profile - descents convert 2g·dh
          // to speed, climbs bleed it, the tank buys back a transit floor
          // where the leg starves (jets cap out near 50 anyway), seconds
          // of extra leg cost a flat tax. Affordability, basin traps and
          // apron climb-backs are not separate gates: a crest you reach
          // at v≈4 doesn't buy its dive back fast enough to beat going
          // straight - it just scores low.
          headGoal = this.entry.headScan(p, enemyStand, dStand, foes, me);
        }
      }
      if (headGoal) {
        goalPos = headGoal;
      } else if (dStand > (capper ? 25 : 20) && !laneClear && dStand < BotRouting.RING_MAX) {
        const inc = this.routeHold.get(p.id);
        const incLive = inc && dist3(inc.stand, enemyStand) < 1 ? inc : null;
        // A pressed-in record (pos≈stand) short-circuits the whole entry
        // probe for its window - see PRESS_MS.
        const pressing = incLive && dist3(incLive.pos, enemyStand) < 1
          && simNow() - incLive.at < (capper ? BotRouting.CAP_PRESS_MS : BotRouting.PRESS_MS);
        if (incLive && dist3(incLive.pos, enemyStand) < 1 && !pressing) {
          this.routeHold.delete(p.id); // stale press - re-probe
        }
        let routed = false;
        if (pressing) {
          goalPos = Object.assign({}, enemyStand);
          routed = true;
        } else if (incLive) {
          // An incumbent entry is a commitment, not a suggestion: chase
          // it to arrival. Re-probing the wall every think let the
          // verdict oscillate as the bot moved through a valley -
          // stand/entry flip-flops had it orbiting 150m out (kata
          // probe). Arrival can't be exact - ring points land on faces
          // the bot can't occupy - so it is consumed into a press at the
          // face base. The bail is progress, not time: a detour chase
          // legitimately outlasts any short fuse (timing out into a
          // press recreates the same stand/entry orbit one level up),
          // but an entry the bot hasn't approached in 30s is a wall.
          const dEntry = Math.hypot(incLive.pos.x - p.position.x, incLive.pos.z - p.position.z);
          if (dEntry < 45) {
            this.routeHold.set(p.id, { stand: enemyStand, pos: Object.assign({}, enemyStand), at: simNow() });
            goalPos = Object.assign({}, enemyStand);
          } else if (incLive.minD === undefined || dEntry < incLive.minD - 20) {
            incLive.minD = dEntry;
            incLive.at = simNow();
            goalPos = Object.assign({}, incLive.pos);
          } else if (simNow() - incLive.at > 30_000) {
            this.routeHold.delete(p.id);
            this.failRoute(p.id, incLive.pos, enemyStand);
          } else {
            goalPos = Object.assign({}, incLive.pos);
          }
          routed = goalPos !== pick;
        }
        if (!routed) {
        goalPos = this.entry.routeEntry({ p, enemyStand, enemyFlagY, dStand, capper,
          waveTask: task?.kind === 'push' || task?.kind === 'escort',
          laneBlocked, foes, me });
        }
      }
    }
    // Cloak intent only for the infiltrator: the drain is speed-scaled,
    // so a light capper burning RMB-to-stand empties its tank mid-route
    // and arrives with no jet fuel - infiltration is the saboteur's job.
    // Posted roles (HoF, home defense) hold a leash instead of chasing
    // every contact they can see - 300m sight pulling feet off the
    // stand is how the anchor ends up wandering midfield. The leash
    // widens once our flag is already gone: no stand to guard means
    // the defender roams the counter-attack.
    const anchored = role === 'hof' || role === 'ldefense' || role === 'defense' || role === 'technician' || role === 'sniper';
    let posted = 0;
    // The sniper's anchor is his perch, not the stand - 75m down the
    // approach lane would fail the home-distance check, so his leash
    // is keyed on the role, sized to overwatch range.
    if (anchored && (role === 'sniper' || Math.hypot(pick.x - own.home.x, pick.z - own.home.z) < 15)) {
      let base = role === 'hof' ? BOT_TUNING.hof.postHome : 90;
      if (role === 'sniper') { base = 140; }
      else if (own.state === 'carried') { base = role === 'hof' ? BOT_TUNING.hof.postCarried : 200; }
      posted = base * (1.35 - 0.5 * duty);
    }
    return { pos: goalPos, flagPos: enemyStand, infiltrating: enemyStand !== null && pick !== null &&
      // dist<8 like the push-call check - a goal parked on the stand is
      // stand-bound regardless of which object holds it; ref equality
      // silently failed for entry-probe picks (cloak read 0%).
      dist3(pick, enemyStand) < 8 &&
      // Cappers infiltrate too - the approach IS a covert run (T2 jammer
      // pack); he dies ~150m out every soak because the whole transit
      // runs visible. The intent still prices the tank - cloak only
      // when energy ≥ cloakCost+15, so a dry runner stays loud.
      // Push members share the covert approach - a loud flood dies in
      // transit (soak: wave d480m, near0%, dead450+) and the ring never
      // sees it. Escorts stay loud: pulling eyes off the carrier is
      // the job. Cloak drops the moment they fight, which is exactly
      // when the defense should hear them - at the stand, not on the way.
      (role === 'infiltrator' || role === 'capper' || task?.kind === 'push'), runner: role === 'capper',
      // Named wave member (push/escort): his feet are committed to the
      // flood like a runner's - untasked attackers let every midfield
      // contact steal the stand run (soak: sup@0 - the called wave
      // never once arrived). Staging/propel stay capper-only.
      // Named chasers get the same committed feet: their job is the
      // carrier intercept, and midfield contacts stole the run identically
      // (soak: defense dies to the midfield war, nobody reaches the thief).
      // Returners too: a dropped flag in a kill pocket needs someone
      // whose feet don't reroute to the nearest contact - same stolen-
      // run failure, one task kind later.
      // Besiegers too: the generator walk is a 400m+ transit through the
      // midfield war - without committed feet every contact steals the
      // run and the grid never dies (probe: besiegers orbited ~400m for
      // 10 minutes, nearest 107m).
      wave: task?.kind === 'push' || task?.kind === 'escort' || task?.kind === 'chase' || task?.kind === 'return' || task?.kind === 'siege',
      // Push-only: the member mass-orbits ~110m out until the flood is
      // actually converging. Escorts share wave's committed feet but
      // must never hold off a moving carrier - that's just losing him.
      marshal: task?.kind === 'push', posted, kout };
  }


  /** A teammate carrying the enemy flag is the escort point - the
   *  carrier's position is already on the wire, no wallhack needed. */
  private escortSpot(carrier: string | null | undefined, me: TeamId): (Vec3 & { vx?: number; vz?: number }) | null {
    const escortP = carrier ? this.room.players.getPlayer(carrier) : null;
    if (!escortP || escortP.team !== me) {return null;}
    return Object.assign({}, escortP.position, {vx: escortP.velocity.x,vz: escortP.velocity.z});
  }

  /** Closest hostile pressing our stand - the HoF body-block anchor.
   *  Only counts enemies inside the ring so a fighter out in the field
   *  doesn't drag the anchor off the flag. */
  private standThreat(home: Vec3, me: TeamId): Vec3 | null {
    let best: Vec3 | null = null, bestD = 26;
    for (const q of this.parties.nearHostiles(home.x, home.z, bestD, me)) {
      const d = Math.hypot(q.pos.x - home.x, q.pos.z - home.z);
      if (d < bestD) { bestD = d; best = q.pos; }
    }
    return best;
  }

  /** The deciding bot's tryhard scalar - ServerBots wires this to the
   *  brain's sweatLevel so the shared goal table can unlock comp-pub
   *  behaviors per bot, not per lobby. */
  sweatOf: (id: string) => number = () => 0;

  /** Who's carrying OUR flag - pos+vel are beacon info (the wire streams
   *  the carrier anyway), so returning them to the brain is not a wallhack.
   *  pickHunt consumes this to actually ENGAGE the thief, not just run at
   *  the flag's old stand position. */
  thiefOf(team: string): BotEnemy | null {
    const {flags} = this.room;
    if (!flags || (team !== 'alpha' && team !== 'bravo')) {return null;}
    const own = flags.flags.get(team);
    if (!own || own.state !== 'carried' || !own.carrier) {return null;}
    const t = this.room.players.getPlayer(own.carrier);
    if (!t || t.isDead) {return null;}
    return { id: t.id, pos: t.position, vel: t.velocity, alive: true,
      aimY: classCapsule(t.armorClass).centerOff };
  }
}