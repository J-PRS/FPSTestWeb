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
import { seatKits } from '../../shared/structKits.ts';
import { InfluenceMap } from './influenceMap.ts';
import { hmHeight, HM_WORLD_SCALE, type Heightfield } from '../../shared/heightfield.ts';
import { NOISE_TTL_MS } from '../../shared/wire.ts';
import { RoomMoveSim } from './RoomMoveSim.ts';
import { type MapSpec, type Vec3like, type StructureSpec, resolveMapSpec, flagStandSpecs } from '../../shared/mapSpec.ts';
import { KIT_HULLS, KIT_STAND_TOP } from '../../shared/structKits.ts';
import { MODES, pickTeam, makeScores, type ModeId, type ModeSpec, type TeamScores, type TeamId } from '../../shared/teams.ts';
import { ServerBots } from './ServerBots.ts';
import { RoomFlags } from './RoomFlags.ts';
import { RoomPickups } from './RoomPickups.ts';
import { RoomArena } from './RoomArena.ts';
import { RoomDeployables } from './RoomDeployables.ts';
import { RoomProjectiles } from './RoomProjectiles.ts';
import type { PlayerState, Vec3, ClientMessage } from './types.ts';
import { CLASS_STATS, classCapsule, type ArmorClass } from '../../shared/botClasses.ts';
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
import { chatKindFor, vgsCommandFor } from '../../shared/botTaunts.ts';
import { perkMods } from '../../shared/perks.ts';
import { healPool } from './healPool.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { simNow } from './simClock.ts';
import { wallNow } from './wallClock.ts';

export class Room {
  readonly name: string;
  /** Unlisted rooms never appear in /rooms or quick-join picks — the
   *  only way in is knowing the name. Set once at creation. */
  unlisted = false;
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
  rng: () => number = () => botRand();

