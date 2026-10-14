/**
 * Room — one match's worth of state: players, sockets, rate limits,
 * message routing, and its own BallSim. GameServer holds a rooms map and
 * dispatches connections to them; today every player lands in "default",
 * but the seam is what turns matchmaking/lobbies/multi-match servers into
 * plumbing instead of surgery.
 *
 * Deliberately owns NO transport specifics beyond the broadcast/send
 * closures it hands to its children — a room is just "everyone who shares
 * this match state."
 */
import { PlayerManager } from './PlayerManager.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { MessageHandler, type RoomInfo } from './MessageHandler.ts';
import { BallSim } from './BallSim.ts';
import { CreatureSim } from './CreatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import { InfluenceMap } from './influenceMap.ts';
import { hmHeight, hmChord, HM_WORLD_SCALE, type Heightfield } from '../../shared/heightfield.ts';
import { beamSweepRay } from './beamSweep.ts';
import type { BeamContact } from './CombatHandler.ts';
import { NOISE_TTL_MS , type V4Last } from '../../shared/wire.ts';
import { RoomMoveSim } from './RoomMoveSim.ts';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES, pickTeam, makeScores, type ModeId, type ModeSpec, type TeamScores, type TeamId } from '../../shared/teams.ts';
import { ServerBots } from './ServerBots.ts';
import { RoomFlags } from './RoomFlags.ts';
import { FlagPlacer } from './roomFlagPlacer.ts';
import { RoomStructures } from './roomStructures.ts';
import { RoomPickups } from './RoomPickups.ts';
import { RoomArena } from './RoomArena.ts';
import { RoomDeployables } from './RoomDeployables.ts';
import { RoomProjectiles } from './RoomProjectiles.ts';
import type { PlayerState, Vec3, ClientMessage,WebSocketData } from './types.ts';
import { CLASS_STATS, classCapsule, type ArmorClass } from '../../shared/botClasses.ts';
import { inv, setInvariantSink } from '../../shared/invariants.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { WORLD_MODEL, verbPayload, eventPayload } from '../../shared/worldModel.ts';
import { botRand, tauntRand } from '../../shared/botRand.ts';
import { MatchClock, type MatchHost } from './roomMatch.ts';
import { EventBus } from './roomEvents.ts';
import { RoomScore } from './roomScore.ts';
import { ENERGY, type BodyCapsule } from '../../shared/movement.ts';
import { BELT_MAX } from '../../shared/weapons.ts';
import { chatKindFor, vgsCommandFor, radioAimFor } from '../../shared/botTaunts.ts';
import { perkMods } from '../../shared/perks.ts';
import { healPool } from './healPool.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { ServerWebSocket } from 'bun';

import { simNow } from './simClock.ts';
import { wallNow, wallMs, type WallMs } from './wallClock.ts';
import type { SessionRegistry } from './sessionRegistry.ts';

export class Room {
  readonly name: string;
  /** Unlisted rooms never appear in /rooms or quick-join picks — the
   *  only way in is knowing the name. Set once at creation. */
  unlisted = false;
  /** Creation-time sim gates (host toggles): strip the melee-species /
   *  ball populations at mint and on applySpec reloads. */
  noCreatures = false;
  noBalls = false;
  // First joiner's mode locks the match — later joins inherit it via
  // gameState rather than a per-client URL param.
  readonly mode: string;
  readonly players = new PlayerManager();
  readonly connections = new ConnectionManager();
  readonly rateLimiter = new RateLimiter();
  readonly messages: MessageHandler;
  readonly ballSim: BallSim;
  readonly creatureSim: CreatureSim;
  /** Host-side randomness (loot scatter) — tests inject a seeded fn.
   *  Defaults to the injectable botRand stream: construction-time
   *  consumers (bot populate → spawn scatter) run before a harness can
   *  assign `room.rng`, so a plain Math.random default made every room
   *  after the first diverge — spawn layout is part of the seed. */
  rng: () => number = (): number => botRand();

