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
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { RoomMoveSim } from './RoomMoveSim.ts';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES, pickTeam, makeScores, bank, winner, type ModeId, type ModeSpec, type TeamScores } from '../../shared/teams.ts';
import { ServerBots } from './ServerBots.ts';
import { RoomFlags } from './RoomFlags.ts';
import { RoomPickups } from './RoomPickups.ts';
import { RoomArena } from './RoomArena.ts';
import { RoomDeployables } from './RoomDeployables.ts';
import { RoomProjectiles } from './RoomProjectiles.ts';
import type { PlayerState, Vec3 } from './types.ts';
import { CLASS_STATS } from '../../shared/botClasses.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { POWERUP, rollCreatureDrop, type PowerupKind } from '../../shared/pickups.ts';
import { ENERGY } from '../../shared/movement.ts';
import { perkMods } from '../../shared/perks.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { MatchClock, type MatchHost } from './roomMatch.ts';

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

  /** Per-player K/D at the horn — the match journal's useful payload. */
  private matchPlayers(): { id: string; team?: string; kills: number; deaths: number }[] {
    return [...this.players.getAllPlayers().values()].map((p) => ({
      id: p.id, team: p.team, kills: p.kills, deaths: p.deaths,
    }));
  }

  /** Push the player's armor-class ground multiplier into its shadow —
   *  the single place class→speedScale mapping is read. */
  private applyClassScale(playerId: string): void {
    const cls = this.players.getPlayer(playerId)?.armorClass as 'light' | 'medium' | 'heavy' | undefined;
    this.moveSim.setSpeedScale(playerId, CLASS_STATS[cls ?? 'medium']?.speedScale ?? 1);
  }

  /** Room's current heightfield — GameServer updates it on terrain
   *  attach/rotation so gameplay code can resolve ground height. */
  field: Heightfield | null = null;

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
    this.ballSim.onKilled = (by, pos, variant) => this.creatureKill(by, pos, variant);
    this.ballSim.colliders = structureColliders(this.spec.structures);
    if (this.spec.ballMix) this.ballSim.ballMix = this.spec.ballMix;
    if (this.spec.spawns) this.players.spawnPoints = this.spec.spawns;
    this.messages.setBallSim(this.ballSim);
    if (field) this.ballSim.attachField(field);
    // Server-authoritative melee species — the crawl* wire events are the
    // state-edge stream (retarget/windup/pounce/bite/die); clients replay
    // the seeded hop sim between them.
    this.creatureSim = new CreatureSim(
      this.players,
      (msg) => this.connections.broadcast(msg),
      (pid, msg) => this.connections.sendToPlayer(pid, msg),
    );
    this.creatureSim.pops = this.spec.creatures ?? {};
    this.creatureSim.colliders = this.ballSim.colliders;
    this.creatureSim.onBite = (c, targetId) => {
      // dep:N ids are deployables — gnaw their hp, not a player.
      if (targetId.startsWith('dep:')) {
        this.deployables.gnaw(targetId, c.biteDamage);
        return;
      }
      this.messages.crawlerBite(targetId, c.biteDamage, c.species, { x: c.x, y: c.y, z: c.z });
    };
    this.creatureSim.extraTargets = () => this.deployables.creatureTargets();
    this.creatureSim.targetPos = (id) => id.startsWith('dep:') ? this.deployables.posOf(id) : null;
    this.creatureSim.onDetonate = (b) => {
      const pos = { x: b.x, y: b.y, z: b.z };
      this.messages.mineBlast('environment', pos, b.biteDamage, b.blastRadius, 14);
      this.pushNoise(pos); // bots hear the pop like any other blast
    };
    this.creatureSim.onKilled = (by, pos) => this.creatureKill(by, pos, 0);
    this.messages.setCreatureSim(this.creatureSim);
    if (field) this.creatureSim.attachField(field);
    this.bots = new ServerBots(this, field);
    // Bots populate before humans join so team balancing puts humans on
    // the emptier side.
    if (this.spec.bots) this.bots.populate(this.spec.bots);
    this.wireModeFeatures(field);
    this.deployables = new RoomDeployables(this);
    this.projectiles = new RoomProjectiles(this, field);
    this.projectiles.attachStructures(this.spec.structures);
    this.registerSims();
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
        // Gems back the collector's next heal claim; kill-confirmed tags
        // are pure score — no resource bundled into the same pickup.
        if (kind === 'gem') {
          p.healCredit += 25;
          // Client refills half the energy tank on a gem — the shadow
          // must too or the next jet run diverges for honest reasons.
          this.moveSim.grantEnergy(pid, ENERGY.max * 0.5 * perkMods(p.perk).energyMax);
        }
        const team = p.team;
        if (team === 'alpha' || team === 'bravo') this.score(team);
        return;
      }
      this.applyPowerup(p, kind);
    };
    if (this.modeSpec?.flags && bases?.alpha && bases?.bravo) {
      // Spec y is advisory — flags live on the ground, so touch checks
      // measure feet-to-flag, not feet-to-arbitrary-height.
      const snap = (v: { x: number; y: number; z: number }) => ({
        ...v,
        y: field ? hmHeight(field, v.x, v.z) : v.y,
      });
      this.flags = new RoomFlags(this, { alpha: snap(bases.alpha), bravo: snap(bases.bravo) });
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

  /** Per-player scoreboard for FFA modes (dm). Bots are in the same map —
   *  a bot can legitimately win a deathmatch. */
  readonly ffaScores = new Map<string, number>();

  /** Creature kill — ballDie attribution from BallSim. FFA modes award
   *  the killer directly; team modes drop a nugget at the corpse that
   *  anyone must touch to bank (kill-confirmed style scoring). */
  private creatureKill(by: string, pos: Vec3, variant = 0): void {
    // The economy runs on kills — soak validation needs these visible.
    logger.info('Creature killed', { room: this.name, by, variant });
    // Powerup drops roll in EVERY mode — the pickup does the granting.
    const powerup = rollCreatureDrop();
    // Creatures die mid-flight — the drop must land on the ground or the
    // dy<=6 pickup grab can never reach it and the economy starves.
    const gy = (this.field ? hmHeight(this.field, pos.x, pos.z) : pos.y) + 0.5;
    if (powerup) {
      this.pickups?.spawn({ x: pos.x + (this.rng() - 0.5) * 2, y: gy, z: pos.z + (this.rng() - 0.5) * 2 }, powerup);
    }
    const spec = this.modeSpec;
    if (spec?.teams) {
      // Pay for the corpse's threat: variant 3 elites and v2 tanks drop a
      // burst, fodder still drops one (same scale curve the client uses).
      const drops = [1, 2, 3, 3][variant] ?? 1;
      for (let i = 0; i < drops; i++) {
        this.pickups?.spawn({ x: pos.x + (this.rng() - 0.5) * 2, y: gy, z: pos.z + (this.rng() - 0.5) * 2 });
      }
      return;
    }
    if (!spec?.ffa || spec.ptsCreatureKill <= 0 || !this.players.getPlayer(by)) return;
    this.awardFfa(by, spec.ptsCreatureKill);
  }

  /** Powerup pickup resolution — buffs are server-owned so a client can
   *  never claim regen/dd it didn't touch. Bots collect too: they read
   *  the fields directly, no wire message needed for them. */
  private applyPowerup(p: PlayerState, kind: PowerupKind): void {
    const now = Date.now();
    const buff: Extract<ServerMessage, { type: 'buff' }> = { type: 'buff', kind };
    if (kind === 'heal') {
      p.health = Math.min(p.maxHealth, p.health + POWERUP.heal);
      buff.health = p.health;
    } else if (kind === 'armor') {
      p.armor = Math.min(POWERUP.maxArmor, p.armor + POWERUP.armor);
      buff.armor = p.armor;
    } else if (kind === 'regen') {
      p.regenUntil = now + POWERUP.regenMs;
      buff.until = p.regenUntil;
    } else {
      p.ddUntil = now + POWERUP.ddMs;
      buff.until = p.ddUntil;
    }
    p.forceSendUntil = now + 500; // buffed health/status rides the next ticks
    this.connections.sendToPlayer(p.id, buff);
  }

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
      ffaScores: () => Object.fromEntries(this.ffaScores),
      bases: this.spec.bases,
      structures: this.spec.structures,
      arena: this.spec.arena,
      ambient: this.spec.ambient,
      terrain: this.spec.terrain,
      terrainTex: this.spec.terrainTex,
      sky: this.spec.sky,
      interiors: this.spec.interiors,
      onKill: (pid, shooter) => this.onKill(pid, shooter),
      onHit: (pid, shooter) => this.bots.flinch(pid, shooter),
      flags: () => this.flags?.snapshot() ?? [],
      pickups: () => this.pickups?.snapshot() ?? [],
      onDeploy: (pid, kind, pos) => this.deployables.handleDeploy(pid, kind, pos),
      onRepair: (pid, targetId) => this.deployables.repair(pid, targetId),
      deployBlast: (pos, damage, radius, shooter) => this.deployables.applyBlast(pos, damage, radius, shooter),
      creatureArmor: (pos, amount, radius) => {
        this.ballSim.armorBlast(pos, radius, amount);
        this.creatureSim.armorBlast(pos, radius, amount);
      },
      deployables: () => this.deployables.snapshot(),
      matchEndsAt: () => this.matchClock.timeLeftMs() > 0 ? Date.now() + this.matchClock.timeLeftMs() : 0,
      moveInput: (pid, i, status, seq) => this.moveSim.setInput(pid, {
        forward: i.forward, right: i.right,
        jumpPressed: !!i.jump, jumpHeld: !!i.jump, skiHeld: !!i.ski,
        jetHeld: !!i.jet,
      }, status, seq),
      moveReport: (pid, pos, yaw, vel, inputSeq) => this.moveSim.reconcile(pid, pos, yaw, vel, inputSeq),
      moveImpulse: (pid, dv) => this.moveSim.applyImpulse(pid, dv),
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
      moveAuthority: () => this.moveAuthority,
      health: this.health,
      envRange: (pid) => {
        const p = this.players.getPlayer(pid);
        return p ? this.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z) : Infinity;
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
      ffaScores: this.ffaScores,
      getHumanCount: () => this.players.getHumanCount(),
      matchPlayers: () => this.matchPlayers(),
      broadcast: (msg) => this.broadcast(msg),
      endCleanup: () => {
        this.flags?.reset();
        this.pickups?.clear();
        this.deployables.clearAll();
        this.players.resetStats();
      },
      rotate: () => this.onRotate?.() ?? null,
      applySpec: (s) => this.applySpec(s),
      onMatchEnd: (r) => this.onMatchEnd?.(r),
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

  private endMatch(w: string): void {
    this.matchClock.end(w);
  }

  private awardFfa(id: string, n: number): void {
    const spec = this.modeSpec!;
    const pts = (this.ffaScores.get(id) ?? 0) + n;
    this.ffaScores.set(id, pts);
    this.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: spec.winAt });
    if (pts >= spec.winAt) this.endMatch(id);
  }

  /** Kill hook from the damage funnel: flag drop in every mode, frag
   *  points in FFA rooms. 'environment' shooters score nothing. */
  private onKill(targetId: string, shooterId: string): void {
    this.flagCarrierDied(targetId);
    this.deployables.clearOwner(targetId);
    // A death is audible — nearby idle bots drift toward the kill spot.
    const corpse = this.players.getPlayer(targetId);
    if (corpse) this.pushNoise(corpse.position);
    const spec = this.modeSpec;
    const shooter = this.players.getPlayer(shooterId);
    if (!spec || !shooter || spec.ptsPlayerKill <= 0) return;
    if (spec.ffa) this.awardFfa(shooterId, spec.ptsPlayerKill);
    else if (shooter.team) {
      this.score(shooter.team, spec.ptsPlayerKill);
      // Kill-confirmed mode (tdm): the corpse drops a tag that ANY team
      // can pick up for another point — deny by grabbing it first.
      const t = this.players.getPlayer(targetId);
      if (this.mode === 'tdm' && t) this.pickups?.spawn(t.position, 'tag');
    }
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: 'alpha' | 'bravo', n = 1): void {
    if (!this.modeSpec?.teams) return;
    bank(this.scores, team, n);
    this.broadcast({ type: 'teamScore', scores: { ...this.scores }, winAt: this.modeSpec.winAt });
    const w = winner(this.scores, this.modeSpec.winAt);
    if (w) this.endMatch(w);
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
    const now = Date.now();
    while (this.noises.length && now - this.noises[0]!.at > Room.NOISE_TTL) this.noises.shift();
    this.noises.push({ pos: { ...pos }, at: now });
    if (this.noises.length > Room.NOISE_MAX) this.noises.shift();
  }

  /** Recent noise positions within earshot of pos (no LOS required). */
  noisesNear(pos: Vec3, radius: number): Vec3[] {
    const now = Date.now();
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
  nextTeam(): 'alpha' | 'bravo' | undefined {
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
    this.ballSim.colliders = structureColliders(spec.structures);
    this.moveSim.attachStructures(spec.structures);
    this.projectiles.attachStructures(spec.structures);
    if (spec.balls) this.ballSim.population = spec.balls;
    if (spec.ballMix) this.ballSim.ballMix = spec.ballMix;
    this.creatureSim.pops = spec.creatures ?? {};
    this.creatureSim.colliders = this.ballSim.colliders;
    this.messages.setMap(spec.bases, spec.structures, spec.arena, spec.ambient, spec.terrain, spec.terrainTex, spec.sky, spec.interiors);
    this.broadcast({
      type: 'mapUpdate',
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
    if (this.ffaScores.delete(playerId)) {
      this.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: this.modeSpec!.winAt });
    }
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
