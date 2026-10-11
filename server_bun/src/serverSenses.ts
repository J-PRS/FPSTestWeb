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
import { botRand } from '../../shared/botRand.ts';
import { SpotBoard } from './spotBoard.ts';
import { ServerParties } from './serverParties.ts';
import { sharedEnv } from '../../shared/env.ts';

export class ServerBotSenses {
  constructor(
    private readonly room: Room,
    private readonly field: Heightfield | null,
    private readonly loadouts: Map<string, BotLoadout>,
    private readonly roles: Map<string, BotRole>,
    /** Visible-enemy-present flags (epoch ms expiry) — markFoeNear writes,
     *  ServerBots reads for the sheep charge. */
    private readonly foeNear: Map<string, number>,
  ) {
    // Field initializers run before parameter properties land — the board
    // needs the room's roster, so it builds here not at declaration.
    this.spotBoard = new SpotBoard(this.room.players);
    this.parties = new ServerParties(this.room);
    this.routing = new BotRouting(this.room, this.field, this.parties, this.roles);
  }

  /** Squad routing memory — incumbent entries, failure graveyard, wait
   *  spots, push-calls, team commanders — lives in botRouting.ts so a
   *  retired bot's whole footprint prunes through one forget(). */
  readonly routing: BotRouting;
  /** ServerBots reads the per-team push-call counter directly. */
  get pushCalls(): Map<TeamId, number> { return this.routing.pushCalls; }

  /** Squad spotting board — the team's shared eyes (see spotBoard.ts). */
  private readonly spotBoard: SpotBoard;

  /** Shared per-tick roster + spatial domain index (see serverParties.ts). */
  private readonly parties: ServerParties;

  /** groundY memo — see the ctx closure for the cell scheme. */
  private readonly groundMemo = new Map<number, number>(); private groundEpoch = -1;

  /** A room event the squad may react to — delivered to each bot on its
   *  OWN think phase (phases are offset across the squad), so reactions
   *  scatter naturally; the taunt cooldown+dice thin out who speaks.
   *  Nothing dispatches "a crowd" — the chattiness is emergent. */
  private readonly notices = new RoomNoticer();
  /** Bot left the room — drop its notice receipt so the map can't grow
   *  one entry per retired bot for the room's life. */
  forget(id: string): void {
    this.notices.forget(id);
    this.routing.forget(id);
  }

  /** Room code reports an event worth a reaction (flag cap/grab/return/
   *  drop). Actor's own line is separate — the actor never gets a notice. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string, goal?: { x: number; y: number; z: number },
    goalSide?: 'same' | 'other'): void {
    this.notices.notice(kind, actorId, actorTeam, simNow(), goal, goalSide);
  }

  /** One pass producing every per-think roster view — the shared tick
   *  cache + spatial domain live in serverParties so each think scans
   *  bodies inside the legal sight domain, not the whole roster. */
  partiesOf(p: { id: string; team?: string; position: Vec3 }): ReturnType<ServerParties['of']> {
    return this.parties.of(p);
  }

