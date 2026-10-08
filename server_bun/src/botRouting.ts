import type { Room } from './Room.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { dist3, type BotVec } from '../../shared/botVec.ts';
import { TeamCommand, type CommandMember, type CommandTask } from './botCommand.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import type { TeamId } from '../../shared/teams.ts';
import { simNow } from './simClock.ts';
import { botRand } from '../../shared/botRand.ts';
import { TerrainFlow } from '../../shared/botGraph.ts';
import type { Vec3 } from './types.ts';
import type { BotEnemy } from '../../shared/botBrain.ts';
import { roleObjective, type BotRole, type FlagSituation } from '../../shared/flagGoals.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { FLAG_STAND_LIFT } from '../../shared/mapSpec.ts';
import type { ServerParties } from './serverParties.ts';

/**
 * BotRouting — the squad's persistent movement memory: incumbent ring
 * entries, failed-entry graveyard, habitual route leans, the shared
 * TerrainFlow, carrier wait spots, team push-calls, and the per-team
 * commanders. All of it is per-bot/per-team state that must live
 * longer than one think tick; one owner means forget(id) prunes a bot's
 * whole routing footprint in one place instead of a map-per-field audit.
 */
export class BotRouting {
  constructor(
    private readonly room: Room,
    private readonly field: Heightfield | null,
    private readonly parties: ServerParties,
    private readonly roles: Map<string, BotRole>,
  ) {}

