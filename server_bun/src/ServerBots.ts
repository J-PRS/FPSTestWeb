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
import type { Heightfield } from '../../shared/heightfield.ts';
import { BotBrain, BRAWL_RANGE, FOE_CONE_MIN_DOT, type BotVec, type BrainCtx, type BrainOut } from '../../shared/botBrain.ts';
import { losClear } from '../../shared/botLos.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { endTaunt, startTaunt, type ChatterKind, type EndOutcome, type TauntLine } from '../../shared/botTaunts.ts';
import { logger } from './logger.ts';
import { pushRewindSample } from './rewind.ts';
import { STATUS, CLIENT_STATUS_MASK } from '../../shared/status.ts';
import type { MoveState } from '../../shared/movement.ts';
import { type BotLoadout } from '../../shared/botLoadouts.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { MobilityWatchdog, type MobilitySample } from './botMobility.ts';
import { BotArsenal } from './botArsenal.ts';
import { BotSheepMeter } from './botSheep.ts';
import { ServerBotSenses } from './serverSenses.ts';
import type { BotRole } from '../../shared/flagGoals.ts';
import { BotRoster } from './botRoster.ts';
import { driveMove as driveMoveInto, legacyMove as legacyMoveInto } from './botDrive.ts';
import { simNow } from './simClock.ts';
import { wallNow } from './wallClock.ts';
import { botRand } from '../../shared/botRand.ts';
import { WeaponType, HEALBEAM_ENERGY, HEALBEAM_RANGE, BELT_MAX, BELT_THROW_COST } from '../../shared/weapons.ts';

/** Tribes-flavored squad roles — the type and the objective rules live in
 *  shared/flagGoals.ts so offline CTF plays by the identical table. */