  /** Hostile emplacement the bot can legally see — a turret/mine/drone
   *  owned by the other team, near the bot and near what it's after.
   *  The stand's kill-zone is knowledge the room advertises anyway. */
  hostileGear(p: { id: string; team?: string; position: Vec3 }, goal: BotVec | null, sabotage = false): Vec3 | null {
    if (!goal && !sabotage) {return null;}
    let best: Vec3 | null = null;
    // Lob from the edge of turret sight (42m) — a bot that must first
    // survive to 30m never gets the shot off.
    // bestD caps past the widest limit below (generator) — per-kind
    // limits do the rejecting, bestD just keeps the nearest winner.
    let bestD = 56;
    // items.values() directly — snapshot() built per-item clones + a
    // redundant owner lookup per call (per think). Read-only iteration
    // is deletion-safe on this Map (clearOwner relies on it).
    for (const d of this.room.deployables.items.values()) {
      if (d.kind === 'station') {continue;} // pads aren't a threat
      const owner = this.room.players.getPlayer(d.owner);
      if (p.team && owner?.team === p.team) {continue;}
      if (!p.team && d.owner === p.id) {continue;}
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      // The generator is a vault target — the lob must fly its doorway
      // from outside the face, so it earns a wider envelope than a
      // field turret you'd chip in passing.
      const limit = d.kind === 'generator' ? 55 : 40;
      // A saboteur wrecks whatever gear it can reach — goal proximity
      // only gates the objective-driven lobbers.
      const gd = goal ? Math.hypot(d.pos.x - goal.x, d.pos.z - goal.z) : 0;
      // A generator IS the base's objective — on fortress maps it sits
      // a full compound behind the flag stand, so the stand-near gate
      // alone would never admit it. Anything else must still shadow
      // what the bot is actually after.
      const nearGoal = d.kind === 'generator' ? gd < 160 : gd < 50;
      if (bd < limit && bd < bestD && (sabotage || nearGoal)) { bestD = bd; best = d.pos; }
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
   *  fastest cowardice tell there is. Creatures don't count — walking
   *  past wildlife isn't fear. Computed at think cadence; the flag
   *  decays in half a second so a bot that out-skis a duel isn't
   *  re-charged while it's gone. */
  markFoeNear(id: string, ctx: BrainCtx, pos: Vec3, yaw: number, now: number): void {
    for (const e of ctx.enemies) {
      if (e.id.startsWith('b:') || e.id.startsWith('c:')) {continue;}
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      const d = Math.hypot(dx, e.pos.y - pos.y, dz);
      // Brawl range, not spotting range — a foe it can't reach yet is a
      // marching target, not an ignored duel.
      // Reach-gated like pickFire: a foe past the drawn gun's reach
      // isn't being ignored — closing on it is the correct play, and
      // charging "cowardice" while it does so is the early-spawn spam
      // (spawn rings put enemies in the cone at 40-60m, out of most
      // weapons' honest reach).
      const reach = ctx.weaponRange?.(d) ?? BRAWL_RANGE;
      if (d < Math.min(BRAWL_RANGE, reach) && losClear(ctx, pos, e.pos)) {
        // Only counts when the bot is actually LOOKING at the foe —
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

  /** The named responder's task, whichever team owns him — spawn
   *  scoring reads this so a tasked member materializes toward his
   *  job instead of hiking 500m back through the kill zone. */
  taskGoalFor(id: string): CommandTask | undefined {
    return this.routing.taskGoalFor(id);
  }

  /** Test hook — live command task list for a team (soak wave probe). */
  debugTasks(team: string): { id: string; kind: string; goal: BotVec }[] {
    return this.routing.debugTasks(team);
  }

  /** The team's active push target for non-goal consumers (the stand
   *  bombardment volley in ServerBots reads it directly). */
  pushTarget(me: string | undefined): BotVec | null {
    return this.routing.pushTarget(me);
  }

  private pushFor(me: TeamId): BotVec | null {
    return this.routing.pushFor(me);
  }

  /** CTF objective for a bot — the evaluator lives in botRouting.ts
   *  beside the route/command memory it spends. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1, parties?: ReturnType<ServerParties['of']>): { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null {
    return this.routing.flagGoal(p, duty, parties);
  }

  /** The sensorium for one think tick — see file header for what's legal
   *  on each channel. */
  build(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number; kills?: number; deaths?: number }, goal: { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean; wave?: boolean; marshal?: boolean; posted?: number } | null, now: number, skill?: BotSkill, sharedParties?: ReturnType<ServerBotSenses['partiesOf']>, builder?: boolean): BrainCtx {
    // Competence-biased draw: the weapon pick and the aim error read
    // the same matrix, so a phenom both reaches for its gun and lands it.
    const bias = skill ? (t: number): number => aimSkillFor(skill, t, 0) : undefined;
    const parties = sharedParties ?? this.partiesOf(p);
    const bp = sharedEnv.thinkProf ? (k: string, t0: number): Map<string, number> => sharedEnv.thinkProf!.set(k, (sharedEnv.thinkProf!.get(k) ?? 0) + sharedEnv.wallPerf!() - t0) : null;
    const ctx: BrainCtx = Object.assign({}, {id: p.id,team: p.team,pos: p.position,vel: p.velocity,enemies: parties.enemies,objective: goal?.pos ?? null,infiltrating: goal?.infiltrating ?? false,running: goal?.running ?? false,runner: goal?.runner ?? false,wave: goal?.wave ?? false,marshal: goal?.marshal ?? false,pushLive: p.team === 'alpha' || p.team === 'bravo' ? this.pushFor(p.team) !== null : false,posted: goal?.posted ?? 0,pickup: bp ? ((): BotVec | undefined => { const t = sharedEnv.wallPerf!(); const v = this.pickupFor(p, parties.enemies) ?? undefined; bp('sense:pickup', t); return v; })() : (this.pickupFor(p, parties.enemies) ?? undefined),huntCreatures: this.room.mode === 'nuggets'
        || Object.values(this.room.creatureSim.pops).some((cap): boolean => cap > 0),groundY: (x, z): number => {
        const t0 = sharedEnv.thinkProf ? sharedEnv.wallPerf!() : 0;
        const ep = this.room.moveSim.structureEpoch;
        if (ep !== this.groundEpoch) { this.groundMemo.clear(); this.groundEpoch = ep; }
        const cx = Math.round(x / 4) + 2048, cz = Math.round(z / 4) + 2048;
        const k = cx >= 0 && cx < 4096 && cz >= 0 && cz < 4096 ? cx * 4096 + cz : -1;
        let y = k >= 0 ? this.groundMemo.get(k) : undefined;
        if (y === undefined) {
          // Sample at the cell center, not the queried point — the memo
          // must be a pure function of the cell or a sub-cell ulp drift
          // anywhere upstream freezes into a permanent height divergence.
          const qx = Math.round(x / 4) * 4, qz = Math.round(z / 4) * 4;
          y = Math.max(this.field ? hmHeight(this.field, qx, qz) : p.position.y,
            this.room.moveSim.structureTop(qx, qz));
          if (k >= 0) { if (this.groundMemo.size > 32_768) {this.groundMemo.clear();} this.groundMemo.set(k, y); }
        }
        if (sharedEnv.thinkProf) {sharedEnv.thinkProf.set('sense:groundY', (sharedEnv.thinkProf.get('sense:groundY') ?? 0) + sharedEnv.wallPerf!() - t0);}
        return y;
      },route: this.routing.routeOf(p),others: parties.others,allies: parties.allies,engageRange: this.loadouts.get(id)?.far === WeaponType.Mortar ? 95 : undefined,thief: this.routing.thiefOf(p.team ?? '')}, botWeaponHooks(
        (d): WeaponType => pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage) as WeaponType,
        this.loadouts.get(id) ?? BOT_LOADOUTS[0]!,
      ), (skill ? {
        aimSkill: (d: number, targetSpeed: number): number =>
          aimSkillFor(skill, pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias, skill?.courage), targetSpeed),
      } : {}), {solids: this.room.ballSim.colliders,solidIndex: this.room.ballSim.colliderIndex,energy: this.room.moveSim.energyOf(id) ?? undefined,moveSkill: skill?.movement,healthFrac: p.maxHealth > 0 ? p.health / p.maxHealth : 1,confidence: this.confidenceOf(p),threats: bp ? ((): Vec3[] => { const t = sharedEnv.wallPerf!(); const v = this.room.projectiles.incomingNear(p.position, 12); bp('sense:threats', t); return v; })() : this.room.projectiles.incomingNear(p.position, 12),sounds: bp ? ((): Vec3[] => { const t = sharedEnv.wallPerf!(); const v = this.room.noisesNear(p.position, 50); bp('sense:sounds', t); return v; })() : this.room.noisesNear(p.position, 50),imapQuietDir: (v: BotVec): { x: number; z: number; } =>
        this.room.influence.quietestDir(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),imapHottest: (v: BotVec): { x: number; z: number; v: number; } | null => this.room.influence.hottestNear(v, 'opportunity'),imapDanger: (v: BotVec): number =>
        this.room.influence.value(v, this.room.influence.dangerLayer(p.team ?? 'alpha')),notice: this.notices.for(id, p.team, now),repair: builder === false ? null : this.repairJob(p), now});
    // Squad spot-report: reports land via reportSpots() AFTER the bot's
    // think (they're its verified sightings); here it only reads what
    // the squad's eyes already banked — as legal as the thief beacon.
    ctx.spots = this.spotBoard.forTeam(p.team, now);
    return ctx;
  }

  /** Post-think: bank this bot's verified sightings for its squad —
   *  the scanVisible passers, not a second LOS sweep of its own. */
  reportSpots(p: { team?: string }, seen: BotEnemy[], now: number): void {
    this.spotBoard.update(p, seen, now);
  }

  /** The bot's nerve input, 0..1: how the match is going FOR it — team
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

  /** Which gem to chase: nearest within real reach, unless the bot is so
   *  hurt the contested walk is suicide. Enemies near the GEM camp the
   *  grab — a healthy bot accepts that trade, a wounded one doesn't. */
  private pickupFor(p: { id: string; team?: string; position: Vec3; health: number; maxHealth: number }, foes: BotEnemy[]): BotVec | null {
    const snaps = this.parties.tick().pickups;
    if (snaps.length === 0) {return null;}
    // Greedy like the capper's roam shell, not a wall: close gems always
    // pull, far ones only sometimes — acceptance odds fall with distance
    // so a nuggets map spreads the fleet over the field instead of every
    // brain locking the same nearest gem. Elsewhere it's opportunism.
    const nuggets = this.room.mode === 'nuggets';
    const worthIt = (d: number): boolean => nuggets
      ? d < 160 || botRand() < (d < 260 ? 0.6 : d < 320 ? 0.3 : 0.08)
      : d < 140;
    let best: BotVec | null = null, bestD = Infinity;
    for (const g of snaps) {
      const d = dist3(p.position, g.pos);
      if (d >= bestD || !worthIt(d)) {continue;}
      const hurt = p.maxHealth > 0 && p.health / p.maxHealth < 0.4;
      if (hurt) {
        let camped = false;
        for (const f of foes) {
          if (!f.alive) {continue;}
          if (Math.hypot(f.pos.x - g.pos.x, f.pos.z - g.pos.z) < 35) { camped = true; break; }
        }
        if (camped && d > 12) {continue;} // close enough to sneeze on it anyway
      }
      bestD = d; best = g.pos;
    }
    return best;
  }

}
