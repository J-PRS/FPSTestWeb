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
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { RoomMoveSim } from './RoomMoveSim.ts';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES, pickTeam, makeScores, type ModeId, type ModeSpec, type TeamScores, type TeamId } from '../../shared/teams.ts';
import { ServerBots } from './ServerBots.ts';
import { RoomFlags } from './RoomFlags.ts';
import { RoomPickups } from './RoomPickups.ts';
import { RoomArena } from './RoomArena.ts';
import { RoomDeployables } from './RoomDeployables.ts';
import { RoomProjectiles } from './RoomProjectiles.ts';
import type { PlayerState, Vec3 } from './types.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { botRand } from '../../shared/botRand.ts';
import { MatchClock, type MatchHost } from './roomMatch.ts';
import { RoomScore } from './roomScore.ts';
import { ENERGY } from '../../shared/movement.ts';
import { BELT_MAX } from '../../shared/weapons.ts';
import { chatKindFor } from '../../shared/botTaunts.ts';
import { perkMods } from '../../shared/perks.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { simNow } from './simClock.ts';

export class Room {
  readonly name: string;
  // First joiner's mode locks the match — later joins inherit it via
  // gameState rather than a per-client URL param.
  readonly mode: string;
  readonly players = new PlayerManager();
  readonly connections = new ConnectionManager();
  readonly rateLimiter = new RateLimiter();
  readonly messages: MessageHandler;
  readonly ballSim: BallSim;
  readonly creatureSim: CreatureSim;
  /** Host-side randomness (loot scatter) — tests inject a seeded fn. */
  rng: () => number = Math.random;

  // Per-room session bookkeeping (was global — a grace-period slot belongs
  // to the match it was in, not the whole server).
  readonly disconnected = new Map<string, { timeout: ReturnType<typeof setTimeout> }>();
  /** Watching sockets — no player record, get broadcasts + ticks. */
  readonly spectators = new Set<string>();
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
  healthBump(key: string, n = 1): void {
    this.health.set(key, (this.health.get(key) ?? 0) + n);
  }
  private healthTimer = 0;
  private healthTick(dt: number): void {
    this.healthTimer += dt;
    if (this.healthTimer < 15) return;
    this.healthTimer = 0;
    if (!this.health.size) return;
    logger.info('Room health', { room: this.name, humans: this.players.getHumanCount(), ...Object.fromEntries(this.health) });
    // Fold the window into since-boot totals. gapMax is a gauge (the
    // worst single sample), not a counter — merge by max, not sum.
    for (const [k, v] of this.health) {
      this.healthTotal.set(k, k === 'gapMax'
        ? Math.max(this.healthTotal.get(k) ?? 0, v)
        : (this.healthTotal.get(k) ?? 0) + v);
    }
    this.health.clear();
  }

