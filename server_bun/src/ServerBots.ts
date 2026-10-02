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
import { BotBrain, type BotVec, type BrainOut } from '../../shared/botBrain.ts';
import type { ChatterKind } from '../../shared/botTaunts.ts';
import { logger } from './logger.ts';
import { pushRewindSample } from './rewind.ts';
import { STATUS, CLIENT_STATUS_MASK } from '../../shared/status.ts';
import type { MoveState } from '../../shared/movement.ts';
import { type BotLoadout } from '../../shared/botLoadouts.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { BotWatchdog, type MobilitySample } from './botWatchdog.ts';
import { BotArsenal } from './botArsenal.ts';
import { BotSheepMeter } from './botSheep.ts';
import { ServerBotSenses } from './serverSenses.ts';
import { BotRoster } from './botRoster.ts';
import { driveMove as driveMoveInto, legacyMove as legacyMoveInto } from './botDrive.ts';

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
  /** inputMove ordering key — the shadow drops non-increasing seqs. */
  seq = 1; // public — botDrive commits inputs under this counter
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
  /** Mobility watchdog — stuck + sheep alarms live in botWatchdog.ts so
   *  this file stays about driving bots, not auditing them. */
  watchdog: BotWatchdog;
  /** What brains may see — serverSenses.ts builds the wire-legal ctx. */
  private sense: ServerBotSenses;

  constructor(room: Room, field: Heightfield | null) {
    this.room = room;
    this.field = field;
    this.watchdog = new BotWatchdog(room.name);
    this.sheep = new BotSheepMeter(room);
    this.arsenal = new BotArsenal(room, this.loadouts, (id) => this.lastHuntId(id), (id) => this.brains.get(id)?.skill);
    this.roster = new BotRoster(room, this.brains, this.loadouts, this.thinkPhase, (id) => this.untrack(id), ServerBots.THINK_DIV);
    this.sense = new ServerBotSenses(room, field, this.loadouts, this.roster.roleInfo, this.foeNear);
  }

  private roster: BotRoster;
  /** Brain cadence: senses+think+fire run every THINK_DIV tick per bot
   *  (phase-offset so the squad doesn't think in lockstep). 20Hz decisions
   *  cost O(bots × (players+creatures)) per tick; at 4Hz reaction is still
   *  faster than human perception while the move sim keeps integrating
   *  at full rate, so motion smoothness is unchanged. */
  private static readonly THINK_DIV = 5;
  private thinkPhase = new Map<string, number>();
  private lastOut = new Map<string, BrainOut>();
  /** Visible-enemy-present flag from the last think (epoch ms expiry). */
  readonly foeNear = new Map<string, number>();
  private thinkCounter = 0;
  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Roster owns the spawn/role/class bookkeeping. */
  populate(n: number): void {
    this.roster.populate(n);
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
    this.roster.forget(playerId);
    this.sheep.clear(playerId);
    this.arsenal.untrack(playerId);
    this.foeNear.delete(playerId);
    this.gearLobT.delete(playerId);
    this.deadSet.delete(playerId);
    this.quiet.delete(playerId);
    this.watchdog.remove(playerId);
    this.sense.forget(playerId);
    this.room.moveSim.untrack(playerId);
  }

  /** Scenario tests poke the objective pick directly. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }) {
    return this.sense.flagGoal(p);
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
    const carrying = this.room.flags?.snapshot().some(f => f.carrier === id) ?? false;
    this.watchdog.checkStuck(id, p.position, brain, carrying, now);
  }

  checkSheep(id: string, p: { position: Vec3 }, m: MobilitySample, now: number): void { // public — botDrive host hook
    this.watchdog.checkSheep(id, p.position, m, now);
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
  private firePhase(id: string, p: { id: string; position: Vec3; velocity: Vec3; armorClass: string; team?: string }, out: BrainOut, goal: { pos: BotVec } | null, now: number, sh: MoveState | null): void {
    if (out.fire) this.arsenal.fireAt(p, out.fire.targetId, out.fire.aim);
    if (out.belt) this.arsenal.throwBelt(p);
    this.arsenal.tryPropel(id, p, out, goal, sh, now);
    // Sentry-clearing lob: hostile gear watching the objective gets a
    // grenade on its own slow cadence — the same legal path humans use
    // to soften a stand, not a wallhack aim-assist.
    const saboteur = this.roster.roleInfo.get(id) === 'infiltrator';
    const ready = (this.gearLobT.get(id) ?? 0) <= now;
    const gear = ready ? this.sense.hostileGear(p, goal?.pos ?? null, saboteur) : null;
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
    // Weld ticks ride the human repair path too — range, LOS, team and
    // the per-shooter rate cap all re-check server-side.
    if (out.repair) this.room.deployables.repair(id, +out.repair);
  }

  private driveMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; status: number; skiing: number; armorClass: string }, out: BrainOut, sh: MoveState, dt: number, now: number): void {
    driveMoveInto(this, id, p, { out, sh, dt, now });
  }

  private legacyMove(id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; lastSeq: number; armorClass: string }, dest: Vec3, dt: number): boolean {
    return legacyMoveInto(this, id, p, dest, dt);
  }

  /** The meter the tick stream publishes — 0 for non-bots. */
  sheepOf(id: string): number {
    return this.sheep.of(id);
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


  tick(dt: number): void {
    this.roster.maintain(Date.now());
    this.arsenal.step(dt); // sim-clock — the weapon-rate gate is sim-paced
    this.sheep.step(dt); // sim-clock — the coverage window is sim-paced too
    this.meterHumans(dt);
    if (this.brains.size === 0) return;
    const now = Date.now();
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
        this.sheep.clear(id); // respawn is a fresh leash
        this.foeNear.delete(id);
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
        const goal = this.sense.flagGoal(p);
        const ctx = this.sense.build(id, p, goal, now, brain.skill);
        out = brain.think(dt * ServerBots.THINK_DIV, ctx);
        // Situation chatter edge — killFeed.say resolves the kind through
        // the taunt pools + throttle, so a fresh contact/bored edge reads
        // as a remark rather than spam.
        if (out.say) this.room.messages.killFeed.say(id, out.say.kind, out.say.target);
        this.sense.markFoeNear(id, ctx, p.position, p.rotation.yaw, now);
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

  /** Humans get the same sheep meter as bots — the wire tick's `sheep`
   *  field carries it for the leaderboard, so a parked human reads as
   *  honestly as a parked bot. The synthesized BrainOut reports no
   *  intents: fire recency arrives via noteFire from the claim path,
   *  and a live human always counts as having a destination (coverage
   *  stall applies — standing around is the thing being measured). */
  private meterHumans(dt: number): void {
    const now = Date.now();
    const players = this.room.players.getAllPlayers();
    for (const [id, p] of players) {
      if (p.isBot || p.isDead) continue;
      // A closed socket freezes the last position but the player is
      // gone — charging sheep to a corpse-of-a-session just spams
      // maxed warns through the grace window.
      if (now - p.lastSeen > 2000) continue;
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

  /** 45m brawl-range enemy in eye-line — same evidence the bot senses
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
      if (d >= 45) continue;
      const gd = Math.hypot(dx, dz) || 1;
      if ((dx * fx + dz * fz) / gd < -0.4) continue;
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