  /** Grace seats live on the registry session itself (timer included) —
   *  assigned post-ctor by the factory. `graceInRoom` replaces the old
   *  per-room disconnected map so the countdown can't outlive the
   *  session it belongs to. */
  sessions?: SessionRegistry;
  /** Watching sockets — no player record, get broadcasts + ticks. */
  readonly spectators = new Set<string>();
  /** Room-scoped u16 record ids for v3 tick frames — minted lazily on a
   *  player's first record (tickRecords); joiners get the snapshot inside
   *  gameState, everyone else via 'wireIds' deltas broadcast before the
   *  frames that need them. Ids are finite (u16), so a departing player
   *  releases theirs into wireIdRetired — after a quiet window the mint
   *  prefers recycled ids over burning toward the 65536 wrap, where
   *  setUint16 would silently alias a live teammate's binding. */
  readonly wireIds = new Map<string, number>();
  /** wireId → wall-ms it was released at. */
  readonly wireIdRetired = new Map<number, number>();
  /** wireId → v4 delta-compare basis (last-ENCODED values). Keyed by
   *  wireId, not by pooled-record slot: slot↔player binding shuffles on
   *  every join/leave/suppression, and a slot-carried basis would emit a
   *  mask computed against a different player's values. */
  readonly v4Last = new Map<number, V4Last>();
  nextWireId = 1;
  readonly sessionTokens = new Map<string, string>();
  readonly lastSentPositions = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; jet: number; status: number; sheep: number; t: number }>();
  tickSeq = 0;
  /** Last tickSeq a client seated/reclaimed — tickRecords forces full
   *  v4 records for a window after it so the new decode baseline lands
   *  every wireId's fields at once instead of each player's first
   *  staggered full up to 750ms out (join pop-in). */
  introSeq = -1_000_000;
  /** Wall-clock of the last accepted tickNack — room-wide cooldown above. */
  private lastNackAt = 0;

  /** Rolling health counters for the room heartbeat — every subsystem
   *  bumps tagged keys (shot claims, rejects, corrections, desyncs,
   *  implausible damage) and healthTick flushes them to one INFO line
   *  every ~15s so a soak log answers "did anything weird happen" at a
   *  glance instead of needing per-event archaeology. */
  readonly health = new Map<string, number>();
  /** Since-boot totals — the rollup window clears per flush, so /metrics
   *  reads this cumulative mirror instead of racing it. */
  readonly healthTotal = new Map<string, number>();
  /** Domain-event channel — combat/chat notifications (kill/hit/fire/
   *  botSpoke/chat) fan out to subscribers wired in the ctor. */
  readonly events = new EventBus();
  healthBump(key: string, n = 1): void {
    this.health.set(key, (this.health.get(key) ?? 0) + n);
  }
  private healthTimer = 0;
  private healthTick(dt: number): void {
    this.healthTimer += dt;
    if (this.healthTimer < 15) {return;}
    this.healthTimer = 0;
    if (this.health.size === 0) {return;}
    logger.debug('Room health', Object.assign({room: this.name,humans: this.players.getHumanCount()}, Object.fromEntries(this.health)));
    // Fold the window into since-boot totals. gapMax is a gauge (the
    // worst single sample), not a counter — merge by max, not sum.
    for (const [k, v] of this.health) {
      this.healthTotal.set(k, k === 'gapMax'
        ? Math.max(this.healthTotal.get(k) ?? 0, v)
        : (this.healthTotal.get(k) ?? 0) + v);
    }
    this.health.clear();
  }

  /** Buried-body failsafe: every sim path should pull a body back to the
   *  surface in one tick, but authored spawns, stale shadows and legacy
   *  writes have all leaked players under the field. Cheap sweep: feet
   *  below the terrain gets lifted to the surface and the shadow reseated
   *  so client and server agree. Counted in room health — if the number
   *  stays nonzero there's a real leak to hunt. */
  private unburyAcc = 0;
  private unburyLogN = 0;
  /** Leaderboard receipt minter — roomFactory wires one per room onto the
   *  event bus; roomMatch mints the signed token at matchEnd. Optional:
   *  unsigned dev rooms still get the record, just no signature. */
  resultSigner: import('./resultSigner.ts').ResultSigner | null = null;
  private unburyTick(dt: number): void {
    if (!this.field) {return;}
    this.unburyAcc += dt;
    if (this.unburyAcc < 0.5) {return;}
    this.unburyAcc = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.isDead || (!p.isBot && !p.hasReceivedPosition)) {continue;}
      // Measure with the shadow's own eye when one exists — the class
      // capsule and the sim body disagree whenever a refit left the sim
      // at the default eye, and the record's view was the stale one.
      const eye = this.moveSim.eyeOf(p.id) ?? classCapsule(p.armorClass as ArmorClass).eye;
      // Judge each body on the floor it sims on: bot shadows ride the
      // chord-augmented surface (what remotes draw), human shadows the
      // plain field — a field-grounded human in a gully is legitimately
      // under the drawn chord, and popping their claim is a phantom
      // correction. Remote-side render lift owns the visual clearance.
      const terrain = p.isBot
        ? Math.max(hmHeight(this.field, p.position.x, p.position.z), hmChord(this.field, p.position.x, p.position.z))
        : hmHeight(this.field, p.position.x, p.position.z);
      // The ground law as an invariant — scoped to sim-owned bodies.
      // A bot's record mirrors its shadow every tick (botDrive), so a
      // buried bot record IS a violation. Human records are claims —
      // a lagged claim under the surface is lag, not a bug.
      // pos.y IS the eye point — "feet" would double-subtract the eye and
      // phantom-bury every banded contact (a grounded heavy legally rides
      // its eye ~0.5 under the floor in the snap window). Buried means
      // the EYE itself is below the surface.
      if (p.isBot) {inv('bot-below-ground', !Number.isFinite(terrain) || p.position.y >= terrain - 0.5,
        { id: p.id, y: Number(p.position.y.toFixed(1)), eye, terrain: Number.isFinite(terrain) ? Number(terrain.toFixed(1)) : 'n/a', dbg: this.moveSim.unburyDebug(p.id) });}
      if (!Number.isFinite(terrain) || p.position.y >= terrain - 0.5) {continue;}
      // First rescues carry the autopsy at debug level — the 'unbury'
      // health counter and the bot-scoped inv above are the loud signal;
      // a warn per rescue reads as jank in soak asserts while routine
      // claim wobble is legitimately rescued.
      if (((this.unburyLogN += 1) - 1) < 30) {
        logger.debug(`unbury ${p.id}: pos.y=${p.position.y.toFixed(1)} feet=${(p.position.y - eye).toFixed(1)} terrain=${terrain.toFixed(1)} bot=${p.isBot} ${this.moveSim.unburyDebug(p.id)}`);
      }
      p.position.y = terrain + eye;
      p.velocity.y = Math.max(0, p.velocity.y);
      this.moveSim.resync(p.id, p.position, p.rotation.yaw);
      this.healthBump('unbury');
    }
  }

  spec: MapSpec; // mutable — admin hot-reload rewrites it live
  // Server-owned match scoreboard — only populated in team modes.
  readonly modeSpec: ModeSpec | null;
  readonly scores: TeamScores = makeScores();
  /** Server-driven filler players, populated from the map spec. */
  readonly bots: ServerBots;
  /** CTF flag authority — only when the mode has flags AND the map has bases. */
  flags: RoomFlags | null = null;
  // Flag/deploy placement domain — standTop surfaces, shelf rescue,
  // deploy floor, home re-snap — lives in roomFlagPlacer.ts. The
  // callbacks carry the two room-level effects a re-snap has (structure
  // collider re-attach + skinny mapUpdate push; spawn-anchor re-seat).
  // Declared before the ctor's wireModeFeatures/flags init uses it.
  readonly flagPlacer = new FlagPlacer(this,
    (broadcast): void => { this.structs.attach(); if (broadcast) {this.structs.pushUpdate();} },
    (snapped): void => {
      if (this.modeSpec?.teams) {
        this.players.teamBases = { alpha: Object.assign({}, snapped.alpha), bravo: Object.assign({}, snapped.bravo) };
      }
    },
    (rings): void => {
      // Auto-derived stands mint their own spawn rings — but authored
      // teamSpawns still win when a base-less spec bothered to ship them.
      if (this.modeSpec?.teams && !this.spec.teamSpawns) {
        this.players.teamSpawns = rings;
      }
    });
  /** Effective structure set (authored + dais hulls) and everywhere it
   *  feeds — colliders, join echo, skinny mapUpdate diff — lives in
   *  roomStructures.ts. Reads live state through this, so declare it
   *  after flagPlacer which the eff list consults. */
  readonly structs = new RoomStructures(this);

  /** Direct carrier check — snapshot() clones every flag just to answer
   *  "is id carrying", and per-tick callers (checkStuck, propel gate)
   *  paid it every bot every tick. */
  flagCarriedBy(playerId: string): boolean {
    if (!this.flags) {return false;}
    for (const f of this.flags.flags.values()) {if (f.carrier === playerId) {return true;}}
    return false;
  }
  /** Server-owned ground loot — gems/tags score in team modes, powerups
   *  (heal/armor/regen/dd) drop from creature kills in every mode. */
  pickups: RoomPickups | null = null;
  /** Server-owned deployables — turrets/mines/stations/drones a `deploy`
   *  claim plants; caps + TTL + teardown live here. */
  readonly deployables: RoomDeployables;
  /** Server-simulated projectiles — bot fire spawns real shells here
   *  instead of rolled hitscan (bots-as-legal-players phase 2). */
  readonly projectiles: RoomProjectiles;
  /** Server-side simulations ticked each room tick, in order. A sim
   *  with worldState() also emits its join/resync replay frames (roster
   *  snapshots), so sendWorldState iterates this registry instead of
   *  naming each sim. */
  readonly sims: { name?: string; tick(dt: number): void; worldState?(): ServerMessage[] }[] = [];

  /** Wall ms of the last room tick — TickLoop turns the gap into the dt
   *  every sim sees, so interval lag can't drift sim clocks off wall time. */
  lastStepAt = 0;

  /** Inbound client messages park here until the next tick drains them —
   *  the Quake/Valve command-buffer pattern: all input lands at phase 0
   *  so sims see a deterministic order (input → sim → fanout) instead of
   *  arrival-time mutations interleaving with bot/projectile ticks. */
  readonly commands: { playerId: string; msg: ClientMessage; at: WallMs }[] = [];
  drainCommands(): void {
    if (this.commands.length === 0) {return;}
    for (const c of this.commands) {
      // Contain per command: a throwing handler must not kill the rest
      // of the drain (and the tick that hosts it) — the client's binary
      // dispatch got the same treatment; one malformed input = one
      // counted drop, never a stalled queue.
      try { this.messages.handleMessage(c.playerId, c.msg, c.at); }
      catch (error) {
        this.messages.hb('handlerThrow');
        this.messages.hb(`handlerThrow.${c.msg.type}`);
        logger.warn('Handler threw — contained, counted', { room: this.name, playerId: c.playerId, type: c.msg.type, error });
      }
    }
    this.commands.length = 0;
  }
  /** Spatial memory — kills/fights/gems/flags leave decaying scent the
   *  brains read for where-the-action-was. See influenceMap.ts. Sized to
   *  the map's tile span; resized by applySpec when that changes. */
  readonly influence: InfluenceMap;
  /** Per-player movement shadow — MoveSim fed by inputMove, reconciled
   *  against reported positions. Judge mode: reported pos stays truth,
   *  divergence is the anti-cheat signal. Authority mode
   *  (FPS_MOVE_AUTHORITY): sim pos IS truth — GameServer's tick commits
   *  it into the player record and reports only carry aim/ping/liveness. */
  readonly moveSim: RoomMoveSim;
  readonly moveAuthority: boolean;
  /** Match-results journal hook — GameServer writes matches.jsonl and
   *  feeds /matches from it. Fired on every win condition. */
  onMatchEnd?: (record: { room: string; mode: string; winner: string; scores: Record<string, number>; players: { id: string; team?: string; kills: number; deaths: number }[]; token?: import('../../shared/resultToken.ts').ResultToken }) => void;
  /** Map-rotation hook — GameServer returns the next same-mode spec at
   *  the horn, or null to replay the current map. */
  onRotate?: () => MapSpec | null;
  /** Terrain swap — GameServer owns the field cache and attaches the
   *  loaded heightfield to ballSim/moveSim/projectiles. applySpec calls
   *  this when the new spec names a different terrain; without it the
   *  sims keep the OLD map's field while clients load the new one —
   *  balls bounce on ground that doesn't exist (the rubberband storm). */
  onTerrain?: (spec: MapSpec) => void;

  /** Push the player's armor-class body into its shadow — ground speed,
   *  jet mass, and eye height all ride the same class row so the shadow
   *  sim produces the trajectory the client's prediction computes. */
  private applyClassScale(playerId: string): void {
    const cls = this.players.getPlayer(playerId)?.armorClass as ArmorClass | undefined;
    const st = CLASS_STATS[cls ?? 'medium'];
    this.moveSim.setSpeedScale(playerId, st?.speedScale ?? 1);
    this.moveSim.setBody(playerId, st?.mass ?? 1, st?.eyeHeight ?? 1.8, st?.radius ?? classCapsule().radius);
  }

  /** Room's current heightfield — GameServer updates it on terrain
   *  attach/rotation so gameplay code can resolve ground height. */
  field: Heightfield | null = null;

  /** maps/<X>.json filename this room's spec came from — the scoreboard's
   *  map title when the spec has no authored `name`. Factory sets it at
   *  birth; mapCatalog's rotation + GameServer's reload keep it current. */
  mapSrc = '';

  constructor(name: string, field: Heightfield | null, mode = '', spec?: MapSpec, moveAuthority = false) {
    // Invariant violations land on the room health counters — /metrics
    // exposes them as inv:<name> totals next to the existing tallies.
    setInvariantSink((n, ctx): void => { this.healthBump(`inv:${n}`); logger.warn(`INVARIANT ${n}`, ctx ?? {}); });
    this.name = name;
    this.field = field;
    this.moveAuthority = moveAuthority && Boolean(field);
    this.spec = spec ?? resolveMapSpec(null);
    this.influence = new InfluenceMap(this.spec.tileSize);
    this.mode = mode || this.spec.mode || '';
    this.modeSpec = MODES[this.mode as ModeId] ?? null;
    this.messages = new MessageHandler(
      this.players,
      this.rateLimiter,
      (msg, exclude): void => this.connections.broadcast(msg, exclude),
      (pid, msg): void => this.connections.sendToPlayer(pid, msg),
      this.handlerInfo(name),
    );
    this.moveSim = new RoomMoveSim(field, this.moveAuthority);
    // Player-vs-player contact: every shadow resolves against the live
    // roster (corpses don't block), so a defender's body is real cover.
    this.moveSim.bodySource = (): ({ id: string; } & BodyCapsule)[] => {
      const out: ({ id: string } & BodyCapsule)[] = [];
      for (const p of this.players.getAllPlayers().values()) {
        if (p.isDead) {continue;}
        const st = CLASS_STATS[p.armorClass as ArmorClass];
        out.push({ id: p.id, x: p.position.x, y: p.position.y, z: p.position.z, h: st.eyeHeight, mass: st.mass, r: st.radius, vx: p.velocity.x, vz: p.velocity.z });
      }
      return out;
    };
    this.matchClock = new MatchClock(this.matchHost());
    // Hard-tolerance trip: the client's input watermark outran our consumed
    // seq for ≥3 reports — an input edge died in flight (dead-lane drop).
    // Ask it to re-emit its current input; cooldown lives on the shadow.
    this.moveSim.onInputGap = (pid, lastSeq): void => {
      this.health?.set('inputgap', (this.health?.get('inputgap') ?? 0) + 1);
      this.connections.sendToPlayer(pid, { type: 'inputSync', lastSeq });
    };
    // Reclaim desync accounting — journal wraps and reclaim gaps are the
    // only ways a reconnected client silently loses event history.
    this.connections.onJournalWrap = (n): void => this.healthBump('journalWrap', n);
    this.connections.onReclaimGap = (_pid, n): void => this.healthBump('reclaimGap', n);
    // A drowned socket is a client-side or path failure — count each
    // forced close so it shows in room health, not just the close log.
    this.connections.onDrowned = (): void => this.healthBump('drownedSock', 1);
    this.moveSim.attachStructures(this.structs.eff());
    // Shield soak burns the same tank the jet model owns — without this
    // a shielded player under fire runs the sim tank ahead of the real one.
    this.players.energyBurn = (pid, n): boolean => this.moveSim.drainEnergy(pid, n);
    // Closure over this.field — a mid-match terrain swap must not leave
    // spawn anchors snapping to the old map.
    // Anchors lift to the drawn surface, not just the field — an authored
    // point under a chord bridge (gully apex) would otherwise respawn a
    // body whose wire pos sits under the mesh it renders on.
    this.players.groundAt = (x, z): number => (this.field ? Math.max(hmHeight(this.field, x, z), hmChord(this.field, x, z)) : 0);
    this.ballSim = new BallSim(
      this.players,
      (msg): void => this.connections.broadcast(msg),
      (data): void => this.connections.broadcastBinaryReliable(data),
    );
    if (this.noBalls) {this.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
    else if (this.spec.balls) {this.ballSim.population = this.spec.balls;}
    this.ballSim.onKilled = (by, pos, variant): void => this.scoring.nonPlayerKill(by, pos, variant);
    this.ballSim.colliders = structureColliders(this.structs.eff());
    if (this.spec.ballMix) {this.ballSim.ballMix = this.spec.ballMix;}
    if (this.spec.spawns) {this.players.spawnPoints = this.spec.spawns;}
    this.players.teamSpawns = this.spec.teamSpawns ?? null;
    this.players.spawnRng = (): number => this.rng();
    this.messages.setBallSim(this.ballSim);
    if (field) {this.ballSim.attachField(field);}
    this.creatureSim = this.initCreatures(field);
    this.bots = new ServerBots(this, field);
    // Event subscriptions — producers emit through RoomInfo.emit; each
    // consumer reads only the kinds it cares about. A spoken line is
    // itself an event worth a reply — the squad sees it on their own
    // think phases, so an answer lands a beat later like real chat.
    this.events.on((e): void => {
      switch (e.type) {
        case 'kill': { this.scoring.onKill(e.targetId, e.shooterId); break;
        }
        case 'hit': { this.bots.flinch(e.targetId, e.shooterId); this.scoring.onDamage(e.shooterId, e.targetId, e.damage); break;
        }
        case 'fire': {
          this.bots.noteHumanFire(e.playerId);
          const shooter = this.players.getPlayer(e.playerId);
          if (shooter) {shooter.lastFireSim = simNow();} // decloak-on-fire: senses unmask CLOAK for the reveal window
          break;
        }
        case 'botSpoke': {
          const team = this.players.getPlayer(e.id)?.team;
          // A bot who spoke a command chord issued a real call — teammates
          // get the pin just like a human's VGS. Everything else is a bark.
          const goal = e.vgs ? this.radioGoal(e.vgs, e.id, team) : undefined;
          this.bots.notice(goal ? 'ack' : 'reply', e.id, team, goal);
          break;
        }
        case 'chat': {
          const kind = chatKindFor(e.text)
            ?? (e.vgs ? vgsCommandFor(e.vgs) : null)
            ?? (this.bots.nameIn(e.text) ? 'mention' : null);
          const team = this.players.getPlayer(e.id)?.team;
          if (kind) {this.bots.notice(kind, e.id, team, e.vgs ? this.radioGoal(e.vgs, e.id, team) : undefined);}
          this.noteChatPace(e.id);
          break;
        }
        // Blast aftermath — each emit once carried a bespoke RoomInfo
        // hook; the bus fans it out instead. Claimed blasts punt only
        // flags ('flag'): a client-claimed origin is untrusted, so it
        // must not punt loose pickups — 'pickup' emits only come from
        // server-owned blast paths (shells, mines).
        case 'blast': { this.deployables.applyBlast(e.pos, e.damage, e.radius, e.shooterId, e.scales, e.weapon, e.splash); break;
        }
        case 'knock': {
          if (e.kind === 'prey') { this.ballSim.knock(e.pos, e.radius, e.force, e.pull); this.creatureSim.knock(e.pos, e.radius, e.force, e.pull); }
          else {(e.kind === 'pickup' ? this.pickups : this.flags)?.knock(e.pos, e.radius, e.force, e.pull);}
          break;
        }
        case 'preySplash': {
          this.ballSim.splashDamage(e.ownerId, e.pos, e.radius, e.maxDamage);
          this.creatureSim.splashDamage(e.ownerId, e.pos, e.radius, e.maxDamage);
          break;
        }
        case 'meleeSweep': {
          this.ballSim.meleeSweep(e.playerId, e.pos, e.dir);
          this.creatureSim.meleeSweep(e.playerId, e.pos, e.dir);
          break;
        }
        case 'armor': {
          this.ballSim.armorBlast(e.pos, e.radius, e.amount);
          this.creatureSim.armorBlast(e.pos, e.radius, e.amount);
          break;
        }
        case 'impulse': { this.moveSim.applyImpulse(e.playerId, e.dv); break;
        }
        case 'flagDrop': { this.flags?.dropIfCarrier(e.playerId); break;
        }
              default: { break; }
}
    });
    // Posted roles spawn at home — a defender materializing on a
    // front-line sphere 400m out spends the next minute hiking, which
    // reads as wandering on every post/flag metric. Runners keep pure
    // foe-clearance scoring so the forward spheres stay useful.
    this.players.spawnHomeBias = (id): 1.6 | undefined => {
      const role = this.bots?.roleOf(id);
      return role === 'hof' || role === 'ldefense' || role === 'defense' || role === 'technician' ? 1.6 : undefined;
    };
    // A tasked member materializes toward his JOB, not home — the wave
    // member who respawned at base re-ran the lethal transit and died
    // again (katabatic soak: wave d518m median, near1%, dead~850). The
    // pull is softer than the defenders' — foe clearance still scores,
    // so a spawn directly on the enemy blob loses on safety.
    this.players.spawnObjective = (id) => {
      const t = this.bots?.taskGoalFor(id);
      return t ? { pos: t.goal, w: 1.6 } : null;
    };
    // Bots populate before humans join so team balancing puts humans on
    // the emptier side.
    if (this.spec.bots) {this.bots.populate(this.spec.bots);}
    this.wireModeFeatures();
    this.deployables = new RoomDeployables(this);
    // Deployables are solid — the move shadows push bodies out of gear.
    this.moveSim.setDynamic(this.deployables.solidCols);
    if (this.spec.deploys) {
      // Ride structure floors: a generator seeded inside a genhouse must
      // stand on its deck (seated high over terrain), not drown in it.
      // max() keeps authored elevations — tower sentries never descend.
      this.deployables.seedBase(this.spec.deploys.map(e => Object.assign({}, e, {pos: Object.assign({}, e.pos, {y: Math.max(e.pos.y, this.flagPlacer.deployFloor(e.pos.x, e.pos.z, e.pos.y))})})));
    }
    this.projectiles = new RoomProjectiles(this, field);
    this.projectiles.attachStructures(this.structs.eff());
    this.registerSims();
  }

  /** Chat lines per speaker inside the spam window — a burst of fast
   *  typing is the trigger for a single 'quiet' callout. */
  private chatPace = new Map<string, number[]>();

  /** 4+ lines inside 8s reads as spam. The callout itself is rare (~12%)
   *  and goes to ONE random bot — VGQ works as a surprise, not a rule,
   *  and a squad chorus of "Quiet!" would spam the feed worse. */
  private noteChatPace(id: string): void {
    const now = simNow();
    const hits = (this.chatPace.get(id) ?? []).filter((t): boolean => now - t < 8000);
    hits.push(now);
    if (hits.length < 4) { this.chatPace.set(id, hits); return; }
    this.chatPace.delete(id); // burst spent — re-arm on the next run
    if (tauntRand() >= 0.12) {return;}
    const bots = [...this.players.getAllPlayers().values()].filter((p): boolean => p.id.startsWith('BOT-') && !p.isDead);
    if (bots.length > 0) {this.messages.killFeed.say(bots[Math.trunc((tauntRand() * bots.length))]!.id, 'quiet', id);}
  }

  /** A team VGS chord → the spot it orders bots toward. 'own'/'enemy'
   *  resolve through the flag table; 'carrier' is OUR flag's runner
   *  ("Chase the enemy flag carrier!" means the thief holding ours);
   *  'actor' is the caller's position. No stand/no flag → no pin. */
  private radioGoal(chord: string, actorId: string, actorTeam?: string): { x: number; y: number; z: number } | undefined {
    const aim = radioAimFor(chord);
    if (!aim) {return undefined;}
    if (aim === 'actor') {return this.players.getPlayer(actorId)?.position;}
    if (!this.flags || !actorTeam) {return undefined;}
    const ours = this.flags.flags.get(actorTeam as TeamId);
    const enemyTeam = actorTeam === 'alpha' ? 'bravo' : 'alpha';
    const theirs = this.flags.flags.get(enemyTeam);
    if (aim === 'own') {return ours?.home;}
    if (aim === 'enemy') {return theirs?.home;}
    // 'carrier' — the thief holding OUR flag; beacon info, pos is public
    return ours && ours.state === 'carried' ? ours.pos : undefined;
  }

  /** Server-authoritative melee species — the crawl* wire events are the
   *  state-edge stream (retarget/windup/pounce/bite/die); clients replay
   *  the seeded hop sim between them. */
  private initCreatures(field: Heightfield | null): CreatureSim {
    const creatureSim = new CreatureSim(
      this.players,
      (msg): void => this.connections.broadcast(msg),
      (pid, msg): void => this.connections.sendToPlayer(pid, msg),
    );
    creatureSim.pops = this.noCreatures ? {} : (this.spec.creatures ?? {});
    creatureSim.colliders = this.ballSim.colliders;
    creatureSim.onBite = (c, targetId): void => {
      // dep:N ids are deployables — gnaw their hp, not a player.
      if (targetId.startsWith('dep:')) {
        this.deployables.gnaw(targetId, c.biteDamage);
        return;
      }
      this.messages.crawlerBite(targetId, c.biteDamage, c.species, { x: c.x, y: c.y, z: c.z });
    };
    creatureSim.extraTargets = (): { id: string; pos: Vec3; }[] => this.deployables.creatureTargets();
    creatureSim.targetPos = (id): Vec3 | null => id.startsWith('dep:') ? this.deployables.posOf(id) : null;
    creatureSim.onDetonate = (b): void => {
      const pos = { x: b.x, y: b.y, z: b.z };
      this.messages.mineBlast('environment', pos, b.biteDamage, b.blastRadius, 14);
      this.pushNoise(pos); // bots hear the pop like any other blast
    };
    creatureSim.onKilled = (by, pos): void => this.scoring.nonPlayerKill(by, pos, 0);
    this.messages.setCreatureSim(creatureSim);
    if (field) {creatureSim.attachField(field);}
    return creatureSim;
  }

  // Team bases → spawn anchors, kill-confirmed pickups, CTF flags — the
  // per-mode feature set the spec + modeSpec select together.
  private wireModeFeatures(): void {
    const {bases} = this.spec;
    if (this.modeSpec?.teams && bases?.alpha && bases?.bravo) {
      // Spawn anchoring uses the SNAPPED stand positions — a defender
      // bias toward a floating/under-terrain authored base sends players
      // to where the flag was authored, not where it actually is.
      const snapped = this.flagPlacer.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
      this.players.teamBases = { alpha: Object.assign({}, snapped.alpha), bravo: Object.assign({}, snapped.bravo) };
    }
    this.pickups = new RoomPickups(this);
    this.pickups.onCollect = (pid, kind): void => {
      const p = this.players.getPlayer(pid);
      if (!p) {return;}
      if (kind === 'gem' || kind === 'tag') {
        // Gems also heal — server-declared now: the collect IS the intent,
        // so the heal applies here instead of waiting on a claim that a
        // drop could silently lose (credit stayed banked but unclaimed).
        if (kind === 'gem') {
          healPool(p, Math.min(25, Math.round(20 * perkMods(p.perk).healBoost)));
          p.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
          // Client refills half the energy tank on a gem — the shadow
          // must too or the next jet run diverges for honest reasons.
          this.moveSim.grantEnergy(pid, ENERGY.max * 0.5 * perkMods(p.perk).energyMax);
        }
        // Score pickups are the belt economy's income: one charge per
        // nugget, capped at the spawn stock. Gems bank only in a gems
        // mode — in CTF a gem is heal+credit, not a cap. Tags are tdm's
        // kill-confirmation point; they only ever spawn there.
        p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
        const {team} = p;
        if ((kind === 'tag' || this.modeSpec?.gems) && (team === 'alpha' || team === 'bravo')) {
          this.score(team);
          // Banker credit — without it nuggets/tdm leave the personal
          // PTS column blank and hauling objective pays zero honor.
          this.scoring.awardPersonal(pid, 1);
        }
        return;
      }
      this.scoring.applyPowerup(p, kind);
    };
    if (this.modeSpec?.flags) {
      if (this.mode === 'rabbit') {
        this.flags = new RoomFlags(this, { alpha: this.flagPlacer.rabbitFlagHome() });
      } else {
        // No authored bases — modes are map-agnostic: auto-place both
        // stands so any geometry can host a flag game.
        this.flags = new RoomFlags(this, bases?.alpha && bases?.bravo
          ? this.flagPlacer.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo })
          : this.flagPlacer.autoFlagBases());
      }
    }
    // What the wire currently carries — the join echo and every structure
    // push both emit eff(), so boot-time stands are the baseline
    // any later re-push compares against.
    this.structs.baseline();
  }

  /** Re-snaps flag homes against the LIVE heightfield — terrain attach
   *  and applySpec re-run it (bases can move with the map). */
  refreshFlagHomes(broadcastUpdate = true): void {
    this.flagPlacer.refreshHomes(broadcastUpdate);
  }

  /** Generator state flips which shield panes exist — colliders and the
   *  wire echo share this list, so one call re-syncs every client. */
  refreshPowerStructures(): void {
    this.structs.refreshPower();
  }

  // The tick registry — GameServer steps every entry per tick; new
  // server-side systems (deployables, generators) register here instead
  // of editing the tick loop.
  private registerSims(): void {
    // World sims step first — bots and downstream systems see post-step
    // wildlife positions inside the same tick.
    this.sims.push({ name: 'balls', tick: (dt): void => this.ballSim.step(dt), worldState: () => [{ type: 'ballRoster', balls: this.ballSim.roster() }] });
    this.sims.push({ name: 'crawl', tick: (dt): void => this.creatureSim.step(dt), worldState: () => [{ type: 'crawlRoster', crawlers: this.creatureSim.roster() }] });
    this.sims.push({ name: 'bots', tick: (dt): void => this.bots.tick(dt) });
    if (this.flags) {this.sims.push({ name: 'flags', tick: (dt): void => this.tickFlags(dt), worldState: () => [{ type: 'flagUpdate', flags: this.flags!.snapshot() }] });}
    if (this.pickups) {this.sims.push({ name: 'pickups', tick: (dt): void => this.pickups!.tick(dt), worldState: (): ServerMessage[] => this.pickups!.snapshot().map((p) => ({ type: 'pickupSpawn', id: p.id, pos: p.pos, kind: p.kind }) as ServerMessage) });}
    this.sims.push({ name: 'unbury', tick: (dt): void => this.unburyTick(dt) });
    if (this.spec.arena) {
      const arena = new RoomArena(this, this.spec.arena);
      this.sims.push({ name: 'arena', tick: (dt): void => arena.tick(dt) });
    }
    // Deployables join the worldState replay: only edges streamed before,
    // so a mid-game joiner saw a compound it never spawned — permanent
    // DEPLOY/flag/pickup hash desyncs until something happened to change.
    this.sims.push({ name: 'deploy', tick: (dt): void => this.deployables.tick(dt), worldState: (): ServerMessage[] => this.deployables.snapshot().map((d) => ({ type: 'deploySpawn', id: d.id, owner: d.owner, kind: d.kind, pos: d.pos, team: d.team }) as ServerMessage) });
    this.sims.push({ name: 'proj', tick: (dt): void => this.projectiles.tick(dt) });
    this.sims.push({ name: 'move', tick: (dt): void => this.moveSim.tick(dt) });
    this.sims.push({ name: 'health', tick: (dt): void => this.healthTick(dt) });
    // Server-side RTT probe: round-robin one human per cadence tick so
    // the move shadow's transit EMA has a channel the client can't
    // fabricate (it cross-checks the ping riding position frames).
    this.sims.push({ name: 'ping', tick: (): void => this.pingTick() });
    this.sims.push({ name: 'influence', tick: (dt): void => this.influence.tick(dt) });
    this.moveSim.health = this.health;
  }

  /** Server-issued ping: one human per cadence window, round-robin, so
   *  each player's transit EMA refreshes every ~500ms×roster. Bots are
   *  skipped — their shadow lives on this box, transit is zero. */
  private pingCycle = 0;
  /** Stamp of the ping each player last received — the pong must echo
   *  an actually-issued stamp or it could spoof an RTT (a client sending
   *  `pong{timestamp: now}` unprompted measures rtt≈0 — the lowball
   *  exploit through the trusted channel). */
  private lastPingStamp = new Map<string, number>();
  private pingTick(): void {
    if ((this.pingCycle += 1) % 10 !== 0) {return;}
    const humans = [...this.players.getAllPlayers().values()].filter((p): boolean => !p.isBot);
    if (humans.length === 0) {return;}
    // Unmeasured humans jump the queue — the client channel stands alone
    // until the first pong lands, and join grace shouldn't outlast a
    // full round-robin sweep in a big room.
    const target = humans.find((p): boolean => !this.lastPingStamp.has(p.id))
      ?? humans[(Math.trunc(this.pingCycle / 10)) % humans.length]!;
    const stamp = wallNow();
    this.lastPingStamp.set(target.id, stamp);
    this.sendToPlayer(target.id, { type: 'ping', timestamp: stamp });
  }

  /** Flag tick — called from GameServer's room tick. Captures feed the
   *  same bank→teamScore→matchEnd funnel nuggets use (worth winAt/5-ish:
   *  one capture = one score point). */
  tickFlags(dt: number): void {
    const scoredBy = this.flags?.tick(dt);
    if (scoredBy) {this.score(scoredBy);}
  }

  /** Beam-intent resolution: the honest ray a Lightning tick strikes —
   *  earliest of terrain face, wall, player capsule, or creature wins
   *  (same math as botBeam.beamContact). A creature contact also picks
   *  the chain fork; payment stays in CombatHandler. */
  private beamSweep(shooterId: string, muzzle: Vec3, dir: Vec3, range: number): BeamContact | null {
    // One cast for every authority shape — Room and P2PHost resolve the
    // same rays through shared beamSweep.ts.
    return beamSweepRay({
      players: this.players, field: this.field,
      solids: this.projectiles.solidColliders,
      dynSolids: this.deployables.solidCols,
      ballSim: this.ballSim, creatureSim: this.creatureSim,
      transitOf: (pid): number => this.moveSim.transitOf(pid),
    }, shooterId, muzzle, dir, range);
  }

  /** Any player death drops a carried flag — called from the damage
   *  funnel. In rabbit the same hook doubles as the flag's birth: the
   *  first corpse of the match is where the flag enters play. */
  flagCarrierDied(playerId: string): void {
    this.flags?.dropIfCarrier(playerId);
    this.flags?.spawnAtCorpse(playerId);
  }

  /** The score/kill economy — creature drops, powerup grants, team/FFA
   *  scoring, match-end awards. Own file (roomScore.ts) via ScoreHost. */
  readonly scoring = new RoomScore(this);
  /** Per-player FFA scoreboard — lives on RoomScore now; kept as the
   *  public name GameServer/tests already read. */
  get ffaScores(): Map<string, number> { return this.scoring.ffaScores; }

  /** Match lifecycle — clock/leader/reset funnel lives in roomMatch.ts;
   *  matchHost adapts Room's fields to the leaf interface it takes. */
  readonly matchClock: MatchClock;
  /** MessageHandler's room-facing surface — same lazy-callback pattern
   *  as matchHost: moveSim/matchClock/ballSim are built after `messages`,
   *  so every reference resolves at call time, not at construction. */
  private handlerInfo(roomName: string): RoomInfo {
    return {
      room: roomName,
      mode: this.mode,
      // This authority sims every outcome — no client claim is legitimate.
      claimsAccepted: false,
      scores: this.scores,
      teams: this.modeSpec?.teams,
      friendlyFire: CONFIG.friendlyFire,
      winAt: this.modeSpec?.winAt,
      ffaScores: (): { [k: string]: number; } => Object.fromEntries(this.scoring.ffaScores),
      // Registry stores playerId->u16; the wire roster ships the
      // inverse so receivers resolve a frame's u16 to an identity.
      wireIds: (): { [x: number]: string; } => {
        const out: Record<number, string> = {};
        for (const [pid, id] of this.wireIds) {out[id] = pid;}
        return out;
      },
      simsWorldState: (): ServerMessage[] => this.sims.flatMap((s): ServerMessage[] => s.worldState?.() ?? []),
      bases: this.spec.bases,
      structures: this.structs.eff(),
      arena: this.spec.arena,
      ambient: this.spec.ambient,
      // Authored spec title wins; the maps/<X>.json source filename is the
      // fallback — set post-ctor by the factory, refreshed by rotation.
      mapName: (): string | undefined => this.spec.name ?? (this.mapSrc || undefined),
      terrain: this.spec.terrain,
      heightScale: this.spec.heightScale,
      tileSize: this.spec.tileSize,
      fog: this.spec.fog,
      terrainTex: this.spec.terrainTex,
      terrainPreset: this.spec.terrainPreset,
      sky: this.spec.sky,
      interiors: this.spec.interiors,
      emit: this.events.emit,
      rng: (): number => this.rng(),
      flags: () => this.flags?.snapshot() ?? [],
      pickups: () => this.pickups?.snapshot() ?? [],
      // tickNack: reuse the introSeq full-window — every record goes full
      // for ~1s, which reseeds every client's baselines whether they
      // nacked or not (records are shared; scoping per-socket isn't
      // possible without per-socket encodes). 500ms room cooldown so a
      // nack-storm can't hold the room on fulls permanently.
      nackFulls: (): void => {
        const now = wallNow();
        if (now - this.lastNackAt < 500) {return;}
        // A window still paying out covers every client — re-stamping
        // would let a nack every 500ms hold the room on fulls forever.
        if (this.tickSeq - this.introSeq < 20) {return;}
        this.lastNackAt = now;
        this.introSeq = this.tickSeq;
      },
      fireProjectile: (pid, wt, origin, dir, vel, shotId): string | null => this.projectiles.spawn(pid, wt, origin, dir, vel, shotId),
      beamSweep: (pid, muzzle, dir, range): BeamContact | null => this.beamSweep(pid, muzzle, dir, range),
      ballHit: (pid, id, dmg) => this.ballSim.handleHit(pid, id, dmg),
      crawlerHit: (pid, id, dmg) => this.creatureSim.handleHit(pid, id, dmg),
      repairTarget: (pid, muz, dir, range): number | null => this.deployables.repairTarget(pid, muz, dir, range),
      onDeploy: (pid, kind, pos): string | true => this.deployables.handleDeploy(pid, kind, pos),
      onRepair: (pid, targetId): string | true => this.deployables.repair(pid, targetId),
      deployables: () => this.deployables.snapshot(),
      influence: this.influence,
      matchEndsAt: (): number => this.matchClock.timeLeftMs() > 0 ? simNow() + this.matchClock.timeLeftMs() : 0,
      moveInput: (pid, i, status, seq): boolean => this.moveSim.queueInput(pid, {
        forward: i.forward, right: i.right,
        jumpPressed: Boolean(i.jump), jumpHeld: Boolean(i.jump), skiHeld: Boolean(i.ski),
        jetHeld: Boolean(i.jet),
      }, status, seq),
      moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => this.moveSim.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
      inputSeqOf: (pid): number => this.moveSim.inputSeqOf(pid),
      transitOf: (pid): number => this.moveSim.transitOf(pid),
      transitNote: (pid, rtt, stamp): void => {
        if (this.lastPingStamp.get(pid) !== stamp) {return;}
        this.moveSim.feedTransit(pid, rtt);
        // Echo the server-measured RTT back — the client's own ping/pong
        // number includes its event-loop stall, so the pair reads as
        // "client/server" and splits a busy renderer from a slow wire.
        this.sendToPlayer(pid, { type: 'srvPing', rtt });
      },
      uplinkNote: (pid, fireAt): void => {
        // (arrival − declared instant) is this claim's uplink transit —
        // bounded so a wildly off clock (or forged stamp) degrades to the
        // ping/pong channel instead of poisoning the EMA.
        const uplink = wallNow() - fireAt;
        if (uplink >= 0 && uplink <= 2000) {this.moveSim.feedUplink(pid, uplink);}
      },
      // The rabbit dep's presence IS the mode check — CombatHandler gates
      // all PvP damage on the carrier being one side of the pair.
      rabbitCarrier: this.mode === 'rabbit' ? (): string | null => this.flags?.carrierId() ?? null : undefined,
      rabbitFlagLive: this.mode === 'rabbit' ? (): boolean => this.flags?.spawned() ?? false : undefined,
      rabbitBottom: this.mode === 'rabbit' ? (): Set<string> => this.scoring.bottomFeeders() : undefined,
      drainEnergy: (pid, n): boolean => this.moveSim.drainEnergy(pid, n),
      // Instant-skill claim: the client already spent the energy locally —
      // mirror the same ante on the shadow or the tank drifts 50 apart.
      onSkillUse: (pid): true | "gone" => this.moveSim.drainEnergy(pid, ENERGY.skillCost) ? true : 'gone',
      onThrowFlag: (pid): void | undefined => this.flags?.throwFor(pid),
      energyOf: (pid): number | null => this.moveSim.energyOf(pid),
      moveResync: (pid, pos, yaw, fullEnergy): void => {
        this.moveSim.resync(pid, pos, yaw, fullEnergy);
        // Resync re-anchors the shadow — also refresh the class speed
        // scale so a respawn-applied tier swap propagates (moveTrack
        // only re-reads it at handshake).
        this.applyClassScale(pid);
      },
      moveTrack: (pid, pos, yaw): void => {
        const p = this.players.getPlayer(pid);
        this.moveSim.track(pid, pos, yaw, p?.perk, p?.team, p?.isBot, p?.armorClass);
        // Re-seats (room hop) have stale position frames in flight — arm
        // the same grace resync() uses so they can't seed the fresh
        // shadow at the old seat and flag the real spawn landing a cheat.
        this.moveSim.markReseated(pid);
        this.applyClassScale(pid);
      },
      moveMute: (pid): void => this.moveSim.markReseated(pid),
      moveUntrack: (pid): void => {
        this.moveSim.untrack(pid);
        this.lastPingStamp.delete(pid);
      },
      // A spoken line is itself an event worth a reply — the squad sees
      // it on their own think phases, so an answer (if any) lands a beat
      // later like real chat, not a scripted call-and-response.

      moveAuthority: (): boolean => this.moveAuthority,
      health: this.health,
      envRange: (pid): number => {
        const p = this.players.getPlayer(pid);
        return p ? this.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z) : Infinity;
      },
      preyNear: (pos, shooterId): { ball: number; crawler: number; foe: number; } => {
        let crawler = Infinity;
        for (const c of this.creatureSim.crawlers.values()) {
          const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
          if (d < crawler) {crawler = d;}
        }
        // Nearest enemy body to the pop — a foe eating the shell at 5m
        // reads as a 'lip' in the autopsy otherwise, masking body
        // intercepts as terrain clips.
        const team = shooterId ? this.players.getPlayer(shooterId)?.team : undefined;
        let foe = Infinity;
        for (const q of this.players.getAllPlayers().values()) {
          if (q.id === shooterId || q.isDead || (team && q.team === team)) {continue;}
          const d = Math.hypot(q.position.x - pos.x, q.position.y - pos.y, q.position.z - pos.z);
          if (d < foe) {foe = d;}
        }
        return { ball: this.ballSim.nearestBallDist(pos.x, pos.y, pos.z), crawler, foe };
      },
    };
  }

  /** Built in the constructor — field-initializer order would read
   *  mode/modeSpec before they're assigned. */
  private matchHost(): MatchHost {
    return {
      room: this.name,
      mode: this.mode,
      modeSpec: this.modeSpec,
      scores: this.scores,
      ffaScores: this.scoring.ffaScores,
      getHumanCount: (): number => this.players.getHumanCount(),
      matchPlayers: (): { id: string; team?: string; kills: number; deaths: number; }[] => this.scoring.matchPlayers(),
      broadcast: (msg): void => this.broadcast(msg),
      resultSigner: this.resultSigner,
      mapSrc: this.mapSrc,
      endCleanup: (): void => {
        this.flags?.reset();
        this.pickups?.clear();
        this.deployables.clearAll();
        this.players.resetStats();
      },
      reshuffleBots: (): void => {
        const bots = [...this.players.getAllPlayers().values()].filter((p): boolean | undefined => p.isBot);
        if (bots.length < 2 || !this.modeSpec?.teams) {return;}
        // Fisher-Yates on botRand so harness replays stay deterministic,
        // then alternate alpha/bravo — sizes stay even, loyalties don't.
        for (let i = bots.length - 1; i > 0; i -= 1) {
          const j = Math.floor(botRand() * (i + 1));
          [bots[i], bots[j]] = [bots[j]!, bots[i]!];
        }
        bots.forEach((p, i): void => { p.team = i % 2 === 0 ? 'alpha' : 'bravo'; });
        for (const p of bots) {
          this.players.respawnPlayer(p.id);
          this.broadcast(eventPayload(WORLD_MODEL.player!, 'teamUpdate', 'playerId', p.id, { team: p.team! }) as ServerMessage);
        }
      },
      rotate: (): MapSpec | null => this.onRotate?.() ?? null,
      applySpec: (s): void => this.applySpec(s),
      onMatchEnd: (r): void | undefined => this.onMatchEnd?.(r),
      // 'match' isn't a bot id — nobody's actor-excluded, so every bot
      // sees the gg notice on its own think phase and the usual dice
      // decide who bothers replying. matchEnd adds the staggered
      // outcome lines on top — the shared chatter cooldown keeps the
      // two paths from double-speaking the same bot.
      onEnded: (w): void => { this.bots.notice('gg', 'match'); this.bots.matchEnd(w); },
      // The opener half of the beat — gl-hf as the round goes live.
      onStarted: (): void => this.bots.matchStart(),
    };
  }

  /** ms until the horn; 0 when the clock isn't armed. */
  matchTimeLeftMs(): number {
    return this.matchClock.timeLeftMs();
  }

  checkMatchClock(now: number): void {
    this.matchClock.tick(now);
  }

  /** Admin force-end: resolve with the current leader (or draw) and run
   *  the normal reset funnel. No-op in rooms without a mode. */
  forceEndMatch(): boolean {
    return this.matchClock.forceEnd();
  }

  endMatch(w: string): void { // public — ScoreHost calls it on a win
    this.matchClock.end(w);
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: TeamId, n = 1): void {
    this.scoring.score(team, n);
  }

  /** A Room-shaped send for host interfaces — RoomScore echoes buffs
   *  through the same path the ctor closures use. */
  sendToPlayer(playerId: string, msg: ServerMessage): void {
    this.connections.sendToPlayer(playerId, msg);
  }

  // Combat noise — a short-lived ring of recent loud events (shots,
  // blasts). Bots "hear" these without LOS, which produces emergent
  // scouting: a fight across the map attracts attention.
  private noises: { pos: Vec3; at: number }[] = [];
  private static NOISE_TTL = NOISE_TTL_MS; // old noise fades
  private static NOISE_MAX = 24;

  /** Every broadcast carrying a firing position is audible. */
  broadcast(msg: Parameters<ConnectionManager['broadcast']>[0], exclude?: string): void {
    const t = (msg as { type?: string }).type;
    if (t === 'projectileCreated' || t === 'playerShot') {
      // Hitscan relays carry `pos` (server-stamped), spawns carry `position`.
      const m = msg as { position?: Vec3; pos?: Vec3 };
      const pos = m.position ?? m.pos;
      if (pos) {this.pushNoise(pos);}
    }
    this.connections.broadcast(msg, exclude);
  }

  /** Blasts detonate server-side without a broadcast position — the sim
   *  reports them here so bots hear explosions as well as muzzle fire. */
  pushNoise(pos: Vec3): void {
    const now = simNow();
    while (this.noises.length > 0 && now - this.noises[0]!.at > Room.NOISE_TTL) {this.noises.shift();}
    this.noises.push({ pos: Object.assign({}, pos), at: now });
    if (this.noises.length > Room.NOISE_MAX) {this.noises.shift();}
    this.influence.splat(pos, 'opportunity', 0.4);
  }

  /** Recent noise positions within earshot of pos (no LOS required). */
  noisesNear(pos: Vec3, radius: number): Vec3[] {
    const now = simNow();
    const out: Vec3[] = [];
    for (const n of this.noises) {
      if (now - n.at > Room.NOISE_TTL) {continue;}
      const dx = n.pos.x - pos.x, dy = n.pos.y - pos.y, dz = n.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) {out.push(n.pos);}
    }
    return out;
  }

  playerCount(): number {
    return this.players.getPlayerCount();
  }

  socketOf(playerId: string): ServerWebSocket<WebSocketData> | undefined {
    return this.connections.getConnection(playerId);
  }

  /** Nothing left to serve: no humans, no grace-period ghosts. Bots don't
   *  keep a match alive — they exist to serve the humans in it. */
  get empty(): boolean {
    return this.players.getHumanCount() === 0 && (this.sessions?.graceInRoom(this.name) ?? 0) === 0
      && this.spectators.size === 0;
  }

  /** Balance pick: smallest team gets the newcomer. FFA modes return
   *  undefined. Split from assignTeam so GameServer can pass the pick to
   *  addPlayer — the join spawn itself is then already team-aware. */
  nextTeam(): TeamId | undefined {
    if (!this.modeSpec?.teams) {return undefined;}
    let alpha = 0, bravo = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.team === 'alpha') {alpha += 1;}
      else if (p.team === 'bravo') {bravo += 1;}
    }
    return pickTeam({ alpha, bravo });
  }

  /** Balance join for players added without a team (server bots populate
   *  this way). */
  assignTeam(player: PlayerState): void {
    player.team ??= this.nextTeam();
  }

  /** Admin hot-reload: swap in a re-read map spec without restarting the
   *  room. Mode stays locked (a mode change mid-match would invalidate
   *  scores/teams) — everything layout-side applies live: spawn points,
   *  structures, arena, ball mix/population, bot fill. Clients get a
   *  mapUpdate broadcast to rebuild their geometry. */
  applySpec(spec: MapSpec): void {
    const terrainChanged = spec.terrain !== this.spec.terrain || spec.heightScale !== this.spec.heightScale || spec.tileSize !== this.spec.tileSize;
    if (spec.tileSize !== this.spec.tileSize) {this.influence.resize(spec.tileSize ?? HM_WORLD_SCALE);}
    this.spec = spec;
    if (spec.spawns) {this.players.spawnPoints = spec.spawns;}
    this.players.teamSpawns = spec.teamSpawns ?? null;
    this.structs.attach(); // merged authored + stand hulls; refreshFlagHomes re-runs it post-snap
    // Bases can move with a new spec — re-snap homes (no update push: the
    // mapUpdate below carries the post-snap list). If the terrain is
    // also rotating the attach below corrects them once it lands.
    this.refreshFlagHomes(false);
    if (this.noBalls) {this.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
    else if (spec.balls) {this.ballSim.population = spec.balls;}
    if (spec.ballMix) {this.ballSim.ballMix = spec.ballMix;}
    this.creatureSim.pops = this.noCreatures ? {} : (spec.creatures ?? {});
    this.creatureSim.colliders = this.ballSim.colliders;
    // The echo carries the merged list too — joiners get stand hulls in
    // their gameState structures, and combat occlusion sees the dais.
    this.messages.setMap(Object.assign({}, spec, { structures: this.structs.eff() }));
    this.structs.baseline(); // the push below is what clients hold now
    this.broadcast({
      type: 'mapUpdate',
      mapName: spec.name ?? (this.mapSrc || undefined),
      bases: spec.bases,
      structures: this.structs.eff(),
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      terrain: spec.terrain,
      heightScale: spec.heightScale,
      tileSize: spec.tileSize,
      fog: spec.fog,
      terrainTex: spec.terrainTex,
      terrainPreset: spec.terrainPreset,
      sky: spec.sky,
      interiors: spec.interiors,
    });
    // Rotate the sims' heightfield WITH the broadcast — clients rebuild on
    // mapUpdate; a sim still running the old field disagrees about where
    // the ground is for the entire match.
    if (terrainChanged) {this.onTerrain?.(spec);}
    this.retuneBots(spec.bots ?? 0);
  }

  /** Top up / retire bots toward a spec's bot count (admin reload). */
  private retuneBots(want: number): void {
    if (this.bots.count < want) { this.bots.populate(want - this.bots.count); return; }
    if (this.bots.count <= want) {return;}
    let excess = this.bots.count - want;
    // Snapshot first — removePlayerCompletely mutates the map we're walking.
    // oxlint-disable-next-line no-useless-spread
    for (const p of [...this.players.getAllPlayers().values()]) {
      if (excess <= 0) {break;}
      if (!p.isBot) {continue;}
      this.removePlayerCompletely(p.id, 'adminReload', (): void => { return; });
excess -= 1;
    }
  }

  dispose(): void {
    this.ballSim.stop();
    this.creatureSim.stop();
    this.messages.dispose();
  }

  /** Full teardown — every store moves together or a slot/token leaks. */
  removePlayerCompletely(playerId: string, reason: string, log: (m: string, o?: object) => void): void {
    // Bot cleanup funnels here too — callers other than retire/adminReload
    // (idle reap on a hibernating room, future teardown paths) used to
    // leave the brain keyed on a gone player forever. Idempotent: retire
    // already untracked before reaching this.
    const wasBot = this.players.getPlayer(playerId)?.isBot;
    if (wasBot) {this.bots.untrack(playerId);}
    // A carrier leaving drops the flag — same rule as dying with it.
    this.flagCarrierDied(playerId);
    this.deployables.clearOwner(playerId);
    this.projectiles.clearOwner(playerId);
    this.players.removePlayer(playerId);
    this.scoring.dropPlayer(playerId);
    this.messages.onPlayerRemoved(playerId);
    this.sessionTokens.delete(playerId);
    // Removal-without-disconnect paths (kick, idle reap, bot retire)
    // never hit the onClose cleanup — the limiter's per-player buckets
    // would sit in this room's map for its life.
    this.rateLimiter.removePlayer(playerId);
    // A pending grace timer is part of the player's teardown: kick/room
    // hop/admin removal during the window would otherwise leave a zombie
    // timer that re-runs this whole funnel later (double playerLeft,
    // double leaves count — or worse, tearing down a rejoined player).
    // Terminating here (not only in GameServer's wrapper) keeps the funnel
    // complete when the room is driven directly — the session's armed
    // countdown dies with its transition to reaped.
    this.sessions?.terminate(playerId, reason);
    // Retire the wire id: the u16 space wraps at 65536 and a monotonic
    // mint would eventually alias live bindings. Retired ids are reissued
    // only after a reorder-safe quiet window (tickRecords mint), and the
    // remove edge lets clients drop the stale binding now.
    const wid = this.wireIds.get(playerId);
    if (wid !== undefined) {
      this.wireIds.delete(playerId);
      this.wireIdRetired.set(wid, wallNow());
      this.v4Last.delete(wid);
      this.connections.broadcast({ type: 'wireIds', add: {}, remove: [wid] });
    }
    this.lastSentPositions.delete(playerId);
    this.chatPace.delete(playerId);
    this.connections.broadcast(verbPayload(WORLD_MODEL.player!, 'gone', 'playerId', playerId, {}) as ServerMessage);
    this.rebalanceTeams();
    log('Player removed', { room: this.name, playerId, reason, remaining: this.playerCount() });
  }

  /** Even out team sizes after a departure by moving bots to the short
   *  side. Bots absorb the swing because flipping a human mid-match is
   *  hostile; a bot doesn't care which jersey it's wearing. No-op in
   *  non-team modes and when the delta is ≤1 (already balanced). */
  private rebalanceTeams(): void {
    if (!this.modeSpec?.teams) {return;}
    const counts = this.players.teamCounts();
    const [big, small] =
      counts.alpha >= counts.bravo
        ? (['alpha', 'bravo'] as const)
        : (['bravo', 'alpha'] as const);
    if (counts[big] - counts[small] < 2) {return;}
    for (const p of this.players.getAllPlayers().values()) {
      if (counts[big] - counts[small] < 2) {break;}
      if (p.team !== big || !p.isBot) {continue;}
      // A flipped carrier would hold the flag in 'carried' forever —
      // tickCarried requires carrier.team !== flag.team, and the bot's
      // new own-team can't grab or return it. Drop it at their feet.
      this.flagCarrierDied(p.id);
      this.players.setTeam(p.id, small);
      this.moveSim.setTeam(p.id, small);
      this.broadcast(eventPayload(WORLD_MODEL.player!, 'teamUpdate', 'playerId', p.id, { team: small }) as ServerMessage);
counts[big] -= 1;
counts[small] += 1;
    }
  }
}