  spec: MapSpec; // mutable — admin hot-reload rewrites it live
  // Server-owned match scoreboard — only populated in team modes.
  readonly modeSpec: ModeSpec | null;
  readonly scores: TeamScores = makeScores();
  /** Server-driven filler players, populated from the map spec. */
  readonly bots: ServerBots;
  /** CTF flag authority — only when the mode has flags AND the map has bases. */
  flags: RoomFlags | null = null;
  /** Server-owned ground loot — gems/tags score in team modes, powerups
   *  (heal/armor/regen/dd) drop from creature kills in every mode. */
  pickups: RoomPickups | null = null;
  /** Server-owned deployables — turrets/mines/stations/drones a `deploy`
   *  claim plants; caps + TTL + teardown live here. */
  readonly deployables: RoomDeployables;
  /** Server-simulated projectiles — bot fire spawns real shells here
   *  instead of rolled hitscan (bots-as-legal-players phase 2). */
  readonly projectiles: RoomProjectiles;
  /** Server-side simulations ticked each room tick, in order. */
  readonly sims: { tick(dt: number): void }[] = [];
  /** Spatial memory — kills/fights/gems/flags leave decaying scent the
   *  brains read for where-the-action-was. See influenceMap.ts. */
  readonly influence = new InfluenceMap();
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
    this.moveSim.setBody(playerId, st?.mass ?? 1, st?.eyeHeight ?? 1.8);
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
    this.matchClock = new MatchClock(this.matchHost());
    this.moveSim.attachStructures(this.spec.structures);
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
    this.ballSim.colliders = structureColliders(this.spec.structures);
    if (this.spec.ballMix) this.ballSim.ballMix = this.spec.ballMix;
    if (this.spec.spawns) this.players.spawnPoints = this.spec.spawns;
    this.players.teamSpawns = this.spec.teamSpawns ?? null;
    this.players.spawnRng = () => this.rng();
    this.messages.setBallSim(this.ballSim);
    if (field) this.ballSim.attachField(field);
    this.creatureSim = this.initCreatures(field);
    this.bots = new ServerBots(this, field);
    // Posted roles spawn at home — a defender materializing on a
    // front-line sphere 400m out spends the next minute hiking, which
    // reads as wandering on every post/flag metric. Runners keep pure
    // foe-clearance scoring so the forward spheres stay useful.
    this.players.spawnHomeBias = (id) => {
      const role = this.bots?.roleOf(id);
      return role === 'hof' || role === 'ldefense' || role === 'defense' || role === 'technician' ? 1.6 : 0;
    };
    // Bots populate before humans join so team balancing puts humans on
    // the emptier side.
    if (this.spec.bots) this.bots.populate(this.spec.bots);
    this.wireModeFeatures(field);
    this.deployables = new RoomDeployables(this);
    this.projectiles = new RoomProjectiles(this, field);
    this.projectiles.attachStructures(this.spec.structures);
    this.registerSims();
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
  private wireModeFeatures(field: Heightfield | null): void {
    const bases = this.spec.bases;
    if (this.modeSpec?.teams && bases?.alpha && bases?.bravo) {
      this.players.teamBases = { alpha: { ...bases.alpha }, bravo: { ...bases.bravo } };
    }
    this.pickups = new RoomPickups(this);
    this.pickups.onCollect = (pid, kind) => {
      const p = this.players.getPlayer(pid);
      if (!p) return;
      if (kind === 'gem' || kind === 'tag') {
        // Gems also back the collector's next heal claim; both kinds pay
        // one belt charge below — the nuggets ARE the ordnance economy.
        if (kind === 'gem') {
          p.healCredit += 25;
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
    if (this.modeSpec?.flags && bases?.alpha && bases?.bravo) {
      // Spec y is advisory — flags live on the walkable surface, so
      // touch checks measure feet-to-flag, not feet-to-arbitrary-height.
      // Both error directions land the same: a flag authored under the
      // terrain or inside a stand pad pops up to the pad's deck, and a
      // flag authored floating drops onto it — max() of every surface
      // the point could stand on IS the perfect spot either way.
      const standTop = (x: number, z: number): number => {
        let top = field ? hmHeight(field, x, z) : 0;
        for (const s of this.spec.structures ?? []) {
          if (Math.abs(x - s.pos.x) <= s.size.x / 2 && Math.abs(z - s.pos.z) <= s.size.z / 2) {
            top = Math.max(top, s.pos.y + s.size.y / 2);
          }
        }
        return top;
      };
      const snap = (v: { x: number; y: number; z: number }) => ({
        ...v,
        y: standTop(v.x, v.z),
      });
      // Unreachable-shelf rescue: a flag snapped onto a mesa or pad that
      // towers over every approach is a flag nobody can touch — walk it
      // downhill toward the gentlest ring neighbor until some side is a
      // jet-able climb (~18m over 60m) instead of a wall.
      const deShelf = (v: { x: number; y: number; z: number }) => {
        let x = v.x, z = v.z;
        for (let i = 0; i < 10; i++) {
          const top = standTop(x, z);
          // Reachable when SOME side offers a jet-able approach (~18m
          // over 60m); a big flat mesa reads correctly this way — local
          // flatness doesn't fake accessibility, the far ring does.
          let bestTop = -Infinity, bx = x, bz = z;
          for (let a = 0; a < 8; a++) {
            const px = x + Math.cos((a / 8) * Math.PI * 2) * 60;
            const pz = z + Math.sin((a / 8) * Math.PI * 2) * 60;
            const t = standTop(px, pz);
            if (t > bestTop) { bestTop = t; bx = px; bz = pz; }
          }
          if (top - bestTop <= 18) break;
          const dx = bx - x, dz = bz - z, dd = Math.hypot(dx, dz) || 1;
          x += (dx / dd) * 15; z += (dz / dd) * 15;
        }
        return { x, z };
      };
      const snapBase = (v: { x: number; y: number; z: number }) => {
        const p = deShelf(v);
        return snap({ x: p.x, y: v.y, z: p.z });
      };
      this.flags = new RoomFlags(this, { alpha: snapBase(bases.alpha), bravo: snapBase(bases.bravo) });
    }
  }

  // The tick registry — GameServer steps every entry per tick; new
  // server-side systems (deployables, generators) register here instead
  // of editing the tick loop.
  private registerSims(): void {
    this.sims.push({ tick: (dt) => this.bots.tick(dt) });
    if (this.flags) this.sims.push({ tick: (dt) => this.tickFlags(dt) });
    if (this.pickups) this.sims.push({ tick: (dt) => this.pickups!.tick(dt) });
    if (this.spec.arena) {
      const arena = new RoomArena(this, this.spec.arena);
      this.sims.push({ tick: (dt) => arena.tick(dt) });
    }
    this.sims.push({ tick: (dt) => this.deployables.tick(dt) });
    this.sims.push({ tick: (dt) => this.projectiles.tick(dt) });
    this.sims.push({ tick: (dt) => this.moveSim.tick(dt) });
    this.sims.push({ tick: (dt) => this.healthTick(dt) });
    this.sims.push({ tick: (dt) => this.influence.tick(dt) });
    this.moveSim.health = this.health;
  }

  /** Flag tick — called from GameServer's room tick. Captures feed the
   *  same bank→teamScore→matchEnd funnel nuggets use (worth winAt/5-ish:
   *  one capture = one score point). */
  tickFlags(dt: number): void {
    const scoredBy = this.flags?.tick(dt);
    if (scoredBy) this.score(scoredBy);
  }

  /** Any player death drops a carried flag — called from the damage funnel. */
  flagCarrierDied(playerId: string): void {
    this.flags?.dropIfCarrier(playerId);
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
      bases: this.spec.bases,
      structures: this.spec.structures,
      arena: this.spec.arena,
      ambient: this.spec.ambient,
      // Authored spec title wins; the maps/<X>.json source filename is the
      // fallback — set post-ctor by the factory, refreshed by rotation.
      mapName: () => this.spec.name ?? (this.mapSrc || undefined),
      terrain: this.spec.terrain,
      terrainTex: this.spec.terrainTex,
      sky: this.spec.sky,
      interiors: this.spec.interiors,
      onKill: (pid, shooter) => this.scoring.onKill(pid, shooter),
      onHit: (pid, shooter) => this.bots.flinch(pid, shooter),
      onFire: (pid) => this.bots.noteHumanFire(pid),
      rng: () => this.rng(),
      flags: () => this.flags?.snapshot() ?? [],
      pickups: () => this.pickups?.snapshot() ?? [],
      onDeploy: (pid, kind, pos) => this.deployables.handleDeploy(pid, kind, pos),
      onRepair: (pid, targetId) => this.deployables.repair(pid, targetId),
      deployBlast: (pos, damage, radius, shooter) => this.deployables.applyBlast(pos, damage, radius, shooter),
      pickupsKnock: (at, radius, force) => this.pickups?.knock(at, radius, force),
      preySplash: (ownerId, pos, radius, maxDamage) => {
        this.ballSim.splashDamage(ownerId, pos, radius, maxDamage);
        this.creatureSim.splashDamage(ownerId, pos, radius, maxDamage);
      },
      influence: this.influence,
      creatureArmor: (pos, amount, radius) => {
        this.ballSim.armorBlast(pos, radius, amount);
        this.creatureSim.armorBlast(pos, radius, amount);
      },
      deployables: () => this.deployables.snapshot(),
      matchEndsAt: () => this.matchClock.timeLeftMs() > 0 ? simNow() + this.matchClock.timeLeftMs() : 0,
      moveInput: (pid, i, status, seq) => this.moveSim.setInput(pid, {
        forward: i.forward, right: i.right,
        jumpPressed: !!i.jump, jumpHeld: !!i.jump, skiHeld: !!i.ski,
        jetHeld: !!i.jet,
      }, status, seq),
      moveReport: (pid, pos, yaw, vel, inputSeq) => this.moveSim.reconcile(pid, pos, yaw, vel, inputSeq),
      moveImpulse: (pid, dv) => this.moveSim.applyImpulse(pid, dv),
      dropFlagCarrier: (pid) => this.flags?.dropIfCarrier(pid),
      drainEnergy: (pid, n) => this.moveSim.drainEnergy(pid, n),
      // Instant-skill claim: the client already spent the energy locally —
      // mirror the same ante on the shadow or the tank drifts 50 apart.
      onSkillUse: (pid) => this.moveSim.drainEnergy(pid, ENERGY.skillCost),
      energyOf: (pid) => this.moveSim.energyOf(pid),
      moveResync: (pid, pos, yaw, fullEnergy) => {
        this.moveSim.resync(pid, pos, yaw, fullEnergy);
        // Resync re-anchors the shadow — also refresh the class speed
        // scale so a respawn-applied tier swap propagates (moveTrack
        // only re-reads it at handshake).
        this.applyClassScale(pid);
      },
      moveTrack: (pid, pos, yaw) => {
        this.moveSim.track(pid, pos, yaw, this.players.getPlayer(pid)?.perk);
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
      onBotSpoke: (pid) => this.bots.notice('reply', pid, this.players.getPlayer(pid)?.team),
      onChat: (pid, text) => {
        const kind = chatKindFor(text) ?? (this.bots.nameIn(text) ? 'mention' : null);
        if (kind) this.bots.notice(kind, pid, this.players.getPlayer(pid)?.team);
      },
      moveAuthority: () => this.moveAuthority,
      health: this.health,
      envRange: (pid) => {
        const p = this.players.getPlayer(pid);
        return p ? this.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z) : Infinity;
      },
      preyNear: (pos) => {
        let crawler = Infinity;
        for (const c of this.creatureSim.crawlers.values()) {
          const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
          if (d < crawler) crawler = d;
        }
        return { ball: this.ballSim.nearestBallDist(pos.x, pos.y, pos.z), crawler };
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
          this.broadcast({ type: 'teamUpdate', playerId: p.id, team: p.team! });
        }
      },
      rotate: () => this.onRotate?.() ?? null,
      applySpec: (s) => this.applySpec(s),
      onMatchEnd: (r) => this.onMatchEnd?.(r),
      // 'match' isn't a bot id — nobody's actor-excluded, so every bot
      // sees the gg notice on its own think phase and the usual dice
      // decide who bothers replying.
      onEnded: () => this.bots.notice('gg', 'match'),
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
  private static NOISE_TTL = 2000; // ms — old noise fades
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
    return this.players.getHumanCount() === 0 && this.disconnected.size === 0
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
    const terrainChanged = spec.terrain !== this.spec.terrain;
    this.spec = spec;
    if (spec.spawns) this.players.spawnPoints = spec.spawns;
    this.players.teamSpawns = spec.teamSpawns ?? null;
    this.ballSim.colliders = structureColliders(spec.structures);
    this.moveSim.attachStructures(spec.structures);
    this.projectiles.attachStructures(spec.structures);
    if (spec.balls) this.ballSim.population = spec.balls;
    if (spec.ballMix) this.ballSim.ballMix = spec.ballMix;
    this.creatureSim.pops = spec.creatures ?? {};
    this.creatureSim.colliders = this.ballSim.colliders;
    this.messages.setMap(spec);
    this.broadcast({
      type: 'mapUpdate',
      mapName: spec.name ?? (this.mapSrc || undefined),
      bases: spec.bases,
      structures: spec.structures,
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      terrain: spec.terrain,
      terrainTex: spec.terrainTex,
      sky: spec.sky,
      interiors: spec.interiors,
    });
    // Rotate the sims' heightfield WITH the broadcast — clients rebuild on
    // mapUpdate; a sim still running the old field disagrees about where
    // the ground is for the entire match.
    if (terrainChanged) this.onTerrain?.(spec);
    // Top up / retire bots toward the new spec count.
    const want = spec.bots ?? 0;
    if (this.bots.count < want) this.bots.populate(want - this.bots.count);
    else if (this.bots.count > want) {
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
    const pendingGrace = this.disconnected.get(playerId);
    if (pendingGrace) {
      clearTimeout(pendingGrace.timeout);
      this.disconnected.delete(playerId);
    }
    this.lastSentPositions.delete(playerId);
    this.connections.broadcast({ type: 'playerLeft', playerId });
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
      this.broadcast({ type: 'teamUpdate', playerId: p.id, team: small });
      counts[big]--;
      counts[small]++;
    }
  }
}