  /** Grace seats live on the registry session itself (timer included) —
   *  assigned post-ctor by the factory. `graceInRoom` replaces the old
   *  per-room disconnected map so the countdown can't outlive the
   *  session it belongs to. */
  sessions?: import('./sessionRegistry.ts').SessionRegistry;
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
  nextWireId = 1;
  readonly sessionTokens = new Map<string, string>();
  readonly lastSentPositions = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; status: number; sheep: number; t: number }>();
  tickSeq = 0;

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
    if (this.healthTimer < 15) return;
    this.healthTimer = 0;
    if (!this.health.size) return;
    logger.debug('Room health', { room: this.name, humans: this.players.getHumanCount(), ...Object.fromEntries(this.health) });
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
  private unburyTick(dt: number): void {
    if (!this.field) return;
    this.unburyAcc += dt;
    if (this.unburyAcc < 0.5) return;
    this.unburyAcc = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.isDead || (!p.isBot && !p.hasReceivedPosition)) continue;
      const eye = classCapsule(p.armorClass as ArmorClass).eye;
      const terrain = hmHeight(this.field, p.position.x, p.position.z);
      if (p.position.y - eye >= terrain - 0.5) continue;
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

  /** Direct carrier check — snapshot() clones every flag just to answer
   *  "is id carrying", and per-tick callers (checkStuck, propel gate)
   *  paid it every bot every tick. */
  flagCarriedBy(playerId: string): boolean {
    if (!this.flags) return false;
    for (const f of this.flags.flags.values()) if (f.carrier === playerId) return true;
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
  readonly commands: { playerId: string; msg: ClientMessage; at: number }[] = [];
  drainCommands(): void {
    if (!this.commands.length) return;
    for (const c of this.commands) this.messages.handleMessage(c.playerId, c.msg, c.at);
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
  onMatchEnd?: (record: { room: string; mode: string; winner: string; scores: Record<string, number>; players: { id: string; team?: string; kills: number; deaths: number }[] }) => void;
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
    this.name = name;
    this.field = field;
    this.moveAuthority = moveAuthority && !!field;
    this.spec = spec ?? resolveMapSpec(null);
    this.influence = new InfluenceMap(this.spec.tileSize);
    this.mode = mode || this.spec.mode || '';
    this.modeSpec = MODES[this.mode as ModeId] ?? null;
    this.messages = new MessageHandler(
      this.players,
      this.rateLimiter,
      (msg, exclude) => this.connections.broadcast(msg, exclude),
      (pid, msg) => this.connections.sendToPlayer(pid, msg),
      this.handlerInfo(name),
    );
    this.moveSim = new RoomMoveSim(field, this.moveAuthority);
    // Player-vs-player contact: every shadow resolves against the live
    // roster (corpses don't block), so a defender's body is real cover.
    this.moveSim.bodySource = () => {
      const out: ({ id: string } & BodyCapsule)[] = [];
      for (const p of this.players.getAllPlayers().values()) {
        if (p.isDead) continue;
        const st = CLASS_STATS[p.armorClass as ArmorClass];
        out.push({ id: p.id, x: p.position.x, y: p.position.y, z: p.position.z, h: st.eyeHeight, mass: st.mass, r: st.radius, vx: p.velocity.x, vz: p.velocity.z });
      }
      return out;
    };
    this.matchClock = new MatchClock(this.matchHost());
    // Hard-tolerance trip: the client's input watermark outran our consumed
    // seq for ≥3 reports — an input edge died in flight (dead-lane drop).
    // Ask it to re-emit its current input; cooldown lives on the shadow.
    this.moveSim.onInputGap = (pid, lastSeq) => {
      this.health?.set('inputgap', (this.health?.get('inputgap') ?? 0) + 1);
      this.connections.sendToPlayer(pid, { type: 'inputSync', lastSeq });
    };
    // Reclaim desync accounting — journal wraps and reclaim gaps are the
    // only ways a reconnected client silently loses event history.
    this.connections.onJournalWrap = (n) => this.healthBump('journalWrap', n);
    this.connections.onReclaimGap = (_pid, n) => this.healthBump('reclaimGap', n);
    // A drowned socket is a client-side or path failure — count each
    // forced close so it shows in room health, not just the close log.
    this.connections.onDrowned = () => this.healthBump('drownedSock', 1);
    this.moveSim.attachStructures(this.effStructures());
    // Shield soak burns the same tank the jet model owns — without this
    // a shielded player under fire runs the sim tank ahead of the real one.
    this.players.energyBurn = (pid, n) => this.moveSim.drainEnergy(pid, n);
    // Closure over this.field — a mid-match terrain swap must not leave
    // spawn anchors snapping to the old map.
    this.players.groundAt = (x, z) => (this.field ? hmHeight(this.field, x, z) : 0);
    this.ballSim = new BallSim(
      this.players,
      (msg) => this.connections.broadcast(msg),
      (data) => this.connections.broadcastBinaryReliable(data),
    );
    if (this.spec.balls) this.ballSim.population = this.spec.balls;
    this.ballSim.onKilled = (by, pos, variant) => this.scoring.nonPlayerKill(by, pos, variant);
    this.ballSim.colliders = structureColliders(this.effStructures());
    if (this.spec.ballMix) this.ballSim.ballMix = this.spec.ballMix;
    if (this.spec.spawns) this.players.spawnPoints = this.spec.spawns;
    this.players.teamSpawns = this.spec.teamSpawns ?? null;
    this.players.spawnRng = () => this.rng();
    this.messages.setBallSim(this.ballSim);
    if (field) this.ballSim.attachField(field);
    this.creatureSim = this.initCreatures(field);
    this.bots = new ServerBots(this, field);
    // Event subscriptions — producers emit through RoomInfo.emit; each
    // consumer reads only the kinds it cares about. A spoken line is
    // itself an event worth a reply — the squad sees it on their own
    // think phases, so an answer lands a beat later like real chat.
    this.events.on((e) => {
      switch (e.type) {
        case 'kill': this.scoring.onKill(e.targetId, e.shooterId); break;
        case 'hit': this.bots.flinch(e.targetId, e.shooterId); this.scoring.onDamage(e.shooterId, e.targetId, e.damage); break;
        case 'fire': {
          this.bots.noteHumanFire(e.playerId);
          const shooter = this.players.getPlayer(e.playerId);
          if (shooter) shooter.lastFireSim = simNow(); // decloak-on-fire: senses unmask CLOAK for the reveal window
          break;
        }
        case 'botSpoke': this.bots.notice('reply', e.id, this.players.getPlayer(e.id)?.team); break;
        case 'chat': {
          const kind = chatKindFor(e.text)
            ?? (e.vgs ? vgsCommandFor(e.vgs) : null)
            ?? (this.bots.nameIn(e.text) ? 'mention' : null);
          if (kind) this.bots.notice(kind, e.id, this.players.getPlayer(e.id)?.team);
          this.noteChatPace(e.id);
          break;
        }
        // Blast aftermath — each emit once carried a bespoke RoomInfo
        // hook; the bus fans it out instead. Claimed blasts punt only
        // flags ('flag'): a client-claimed origin is untrusted, so it
        // must not punt loose pickups — 'pickup' emits only come from
        // server-owned blast paths (shells, mines).
        case 'blast': this.deployables.applyBlast(e.pos, e.damage, e.radius, e.shooterId, e.scales, e.weapon, e.splash); break;
        case 'knock': (e.kind === 'pickup' ? this.pickups : this.flags)?.knock(e.pos, e.radius, e.force); break;
        case 'preySplash':
          this.ballSim.splashDamage(e.ownerId, e.pos, e.radius, e.maxDamage);
          this.creatureSim.splashDamage(e.ownerId, e.pos, e.radius, e.maxDamage);
          break;
        case 'meleeSweep':
          this.ballSim.meleeSweep(e.playerId, e.pos, e.dir);
          this.creatureSim.meleeSweep(e.playerId, e.pos, e.dir);
          break;
        case 'armor':
          this.ballSim.armorBlast(e.pos, e.radius, e.amount);
          this.creatureSim.armorBlast(e.pos, e.radius, e.amount);
          break;
        case 'impulse': this.moveSim.applyImpulse(e.playerId, e.dv); break;
        case 'flagDrop': this.flags?.dropIfCarrier(e.playerId); break;
      }
    });
    // Posted roles spawn at home — a defender materializing on a
    // front-line sphere 400m out spends the next minute hiking, which
    // reads as wandering on every post/flag metric. Runners keep pure
    // foe-clearance scoring so the forward spheres stay useful.
    this.players.spawnHomeBias = (id) => {
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
    if (this.spec.bots) this.bots.populate(this.spec.bots);
    this.wireModeFeatures();
    this.deployables = new RoomDeployables(this);
    // Deployables are solid — the move shadows push bodies out of gear.
    this.moveSim.setDynamic(this.deployables.solidCols);
    if (this.spec.deploys) {
      // Ride structure floors: a generator seeded inside a genhouse must
      // stand on its deck (seated high over terrain), not drown in it.
      // max() keeps authored elevations — tower sentries never descend.
      this.deployables.seedBase(this.spec.deploys.map(e => ({
        ...e, pos: { ...e.pos, y: Math.max(e.pos.y, this.deployFloor(e.pos.x, e.pos.z, e.pos.y)) },
      })));
    }
    this.projectiles = new RoomProjectiles(this, field);
    this.projectiles.attachStructures(this.effStructures());
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
    const hits = (this.chatPace.get(id) ?? []).filter((t) => now - t < 8000);
    hits.push(now);
    if (hits.length < 4) { this.chatPace.set(id, hits); return; }
    this.chatPace.delete(id); // burst spent — re-arm on the next run
    if (tauntRand() >= 0.12) return;
    const bots = [...this.players.getAllPlayers().values()].filter((p) => p.id.startsWith('BOT-') && !p.isDead);
    if (bots.length) this.messages.killFeed.say(bots[(tauntRand() * bots.length) | 0]!.id, 'quiet', id);
  }

  /** Server-authoritative melee species — the crawl* wire events are the
   *  state-edge stream (retarget/windup/pounce/bite/die); clients replay
   *  the seeded hop sim between them. */
  private initCreatures(field: Heightfield | null): CreatureSim {
    const creatureSim = new CreatureSim(
      this.players,
      (msg) => this.connections.broadcast(msg),
      (pid, msg) => this.connections.sendToPlayer(pid, msg),
    );
    creatureSim.pops = this.spec.creatures ?? {};
    creatureSim.colliders = this.ballSim.colliders;
    creatureSim.onBite = (c, targetId) => {
      // dep:N ids are deployables — gnaw their hp, not a player.
      if (targetId.startsWith('dep:')) {
        this.deployables.gnaw(targetId, c.biteDamage);
        return;
      }
      this.messages.crawlerBite(targetId, c.biteDamage, c.species, { x: c.x, y: c.y, z: c.z });
    };
    creatureSim.extraTargets = () => this.deployables.creatureTargets();
    creatureSim.targetPos = (id) => id.startsWith('dep:') ? this.deployables.posOf(id) : null;
    creatureSim.onDetonate = (b) => {
      const pos = { x: b.x, y: b.y, z: b.z };
      this.messages.mineBlast('environment', pos, b.biteDamage, b.blastRadius, 14);
      this.pushNoise(pos); // bots hear the pop like any other blast
    };
    creatureSim.onKilled = (by, pos) => this.scoring.nonPlayerKill(by, pos, 0);
    this.messages.setCreatureSim(creatureSim);
    if (field) creatureSim.attachField(field);
    return creatureSim;
  }

  // Team bases → spawn anchors, kill-confirmed pickups, CTF flags — the
  // per-mode feature set the spec + modeSpec select together.
  private wireModeFeatures(): void {
    const bases = this.spec.bases;
    if (this.modeSpec?.teams && bases?.alpha && bases?.bravo) {
      // Spawn anchoring uses the SNAPPED stand positions — a defender
      // bias toward a floating/under-terrain authored base sends players
      // to where the flag was authored, not where it actually is.
      const snapped = this.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
      this.players.teamBases = { alpha: { ...snapped.alpha }, bravo: { ...snapped.bravo } };
    }
    this.pickups = new RoomPickups(this);
    this.pickups.onCollect = (pid, kind) => {
      const p = this.players.getPlayer(pid);
      if (!p) return;
      if (kind === 'gem' || kind === 'tag') {
        // Gems also heal — server-declared now: the collect IS the intent,
        // so the heal applies here instead of waiting on a claim that a
        // drop could silently lose (credit stayed banked but unclaimed).
        if (kind === 'gem') {
          healPool(p, Math.min(25, Math.round(20 * perkMods(p.perk).healBoost)));
          p.forceSendUntil = wallNow() + FORCE_SEND_MS;
          // Client refills half the energy tank on a gem — the shadow
          // must too or the next jet run diverges for honest reasons.
          this.moveSim.grantEnergy(pid, ENERGY.max * 0.5 * perkMods(p.perk).energyMax);
        }
        // Score pickups are the belt economy's income: one charge per
        // nugget, capped at the spawn stock.
        p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
        const team = p.team;
        if (team === 'alpha' || team === 'bravo') this.score(team);
        return;
      }
      this.scoring.applyPowerup(p, kind);
    };
    if (this.modeSpec?.flags) {
      if (this.mode === 'rabbit') {
        this.flags = new RoomFlags(this, { alpha: this.rabbitFlagHome() });
      } else if (bases?.alpha && bases?.bravo) {
        this.flags = new RoomFlags(this, this.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo }));
      }
    }
    // What the wire currently carries — the join echo and every structure
    // push both emit effStructures, so boot-time stands are the baseline
    // any later re-push compares against.
    this.emittedStands = this.standsJson();
  }

  /** Rabbit's one stand: the midpoint of a two-base map (a team's own
   *  stand would hand them free territory), else the arena center, else
   *  the first spawn — always de-shelved + snapped to walkable ground. */
  private rabbitFlagHome(): Vec3 {
    const src = (this.spec.bases?.alpha && this.spec.bases?.bravo)
      ? {
        x: (this.spec.bases.alpha.x + this.spec.bases.bravo.x) / 2,
        y: 0,
        z: (this.spec.bases.alpha.z + this.spec.bases.bravo.z) / 2,
      }
      : this.spec.bases?.alpha
        ?? (this.spec.arena ? { x: this.spec.arena.x, y: 0, z: this.spec.arena.z } : null)
        ?? this.spec.spawns?.[0]
        ?? { x: 0, y: 0, z: 0 };
    const p = this.flagDeShelf(src);
    return { x: p.x, y: this.flagStandTop(p.x, p.z), z: p.z };
  }

  // Spec y is advisory — flags live on the walkable surface, so touch
  // checks measure feet-to-flag, not feet-to-arbitrary-height. Both error
  // directions land the same: a flag authored under the terrain or inside
  // a stand pad pops up to the pad's deck, and a flag authored floating
  // drops onto it — max() of every surface the point could stand on IS
  // the perfect spot either way.
  private flagStandTop(x: number, z: number): number {
    let top = this.field ? hmHeight(this.field, x, z) : 0;
    for (const s of this.spec.structures ?? []) {
      if (s.kind === 'kit') {
        // Authored stand pieces ARE the platform — a base inside one's
        // footprint homes onto its standing surface (KIT_STAND_TOP).
        // Other kits' placeholder {1,1,1} size must never count.
        const lift = KIT_STAND_TOP[s.piece ?? ''];
        if (lift === undefined) continue;
        const k = s.scale ?? 1;
        let reach = 0;
        for (const h of KIT_HULLS[s.piece!] ?? []) {
          reach = Math.max(reach,
            (Math.abs(h.pos.x) + h.size.x / 2) * k,
            (Math.abs(h.pos.z) + h.size.z / 2) * k);
        }
        if (Math.abs(x - s.pos.x) <= reach && Math.abs(z - s.pos.z) <= reach) {
          top = Math.max(top, s.pos.y + lift * k);
        }
        continue;
      }
      if (Math.abs(x - s.pos.x) <= s.size.x / 2 && Math.abs(z - s.pos.z) <= s.size.z / 2) {
        top = Math.max(top, s.pos.y + s.size.y);
      }
    }
    return top;
  }

  /** Unreachable-shelf rescue: a flag snapped onto a mesa or pad that
   *  towers over every approach is a flag nobody can touch — walk it
   *  downhill toward the gentlest ring neighbor until some side is a
   *  jet-able climb (~18m over 60m) instead of a wall. */
  private flagDeShelf(v: { x: number; z: number }): { x: number; z: number } {
    let x = v.x, z = v.z;
    for (let i = 0; i < 10; i++) {
      const top = this.flagStandTop(x, z);
      // Reachable when SOME side offers a jet-able approach (~18m over
      // 60m); a big flat mesa reads correctly this way — local flatness
      // doesn't fake accessibility, the far ring does.
      let bestTop = -Infinity, bx = x, bz = z;
      for (let a = 0; a < 8; a++) {
        const px = x + Math.cos((a / 8) * Math.PI * 2) * 60;
        const pz = z + Math.sin((a / 8) * Math.PI * 2) * 60;
        const t = this.flagStandTop(px, pz);
        if (t > bestTop) { bestTop = t; bx = px; bz = pz; }
      }
      if (top - bestTop <= 18) break;
      const dx = bx - x, dz = bz - z, dd = Math.hypot(dx, dz) || 1;
      x += (dx / dd) * 15; z += (dz / dd) * 15;
    }
    return { x, z };
  }

  /** Highest walkable surface under a seeded deploy that isn't a climb
   *  away from its authored height — genhouse decks ride ~1m over the
   *  seated base, walls/roofs sit higher and must not win. Returns the
   *  authored y when nothing taller is under it, so tower-top assets
   *  are never dragged down and terrain never hoists anything. */
  private deployFloor(x: number, z: number, authoredY: number): number {
    // No structure under it → authored y stands. Grounding to terrain
    // lives in applySpec/seatKits, not here.
    //
    // The floor is the LOWEST solid top above the authored point, not
    // the highest: a genhouse seats its foundation on max terrain, so
    // the authored y often lands INSIDE the buried slab — taking the
    // highest top in reach would plant the generator on the roof.
    // The first surface up out of the fill is the deck.
    let floor = Infinity;
    for (const c of this.ballSim?.colliders ?? []) {
      const dx = x - c.cx, dz = z - c.cz;
      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) continue;
      const t = c.cy + c.hy;
      if (t > authoredY && t < floor && t <= authoredY + 12) floor = t;
    }
    return floor === Infinity ? authoredY : floor;
  }

  private snapFlagBases(bases: { alpha: Vec3like; bravo: Vec3like }): { alpha: Vec3; bravo: Vec3 } {
    const snapBase = (v: Vec3like): Vec3 => {
      const p = this.flagDeShelf(v);
      return { ...v, x: p.x, z: p.z, y: this.flagStandTop(p.x, p.z) };
    };
    return { alpha: snapBase(bases.alpha), bravo: snapBase(bases.bravo) };
  }

  /** Re-snaps flag homes against the LIVE heightfield. The ctor runs this
   *  with whatever field the host had at boot (often null), and the real
   *  per-map terrain lands later via the async attachTerrain promise —
   *  without this refresh the homes stay snapped to the wrong ground.
   *  Called again on every terrain attach and applySpec (bases can move
   *  with the map). */
  refreshFlagHomes(broadcastUpdate = true): void {
    if (!this.flags) return;
    if (this.mode === 'rabbit') {
      this.flags.retargetHomes({ alpha: this.rabbitFlagHome() });
      this.attachAllStructures();
      if (broadcastUpdate) this.pushStructureUpdate();
      return;
    }
    const bases = this.spec.bases;
    if (!bases?.alpha || !bases?.bravo) return;
    const snapped = this.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
    this.flags.retargetHomes(snapped);
    // Spawn anchors track the corrected stands too — a mid-match terrain
    // attach can move them tens of meters.
    if (this.modeSpec?.teams) {
      this.players.teamBases = { alpha: { ...snapped.alpha }, bravo: { ...snapped.bravo } };
    }
    // Stands may have moved with the re-snap — their collision hulls
    // are spec entries, so the sims must re-attach the merged list.
    this.attachAllStructures();
    if (broadcastUpdate) this.pushStructureUpdate();
  }

  /** The stand hulls as emitted — the baseline "every client holds"
   *  approximation: gameState echoes and pushes both serialize
   *  effStructures, so the last push's snapshot is what a stayer has. */
  private emittedStands: string | null = null;
  private standsJson(): string {
    // Shields ride the diff too — a generator flip changes which panes emit.
    return JSON.stringify(this.effStructures().filter((s) => s.kind === 'stand' || s.kind === 'shield'));
  }

  /** Re-push the merged structure list when the stand hulls moved — a
   *  skinny mapUpdate (no terrain/name keys) so clients rebuild colliders
   *  without a full map reload. */
  private pushStructureUpdate(): void {
    const stands = this.standsJson();
    if (stands === this.emittedStands) return;
    this.emittedStands = stands;
    const spec = this.spec;
    // Refresh the join-time echo too — setMap freezes whatever snap was
    // live when applySpec ran (often the previous map's field), and
    // gameState re-serves that stale list to every reconnect until the
    // map reloads.
    this.messages.setMap({ ...spec, structures: this.effStructures() });
    this.broadcast({
      type: 'mapUpdate',
      silent: true,
      structures: this.effStructures(),
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      fog: spec.fog,
      terrainTex: spec.terrainTex,
      sky: spec.sky,
      interiors: spec.interiors,
    });
  }

  /** The spec's authored structures PLUS collision hulls for the flag
   *  daises — 'stand' entries collide everywhere (move sim, shells,
   *  balls, blast LOS) and ride the wire echo, but the client never
   *  draws them as generic boxes (the dais mesh is their visual). */
  /** Generator state flips which shield panes exist — colliders and the
   *  wire echo share this list, so one call re-syncs every client. */
  refreshPowerStructures(): void {
    this.attachAllStructures();
    this.pushStructureUpdate();
  }

  private effStructures(): StructureSpec[] {
    // Team shield panes vanish while their grid is dark — no collider,
    // no render, no blocker on either side.
    // deployables construct after the first moveSim/ballSim attach —
    // pre-seed the grid reads live, so a missing table means powered.
    const out = (this.spec.structures ?? []).filter(
      (s) => s.kind !== 'shield' || !s.team || (this.deployables?.teamPowered(s.team) ?? true),
    );
    if (!this.modeSpec?.flags) return out;
    if (process.env.FPS_NOSTAND) return out; // soak A/B: measure approach cost of the dais hulls
    if (this.mode === 'rabbit') {
      out.push(...flagStandSpecs(this.rabbitFlagHome()));
      return out;
    }
    const bases = this.spec.bases;
    if (bases?.alpha && bases?.bravo) {
      const snapped = this.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
      out.push(...flagStandSpecs(snapped.alpha, 'alpha'), ...flagStandSpecs(snapped.bravo, 'bravo'));
    }
    return out;
  }

  /** Re-attach the merged structure list everywhere it feeds — called
   *  at boot and whenever flag homes re-snap (terrain attach, map swap). */
  private attachAllStructures(): void {
    // Kit pieces ground-seat on the live heightfield — authored y in the
    // map file can't know the terrain, and a floating/buried compound is
    // worse than an advisory height. Spec objects are shared with the
    // wire echo, so the mutation reaches clients as the real position.
    if (this.field) seatKits(this.spec.structures, (x, z) => hmHeight(this.field!, x, z));
    const list = this.effStructures();
    this.moveSim.attachStructures(list);
    this.projectiles?.attachStructures(list);
    if (this.ballSim) this.ballSim.colliders = structureColliders(list);
  }

  // The tick registry — GameServer steps every entry per tick; new
  // server-side systems (deployables, generators) register here instead
  // of editing the tick loop.
  private registerSims(): void {
    // World sims step first — bots and downstream systems see post-step
    // wildlife positions inside the same tick.
    this.sims.push({ name: 'balls', tick: (dt) => this.ballSim.step(dt), worldState: () => [{ type: 'ballRoster', balls: this.ballSim.roster() }] });
    this.sims.push({ name: 'crawl', tick: (dt) => this.creatureSim.step(dt), worldState: () => [{ type: 'crawlRoster', crawlers: this.creatureSim.roster() }] });
    this.sims.push({ name: 'bots', tick: (dt) => this.bots.tick(dt) });
    if (this.flags) this.sims.push({ name: 'flags', tick: (dt) => this.tickFlags(dt) });
    if (this.pickups) this.sims.push({ name: 'pickups', tick: (dt) => this.pickups!.tick(dt) });
    this.sims.push({ name: 'unbury', tick: (dt) => this.unburyTick(dt) });
    if (this.spec.arena) {
      const arena = new RoomArena(this, this.spec.arena);
      this.sims.push({ name: 'arena', tick: (dt) => arena.tick(dt) });
    }
    this.sims.push({ name: 'deploy', tick: (dt) => this.deployables.tick(dt) });
    this.sims.push({ name: 'proj', tick: (dt) => this.projectiles.tick(dt) });
    this.sims.push({ name: 'move', tick: (dt) => this.moveSim.tick(dt) });
    this.sims.push({ name: 'health', tick: (dt) => this.healthTick(dt) });
    this.sims.push({ name: 'influence', tick: (dt) => this.influence.tick(dt) });
    this.moveSim.health = this.health;
  }

  /** Flag tick — called from GameServer's room tick. Captures feed the
   *  same bank→teamScore→matchEnd funnel nuggets use (worth winAt/5-ish:
   *  one capture = one score point). */
  tickFlags(dt: number): void {
    const scoredBy = this.flags?.tick(dt);
    if (scoredBy) this.score(scoredBy);
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
  get ffaScores() { return this.scoring.ffaScores; }

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
      scores: this.scores,
      teams: this.modeSpec?.teams,
      friendlyFire: CONFIG.friendlyFire,
      winAt: this.modeSpec?.winAt,
      ffaScores: () => Object.fromEntries(this.scoring.ffaScores),
      // Registry stores playerId->u16; the wire roster ships the
      // inverse so receivers resolve a frame's u16 to an identity.
      wireIds: () => {
        const out: Record<number, string> = {};
        for (const [pid, id] of this.wireIds) out[id] = pid;
        return out;
      },
      simsWorldState: () => this.sims.flatMap((s) => s.worldState?.() ?? []),
      bases: this.spec.bases,
      structures: this.effStructures(),
      arena: this.spec.arena,
      ambient: this.spec.ambient,
      // Authored spec title wins; the maps/<X>.json source filename is the
      // fallback — set post-ctor by the factory, refreshed by rotation.
      mapName: () => this.spec.name ?? (this.mapSrc || undefined),
      terrain: this.spec.terrain,
      heightScale: this.spec.heightScale,
      tileSize: this.spec.tileSize,
      fog: this.spec.fog,
      terrainTex: this.spec.terrainTex,
      sky: this.spec.sky,
      interiors: this.spec.interiors,
      emit: this.events.emit,
      rng: () => this.rng(),
      flags: () => this.flags?.snapshot() ?? [],
      pickups: () => this.pickups?.snapshot() ?? [],
      fireProjectile: (pid, wt, origin, dir, vel, shotId) => this.projectiles.spawn(pid, wt, origin, dir, vel, shotId),
      onDeploy: (pid, kind, pos) => this.deployables.handleDeploy(pid, kind, pos),
      onRepair: (pid, targetId) => this.deployables.repair(pid, targetId),
      deployables: () => this.deployables.snapshot(),
      influence: this.influence,
      matchEndsAt: () => this.matchClock.timeLeftMs() > 0 ? simNow() + this.matchClock.timeLeftMs() : 0,
      moveInput: (pid, i, status, seq) => this.moveSim.queueInput(pid, {
        forward: i.forward, right: i.right,
        jumpPressed: !!i.jump, jumpHeld: !!i.jump, skiHeld: !!i.ski,
        jetHeld: !!i.jet,
      }, status, seq),
      moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => this.moveSim.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
      inputSeqOf: (pid) => this.moveSim.inputSeqOf(pid),
      // The rabbit dep's presence IS the mode check — CombatHandler gates
      // all PvP damage on the carrier being one side of the pair.
      rabbitCarrier: this.mode === 'rabbit' ? () => this.flags?.carrierId() ?? null : undefined,
      rabbitBottom: this.mode === 'rabbit' ? () => this.scoring.bottomFeeders() : undefined,
      drainEnergy: (pid, n) => this.moveSim.drainEnergy(pid, n),
      // Instant-skill claim: the client already spent the energy locally —
      // mirror the same ante on the shadow or the tank drifts 50 apart.
      onSkillUse: (pid) => this.moveSim.drainEnergy(pid, ENERGY.skillCost) ? true : 'gone',
      onThrowFlag: (pid) => this.flags?.throwFor(pid),
      energyOf: (pid) => this.moveSim.energyOf(pid),
      moveResync: (pid, pos, yaw, fullEnergy) => {
        this.moveSim.resync(pid, pos, yaw, fullEnergy);
        // Resync re-anchors the shadow — also refresh the class speed
        // scale so a respawn-applied tier swap propagates (moveTrack
        // only re-reads it at handshake).
        this.applyClassScale(pid);
      },
      moveTrack: (pid, pos, yaw) => {
        const p = this.players.getPlayer(pid);
        this.moveSim.track(pid, pos, yaw, p?.perk, p?.team);
        // Re-seats (room hop) have stale position frames in flight — arm
        // the same grace resync() uses so they can't seed the fresh
        // shadow at the old seat and flag the real spawn landing a cheat.
        this.moveSim.markReseated(pid);
        this.applyClassScale(pid);
      },
      moveMute: (pid) => this.moveSim.markReseated(pid),
      moveUntrack: (pid) => this.moveSim.untrack(pid),
      // A spoken line is itself an event worth a reply — the squad sees
      // it on their own think phases, so an answer (if any) lands a beat
      // later like real chat, not a scripted call-and-response.

      moveAuthority: () => this.moveAuthority,
      health: this.health,
      envRange: (pid) => {
        const p = this.players.getPlayer(pid);
        return p ? this.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z) : Infinity;
      },
      preyNear: (pos, shooterId) => {
        let crawler = Infinity;
        for (const c of this.creatureSim.crawlers.values()) {
          const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
          if (d < crawler) crawler = d;
        }
        // Nearest enemy body to the pop — a foe eating the shell at 5m
        // reads as a 'lip' in the autopsy otherwise, masking body
        // intercepts as terrain clips.
        const team = shooterId ? this.players.getPlayer(shooterId)?.team : undefined;
        let foe = Infinity;
        for (const q of this.players.getAllPlayers().values()) {
          if (q.id === shooterId || q.isDead || (team && q.team === team)) continue;
          const d = Math.hypot(q.position.x - pos.x, q.position.y - pos.y, q.position.z - pos.z);
          if (d < foe) foe = d;
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
      getHumanCount: () => this.players.getHumanCount(),
      matchPlayers: () => this.scoring.matchPlayers(),
      broadcast: (msg) => this.broadcast(msg),
      endCleanup: () => {
        this.flags?.reset();
        this.pickups?.clear();
        this.deployables.clearAll();
        this.players.resetStats();
      },
      reshuffleBots: () => {
        const bots = [...this.players.getAllPlayers().values()].filter((p) => p.isBot);
        if (bots.length < 2 || !this.modeSpec?.teams) return;
        // Fisher-Yates on botRand so harness replays stay deterministic,
        // then alternate alpha/bravo — sizes stay even, loyalties don't.
        for (let i = bots.length - 1; i > 0; i--) {
          const j = Math.floor(botRand() * (i + 1));
          [bots[i], bots[j]] = [bots[j]!, bots[i]!];
        }
        bots.forEach((p, i) => { p.team = i % 2 === 0 ? 'alpha' : 'bravo'; });
        for (const p of bots) {
          this.players.respawnPlayer(p.id);
          this.broadcast(eventPayload(WORLD_MODEL.player!, 'teamUpdate', 'playerId', p.id, { team: p.team! }) as ServerMessage);
        }
      },
      rotate: () => this.onRotate?.() ?? null,
      applySpec: (s) => this.applySpec(s),
      onMatchEnd: (r) => this.onMatchEnd?.(r),
      // 'match' isn't a bot id — nobody's actor-excluded, so every bot
      // sees the gg notice on its own think phase and the usual dice
      // decide who bothers replying. matchEnd adds the staggered
      // outcome lines on top — the shared chatter cooldown keeps the
      // two paths from double-speaking the same bot.
      onEnded: (w) => { this.bots.notice('gg', 'match'); this.bots.matchEnd(w); },
      // The opener half of the beat — gl-hf as the round goes live.
      onStarted: () => this.bots.matchStart(),
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
      if (pos) this.pushNoise(pos);
    }
    this.connections.broadcast(msg, exclude);
  }

  /** Blasts detonate server-side without a broadcast position — the sim
   *  reports them here so bots hear explosions as well as muzzle fire. */
  pushNoise(pos: Vec3): void {
    const now = simNow();
    while (this.noises.length && now - this.noises[0]!.at > Room.NOISE_TTL) this.noises.shift();
    this.noises.push({ pos: { ...pos }, at: now });
    if (this.noises.length > Room.NOISE_MAX) this.noises.shift();
    this.influence.splat(pos, 'opportunity', 0.4);
  }

  /** Recent noise positions within earshot of pos (no LOS required). */
  noisesNear(pos: Vec3, radius: number): Vec3[] {
    const now = simNow();
    const out: Vec3[] = [];
    for (const n of this.noises) {
      if (now - n.at > Room.NOISE_TTL) continue;
      const dx = n.pos.x - pos.x, dy = n.pos.y - pos.y, dz = n.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(n.pos);
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
    if (!this.modeSpec?.teams) return undefined;
    let alpha = 0, bravo = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.team === 'alpha') alpha++;
      else if (p.team === 'bravo') bravo++;
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
    if (spec.tileSize !== this.spec.tileSize) this.influence.resize(spec.tileSize ?? HM_WORLD_SCALE);
    this.spec = spec;
    if (spec.spawns) this.players.spawnPoints = spec.spawns;
    this.players.teamSpawns = spec.teamSpawns ?? null;
    this.attachAllStructures(); // merged authored + stand hulls; refreshFlagHomes re-runs it post-snap
    // Bases can move with a new spec — re-snap homes (no update push: the
    // mapUpdate below carries the post-snap list). If the terrain is
    // also rotating the attach below corrects them once it lands.
    this.refreshFlagHomes(false);
    if (spec.balls) this.ballSim.population = spec.balls;
    if (spec.ballMix) this.ballSim.ballMix = spec.ballMix;
    this.creatureSim.pops = spec.creatures ?? {};
    this.creatureSim.colliders = this.ballSim.colliders;
    // The echo carries the merged list too — joiners get stand hulls in
    // their gameState structures, and combat occlusion sees the dais.
    this.messages.setMap({ ...spec, structures: this.effStructures() });
    this.emittedStands = this.standsJson(); // the push below is what clients hold now
    this.broadcast({
      type: 'mapUpdate',
      mapName: spec.name ?? (this.mapSrc || undefined),
      bases: spec.bases,
      structures: this.effStructures(),
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      terrain: spec.terrain,
      heightScale: spec.heightScale,
      tileSize: spec.tileSize,
      fog: spec.fog,
      terrainTex: spec.terrainTex,
      sky: spec.sky,
      interiors: spec.interiors,
    });
    // Rotate the sims' heightfield WITH the broadcast — clients rebuild on
    // mapUpdate; a sim still running the old field disagrees about where
    // the ground is for the entire match.
    if (terrainChanged) this.onTerrain?.(spec);
    this.retuneBots(spec.bots ?? 0);
  }

  /** Top up / retire bots toward a spec's bot count (admin reload). */
  private retuneBots(want: number): void {
    if (this.bots.count < want) { this.bots.populate(want - this.bots.count); return; }
    if (this.bots.count <= want) return;
    let excess = this.bots.count - want;
    // Snapshot first — removePlayerCompletely mutates the map we're walking.
    // oxlint-disable-next-line no-useless-spread
    for (const p of [...this.players.getAllPlayers().values()]) {
      if (excess <= 0) break;
      if (!p.isBot) continue;
      this.removePlayerCompletely(p.id, 'adminReload', () => {});
      excess--;
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
    if (wasBot) this.bots.untrack(playerId);
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
    if (!this.modeSpec?.teams) return;
    const counts = this.players.teamCounts();
    let [big, small] =
      counts.alpha >= counts.bravo
        ? (['alpha', 'bravo'] as const)
        : (['bravo', 'alpha'] as const);
    if (counts[big] - counts[small] < 2) return;
    for (const p of this.players.getAllPlayers().values()) {
      if (counts[big] - counts[small] < 2) break;
      if (p.team !== big || !p.isBot) continue;
      // A flipped carrier would hold the flag in 'carried' forever —
      // tickCarried requires carrier.team !== flag.team, and the bot's
      // new own-team can't grab or return it. Drop it at their feet.
      this.flagCarrierDied(p.id);
      this.players.setTeam(p.id, small);
      this.moveSim.setTeam(p.id, small);
      this.broadcast(eventPayload(WORLD_MODEL.player!, 'teamUpdate', 'playerId', p.id, { team: small }) as ServerMessage);
      counts[big]--;
      counts[small]++;
    }
  }
}