  readonly routeHold = new Map<string, { stand: BotVec; pos: BotVec; at: number; minD?: number }>();
  // Entries that were chased and failed: without this memory a dead
  // incumbent is re-elected by the very next probe (it scores best on
  // the same terms it died on), and the bot orbits it forever —
  // raindance's pit orbit was exactly this loop.
  readonly routeFailed = new Map<string, { pos: BotVec; at: number; stand?: BotVec; n?: number }>();
  /** Squad push-call: a capper within ETA of the enemy stand posts it
   *  here; teammates' goal ladders read it for a few seconds so the
   *  stand floods BEFORE the runner lands — the same "capper's 10 out"
   *  call humans make on comms. Legal: the caller's own ETA, not intel. */
  private pushAt = new Map<TeamId, { pos: BotVec; at: number }>();
  private routePrefs = new Map<string, number>();
  /** A bot's habitual route lean — a bearing offset around its own
   *  approach side, stable per id, no RNG draw. */
  routePref(id: string): number {
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
  static readonly PUSH_ETA_S = 75;
  static readonly PUSH_HOLD_MS = 14000;
  /** Once a ring entry is reached the press is committed, not re-probed:
   *  at the lip the straight-line wall check reads the crest the entry
   *  was picked to avoid, bounces the bot back out, and the same entry
   *  wins the next fresh pick — consume→re-pick→consume orbit (kata
   *  probe: capper lapped ~150m off the stand for 100s). 8s covers the
   *  ~80m run-in at a walk; expiry falls back to a normal re-pick. */
  static readonly PRESS_MS = 8000;
  /** A capper's bounce-out excursion after a missed grab runs 15-25s —
   *  an 8s press memory expires mid-orbit and the ring router re-picks
   *  a hilltop entry ~100m out, which is the stand/entry yo-yo the
   *  probes keep catching. Cappers keep their press for the whole
   *  go-around instead. */
  static readonly CAP_PRESS_MS = 30_000;
  /** Outside this stand distance ring entries don't run at all — see
   *  the gate comment where it's used. */
  static readonly RING_MAX = 150;
  /** Meters past the flag a capper aims on the committed run — the
   *  pass-through aim that makes the approach wrap to the home-side
   *  exit instead of beeline-and-stop. */
  static readonly PASS_M = 40;
  /** Carrier wait-circuit waypoint, re-rolled on a TTL so the orbit
   *  wanders its own mini-route instead of parking. */
  private waitSpot = new Map<string, { pos: BotVec; at: number }>();
  static readonly WAIT_TTL_MS = 15_000;
  /** Per-team commander — names responders for contested jobs so one
   *  thief doesn't empty the home defense (botCommand.ts). */
  private commands = new Map<TeamId, TeamCommand>();
  /** Shared leg-scale router — one flow field serves the whole squad;
   *  built on first route query so botless rooms never pay the grid. */
  flow: TerrainFlow | null = null;
  routeOf(p: { team?: string }) {
    if (!this.field) return undefined;
    this.flow ??= new TerrainFlow((x, z) => hmHeight(this.field!, x, z),
      BOT_TUNING.graph.extent, BOT_TUNING.graph.cell, this.room.ballSim.colliders);
    const flow = this.flow;
    // Danger feed is per-team and live: the walk deflects around cells
    // where THIS side keeps dying, so two rooms' routes diverge without
    // a second flood.
    const danger = (x: number, z: number) =>
      this.room.influence.value({ x, y: 0, z }, this.room.influence.dangerLayer(p.team ?? 'alpha'));
    return (fx: number, fz: number, tx: number, tz: number, ahead: number) =>
      flow.route(fx, fz, tx, tz, ahead, danger, p.team);
  }

  /** Neutron shell around home for a flag carrier waiting out a stolen
   *  flag: ~50% of rolls land inside 50m of the stand, ~10% reach the
   *  50-100m sweep, a rare ~1% pulls a big 200m patrol. Azimuth is free
   *  — the bot picks its own circuit. */
  waitSpotFor(id: string, home: BotVec, duty: number): BotVec {
    const now = simNow();
    const cur = this.waitSpot.get(id);
    if (cur && now - cur.at < BotRouting.WAIT_TTL_MS) return cur.pos;
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

  /** Bot left the room — drop every routing trace so no map grows one
   *  entry per retired bot for the room's life. */
  forget(id: string): void {
    this.routeHold.delete(id);
    this.routeFailed.delete(id);
    this.routePrefs.delete(id);
    this.waitSpot.delete(id);
  }

  /** Mark an entry position as failed-to-reach so the next probe can't
   *  re-elect it — bounded memory (a few recent failures per bot).
   *  Failures also count per stand: a presser that burned two dead
   *  entries on the same stand is probing a wall the ring can't see —
   *  it stops detouring and beelines (the jet-escape stack forces the
   *  face better than a third orbit that dies the same way). */
  failRoute(id: string, pos: BotVec, stand?: BotVec): void {
    const f = this.routeFailed.get(id) ?? { pos, at: 0 };
    f.pos = pos;
    f.n = stand !== undefined && f.stand !== undefined && dist3(f.stand, stand) < 1
      ? (f.n ?? 0) + 1 : 1;
    if (stand !== undefined) f.stand = { ...stand };
    f.at = simNow();
    this.routeFailed.set(id, f);
  }

  /** The team's commander, created on first contested job — the caller
   *  (flagGoal) runs update() against it each cycle. */
  command(team: TeamId): TeamCommand {
    let cmd = this.commands.get(team);
    if (!cmd) { cmd = new TeamCommand(); this.commands.set(team, cmd); }
    return cmd;
  }

  /** The named responder's task, whichever team owns him — spawn
   *  scoring reads this so a tasked member materializes toward his
   *  job instead of hiking 500m back through the kill zone. */
  taskGoalFor(id: string): CommandTask | undefined {
    for (const cmd of this.commands.values()) {
      const t = cmd.taskFor(id);
      if (t) return t;
    }
    return undefined;
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

  /** Post the capper's push-call — the re-post throttle and the
   *  pushCalls counter move together so they can't disagree. */
  postPush(me: TeamId, pos: BotVec): void {
    const prev = this.pushAt.get(me);
    if (!prev || simNow() - prev.at > BotRouting.PUSH_HOLD_MS) {
      this.pushCalls.set(me, (this.pushCalls.get(me) ?? 0) + 1);
    }
    this.pushAt.set(me, { pos: { ...pos }, at: simNow() });
  }

  /** Live push-call for this team, or null once it ages out — the
   *  window is short so a dead capper's call doesn't trap the squad
   *  on a stand press long after the run collapsed. */
  pushFor(me: TeamId): BotVec | null {
    const c = this.pushAt.get(me);
    if (!c) return null;
    if (simNow() - c.at > BotRouting.PUSH_HOLD_MS) { this.pushAt.delete(me); return null; }
    return c.pos;
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  carried off → run down the carrier (the carrier's position IS known —
   *  tickUpdate streams it, this is a legal pursuit not a wallhack); own
   *  flag dropped → touch it home; a teammate carrying → escort them;
   *  enemy flag reachable → go grab it. Defenders invert it: their flag
   *  recovery/intercept outranks pressing the enemy stand. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1, parties?: ReturnType<ServerParties['of']>): { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null {
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
      // The home run is the map's most predictable line — every chase
      // and defender reads it, which is why ~70% of raindance grabs
      // die en route (avg hold 16s). Scent the approach so the run
      // bends around the intercept blob instead of plowing through
      // it; inside ~200m the stand is close — dive straight, a bend
      // that late only buys the chasers more runway.
      if (this.room.influence && dist3(p.position, own.home) > 200) {
        const w = this.room.influence.quietApproach(p.position, own.home, this.room.influence.dangerLayer(me), 140);
        return { pos: w, infiltrating: false, running: true, runner: true };
      }
      return { pos: own.home, infiltrating: false, running: true, runner: true };
    }

    // Home flag sits at the skirt's center inside a solid ~3m dais —
    // a ground-level goal pins pressers against the hull face. Lift the
    // goal to deck height so the climb/jet gates mount it; the touch
    // check still reads the real flag pos. Dropped flags stay at
    // ground level — they're sitting in the open.
    const enemyStand = enemy.state === 'home'
      ? { x: enemy.pos.x, y: enemy.pos.y + FLAG_STAND_LIFT, z: enemy.pos.z }
      : enemy.state !== 'carried' ? enemy.pos : null;
    // The touch aim must stay at the flag's real height — the lifted
    // goal is only the mount target; fly-throughs aimed at the lift
    // ride ~3m high and graze past outside the 6m grab window.
    const enemyFlagY = enemy.pos.y;
    const sit: FlagSituation = {
      home: own.home,
      // Own flag's carrier — chase the thief, not the base; velocity
      // rides along so the pick can lead the run, not the wake.
      thief: ((t) => t ? { ...t.pos, vx: t.vel.x, vz: t.vel.z } : null)(this.thiefOf(me)),
      // Own flag dropped — anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
      threat: this.standThreat(own.home, me),
      push: this.pushFor(me),
      me: p.position,
    };
    // The commander names responders for contested jobs before the role
    // table runs — staffed slots are hidden from everyone else so the
    // squad splits its attention instead of lemming one stimulus.
    const cmd = this.command(me);
    const members: CommandMember[] = [];
    for (const [id, role] of this.roles) {
      const mp = this.room.players.getPlayer(id);
      if (!mp || mp.team !== me) continue;
      members.push({ id, role, pos: mp.position, carrier: enemy.carrier === id,
        hpFrac: mp.maxHealth > 0 ? Math.max(0, mp.health / mp.maxHealth) : 1 });
    }
    // Sizing the flood against defenders posted at the ring tried and
    // reverted: same-seed soak 14g/8c -> 4g/4c. A bigger call pulls
    // members off the role table earlier and they trickle as feeders;
    // the converged release wins by TIMING, not by body count.
    // A live enemy generator is the standing siege order — killing it
    // drops every powered shield/turret in the base, which is worth
    // more than any single breach attempt against a sealed fortress.
    let siege: BotVec | null = null;
    for (const d of this.room.deployables.items.values()) {
      if (d.base && d.kind === 'generator' && d.team && d.team !== me && d.hp > 0) { siege = d.pos; break; }
    }
    cmd.update(simNow(), sit, members, siege);
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
    const taskGoal = task && ({ chase: sit.thief, return: sit.dropped, escort: sit.escort, push: sit.push, siege: task.goal }[task.kind]
      // The push call ages out mid-transit while the task persists —
      // its stored stand goal keeps the flood running.
      ?? (task.kind === 'push' ? task.goal : null));
    // One role table for both runtimes — shared/flagGoals.ts.
    let pick = taskGoal ?? roleObjective(this.roles.get(p.id) ?? 'offense', sit, duty);
    // A moving-target pick aims at where it will BE: chasing the raw
    // position means following the wake of a 30m/s+ run forever — the
    // slots' velocity rides along for exactly this lead (escort's slot
    // documented the intent; nobody consumed it, and chases had the
    // same wake-chase until now).
    const lead = pick !== null && pick === sit.escort ? sit.escort
      : pick !== null && pick === sit.thief ? sit.thief : null;
    if (lead) {
      const eta = Math.min(10, Math.hypot(lead.x - p.position.x, lead.z - p.position.z) / 24);
      pick = { x: lead.x + (lead.vx ?? 0) * eta, y: lead.y, z: lead.z + (lead.vz ?? 0) * eta };
    }
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
      if (eta < BotRouting.PUSH_ETA_S) {
        this.postPush(me, enemyStand);
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
      for (const q of (parties ?? this.parties.of(p)).roster) {
        if (q.team && q.team !== me) foes.push({ x: q.pos.x, z: q.pos.z });
      }
      // Ring routing exists to get AROUND a wall: once the lane to the
      // stand is clear at body height (breached the compound, open
      // approach), pressing the flag IS the route — chasing a ring
      // entry beside it just adds a waypoint to fly past (bastion: a
      // capper inside the courtyard chased an entry 52m off and died
      // at the lip 27m from the flag). Probe 6m short of the socket so
      // the stand's own plinth collider can't veto the lane.
      const laneBlocked = dStand > 0 && !!segSolidHit(
        { x: p.position.x, y: p.position.y + 1, z: p.position.z },
        {
          x: enemyStand.x - (enemyStand.x - p.position.x) / dStand * 6,
          y: enemyStand.y + 1,
          z: enemyStand.z - (enemyStand.z - p.position.z) / dStand * 6,
        },
        this.room.ballSim.colliders, this.room.ballSim.colliderIndex ?? undefined, me);
      const laneClear = dStand < 60 && !laneBlocked;
      // Stay live until the last hop: snapping the goal to the raw
      // stand at 90m beelines the bot into the rim wall it probed its
      // way around — presses end 8m below the flag at the wall's foot.
      // Ring entries are a TERMINAL-sector tool: they exist to breach
      // the stand's rim wall, which is only a decision worth making
      // once the press is inside RING_MAX — firing them at 200-300m
      // keeps re-electing hilltop saddles a full excursion away, and
      // each chase is a massif-belt yo-yo against the next press
      // (katabatic 9001: four 30s entry detours, zero net progress).
      // Far out the flow-field router owns the approach; its whole job
      // IS terrain-aware routing around exactly these ridges.
      if (dStand > (capper ? 25 : 20) && !laneClear && dStand < BotRouting.RING_MAX) {
        const inc = this.routeHold.get(p.id);
        const incLive = inc && dist3(inc.stand, enemyStand) < 1 ? inc : null;
        // A pressed-in record (pos≈stand) short-circuits the whole entry
        // probe for its window — see PRESS_MS.
        const pressing = incLive && dist3(incLive.pos, enemyStand) < 1
          && simNow() - incLive.at < (capper ? BotRouting.CAP_PRESS_MS : BotRouting.PRESS_MS);
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
            this.failRoute(p.id, incLive.pos, enemyStand);
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
        // Inside the grab ring a capper commits to the pole — the wall
        // probe still reads the dais/apron face there and routing it
        // back out to ring probes throws away a stand it already owns
        // (broadside 9002: 90s of probe-churn 8-25m out).
        // `wall` measures terrain only — on a structure map it reads 0
        // through a genhouse, so "clear lane" must include solids or the
        // commit press becomes a grind on an interior wall (bastion:
        // cappers pinned 25m from the flag with a flat-terrain "open"
        // lane). Committed pressers still press into the wall — that
        // stall is what feeds the breach machinery.
        if ((wall < 6 && !laneBlocked) || committed || (waveTask && wall < 20) || (capper && dStand < 25)) {
          // Any straight press is ownership of the stand: stamp the
          // press record so a bounce back out past the lane window
          // sees `pressing` instead of re-running the ring probe —
          // laneClear approaches used to leave no trace, so every
          // overshoot re-entered routing and picked a hilltop entry.
          this.routeHold.set(p.id, { stand: enemyStand, pos: { ...enemyStand }, at: simNow() });
          // Two human corrections on the final run:
          // - Altitude pull: a ballistic runner can't dive, so aim the
          //   landing short of the flag and skim through it at grab height.
          // - Track lead: momentum lags yaw, so the velocity ray misses
          //   the pole by meters. Shift the aim point by the measured
          //   miss vector so the converged path crosses the flag.
          const dy = p.position.y - enemyFlagY;
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
            const cx = enemyStand.x + (hx / hd) * BotRouting.PASS_M;
            const cz = enemyStand.z + (hz / hd) * BotRouting.PASS_M;
            // …only when the pass point is open airspace — on rim maps
            // the home-side wrap point sits inside the crater wall and
            // aiming there buries the run in rock (kata no-grab).
            if (hmHeight(this.field, cx, cz) - enemyStand.y < 15) {
              px2 = cx - enemyStand.x; pz2 = cz - enemyStand.z;
            }
          }
          // The pass shape is for a runner arriving with speed — a
          // stalled or point-blank presser aiming PAST the flag slides
          // around the dais hull chasing the offset (broadside: ~19s of
          // ring orbits at 4-15m/s). Threshold lives above crawl pace:
          // a braked bot hovering 5-9m/s flapped between the pole and
          // a point 40m past the flag and paced 10-17m out forever
          // (katabatic 9002). Slow/close presses aim the pole.
          goalPos = spd > 14 && dStand > 6
            ? { x: enemyStand.x + mx + px2 - ux * pull,
                y: enemyFlagY,
                z: enemyStand.z + mz + pz2 - uz * pull }
            : { ...enemyStand };
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
          // Structure cost — the terrain probes are blind to walls, so a
          // ring point inside a walled compound scored like open ground
          // and the bot chased it through a curtain it can't walk
          // through (bastion: every close-ring entry is courtyard
          // interior). Each leg of pos→entry→stand pays per wall on the
          // line; entries that only cross the breach face once still
          // compete, entries walled on both legs lose.
          const cols = this.room.ballSim.colliders;
          if (cols.length) {
            const idx = this.room.ballSim.colliderIndex ?? undefined;
            const body = { x: p.position.x, y: p.position.y + 1, z: p.position.z };
            const ent = { x: ex, y: ey + 1, z: ez };
            const std = { x: enemyStand.x, y: enemyStand.y + 1, z: enemyStand.z };
            if (segSolidHit(body, ent, cols, idx, me)) score -= 150;
            if (segSolidHit(ent, std, cols, idx, me)) score -= 180;
          }
          return score;
        };
        // Route temperament: two runners reading the same terrain pick
        // the same entry — mirrored runs joust head-on mid-field (the
        // capper autopsy: enemy cappers are each other's top killer).
        // A stable per-bot bearing OFFSET fans them out around their
        // own approach side — a fixed world bearing sent runners
        // around the massif to a far-side entry they could never reach
        // (the bravo capper's 750m contour orbit).
        // Two dead entries on this stand = the ring is lying: every
        // probe-elected detour dies on the same wall. Stop spending
        // 30s bail windows proving it a third time — press the stand
        // and let the jet-escape stack force the face. The failure
        // memory decays (90s graveyard window), so the detour sense
        // comes back once the terrain's verdict has room to change.
        const frStale = this.routeFailed.get(p.id);
        if (frStale && (frStale.n ?? 0) >= 2 && frStale.stand !== undefined
          && simNow() - frStale.at < 90_000 && dist3(frStale.stand, enemyStand) < 1) {
          this.routeHold.set(p.id, { stand: enemyStand, pos: { ...enemyStand }, at: simNow() });
          goalPos = { ...enemyStand };
          routed = goalPos !== pick;
        } else {
        // The flood's own near-stand route point joins the ring as a
        // scored candidate — the saddle the cheapest path funnels
        // through. It goes through the same reachability/foe/graveyard
        // scoring as the ring points, so it wins only where the ring's
        // fixed radii are blind to it; on maps where the ring already
        // sees the saddle, nothing changes.
        const flowEntry = this.flow
          ? this.flow.routeNearGoal(p.position.x, p.position.z, enemyStand.x, enemyStand.z, 90, p.team)
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
        ? (role === 'hof' ? BOT_TUNING.hof.postCarried : 200)
        : (role === 'hof' ? BOT_TUNING.hof.postHome : 90);
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
      // Push members share the covert approach — a loud flood dies in
      // transit (soak: wave d480m, near0%, dead450+) and the ring never
      // sees it. Escorts stay loud: pulling eyes off the carrier is
      // the job. Cloak drops the moment they fight, which is exactly
      // when the defense should hear them — at the stand, not on the way.
      (role === 'infiltrator' || role === 'capper' || task?.kind === 'push'), runner: role === 'capper',
      // Named wave member (push/escort): his feet are committed to the
      // flood like a runner's — untasked attackers let every midfield
      // contact steal the stand run (soak: sup@0 — the called wave
      // never once arrived). Staging/propel stay capper-only.
      // Named chasers get the same committed feet: their job is the
      // carrier intercept, and midfield contacts stole the run identically
      // (soak: defense dies to the midfield war, nobody reaches the thief).
      // Returners too: a dropped flag in a kill pocket needs someone
      // whose feet don't reroute to the nearest contact — same stolen-
      // run failure, one task kind later.
      // Besiegers too: the generator walk is a 400m+ transit through the
      // midfield war — without committed feet every contact steals the
      // run and the grid never dies (probe: besiegers orbited ~400m for
      // 10 minutes, nearest 107m).
      wave: task?.kind === 'push' || task?.kind === 'escort' || task?.kind === 'chase' || task?.kind === 'return' || task?.kind === 'siege',
      // Push-only: the member mass-orbits ~110m out until the flood is
      // actually converging. Escorts share wave's committed feet but
      // must never hold off a moving carrier — that's just losing him.
      marshal: task?.kind === 'push', posted };
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
  private standThreat(home: Vec3, me: TeamId): Vec3 | null {
    let best: Vec3 | null = null, bestD = 26;
    for (const q of this.parties.nearHostiles(home.x, home.z, bestD, me)) {
      const d = Math.hypot(q.pos.x - home.x, q.pos.z - home.z);
      if (d < bestD) { bestD = d; best = q.pos; }
    }
    return best;
  }

  /** Who's carrying OUR flag — pos+vel are beacon info (the wire streams
   *  the carrier anyway), so returning them to the brain is not a wallhack.
   *  pickHunt consumes this to actually ENGAGE the thief, not just run at
   *  the flag's old stand position. */
  thiefOf(team: string): BotEnemy | null {
    const flags = this.room.flags;
    if (!flags || (team !== 'alpha' && team !== 'bravo')) return null;
    const own = flags.flags.get(team);
    if (!own || own.state !== 'carried' || !own.carrier) return null;
    const t = this.room.players.getPlayer(own.carrier);
    if (!t || t.isDead) return null;
    return { id: t.id, pos: t.position, vel: t.velocity, alive: true,
      aimY: classCapsule(t.armorClass).centerOff };
  }
}
