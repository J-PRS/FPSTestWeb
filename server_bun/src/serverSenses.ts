/**
 * ServerBotSenses - the brain's sensorium for a server-driven bot.
 * Every channel a legal client could read from the wire: positions,
 * pickups, inbound shells, noises, wall occlusion, the move shadow's
 * honest energy tank. Split out of ServerBots so that file stays about
 * driving bodies; this one only builds what the brain is allowed to see.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { losClear, BRAWL_RANGE, FOE_CONE_MIN_DOT, type BotEnemy, type BotVec, type BrainCtx } from '../../shared/botBrain.ts';

import { RoomNoticer } from '../../shared/roomNoticer.ts';
import type { ChatterKind } from '../../shared/botTaunts.ts';
import { botWeaponHooks } from '../../shared/botWeaponHooks.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';

import { dist3 } from '../../shared/botVec.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { BotRole } from '../../shared/flagGoals.ts';
import type { CommandTask } from './botCommand.ts';
import { BotRouting } from './botRouting.ts';
import { DEPLOY_HP } from '../../shared/deployables.ts';


import type { TeamId } from '../../shared/teams.ts';
import { simNow } from './simClock.ts';
import { SpotBoard } from './spotBoard.ts';
import { ServerParties } from './serverParties.ts';
import { sharedEnv } from '../../shared/env.ts';

export class ServerBotSenses {
  constructor(
    private readonly room: Room,
    private readonly field: Heightfield | null,
    private readonly loadouts: Map<string, BotLoadout>,
    private readonly roles: Map<string, BotRole>,
    /** Visible-enemy-present flags (epoch ms expiry) - markFoeNear writes,
     *  ServerBots reads for the sheep charge. */
    private readonly foeNear: Map<string, number>,
  ) {
    // Field initializers run before parameter properties land - the board
    // needs the room's roster, so it builds here not at declaration.
    this.spotBoard = new SpotBoard(this.room.players);
    this.parties = new ServerParties(this.room);
    this.routing = new BotRouting(this.room, this.field, this.parties, this.roles);
  }

  /** Squad routing memory - incumbent entries, failure graveyard, wait
   *  spots, push-calls, team commanders - lives in botRouting.ts so a
   *  retired bot's whole footprint prunes through one forget(). */
  readonly routing: BotRouting;
  /** ServerBots reads the per-team push-call counter directly. */
  get pushCalls(): Map<TeamId, number> { return this.routing.pushCalls; }

  /** Squad spotting board - the team's shared eyes (see spotBoard.ts). */
  private readonly spotBoard: SpotBoard;

  /** Shared per-tick roster + spatial domain index (see serverParties.ts). */
  private readonly parties: ServerParties;

  /** groundY memo - see the ctx closure for the cell scheme. */
  private readonly groundMemo = new Map<number, number>(); private groundEpoch = -1;

  /** A room event the squad may react to - delivered to each bot on its
   *  OWN think phase (phases are offset across the squad), so reactions
   *  scatter naturally; the taunt cooldown+dice thin out who speaks.
   *  Nothing dispatches "a crowd" - the chattiness is emergent. */
  private readonly notices = new RoomNoticer();
  /** Bot left the room - drop its notice receipt so the map can't grow
   *  one entry per retired bot for the room's life. */
  forget(id: string): void {
    this.notices.forget(id);
    this.routing.forget(id);
  }

  /** Room code reports an event worth a reaction (flag cap/grab/return/
   *  drop). Actor's own line is separate - the actor never gets a notice. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string, goal?: { x: number; y: number; z: number },
    goalSide?: 'same' | 'other'): void {
    this.notices.notice(kind, actorId, actorTeam, simNow(), goal, goalSide);
  }

  /** One pass producing every per-think roster view - the shared tick
   *  cache + spatial domain live in serverParties so each think scans
   *  bodies inside the legal sight domain, not the whole roster. */
  partiesOf(p: { id: string; team?: string; position: Vec3 }): ReturnType<ServerParties['of']> {
    return this.parties.of(p);
  }

  /** Hostile emplacement the bot can legally see - a turret/mine/drone
   *  owned by the other team, near the bot and near what it's after.
   *  The stand's kill-zone is knowledge the room advertises anyway. */
  // oxlint-disable-next-line complexity -- the gear-scoring ladder; each rung is a measured threat tier
  hostileGear(p: { id: string; team?: string; position: Vec3 }, goal: BotVec | null, sabotage = false): Vec3 | null {
    if (!goal && !sabotage) {return null;}
    let best: Vec3 | null = null;
    // Lob from the edge of turret sight (42m) - a bot that must first
    // survive to 30m never gets the shot off.
    // bestD caps past the widest limit below (generator) - per-kind
    // limits do the rejecting, bestD just keeps the nearest winner.
    let bestD = 56;
    // items.values() directly - snapshot() built per-item clones + a
    // redundant owner lookup per call (per think). Read-only iteration
    // is deletion-safe on this Map (clearOwner relies on it).
    for (const d of this.room.deployables.items.values()) {
      if (d.kind === 'station') {continue;} // pads aren't a threat
      const owner = this.room.players.getPlayer(d.owner);
      if (p.team && owner?.team === p.team) {continue;}
      if (!p.team && d.owner === p.id) {continue;}
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      // The generator is a vault target - the lob must fly its doorway
      // from outside the face, so it earns a wider envelope than a
      // field turret you'd chip in passing.
      const limit = d.kind === 'generator' ? 55 : 40;
      // A saboteur wrecks whatever gear it can reach - goal proximity
      // only gates the objective-driven lobbers.
      const gd = goal ? Math.hypot(d.pos.x - goal.x, d.pos.z - goal.z) : 0;
      // A generator IS the base's objective - on fortress maps it sits
      // a full compound behind the flag stand, so the stand-near gate
      // alone would never admit it. Anything else must still shadow
      // what the bot is actually after.
      const nearGoal = d.kind === 'generator' ? gd < 160 : gd < 50;
      if (bd < limit && bd < bestD && (sabotage || nearGoal)) { bestD = bd; best = d.pos; }
    }
    return best;
  }

  /** Friendly gear that needs a weld - nearest damaged item within the
   *  reach a builder would reasonably walk to. Deployables broadcast
   *  their state to every client, so a bot noticing a hurt turret is
   *  reading public info, same as a human watching the stand. */
  repairJob(p: { id: string; team?: string; position: Vec3 }): { key: string; pos: BotVec; frac: number } | null {
    let best: { key: string; pos: BotVec; frac: number } | null = null;
    let bestD = 45;
    for (const d of this.room.deployables.items.values()) {
      const cap = DEPLOY_HP[d.kind];
      if (d.hp >= cap) {continue;}
      if (d.owner !== p.id) {
        const owner = this.room.players.getPlayer(d.owner);
        if (!p.team || owner?.team !== p.team) {continue;}
      }
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      if (bd < bestD) { bestD = bd; best = { key: String(d.id), pos: d.pos, frac: d.hp / cap }; }
    }
    return best;
  }

  /** Ignoring-the-enemy evidence for the sheep meter: a live visible
   *  enemy PLAYER within 60m while the brain elects not to fire is the
   *  fastest cowardice tell there is. Creatures don't count - walking
   *  past wildlife isn't fear. Computed at think cadence; the flag
   *  decays in half a second so a bot that out-skis a duel isn't
   *  re-charged while it's gone. */
  markFoeNear(id: string, ctx: BrainCtx, pos: Vec3, yaw: number, now: number): void {
    for (const e of ctx.enemies) {
      if (e.id.startsWith('b:') || e.id.startsWith('c:')) {continue;}
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      const d = Math.hypot(dx, e.pos.y - pos.y, dz);
      // Brawl range, not spotting range - a foe it can't reach yet is a
      // marching target, not an ignored duel.
      // Reach-gated like pickFire: a foe past the drawn gun's reach
      // isn't being ignored - closing on it is the correct play, and
      // charging "cowardice" while it does so is the early-spawn spam
      // (spawn rings put enemies in the cone at 40-60m, out of most
      // weapons' honest reach).
      const reach = ctx.weaponRange?.(d) ?? BRAWL_RANGE;
      if (d < Math.min(BRAWL_RANGE, reach) && losClear(ctx, pos, e.pos)) {
        // Only counts when the bot is actually LOOKING at the foe -
        // an enemy outside the ~113° view cone is invisible to it, so
        // "ignoring" it is a false positive that maxes out honest bots.
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        const gd = Math.hypot(dx, dz) || 1;
        if ((dx * fx + dz * fz) / gd < FOE_CONE_MIN_DOT) {continue;}
        this.foeNear.set(id, now + 500);
        return;
      }
    }
    this.foeNear.set(id, 0);
  }

  /** The named responder's task, whichever team owns him - spawn
   *  scoring reads this so a tasked member materializes toward his
   *  job instead of hiking 500m back through the kill zone. */
  taskGoalFor(id: string): CommandTask | undefined {
    return this.routing.taskGoalFor(id);
  }

  /** Test hook - live command task list for a team (soak wave probe). */
  debugTasks(team: string): { id: string; kind: string; goal: BotVec }[] {
    return this.routing.debugTasks(team);
  }

  /** Both flags seated on their stands - the no-figit phase marker.
   *  True only in flag rooms; absent flags (other modes) read false so
   *  nobody's acquisition ever gets discounted there. */
  private flagsHome(): boolean {
    const {flags} = this.room;
    if (!flags) {return false;}
    const a = flags.flags.get('alpha'), b = flags.flags.get('bravo');
    return a?.state === 'home' && b?.state === 'home';
  }

  /** The team's active push target for non-goal consumers (the stand
   *  bombardment volley in ServerBots reads it directly). */
  pushTarget(me: string | undefined): BotVec | null {
    return this.routing.pushTarget(me);
  }

  private pushFor(me: TeamId): BotVec | null {
    return this.routing.pushFor(me);
  }

  /** Losing + late = throw everything at the vault. The ramp lives in
   *  the last 4 minutes of a timed match (unarmed/late-clock rooms
   *  read 0 - desperation is only meaningful against a deadline). */
  private desperateOf(p: { team?: string }): number {
    const spec = this.room.modeSpec;
    if (!spec?.teams || (p.team !== 'alpha' && p.team !== 'bravo')) {return 0;}
    const tl = this.room.matchClock?.timeLeftMs?.() ?? 0;
    if (tl <= 0 || tl > 240_000) {return 0;}
    const other = p.team === 'alpha' ? 'bravo' : 'alpha';
    const deficit = Math.max(0, (this.room.scores[other] - this.room.scores[p.team]) / Math.max(1, spec.winAt));
    return deficit * (1 - tl / 240_000) * 2;
  }

  /** Headhunt escort target: the richest friendly hoard worth guarding.
   *  A 20+ token carrier is a map-visible piñata - teammates drift to
   *  its escort the way a flag carrier gets one. Null when nobody on
   *  the team is rich enough to be worth the stand (or self is the vault). */
  private convoyOf(p: { id: string; team?: string }): BotVec | null {
    if (this.room.mode !== 'headhunt' || !p.team) {return null;}
    let best: { pos: Vec3; held: number } | null = null;
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.team !== p.team || q.isDead || q.heldTokens < 20) {continue;}
      if (!best || q.heldTokens > best.held) {best = { pos: q.position, held: q.heldTokens };}
    }
    return best ? Object.assign({}, best.pos) : null;
  }

  /** Corpse-watch: the nearest teammate carrying 15+ tokens at <50% hp
   *  inside 150m - a spill about to land. Vultures circle the body
   *  before it hits dirt; grabbing the drop before the enemy hunter
   *  does is the whole point of the escort. Headhunt-only, like convoy. */
  private spillWatchOf(p: { id: string; team?: string; position: Vec3 }): BotVec | null {
    if (this.room.mode !== 'headhunt' || !p.team) {return null;}
    let best: BotVec | null = null, bd = 150 * 150;
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.team !== p.team || q.isDead || q.heldTokens < 15) {continue;}
      if (q.maxHealth > 0 && q.health / q.maxHealth >= 0.5) {continue;}
      const dx = q.position.x - p.position.x, dz = q.position.z - p.position.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = Object.assign({}, q.position); }
    }
    return best;
  }

  /** CTF objective for a bot - the evaluator lives in botRouting.ts
   *  beside the route/command memory it spends. A pluggable mode module
   *  answers first: its objectiveFor owns the goal channel outright when
   *  the mode carries one (conquest's lattice, future mode objectives). */
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1, parties?: ReturnType<ServerParties['of']>): { pos: BotVec; flagPos?: BotVec | null; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number; kout?: boolean } | null {
    const modeGoal = this.room.modeModule?.objectiveFor?.(p);
    if (modeGoal) {return Object.assign({ infiltrating: false }, modeGoal);}
    return this.routing.flagGoal(p, duty, parties);
  }

  /** The sensorium for one think tick - see file header for what's legal
   *  on each channel. */
  // oxlint-disable-next-line complexity, max-params -- the ctx assembler; one field list, one call
  build(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number; kills?: number; deaths?: number; heldTokens?: number; skill?: string }, goal: { pos: BotVec; flagPos?: BotVec | null; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null, now: number, skill?: BotSkill, sharedParties?: ReturnType<ServerBotSenses['partiesOf']>, builder?: boolean): BrainCtx {
    // Competence-biased draw: the weapon pick and the aim error read
    // the same matrix, so a phenom both reaches for its gun and lands it.
    const bias = skill ? (t: number): number => aimSkillFor(skill, t, 0) : undefined;
    const parties = sharedParties ?? this.partiesOf(p);
    const bp = sharedEnv.thinkProf ? (k: string, t0: number): Map<string, number> => sharedEnv.thinkProf!.set(k, (sharedEnv.thinkProf!.get(k) ?? 0) + sharedEnv.wallPerf!() - t0) : null;
    const ctx: BrainCtx = Object.assign({}, {id: p.id,team: p.team,pos: p.position,vel: p.velocity,enemies: parties.enemies,objective: goal?.pos ?? null,flagPos: goal?.flagPos ?? null,infiltrating: goal?.infiltrating ?? false,running: goal?.running ?? false,runner: goal?.runner ?? false,wave: goal?.wave ?? false,marshal: goal?.marshal ?? false,pushLive: p.team === 'alpha' || p.team === 'bravo' ? this.pushFor(p.team) !== null : false,posted: goal?.posted ?? 0,...((): { pickup?: BotVec; pickupVal?: number } => { const t = sharedEnv.wallPerf?.() ?? 0; const pk = this.pickupFor(p, parties.enemies); if (bp) {bp('sense:pickup', t);} return pk ? { pickup: pk.pos, pickupVal: pk.val } : {}; })(),huntCreatures: this.room.mode === 'nuggets'
        || Object.values(this.room.creatureSim.pops).some((cap): boolean => cap > 0),groundY: (x: number, z: number): number => {
        const t0 = sharedEnv.thinkProf ? sharedEnv.wallPerf!() : 0;
        const ep = this.room.moveSim.structureEpoch;
        if (ep !== this.groundEpoch) { this.groundMemo.clear(); this.groundEpoch = ep; }
        const cx = Math.round(x / 4) + 2048, cz = Math.round(z / 4) + 2048;
        const k = cx >= 0 && cx < 4096 && cz >= 0 && cz < 4096 ? cx * 4096 + cz : -1;
        let y = k >= 0 ? this.groundMemo.get(k) : undefined;
        if (y === undefined) {
          // Sample at the cell center, not the queried point - the memo
          // must be a pure function of the cell or a sub-cell ulp drift
          // anywhere upstream freezes into a permanent height divergence.
          const qx = Math.round(x / 4) * 4, qz = Math.round(z / 4) * 4;
          y = Math.max(this.field ? hmHeight(this.field, qx, qz) : p.position.y,
            this.room.moveSim.structureTop(qx, qz));
          if (k >= 0) { if (this.groundMemo.size > 32_768) {this.groundMemo.clear();} this.groundMemo.set(k, y); }
        }
        if (sharedEnv.thinkProf) {sharedEnv.thinkProf.set('sense:groundY', (sharedEnv.thinkProf.get('sense:groundY') ?? 0) + sharedEnv.wallPerf!() - t0);}
        return y;
      },route: this.routing.routeOf(p),others: parties.others,allies: parties.allies,engageRange: ((): number | undefined => { const far = this.loadouts.get(id)?.far; return far === WeaponType.Mortar || far === WeaponType.MRVLauncher ? 95 : undefined; })(),thief: this.routing.thiefOf(p.team ?? ''),flagsHome: this.flagsHome()}, botWeaponHooks(
        (d): WeaponType => pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage) as WeaponType,
        this.loadouts.get(id) ?? BOT_LOADOUTS[0]!,
      ), (skill ? {
        aimSkill: (d: number, targetSpeed: number): number =>
          aimSkillFor(skill, pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage), targetSpeed),
      } : {}), {solids: this.room.ballSim.colliders,solidIndex: this.room.ballSim.colliderIndex,energy: this.room.moveSim.energyOf(id) ?? undefined,moveSkill: skill?.movement,thrift: skill?.thrift,healthFrac: p.maxHealth > 0 ? p.health / p.maxHealth : 1,skill: p.skill,beltItem: this.loadouts.get(id)?.belt,held: this.room.mode === 'headhunt' ? p.heldTokens : undefined,convoy: this.convoyOf(p),spillSoon: this.spillWatchOf(p),desperate: this.desperateOf(p),capSync: this.routing.capSyncFor(p),confidence: this.confidenceOf(p),hero: this.heroOf(p),threats: bp ? ((): Vec3[] => { const t = sharedEnv.wallPerf!(); const v = this.room.projectiles.incomingNear(p.position, 12); bp('sense:threats', t); return v; })() : this.room.projectiles.incomingNear(p.position, 12),sounds: bp ? ((): Vec3[] => { const t = sharedEnv.wallPerf!(); const v = this.room.noisesNear(p.position, 50); bp('sense:sounds', t); return v; })() : this.room.noisesNear(p.position, 50),imapQuietDir: (v: BotVec): { x: number; z: number; } =>
        this.room.influence.quietestDir(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),imapHottest: (v: BotVec): { x: number; z: number; v: number; } | null => this.room.influence.hottestNear(v, 'opportunity'),imapDanger: (v: BotVec): number =>
        this.room.influence.value(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),notice: this.notices.for(id, p.team, now),repair: builder === false ? null : this.repairJob(p), now});
    // Squad spot-report: reports land via reportSpots() AFTER the bot's
    // think (they're its verified sightings); here it only reads what
    // the squad's eyes already banked - as legal as the thief beacon.
    ctx.spots = this.spotBoard.forTeam(p.team, now);
    return ctx;
  }

  /** Post-think: bank this bot's verified sightings for its squad -
   *  the scanVisible passers, not a second LOS sweep of its own. */
  reportSpots(p: { team?: string }, seen: BotEnemy[], now: number): void {
    this.spotBoard.update(p, seen, now);
  }

  /** The bot's nerve input, 0..1: how the match is going FOR it - team
   *  score margin normalized to the win target plus its own K/D trend.
   *  Team modes only; FFA has no allies to seek anyway so the goal
   *  picker's drift candidate can't fire there regardless. */
  private confidenceOf(p: { team?: string; kills?: number; deaths?: number }): number | undefined {
    const spec = this.room.modeSpec;
    if (!spec?.teams || (p.team !== 'alpha' && p.team !== 'bravo')) {return undefined;}
    const other = p.team === 'alpha' ? 'bravo' : 'alpha';
    const margin = (this.room.scores[p.team] - this.room.scores[other]) / Math.max(1, spec.winAt);
    const kd = Math.tanh(((p.kills ?? 0) - (p.deaths ?? 0)) / 4);
    return Math.min(1, Math.max(0, 0.5 + margin * 0.35 + kd * 0.25));
  }

  /** Hero-mode pressure feed: how badly this bot's side bleeds, how hot
   *  this bot personally runs, and whether a dominant enemy exists to
   *  pull on. heroTick turns it into resolve - the skill lerp lives in
   *  shared/botSkill. */
  private heroOf(p: { id: string; team?: string; kills?: number; deaths?: number; position: Vec3 }): { deficit: number; ownPerf: number; menace: number; menacePos?: BotVec; menaceHp?: number } | undefined {
    const spec = this.room.modeSpec;
    const teams = spec?.teams === true && (p.team === 'alpha' || p.team === 'bravo');
    const ownKd = Math.tanh(((p.kills ?? 0) - (p.deaths ?? 0)) / 4); // -1..1
    const ownPerf = Math.min(1, Math.max(0, 0.5 + ownKd));
    const isFoe = (fid: string, f: { team?: string }): boolean => fid !== p.id && (teams ? f.team !== p.team : true);
    const scan = this.menaceScan(isFoe);
    const {menace} = scan, menacePos = scan.pos;
    const topKills = Math.max(p.kills ?? 0, scan.topKills);
    // Deficit: teams read the scoreboard margin - but kill-scored modes
    // (headhunt) leave teamScores at 0, so the TEAM KILL gap is the
    // fallback deficit channel. FFA reads the gap to the kill leader.
    const scoreDeficit = teams
      ? (this.room.scores[p.team as 'alpha' | 'bravo'] - this.room.scores[p.team === 'alpha' ? 'bravo' : 'alpha']) / Math.max(1, spec!.winAt)
      : 0;
    const teamKillGap = teams ? (scan.foeTeamKills - scan.myTeamKills) / Math.max(4, spec!.winAt) : 0;
    const killGap = teams ? 0 : (topKills - (p.kills ?? 0)) / Math.max(4, spec?.winAt ?? 10);
    const deficit = Math.min(1, Math.max(0, Math.max(-scoreDeficit, teamKillGap, killGap) * 0.7 + Math.max(0, -ownKd) * 0.5));
    return { deficit, ownPerf, menace: Math.max(0, menace), menacePos, menaceHp: scan.hp };
  }

  /** Lobby scan behind heroOf: the strongest enemy K/D + pos, and the
   *  top kill count (the FFA leader mark the kill-gap measures). */
  private menaceScan(isFoe: (fid: string, f: { team?: string }) => boolean): { menace: number; pos?: BotVec; topKills: number; foeTeamKills: number; myTeamKills: number; hp?: number } {
    let menace = 0, pos: BotVec | undefined, topKills = 0, foeTeamKills = 0, myTeamKills = 0, hp: number | undefined;
    for (const [fid, f] of this.room.players.getAllPlayers()) {
      if (f.isDead) {continue;}
      if (!isFoe(fid, f)) {myTeamKills += f.kills ?? 0; continue;}
      foeTeamKills += f.kills ?? 0;
      topKills = Math.max(topKills, f.kills ?? 0);
      const m = Math.tanh(((f.kills ?? 0) - (f.deaths ?? 0)) / 4);
      if (m > menace) {menace = m; pos = f.position; hp = f.health ?? 0;}
    }
    return { menace, pos, topKills, foeTeamKills, myTeamKills, hp };
  }

  /** Which gem to chase: nearest within real reach, unless the bot is so
   *  hurt the contested walk is suicide. Enemies near the GEM camp the
   *  grab - a healthy bot accepts that trade, a wounded one doesn't. */

  private pickupFor(p: { id: string; team?: string; position: Vec3; health: number; maxHealth: number }, foes: BotEnemy[]): { pos: BotVec; val: number } | null {
    const snaps = this.parties.tick().pickups;
    if (snaps.length === 0) {return null;}
    // Nuggets bots KNOW the gem field out to the horizon - the senses
    // report it wide, and the goal picker's distance falloff decides
    // whether the walk is worth it (a 400m gem offers at ~0.2 weight;
    // anything within real reach still wins outright). Elsewhere it's
    // opportunism - a pickup scan isn't a job there.
    const nuggets = this.room.mode === 'nuggets' || this.room.mode === 'headhunt';
    const worthIt = (d: number): boolean => nuggets ? d < 500 : d < 140;
    let best: { pos: BotVec; val: number } | null = null, bestD = Infinity;
    for (const g of snaps) {
      const d = dist3(p.position, g.pos);
      if (!worthIt(d)) {continue;}
      const val = pileValueAt(snaps, g.pos);
      // A fat pile out-pulls a near white - value shrinks effective
      // distance up to 70%, so a purple spill draws the lobby while a
      // lone 1-coin stays opportunism. Non-token kinds carry val≈0-1
      // and price out unchanged.
      const effD = d * (1 - Math.min(val, 40) / 40 * 0.7);
      if (effD >= bestD) {continue;}
      const hurt = p.maxHealth > 0 && p.health / p.maxHealth < 0.4;
      if (hurt) {
        let camped = false;
        for (const f of foes) {
          if (!f.alive) {continue;}
          if (Math.hypot(f.pos.x - g.pos.x, f.pos.z - g.pos.z) < 35) { camped = true; break; }
        }
        if (camped && d > 12) {continue;} // close enough to sneeze on it anyway
      }
      bestD = effD; best = { pos: g.pos, val };
    }
    return best;
  }

}

/** Price the PILE, not the coin: a rich corpse decomposes into
 *  denominations (27+9+3+1) scattered at the spot, so two purples there
 *  out-pull one. Sum every pickup inside 15m of g. */
function pileValueAt(snaps: { pos: Vec3; val?: number }[], g: Vec3): number {
  let val = 0;
  for (const h of snaps) {
    if (Math.hypot(h.pos.x - g.x, h.pos.z - g.z) < 15) {val += h.val ?? 1;}
  }
  return val;
}