export class ServerBots {
  private brains = new Map<string, BotBrain>();
  private loadouts = new Map<string, BotLoadout>();
  /** Squad role — self-assigned and rebalanced by need (see
   *  rebalanceRoles): nobody scripts positions, the squad just notices
   *  a lane is empty and someone takes it. */
  /** Bots we saw dead — respawn transition resyncs the move shadow. */
  private deadSet = new Set<string>();
  /** Brains silenced for tests — the body stays in the sim, it just never
   *  thinks: no wander, no cloak, no shots. Production code never populates
   *  this; the scenario harness does. */
  readonly quiet = new Set<string>();
  /** Next allowed sentry-clearing lob per bot — keeps gear suppression
   *  on a human cadence instead of a per-tick mortar stream. */
  private gearLobT = new Map<string, number>();
  /** Next allowed stand-suppression volley per bot — a few shots on the
   *  approach, not a constant stream while he flies. */
  private suppressT = new Map<string, number>();
  /** Sheep meter lives in botSheep.ts — pedestrian play fills it and
   *  the value is broadcast as a readout. Kept off this file like the
   *  watchdog so ServerBots stays about driving bots.
   *  Public + the others below: botDrive.ts's DriveHost reads them. */
  sheep: BotSheepMeter;
  /** Trigger discipline — own file (botArsenal.ts): weapon select,
   *  muzzle geometry, lobs, disc-jump propels. This file drives brains
   *  and bodies; the arsenal decides when and at what to fire. */
  arsenal: BotArsenal;
  readonly room: Room;
  readonly field: Heightfield | null;
  /** Mobility watchdog — stuck + sheep alarms live in botMobility.ts so
   *  this file stays about driving bots, not auditing them. */
  watchdog: MobilityWatchdog;
  /** What brains may see — serverSenses.ts builds the wire-legal ctx. */
  private sense: ServerBotSenses;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
    this.watchdog = new MobilityWatchdog(room.name);
    this.sheep = new BotSheepMeter(room);
    this.arsenal = new BotArsenal(room, this.loadouts, (id) => this.lastHuntId(id), (id) => this.brains.get(id)?.currentHuntSeen ?? null, (id) => this.brains.get(id)?.skill);
    this.roster = new BotRoster(room, this.brains, this.loadouts, this.thinkPhase, (id) => this.untrack(id), ServerBots.THINK_DIV);
    this.sense = new ServerBotSenses(room, field, this.loadouts, this.roster.roleInfo, this.foeNear);
  }

  private roster: BotRoster;
  /** A bot's current squad role (post-rebalance) — telemetry reads it
   *  for per-role stat lines without touching the roster internals. */
  roleOf(id: string): BotRole | undefined {
    return this.roster.roleInfo.get(id);
  }
  /** A bot's named squad task, if the commander gave it one — spawn
   *  scoring pulls tasked members toward their job. */
  taskGoalFor(id: string) {
    return this.sense.taskGoalFor(id);
  }
  /** A bot's rolled skill matrix — telemetry reads it for per-bot
   *  skill↔outcome lines without touching the brain internals. */
  skillOf(id: string): BotSkill | undefined {
    return this.brains.get(id)?.skill;
  }
  /** Brain cadence: senses+think+fire run every THINK_DIV tick per bot
   *  (phase-offset so the squad doesn't think in lockstep). 20Hz decisions
   *  cost O(bots × (players+creatures)) per tick; at 4Hz reaction is still
   *  faster than human perception while the move sim keeps integrating
   *  at full rate, so motion smoothness is unchanged. */
  private static readonly THINK_DIV = 5;
  private thinkPhase = new Map<string, number>();
  /** One think-phase slot per tick — advanced once per tick() pass so every
   *  brain runs its think exactly once per THINK_DIV ticks regardless of
   *  roster size. */
  private thinkPhaseNow = 0;
  private lastOut = new Map<string, BrainOut>();
  /** Visible-enemy-present flag from the last think (epoch ms expiry). */
  readonly foeNear = new Map<string, number>();
  /** Stage timers — flagGoal/build/think/fire/drive + [5] = the per-bot
   *  loop tail (everything outside those stages: roster scan, dead/quiet
   *  checks, stuck probe, rewind push). Always on: a few timer pairs per
   *  think is noise, and the soak + /metrics both read the same
   *  accumulators (stageMs = ms/sec over the last 10s window). */
  readonly stageProf = Array.from({ length: 6 }, () => 0);
  private stageBase = Array.from({ length: 6 }, () => 0);
  private stageWinAt = 0;
  readonly stageMs = Array.from({ length: 6 }, () => 0);
  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Roster owns the spawn/role/class bookkeeping. */
  populate(n: number): void {
    this.roster.populate(n);
  }

  get count(): number {
    return this.brains.size;
  }

  /** Engagement-density probe — share of live brains currently tracking
   *  a hunt target. The soak report prints the mean as `hunt=`: low
   *  means bots spend their ticks traveling, not dueling (the real
   *  kills/min bottleneck detector). */
  huntUptime(): number {
    let n = 0;
    for (const b of this.brains.values()) if (b.h.hunt) n++;
    return this.brains.size ? n / this.brains.size : 0;
  }

  /** Prune a bot that was fully removed (room teardown / test hooks).
   *  EVERY keyed structure dies here — retire and teardown both funnel
   *  through, so a bot id must not outlive its roster entry in any map. */
  untrack(playerId: string): void {
    this.brains.delete(playerId);
    this.loadouts.delete(playerId);
    this.thinkPhase.delete(playerId);
    this.lastOut.delete(playerId);
    this.roster.forget(playerId);
    this.sheep.clear(playerId);
    this.arsenal.untrack(playerId);
    this.foeNear.delete(playerId);
    this.gearLobT.delete(playerId);
    this.suppressT.delete(playerId);
    this.deadSet.delete(playerId);
    this.quiet.delete(playerId);
    this.skillOffAt.delete(playerId);
    this.supportT.delete(playerId);
    this.healBeamT.delete(playerId);
    this.healNadeT.delete(playerId);
    this.watchdog.remove(playerId);
    this.sense.forget(playerId);
    this.room.moveSim.untrack(playerId);
  }

  /** Scenario tests poke the objective pick directly. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }) {
    return this.sense.flagGoal(p, this.brains.get(p.id)?.dutyLevel ?? 1);
  }

  /** The brain's current hunt target id — needed by throwBelt since the
   *  belt intent carries no aim point of its own. */
  private lastHuntId(botId: string): string | null {
    const brain = this.brains.get(botId);
    return brain?.currentHuntId ?? null;
  }

  /** Getting shot makes the brain recoil — called from the combat funnel. */
  flinch(targetId: string, shooterId: string): void {
    const brain = this.brains.get(targetId);
    const shooter = this.room.players.getPlayer(shooterId);
    if (brain && shooter) brain.takeHit(shooter.position);
  }

  /** A room event the squad may react to — enters the senses as a notice
   *  channel; each bot's brain decides on its own whether to remark. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string): void {
    this.sense.notice(kind, actorId, actorTeam);
  }

  /** The horn beat — every bot rolls an outcome-appropriate line (winners
   *  celebrate, losers say gg anyway, a one-point finish reads as close
   *  for everyone). killFeed staggers delivery inside the intermission. */
  matchEnd(winner: string): void {
    const spec = this.room.modeSpec;
    const entries: { id: string; line: TauntLine }[] = [];
    for (const id of this.brains.keys()) {
      const p = this.room.players.getPlayer(id);
      if (!p) continue;
      let outcome: EndOutcome;
      if (winner === 'draw') outcome = 'draw';
      else if (spec?.teams) {
        const margin = Math.abs(this.room.scores.alpha - this.room.scores.bravo);
        outcome = margin <= 1 ? (p.team === winner ? 'winclose' : 'close') : (p.team === winner ? 'win' : 'loss');
      } else {
        const pts = [...this.room.ffaScores.values()];
        const top = Math.max(...pts);
        const runnerUp = pts.filter((v) => v < top).reduce((a, b) => Math.max(a, b), 0);
        outcome = pts.length > 1 && top - runnerUp <= 1 ? (id === winner ? 'winclose' : 'close') : (id === winner ? 'win' : 'loss');
      }
      const line = endTaunt(id, outcome);
      if (line) entries.push({ id, line });
    }
    this.room.messages.killFeed.matchEnd(entries);
  }

  /** The opener beat — every bot rolls a gl-hf line as the round goes
   *  live. Same once-per-match shape as matchEnd: high flat roll, no
   *  shared cooldown, killFeed staggers delivery. */
  matchStart(): void {
    const entries: { id: string; line: TauntLine }[] = [];
    for (const id of this.brains.keys()) {
      const line = startTaunt(id);
      if (line) entries.push({ id, line });
    }
    this.room.messages.killFeed.matchStart(entries);
  }

  /** Does chat text name a live bot? Callsigns are 'BOT-VEKTOR-01' — the
   *  middle name is what humans actually type ('vektor u sux'). */
  nameIn(text: string): boolean {
    const t = text.toLowerCase();
    for (const id of this.brains.keys()) {
      const name = id.slice(4, id.lastIndexOf('-')).toLowerCase();
      if (name.length > 2 && t.includes(name)) return true;
    }
    return false;
  }

  private checkStuck(id: string, p: { position: Vec3 }, brain: BotBrain, now: number): void {
    const carrying = this.room.flagCarriedBy(id);
    this.watchdog.checkStuck(id, p.position, brain, carrying, now);
  }

  checkSheep(id: string, p: { position: Vec3 }, m: MobilitySample, now: number): void { // public — botDrive host hook
    this.watchdog.checkSheep(id, p.position, m, now);
  }

  /** The brain's status intent IS the player's claim — same rising-edge
   *  antes + drains the human path models, applied via setInput below.
   *  Keep server-owned buff bits (REGEN/DD) — the brain only claims
   *  the toggle skills a client could legitimately hold. */
  /** Per-skill re-arm: statusIntent gates on an energy threshold that
   *  the skill's own drain pulls the tank back under, so the claim
   *  flickers every think — a dropped bit must cool down before the
   *  brain may raise it again (cloak/mend/shield share the window). */
  private skillOffAt = new Map<string, Map<number, number>>();
  private static readonly SKILL_REARM_MS = 1500;
  private applyStatus(id: string, p: { status: number }, out: BrainOut, now: number): void {
    if (out.status === undefined) return;
    let claim = out.status & CLIENT_STATUS_MASK;
    let offs = this.skillOffAt.get(id);
    if (!offs) { offs = new Map(); this.skillOffAt.set(id, offs); }
    const cur = p.status & CLIENT_STATUS_MASK;
    for (const bit of [STATUS.MEND, STATUS.SHIELD, STATUS.CLOAK]) {
      if ((cur & bit) && !(claim & bit)) offs.set(bit, now);
      else if (!(cur & bit) && (claim & bit) && now - (offs.get(bit) ?? -Infinity) < ServerBots.SKILL_REARM_MS) {
        claim &= ~bit; // still cooling down — suppress the flicker
      }
    }
    // Rising-edge skill activation — the only place a bot's mend/
    // shield/cloak intent becomes visible in logs.
    const rising = claim & ~(p.status & CLIENT_STATUS_MASK);
    if (rising & (STATUS.MEND | STATUS.SHIELD | STATUS.CLOAK)) {
      const names = ([
        [STATUS.MEND, 'MEND'], [STATUS.SHIELD, 'SHIELD'], [STATUS.CLOAK, 'CLOAK'],
      ] as const).filter(([bit]) => rising & bit).map(([, n]) => n);
      logger.debug('Bot skill on', { id, skill: names.join('+') });
    }
    p.status = (p.status & ~CLIENT_STATUS_MASK) | claim;
  }

  /** Value-tiered ordnance gate: high-value spends (propel, heals,
   *  plants, saboteur work) pay whenever the pocket covers them; casual
   *  tosses keep a reserve so a bot doesn't dump its whole belt into
   *  speculative arcs. Two relaxations: a FULL pocket may always spend
   *  (the next nugget's +1 would overflow anyway), and income in reach
   *  lowers the reserve — the refill is already planned. */
  private spendOk(id: string, cost: number, highValue: boolean, nuggetNear: boolean): boolean {
    const c = this.room.players.getPlayer(id)?.beltCharges ?? 0;
    if (c < cost) return false;
    if (highValue) return true;
    const reserve = c >= BELT_MAX ? 0 : nuggetNear ? 1 : 2;
    return c - cost >= reserve;
  }

  /** Everything the brain asked to shoot or plant this tick — primary
   *  trigger, belt throw, sentry-clearing lob on its slow cadence, and
   *  deploy claims re-validated through the human message path. */
  private firePhase(id: string, p: { id: string; position: Vec3; velocity: Vec3; armorClass: string; team?: string }, out: BrainOut, s: { goal: { pos: BotVec; runner?: boolean; wave?: boolean } | null; now: number; sh: MoveState | null; nuggetNear: boolean; ctx: BrainCtx }): void {
    const { goal, now, sh, nuggetNear, ctx } = s;
    if (out.fire) this.arsenal.fireAt(p, out.fire.targetId, out.fire.aim);
    // Stand suppression: a committed runner with clear LOS takes a few
    // potshots at the stand while closing — humans pre-soften the ring
    // (disc/GL/bolt, not a mortar barrage) so the pass doesn't fly
    // through untouched defenders. Never interrupts a live hunt shot.
    // Wave members firing it too tried and reverted: chip volleys at
    // the stand steal the member's committed-fire windows and the
    // scatter doesn't hit posted defenders (soaks 11g/2c + 7g/1c vs
    // 14g/8c + 9g/2c — eHp rose, caps fell; suppression that doesn't
    // threaten costs the shooter more than the target).
    else if (goal?.runner && (this.suppressT.get(id) ?? 0) <= now) {
      const sd = Math.hypot(goal.pos.x - p.position.x, goal.pos.z - p.position.z);
      const eye = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
      if (sd > 60 && sd < 280 && losClear(ctx, eye, goal.pos)) {
        this.arsenal.firePoint(p, goal.pos);
        this.suppressT.set(id, now + 2500);
      }
    }
    // The generic hunt lob is the definition of a low-value toss.
    if (out.belt && this.spendOk(id, BELT_THROW_COST, false, nuggetNear)) this.arsenal.throwBelt(p);
    this.arsenal.tryPropel(id, p, out, goal, sh, now);
    // Sentry-clearing lob: hostile gear watching the objective gets a
    // grenade on its own slow cadence — the same legal path humans use
    // to soften a stand, not a wallhack aim-assist.
    const saboteur = this.roster.roleInfo.get(id) === 'infiltrator';
    // A named siege task is the job the same way sabotage is the
    // infiltrator's role — the belt reserve can't starve it dry in a
    // vault where no nugget economy exists.
    const besieger = this.sense.taskGoalFor(id)?.kind === 'siege';
    const ready = (this.gearLobT.get(id) ?? 0) <= now;
    const gear = ready ? this.sense.hostileGear(p, goal?.pos ?? null, saboteur || besieger) : null;
    // Wrecking gear IS the infiltrator's job — high value for it,
    // opportunistic chip damage for everyone else.
    if (gear && this.spendOk(id, BELT_THROW_COST, saboteur || besieger, nuggetNear)) {
      // Sabotage lobs risk their own splash — a vault gen at 11m sits
      // inside the 13m envelope, so the clearance veto would refuse
      // the only shot the siege exists to take.
      this.arsenal.lobAt(p, gear, saboteur || besieger);
      // 3s keeps a siege going: ~1.5-2s grenade flight + reload beat.
      // At 8s a turret effectively outlived the lobber's attention.
      // A saboteur pushes harder — wrecking gear IS its objective.
      this.gearLobT.set(id, now + (saboteur || besieger ? 1800 : 3000));
      logger.debug('Gear lob', { id, x: +gear.x.toFixed(1), z: +gear.z.toFixed(1) });
    }
    // Stand siege: the bombardier's perch IS a shelling job — while it
    // holds the enemy stand in lob range it mortars/nades on cadence,
    // softening defense continuously instead of waiting for the call.
    // A called push temporarily makes EVERYONE near the stand join in.
    const push = ready || !gear ? this.sense.pushTarget(p.team) : null;
    const sieging = this.roster.roleInfo.get(id) === 'bombardier';
    // The shell lands on the flag pad — the perch goal is the bot's
    // own parking spot, not the target.
    const stand = p.team && this.room.flags
      ? this.room.flags.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha')?.pos ?? null
      : null;
    const shell = push ?? (sieging && stand && this.room.flags?.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha')?.state !== 'carried' ? stand : null);
    if (shell && !gear && Math.hypot(shell.x - p.position.x, shell.z - p.position.z) < 95
        && this.spendOk(id, BELT_THROW_COST, sieging, nuggetNear)) {
      this.arsenal.lobAt(p, shell);
      this.gearLobT.set(id, now + (push ? 2500 : 4000));
      logger.debug('Push lob', { id, x: +shell.x.toFixed(1), z: +shell.z.toFixed(1) });
    }
    // Deploy claims run the same handleDeploy a human's message does —
    // kind, plant distance, and per-player cap are all re-validated.
    if (out.deploy) this.room.deployables.handleDeploy(id, out.deploy.kind, out.deploy.pos);
    // Weld ticks ride the human repair path too — range, LOS, team and
    // the per-shooter rate cap all re-check server-side.
    if (out.repair) this.room.deployables.repair(id, +out.repair);
  }

  private driveMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number; pitch: number }; status: number; skiing: number; jetting: number; armorClass: string }, out: BrainOut, sh: MoveState, dt: number, now: number): void {
    driveMoveInto(this, id, p, { out, sh, dt, now });
  }

  private legacyMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; lastSeq: number; armorClass: string }, dest: Vec3, dt: number): boolean {
    return legacyMoveInto(this, id, p, dest, dt);
  }

  /** The meter the tick stream publishes — 0 for non-bots. */
  sheepOf(id: string): number {
    return this.sheep.of(id);
  }

  /** Test hook — the brain's current destination, for soak probes that
   *  need to see whether a bot's legs still point at its goal. */
  debugDest(id: string): { x: number; y: number; z: number } | null {
    return this.lastOut.get(id)?.dest ?? null;
  }

  /** Test hook — the utility ladder's committed goal (pre-pipeline),
   *  so a stray step dest can be blamed on goal-pull vs leg-drag. */
  debugGoal(id: string): { x: number; y: number; z: number } | null {
    return this.brains.get(id)?.goalS.goal ?? null;
  }

  /** Test hook — the brain's fight/flight surface in one line, so a
   *  parked bot's stall probe names which layer actually owns it. */
  debugBrain(id: string): string {
    const b = this.brains.get(id);
    if (!b) return '?';
    const hunt = b.h.hunt ? `${b.h.hunt.pos.x.toFixed(0)},${b.h.hunt.pos.z.toFixed(0)}` : '-';
    return `hunt=${hunt} hold=${b.holding} jet=${b.jetDebug.why}/${b.jetDebug.out ? 'on' : 'off'}`;
  }

  /** Test hook — how many push-calls each team posted this match. */
  debugPushCalls(team: string): number {
    return this.sense.pushCalls.get(team as 'alpha' | 'bravo') ?? 0;
  }

  /** Test hook — live command assignments for a team (wave probe). */
  debugTasks(team: string): { id: string; kind: string; goal: BotVec }[] {
    return this.sense.debugTasks(team);
  }

  /** Test hook — is a push call live for this team right now. */
  pushActive(team: string | undefined): boolean {
    return this.sense.pushTarget(team) !== null;
  }

  /** Test hook — seed the meter directly; accrual tests shouldn't need
   *  to park a bot for 30 simulated seconds to fill the meter. */
  debugSetSheep(id: string, v: number): void {
    this.sheep.set(id, v);
  }

  /** Test hook — the 5s coverage window, driven by explicit sim ms. */
  coverageDebit(id: string, p: { position: Vec3 }, hasDest: boolean, simMs: number): number {
    return this.sheep.coverageDebit(id, p, hasDest, simMs);
  }


  /** Support plating: an ArmorGrenade carrier lobs a nade at a teammate
   *  worth coating — flag carriers staging near the base get it first
   *  (a plated capper survives the run), then hurt allies in reach, and
   *  anyone pressing in. Technicians do it eagerly; other support kits
   *  toss one now and then — a guideline, not a reflex. */
  private supportNade(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; armorClass: string }, brain: BotBrain, now: number, nuggetNear: boolean): void {
    if (!p.team) return;
    const belt = this.loadouts.get(id)?.belt;
    if (belt !== WeaponType.ArmorGrenade) return;
    const tech = this.roster.roleInfo.get(id) === 'technician';
    if ((this.supportT.get(id) ?? 0) > now) return;
    // Plating is a nice-to-have, never worth the reserve — a real carrier
    // target still lobs freely, speculative coats wait for income.
    if (!this.spendOk(id, BELT_THROW_COST, tech, nuggetNear)) return;
    // Scoring: carrier > hurt > nearby — the blast radius coats the
    // cluster around the throw point too, so one nade plates a group.
    let best: { pos: Vec3; vel: Vec3; score: number } | null = null;
    for (const [aid, a] of this.room.players.getAllPlayers()) {
      if (aid === id || a.team !== p.team || a.isDead) continue;
      const d = Math.hypot(a.position.x - p.position.x, a.position.z - p.position.z);
      if (d > 45) continue;
      const carrying = this.room.flagCarriedBy(aid);
      const hurt = a.health < a.maxHealth * 0.8;
      const score = (carrying ? 60 : 0) + (hurt ? 30 : 0) + (45 - d);
      if (score >= 25 && (!best || score > best.score)) best = { pos: a.position, vel: a.velocity, score };
    }
    // No target worth plating → keep the fuse. Duty-scaled chance keeps
    // it a lean: a slack tech forgets to plate, a keen one rarely does.
    if (!best || (!tech && botRand() > 0.45 * brain.dutyLevel)) return;
    this.supportT.set(id, now + 5000 + botRand() * 3000);
    // Lead the lob a touch — the ally is usually running through.
    const aim = { x: best.pos.x + best.vel.x * 0.4, y: best.pos.y, z: best.pos.z + best.vel.z * 0.4 };
    this.arsenal.lobAt(p, aim);
  }

  private supportT = new Map<string, number>();
  private healBeamT = new Map<string, number>();
  private healNadeT = new Map<string, number>();

  /** Medic work, keyed off what the bot CARRIES not its role tag: any
   *  kit holding the beam zaps hurt allies in reach, a HealGrenade belt
   *  lobs at a hurt cluster — the dedicated 'medic' does both eagerly,
   *  hybrids only when duty says so and the tank has a reserve. The
   *  beam's ammo IS jet energy, so pocket-healing spends mobility. */
  private healAlly(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; armorClass: string }, brain: BotBrain, now: number): void {
    if (!p.team) return;
    const lo = this.loadouts.get(id);
    if (!lo) return;
    const hasBeam = lo.near === WeaponType.HealBeam || lo.side === WeaponType.HealBeam || lo.mid === WeaponType.HealBeam || lo.far === WeaponType.HealBeam;
    const hasNade = lo.belt === WeaponType.HealGrenade;
    if (!hasBeam && !hasNade) return;
    const medic = this.roster.roleInfo.get(id) === 'medic';
    if (!medic && botRand() > 0.45 * brain.dutyLevel) return;
    const energy = this.room.moveSim.energyOf(id);
    // Keep a mobility reserve — a medic that drains dry on allies can't
    // jet out of the counter-push. Dedicated medics push the tank lower.
    const floor = medic ? HEALBEAM_ENERGY * 2 : HEALBEAM_ENERGY * 5;
    if (energy !== null && energy < floor) return;
    let best: { id: string; a: { position: Vec3; velocity: Vec3; health: number; maxHealth: number }; score: number } | null = null;
    let hurtCount = 0;
    for (const [aid, a] of this.room.players.getAllPlayers()) {
      if (aid === id || a.team !== p.team || a.isDead || a.health >= a.maxHealth * 0.85) continue;
      const d = Math.hypot(a.position.x - p.position.x, a.position.y - p.position.y, a.position.z - p.position.z);
      if (d > HEALBEAM_RANGE * 1.4) continue;
      hurtCount++;
      const carrying = this.room.flagCarriedBy(aid);
      const missing = a.maxHealth - a.health;
      const score = missing + (carrying ? 40 : 0) - d;
      if (!best || score > best.score) best = { id: aid, a, score };
    }
    if (best && hasBeam && (this.healBeamT.get(id) ?? 0) <= now) {
      this.healBeamT.set(id, now + 110); // ~0.1s tick — matches WEAPON_FIRE_INTERVAL_S[HealBeam]
      this.room.messages.botAttack(id, best.id, WeaponType.HealBeam);
      // Beam visual for observers — a speedless bolt from muzzle to patient.
      const dx = best.a.position.x - p.position.x, dz = best.a.position.z - p.position.z;
      const dl = Math.hypot(dx, dz) || 1;
      this.room.messages.botFire(id, null,
        { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
        { x: (dx / dl) * 220, y: (best.a.position.y - p.position.y) / dl * 40, z: (dz / dl) * 220 },
        WeaponType.HealBeam, false);
    }
    // Burst for the pack: two+ hurt in the blast envelope, or one badly
    // hurt past beam reach — the nade covers what the latch can't.
    if (hasNade && (this.healNadeT.get(id) ?? 0) <= now) {
      const crowded = hurtCount >= 2;
      const far = best ? Math.hypot(best.a.position.x - p.position.x, best.a.position.z - p.position.z) > HEALBEAM_RANGE : false;
      if (best && (crowded || far || (medic && hurtCount >= 1))) {
        this.healNadeT.set(id, now + 6000 + botRand() * 3000);
        const aim = {
          x: best.a.position.x + best.a.velocity.x * 0.5,
          y: best.a.position.y,
          z: best.a.position.z + best.a.velocity.z * 0.5,
        };
        this.arsenal.lobAt(p, aim);
      }
    }
  }

  tick(dt: number): void {
    this.roster.maintain(simNow());
    this.arsenal.step(dt); // sim-clock — the weapon-rate gate is sim-paced
    this.sheep.step(dt); // sim-clock — the coverage window is sim-paced too
    this.meterHumans(dt);
    if (this.brains.size === 0) return;
    this.thinkPhaseNow = (this.thinkPhaseNow + 1) % ServerBots.THINK_DIV;
    const now = simNow();
    // 10s window roll (same pattern as the TickLoop phase rollup): the
    // cumulative prof counters diff into a per-second rate /metrics can
    // show — bot CPU on a live server was only measurable in soaks.
    if (now - this.stageWinAt >= 10_000) {
      for (let i = 0; i < 6; i++) this.stageMs[i] = (this.stageProf[i]! - this.stageBase[i]!) / 10;
      this.stageBase = [...this.stageProf];
      this.stageWinAt = now;
    }
    const tailT0 = performance.now();
    const tailS0 = this.stageProf[0]! + this.stageProf[1]! + this.stageProf[2]! + this.stageProf[3]! + this.stageProf[4]!;
    for (const [id, brain] of this.brains) {
      const p = this.room.players.getPlayer(id);
      if (!p) continue;
      if (p.isDead) {
        // First sighting of this corpse — the brain keeps the spot as a
        // death memory so its wander goals sour on kill zones.
        if (!this.deadSet.has(id)) brain.markDeath(p.position, now);
        this.deadSet.add(id);
        continue;
      }
      p.lastSeen = wallNow(); // wall domain — skipRecord/idle reaper
        // compare it against wallNow, so stamping simNow here makes a
        // frozen-clock harness read every bot as permanently silent.
        // or the idle reaper would cull them on schedule

      // Respawn moved the body — reseat the shadow or the sim keeps
      // integrating from the corpse spot and every tick diverges.
      // Liveness upkeep like the heartbeat: must run before the quiet
      // skip or a silenced bot that dies and respawns keeps a stale
      // deadSet entry + corpse-spot shadow forever.
      const wasDead = this.deadSet.has(id);
      if (!p.isDead && wasDead) {
        this.deadSet.delete(id);
        this.sheep.clear(id); // respawn is a fresh leash
        this.foeNear.delete(id);
        this.room.moveSim.resync(id, p.position, p.rotation.yaw, true);
        // Kit drift: the fresh body rerolls each open slot toward the
        // weapon its skill matrix favors.
        this.roster.adaptOnRespawn(id, (w) => aimSkillFor(brain.skill, w, 0));
      }

      // Test-silenced: heartbeat and shadow upkeep still run — only the
      // think/fire/move pipeline is skipped.
      if (this.quiet.has(id)) continue;

      // Think pipeline runs on the bot's slow cadence; between thinks the
      // previous decision is re-emitted so the move sim still gets inputs
      // every tick (a stale dest for 200ms beats idling the drive).
      // The phase advances once per TICK, not per bot — incrementing it
      // inside this loop canceled out whenever the roster size was a
      // multiple of THINK_DIV (bot count % 5 == 0 parked the counter,
      // freezing every off-phase brain: no think, no fire, posted bots
      // stood on the flag and never engaged).
      const phaseNow = this.thinkPhaseNow;
      let out = this.lastOut.get(id);
      if (phaseNow === (this.thinkPhase.get(id) ?? 0) || !out) {
        const prof = this.stageProf;
        let tm = performance.now();
        // One roster pass feeds the whole think — flagGoal/build each
        // re-scanned the player map per channel before sharing it.
        const parties = this.sense.partiesOf(p);
        const goal = this.sense.flagGoal(p, brain.dutyLevel, parties);
        prof[0]! += performance.now() - tm; tm = performance.now();
        const ctx = this.sense.build(id, p, goal, now, brain.skill, parties, brain.builder);
        prof[1]! += performance.now() - tm; tm = performance.now();
        // Income in reach — a nugget the bot could realistically touch
        // lowers the spend reserve (refill is basically planned).
        const pk = ctx.pickup;
        const nuggetNear = !!pk && Math.hypot(pk.x - p.position.x, pk.z - p.position.z) < 60;
        out = brain.think(dt * ServerBots.THINK_DIV, ctx);
        prof[2]! += performance.now() - tm; tm = performance.now();
        // Situation chatter edge — killFeed.say resolves the kind through
        // the taunt pools + throttle, so a fresh contact/bored edge reads
        // as a remark rather than spam.
        this.sense.reportSpots(p, brain.h.seenEnemies, now);
        if (out.say) this.room.messages.killFeed.say(id, out.say.kind, out.say.target);
        this.sense.markFoeNear(id, ctx, p.position, p.rotation.yaw, now);
        this.applyStatus(id, p, out, now);
        const sh0 = this.room.moveSim.simState(id);
        this.firePhase(id, p, out, { goal, now, sh: sh0, nuggetNear, ctx });
        prof[3]! += performance.now() - tm; tm = performance.now();
        this.supportNade(id, p, brain, now, nuggetNear);
        this.healAlly(id, p, brain, now);
        this.lastOut.set(id, out);
      }
      const tm2 = performance.now();
      const sh = this.room.moveSim.simState(id);
      if (sh) this.driveMove(id, p, out, sh, dt, now);
      else if (this.legacyMove(id, p, out.dest, dt)) continue;
      this.stageProf[4]! += performance.now() - tm2;

      // The stuck leash is 2.5-5s — sampling every 4 ticks keeps the
      // alarm honest without paying a map probe per bot per tick.
      if ((this.room.tickSeq & 3) === ((this.thinkPhase.get(id) ?? 0) & 3)) this.checkStuck(id, p, brain, now);

      p.lastValidPosition = { ...p.position };
      p.lastValidVelocity = { ...p.velocity };
      p.lastSeq++; // tick stream keys staleness off seq

      // Bots never send positions, so nothing else feeds their rewind
      // buffer — without samples, hit validation rewinds to the stale
      // spawn seed and legit shots at moving bots get rejected.
      // history.t is wall domain (receive-time) — simNow() would drift
      // the samples away from what rewinds compare against under warp.
      pushRewindSample(p, wallNow());
    }
    // The loop tail is the real number, not a guess: whole-loop wall
    // minus whatever the five stages already billed this tick.
    this.stageProf[5]! += (performance.now() - tailT0) - (this.stageProf[0]! + this.stageProf[1]! + this.stageProf[2]! + this.stageProf[3]! + this.stageProf[4]! - tailS0);
  }

  /** Humans get the same sheep meter as bots — the wire tick's `sheep`
   *  field carries it for the leaderboard, so a parked human reads as
   *  honestly as a parked bot. The synthesized BrainOut reports no
   *  intents: fire recency arrives via noteFire from the claim path,
   *  and a live human always counts as having a destination (coverage
   *  stall applies — standing around is the thing being measured). */
  private meterHumans(dt: number): void {
    const now = simNow();
    const players = this.room.players.getAllPlayers();
    for (const [id, p] of players) {
      if (p.isBot || p.isDead) continue;
      // A closed socket freezes the last position but the player is
      // gone — charging sheep to a corpse-of-a-session just spams
      // maxed warns through the grace window.
      if (wallNow() - p.lastSeen > 2000) continue; // lastSeen is wall domain
      const sh = this.room.moveSim.simState(id);
      const ground = Math.max(
        this.room.moveSim.structureTop(p.position.x, p.position.z),
        p.position.y - classCapsule(p.armorClass).eye - 2, // parked high = sleeping on deposit, not airborne
      );
      const foe = this.humanFoeNear(id, p, players);
      this.sheep.check(id, p, {
        out: { dest: p.position },
        airborne: sh ? !sh.onGround : Math.abs(p.velocity.y) > 2,
        hasDest: true,
        foe,
        dt,
        height: Math.max(0, p.position.y - classCapsule(p.armorClass).eye - ground),
      }, now);
    }
  }

  /** Brawl-range enemy in eye-line — same evidence the bot senses
   *  give the meter (bots count a foe only inside their ~113° view
   *  cone; a human backing into a duel they can't see isn't ignoring
   *  it either), so facing gets the same cone gate. */
  private humanFoeNear(id: string, p: { position: Vec3; rotation: { yaw: number }; team?: string }, players: Map<string, { position: Vec3; team?: string; isDead?: boolean }>): boolean {
    const fx = Math.sin(p.rotation.yaw), fz = Math.cos(p.rotation.yaw);
    for (const [qid, q] of players) {
      if (qid === id || q.isDead) continue;
      if (q.team && p.team && q.team === p.team) continue;
      const dx = q.position.x - p.position.x, dz = q.position.z - p.position.z;
      const d = Math.hypot(dx, q.position.y - p.position.y, dz);
      if (d >= BRAWL_RANGE) continue;
      const gd = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / gd < FOE_CONE_MIN_DOT) continue;
      return true;
    }
    return false;
  }

  /** Combat path reports a legit human fire claim — the ignore debit's
   *  3s recency window needs it or an engaged human reads as passive. */
  noteHumanFire(id: string): void {
    this.sheep.noteFire(id);
  }
}
