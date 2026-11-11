/**
 * Room  -  one match's worth of state: players, sockets, rate limits,
 * message routing, and its own BallSim. GameServer holds a rooms map and
 * dispatches connections to them; today every player lands in "default",
 * but the seam is what turns matchmaking/lobbies/multi-match servers into
 * plumbing instead of surgery.
 *
 * Deliberately owns NO transport specifics beyond the broadcast/send
 * closures it hands to its children  -  a room is just "everyone who shares
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
import { NOISE_TTL_MS , type V4Last, encodeHit, encodeWidPos, encodeShotEv, WIRE_E_LANDED } from '../../shared/wire.ts';
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
import { RoomIntel } from './serverIntel.ts';
import { RoomProjectiles } from './RoomProjectiles.ts';
import type { PlayerState, Vec3, ClientMessage,WebSocketData } from './types.ts';
import { CLASS_STATS, classCapsule, classCanFire, type ArmorClass } from '../../shared/botClasses.ts';
import { inv, setInvariantSink } from '../../shared/invariants.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { ServerMessage, RoomMods } from '../../shared/protocol.ts';
import { WORLD_MODEL, verbPayload, eventPayload } from '../../shared/worldModel.ts';
import { decomposeTokens, POWERUP } from '../../shared/pickups.ts';
import { botRand, tauntRand } from '../../shared/botRand.ts';
import { lcg32, type Lcg } from '../../shared/simRand.ts';
import { MatchClock, type MatchHost } from './roomMatch.ts';
import { EventBus } from './roomEvents.ts';
import { MODE_MODULES, type ModeModule } from './modeModules.ts';
import { RoomScore } from './roomScore.ts';
import { ENERGY, MOVEMENT_CONFIG, type BodyCapsule } from '../../shared/movement.ts';
import { BELT_MAX, serverSimmed, isInstagibWeapon, WeaponType } from '../../shared/weapons.ts';
import { gunGameClimax, gunGameAllows, gunGameRoll, igunChassis } from '../../shared/gunGame.ts';
import { chatKindFor, vgsCommandFor, radioAimFor } from '../../shared/botTaunts.ts';
import { perkMods, isPerkId } from '../../shared/perks.ts';
import { healPool } from './healPool.ts';
import { collectServerResult, writeMatchResult } from './matchResults.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import type { ServerWebSocket } from 'bun';

import { simNow, simMs } from './simClock.ts';
import { STATUS, SHOOT_REVEAL_S } from '../../shared/status.ts';
import { wallNow, wallMs, type WallMs } from './wallClock.ts';
import type { SessionRegistry } from './sessionRegistry.ts';
import { SimJournal } from './simJournal.ts';
import { RoomDemo } from './roomDemo.ts';

export class Room {
  readonly name: string;
  /** Room modifiers - the single truth for every creation-time gate:
   *  unlisted hides the room, noCreatures/noBalls strip ambient sims,
   *  instagib is the railgun kit lock, gungame/igun own the weapon
   *  ladder (+ flat ~200 damage for igun). roomFactory writes the whole
   *  object on mint and on bot-only adoption; consumers read through
   *  mods() so a post-construction flip can never go stale. */
  mods: RoomMods = {};
  // First joiner's mode locks the match  -  later joins inherit it via
  // gameState rather than a per-client URL param.
  readonly mode: string;
  readonly players = new PlayerManager();
  readonly connections = new ConnectionManager();
  readonly rateLimiter = new RateLimiter();
  readonly messages: MessageHandler;
  readonly ballSim: BallSim;
  readonly creatureSim: CreatureSim;
  /** Host-side randomness (loot scatter)  -  tests inject a seeded fn.
   *  Defaults to the injectable botRand stream: construction-time
   *  consumers (bot populate → spawn scatter) run before a harness can
   *  assign `room.rng`, so a plain Math.random default made every room
   *  after the first diverge  -  spawn layout is part of the seed.
   *  Production rooms get a minted private stream instead (ctor `seed`
   *  param) so a recorded match can replay its draw sequence. */
  rng: () => number = (): number => botRand();
  /** Minted room seed + the private stream it drives  -  undefined on
   *  harness rooms (they keep the injectable botRand default). The pair
   *  is the replay/sync-report surface: {rngSeed, state, draws}. */
  rngSeed?: number;
  rngStream?: Lcg;

  /** Grace seats live on the registry session itself (timer included)  - 
   *  assigned post-ctor by the factory. `graceInRoom` replaces the old
   *  per-room disconnected map so the countdown can't outlive the
   *  session it belongs to. */
  sessions?: SessionRegistry;
  /** Watching sockets  -  no player record, get broadcasts + ticks. */
  readonly spectators = new Set<string>();
  /** Weapon-attributed kills - soaks read this to separate "the item
   *  earned it" from "the carrier earned it". WeaponType → count. */
  readonly killsByWeapon = new Map<number, number>();
  /** Room-scoped u16 record ids for v3 tick frames  -  minted lazily on a
   *  player's first record (tickRecords); joiners get the snapshot inside
   *  gameState, everyone else via 'wireIds' deltas broadcast before the
   *  frames that need them. Ids are finite (u16), so a departing player
   *  releases theirs into wireIdRetired  -  after a quiet window the mint
   *  prefers recycled ids over burning toward the 65536 wrap, where
   *  setUint16 would silently alias a live teammate's binding. */
  readonly wireIds = new Map<string, number>();
  /** Spawn pacing: joiner playerId → seat ids still un-admitted to its
   *  world. gameState ships only admitted seats; the fanout admits a few
   *  per tick via direct playerJoined and gates their records meanwhile  - 
   *  an unpaced world sends its biggest tick to the peer least able to
   *  take it (the joiner mid-handshake). */
  readonly admitPending = new Map<string, Set<string>>();
  /** wireId → wall-ms it was released at. */
  readonly wireIdRetired = new Map<number, number>();
  /** wireId → v4 delta-compare basis (last-ENCODED values). Keyed by
   *  wireId, not by pooled-record slot: slot↔player binding shuffles on
   *  every join/leave/suppression, and a slot-carried basis would emit a
   *  mask computed against a different player's values. */
  readonly v4Last = new Map<number, V4Last>();
  nextWireId = 1;
  readonly sessionTokens = new Map<string, string>();
  /** Reconnect shields armed per seat  -  a deliberate flap chains 2.5s
   *  invulnerability windows forever without a cap. */
  readonly reclaimShields = new Map<string, number>();
  readonly lastSentPositions = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; jet: number; status: number; sheep: number; t: number }>();
  tickSeq = 0;
  /** Room-wide full-record window  -  stamped by tickNack reseeds (every
   *  client's basis may be corrupt, so EVERYONE gets fulls for ~1s).
   *  Per-joiner fulls ride `introPlayers` instead: a fresh seat no longer
   *  poisons the delta stream for the whole room. */
  introSeq = -1_000_000;
  /** Per-recipient intro window: pid → seat tickSeq. tickRecords sends
   *  these recipients a per-socket FULL copy of each record (~1s window)
   *  while everyone else stays on deltas  -  the joiner's decode baseline
   *  lands without doubling the room's egress. Swept by age in
   *  buildRecords. */
  readonly introPlayers = new Map<string, number>();
  /** Wall-clock of the last accepted tickNack  -  room-wide cooldown above. */
  private lastNackAt = 0;

  /** Stamp a fresh/reclaimed/spectator seat's per-recipient intro window.
   *  Also clears lastSentPositions so every live player emits at least
   *  one record inside the window  -  otherwise a suppressed/idle player
   *  could sit out all 20 ticks and the recipient's first post-window
   *  masked delta would decode against a zero basis. Costs ≤1 extra
   *  record per player per stamp. */
  /** A held-off-spawn seat reported ready  -  materialize the body: the
   *  player record existed since seat() but isDead held it out of every
   *  physical funnel and awaitingReady out of every visible channel.
   *  Dead seats re-arm their respawn timer (onPlayerReconnected armed
   *  one that the awaitingReady guard inside respawnPlayer consumed). */
  releaseReady(playerId: string): void {
    const released = this.players.releaseSpawn(playerId);
    if (released?.dead) {this.messages.combat.ensureRespawn(playerId);}
  }

  markIntro(pid: string): void {
    this.introPlayers.set(pid, this.tickSeq);
    this.lastSentPositions.clear();
  }

  /** Rolling health counters for the room heartbeat  -  every subsystem
   *  bumps tagged keys (shot claims, rejects, corrections, desyncs,
   *  implausible damage) and healthTick flushes them to one INFO line
   *  every ~15s so a soak log answers "did anything weird happen" at a
   *  glance instead of needing per-event archaeology. */
  readonly health = new Map<string, number>();
  /** Mutual engagement for the fanout cap: victim -> attacker -> expiry
   *  (wall ms). A player who's shooting you must never lose the record
   *  lottery to a distant idle - the cap scorer boosts engaged records
   *  past even the aim-cone. Bumped on every wireHit; lazily pruned. */
  readonly engagedBy = new Map<string, Map<string, number>>();
  private static readonly ENGAGE_MS = 4000;
  noteEngagement(shooterId: string, victimId: string): void {
    if (shooterId === victimId) {return;}
    let m = this.engagedBy.get(victimId);
    if (!m) {m = new Map(); this.engagedBy.set(victimId, m);}
    m.set(shooterId, wallNow() + Room.ENGAGE_MS);
  }
  /** Attackers currently engaged with `victimId` (expired pruned on read). */
  engagementOf(victimId: string): Map<string, number> | undefined {
    const m = this.engagedBy.get(victimId);
    if (!m) {return undefined;}
    const now = wallNow();
    for (const [k, t] of m) {if (t < now) {m.delete(k);}}
    if (m.size === 0) {this.engagedBy.delete(victimId); return undefined;}
    return m;
  }
  /** Since-boot totals  -  the rollup window clears per flush, so /metrics
   *  reads this cumulative mirror instead of racing it. */
  readonly healthTotal = new Map<string, number>();
  /** Domain-event channel  -  combat/chat notifications (kill/hit/fire/
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
    // Fold the window into since-boot totals. *Max keys are gauges (the
    // worst single sample), not counters  -  merge by max, not sum.
    for (const [k, v] of this.health) {
      this.healthTotal.set(k, k.endsWith('Max')
        ? Math.max(this.healthTotal.get(k) ?? 0, v)
        : (this.healthTotal.get(k) ?? 0) + v);
    }
    this.health.clear();
  }

  /** Buried-body failsafe: every sim path should pull a body back to the
   *  surface in one tick, but authored spawns, stale shadows and legacy
   *  writes have all leaked players under the field. Cheap sweep: feet
   *  below the terrain gets lifted to the surface and the shadow reseated
   *  so client and server agree. Counted in room health  -  if the number
   *  stays nonzero there's a real leak to hunt. */
  private unburyAcc = 0;
  private unburyLogN = 0;
  /** Leaderboard receipt minter  -  roomFactory wires one per room onto the
   *  event bus; roomMatch mints the signed token at matchEnd. Optional:
   *  unsigned dev rooms still get the record, just no signature. */
  resultSigner: import('./resultSigner.ts').ResultSigner | null = null;
  private unburyTick(dt: number): void {
    if (!this.field) {return;}
    this.unburyAcc += dt;
    if (this.unburyAcc < 0.5) {return;}
    this.unburyAcc = 0;
    this.unburySweep();
  }

  /** The room's real field landed (attachTerrain)  -  seats picked before
   *  it resolved kept authored anchor y (groundAt read 0/stale), leaving
   *  bodies meters under the surface the client will draw. One sweep,
   *  including seats that never reported: a server-picked spawn under
   *  the real terrain is our bug to lift, not a claim to honor. */
  unburySeats(): void {
    if (!this.field) {return;}
    this.unburySweep(true);
  }

  private unburySweep(includeUnreported = false): void {
    if (!this.field) {return;}
    for (const p of this.players.getAllPlayers().values()) {
      this.unburyCheck(p, includeUnreported);
    }
  }

  /** One body's ground-law check. Measure with the shadow's own eye when
   *  one exists - the class capsule and the sim body disagree whenever a
   *  refit left the sim at the default eye, and the record's view was the
   *  stale one. Judge each body on the floor it sims on: bot shadows ride
   *  the chord-augmented surface (what remotes draw), human shadows the
   *  plain field - a field-grounded human in a gully is legitimately
   *  under the drawn chord, and popping their claim is a phantom
   *  correction. Remote-side render lift owns the visual clearance.
   *  pos.y IS the eye point - "feet" would double-subtract the eye and
   *  phantom-bury every banded contact (a grounded heavy legally rides
   *  its eye ~0.5 under the floor in the snap window). Buried means the
   *  EYE itself is below the surface. */
  private unburyCheck(p: PlayerState, includeUnreported: boolean): void {
    const field = this.field!;
    if (p.isDead || (!p.isBot && !p.hasReceivedPosition && !includeUnreported)) {return;}
    const eye = this.moveSim.eyeOf(p.id) ?? classCapsule(p.armorClass as ArmorClass).eye;
    const terrain = p.isBot
      ? Math.max(hmHeight(field, p.position.x, p.position.z), hmChord(field, p.position.x, p.position.z))
      : hmHeight(field, p.position.x, p.position.z);
    // The ground law as an invariant - scoped to sim-owned bodies.
    // A bot's record mirrors its shadow every tick (botDrive), so a
    // buried bot record IS a violation. Human records are claims -
    // a lagged claim under the surface is lag, not a bug.
    if (p.isBot) {inv('bot-below-ground', !Number.isFinite(terrain) || p.position.y >= terrain - 0.5,
      { id: p.id, xz: `${p.position.x.toFixed(1)},${p.position.z.toFixed(1)}`, y: Number(p.position.y.toFixed(1)), eye, terrain: Number.isFinite(terrain) ? Number(terrain.toFixed(1)) : 'n/a', dbg: this.moveSim.unburyDebug(p.id) });}
    if (!Number.isFinite(terrain) || p.position.y >= terrain - 0.5) {return;}
    // First rescues carry the autopsy at debug level - the 'unbury'
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

  spec: MapSpec; // mutable  -  admin hot-reload rewrites it live
  // Server-owned match scoreboard  -  only populated in team modes.
  readonly modeSpec: ModeSpec | null;
  readonly scores: TeamScores = makeScores();
  /** Server-driven filler players, populated from the map spec. */
  readonly bots: ServerBots;
  /** CTF flag authority  -  only when the mode has flags AND the map has bases. */
  flags: RoomFlags | null = null;
  /** Server-side demo capture  -  set when FPS_DEMO names a dir at ctor. */
  demo?: RoomDemo;
  /** The pluggable mode's module (MODE_MODULES registry)  -  owns its sims,
   *  wire feed, bot objective and spawn pools behind one seam. */
  modeModule: ModeModule | null = null;
  // Flag/deploy placement domain  -  standTop surfaces, shelf rescue,
  // deploy floor, home re-snap  -  lives in roomFlagPlacer.ts. The
  // callbacks carry the two room-level effects a re-snap has (structure
  // collider re-attach + skinny mapUpdate push; spawn-anchor re-seat).
  // Declared before the ctor's wireModeFeatures/flags init uses it.
  readonly flagPlacer = new FlagPlacer(this,
    (broadcast): void => { this.structs.attach(); if (broadcast) {this.structs.pushUpdate();} },
    (snapped): void => {
      if (this.modeSpec?.teams && this.modeSpec.flags) {
        this.players.teamBases = { alpha: Object.assign({}, snapped.alpha), bravo: Object.assign({}, snapped.bravo) };
      }
    },
    (rings): void => {
      // Auto-derived stands mint their own spawn rings  -  but only flag
      // modes adopt them (tdm/headhunt spawn off bases they don't play),
      // and authored teamSpawns still win either way.
      if (this.modeSpec?.teams && this.modeSpec.flags && !this.spec.teamSpawns) {
        this.players.teamSpawns = rings;
      }
    });
  /** Effective structure set (authored + dais hulls) and everywhere it
   *  feeds  -  colliders, join echo, skinny mapUpdate diff  -  lives in
   *  roomStructures.ts. Reads live state through this, so declare it
   *  after flagPlacer which the eff list consults. */
  readonly structs = new RoomStructures(this);

  /** Direct carrier check  -  snapshot() clones every flag just to answer
   *  "is id carrying", and per-tick callers (checkStuck, propel gate)
   *  paid it every bot every tick. */
  flagCarriedBy(playerId: string): boolean {
    if (!this.flags) {return false;}
    for (const f of this.flags.flags.values()) {if (f.carrier === playerId) {return true;}}
    return false;
  }
  /** Server-owned ground loot  -  gems/tags score in team modes, powerups
   *  (heal/armor/regen/dd) drop from creature kills in every mode. */
  pickups: RoomPickups | null = null;
  /** Server-owned deployables  -  turrets/mines/stations/drones a `deploy`
   *  claim plants; caps + TTL + teardown live here. */
  readonly deployables: RoomDeployables;
  /** Server-truth IFF - per-viewer detection contacts (sensor net +
   *  personal LOS, recon perk memory) feeding the 'intel' wire feed. */
  readonly intel: RoomIntel;
  /** Server-simulated projectiles  -  bot fire spawns real shells here
   *  instead of rolled hitscan (bots-as-legal-players phase 2). */
  readonly projectiles: RoomProjectiles;
  /** Server-side simulations ticked each room tick, in order. A sim
   *  with worldState() also emits its join/resync replay frames (roster
   *  snapshots), so sendWorldState iterates this registry instead of
   *  naming each sim. */
  readonly sims: { name?: string; tick(dt: number): void; worldState?(): ServerMessage[] }[] = [];

  /** Wall ms of the last room tick  -  TickLoop turns the gap into the dt
   *  every sim sees, so interval lag can't drift sim clocks off wall time. */
  lastStepAt = 0;

  /** Inbound client messages park here until the next tick drains them  - 
   *  the Quake/Valve command-buffer pattern: all input lands at phase 0
   *  so sims see a deterministic order (input → sim → fanout) instead of
   *  arrival-time mutations interleaving with bot/projectile ticks. */
  readonly commands: { playerId: string; msg: ClientMessage; at: WallMs }[] = [];
  drainCommands(): void {
    if (this.commands.length === 0) {return;}
    // Sub-tick ordering (the CS2 answer to "I fired first but lost"):
    // claims carrying fireAt adjudicate in click-instant order, not
    // packet-arrival order  -  two shooters inside one 50ms tick resolve
    // by who actually fired first, not whose packet won the wire race.
    // fireAt is the shooter's own server-clock stamp, so clamp it to the
    // physically possible window (arrival − 2× measured uplink transit,
    // minus margin): a skewed/forged stamp degrades to arrival order
    // rather than buying free rewind priority. Unstamped commands keep
    // their arrival slot (sort is stable).
    if (this.commands.length > 1) {
      const key = (c: { playerId: string; msg: ClientMessage; at: WallMs }): number => {
        const f = (c.msg as { fireAt?: number }).fireAt;
        if (typeof f !== 'number' || !Number.isFinite(f)) {return c.at;}
        const transit = this.moveSim.transitOf(c.playerId);
        const jit = this.moveSim.transitVarOf(c.playerId);
        // Margin scales with the link: honest fireAt error IS uplink
        // jitter (the client estimates transit from the same noisy
        // channel), so 4×jitter + 50ms floor covers honest clocks while
        // shrinking the forgeable window from 100ms on stable links.
        return Math.max(Math.min(f, c.at), c.at - (transit * 2 + jit * 4 + 50));
      };
      this.commands.sort((a, b): number => key(a) - key(b));
    }
    for (const c of this.commands) {
      // Contain per command: a throwing handler must not kill the rest
      // of the drain (and the tick that hosts it)  -  the client's binary
      // dispatch got the same treatment; one malformed input = one
      // counted drop, never a stalled queue.
      try { this.messages.handleMessage(c.playerId, c.msg, c.at); }
      catch (error) {
        this.messages.hb('handlerThrow');
        this.messages.hb(`handlerThrow.${c.msg.type}`);
        logger.warn('Handler threw  -  contained, counted', { room: this.name, playerId: c.playerId, type: c.msg.type, error });
      }
    }
    this.commands.length = 0;
  }

  /** Arrival-time muzzle relay - the cosmetic playerShot flash doesn't
   *  adjudicate anything, so it needn't wait ~0-50ms in the command
   *  buffer for the drain. Stamped, cosmetic-path intents only:
   *  projectile-spawning weapons get projectileCreated at drain anyway,
   *  and unstamped claims have no dedupe key so they relay at drain.
   *  The drain skips its own re-emit through earlyRelayed(). Read-only
   *  gates mirror the handler's front door (dead/class); state-mutating
   *  adjudication still happens at drain, in fireAt order. */
  private static readonly EARLY_RELAY_TTL_MS = 5000;
  private static readonly BEAM_INTENT_WTS = new Set<number>([WeaponType.Lightning, WeaponType.Shocklance, WeaponType.Repair, WeaponType.HealBeam]);
  private readonly earlyShots = new Map<string, number>();
  earlyShotRelay(playerId: string, msg: { shotId?: string; weaponType?: number; dir?: Vec3 }): void {
    if (!msg.shotId || msg.weaponType === undefined) {return;}
    const p = this.players.getPlayer(playerId);
    if (!p || p.isDead) {return;}
    // Gungame owns the weapon gate outright (the ladder crosses class
    // tiers on purpose); every other room keeps class + instagib.
    if (this.mods.gungame ? !this.gunGameAllowsFire(playerId, msg.weaponType)
        : (!classCanFire(p.armorClass, msg.weaponType)
          || (this.mods.instagib === true && !isInstagibWeapon(msg.weaponType)))) {return;}
    if (this.mods.gungame) {this.gunGameHeld(playerId, msg.weaponType);}
    // Only intents whose drain path emits a playerShot relay qualify:
    // melee swings, beam intents, and non-simmed weapons all land on the
    // cosmetic emit. A simmed non-beam weapon spawns a shell instead -
    // projectileCreated covers observers, an early flash would double it.
    const cosmetic = msg.weaponType === WeaponType.Melee
      || Room.BEAM_INTENT_WTS.has(msg.weaponType)
      || !serverSimmed(msg.weaponType);
    if (!cosmetic) {return;}
    const wid = this.wireIds.get(playerId);
    if (wid === undefined) {return;} // no binary id: drain's JSON fallback relays instead
    const key = `${playerId}:${msg.shotId}`;
    if (this.earlyShots.has(key)) {return;}
    const now = wallNow();
    this.earlyShots.set(key, now);
    for (const [k, t] of this.earlyShots) {if (now - t > Room.EARLY_RELAY_TTL_MS) {this.earlyShots.delete(k);}}
    if (this.earlyShots.size > 256) {this.earlyShots.delete(this.earlyShots.keys().next().value!);}
    // Origin is the live truth, not the drain's rewound claimOrigin -
    // a few ms of staleness on a cosmetic flash beats re-deriving the
    // rewind outside the adjudication path.
    this.connections.broadcastBinaryReliable(encodeShotEv(wid, msg.weaponType, p.position, msg.dir), 'volatile', playerId);
  }
  /** True when the early relay already flashed this shot - the drain's
   *  relay emit must skip it or observers see a double muzzle. */
  earlyRelayed(playerId: string, shotId?: string): boolean {
    return shotId !== undefined && this.earlyShots.has(`${playerId}:${shotId}`);
  }

  /** Ladder position - rung lives on the seat's PlayerState, so a
   *  grace-period reclaim keeps its climb for free. Absent = rung 0. */
  gunRungOf(playerId: string): number { return this.players.getPlayer(playerId)?.gunRung ?? 0; }

  /** The one weapon gate every gungame fire path consults: the rung's
   *  ladder weapon plus the Hook grapple (deals no damage - it can't
   *  farm rungs, and everyone keeps their traverse). */
  gunGameAllowsFire(playerId: string, weaponType: number): boolean {
    return gunGameAllows(this.gunRungOf(playerId), weaponType, this.mods.igun === true);
  }

  /** Bucket pick edge: a gungame fire claim names the member the player
   *  actually shouldered - roster weapon (remote viewmodel) and the igun
   *  chassis follow the real pick, not the bucket's first member. */
  gunGameHeld(playerId: string, weaponType: number): void {
    const p = this.players.getPlayer(playerId);
    if (!p || p.weapon === weaponType) {return;}
    p.weapon = weaponType;
    this.igunClassSync(playerId);
  }

  /** Rung edge → wire + roster weapon. Only the owner needs the number:
   *  remotes read a player's gun off their own fires (p.weapon rides
   *  the roster), so the push goes to one socket. */
  private setGunRung(playerId: string, rung: number): void {
    const r = Math.max(0, Math.min(gunGameClimax(this.mods.igun === true), Math.floor(rung)));
    const p = this.players.getPlayer(playerId);
    if (!p) {return;}
    p.gunRung = r;
    // Bucket roll: the rung deals one member - luck, not a pick. The wire
    // carries the draw so the client's locked band mirrors the same gun.
    p.weapon = gunGameRoll(r, this.mods.igun === true, this.rng());
    this.igunClassSync(playerId);
    this.sendToPlayer(playerId, { type: 'gunRung', rung: r, wt: p.weapon });
  }

  /** igun chassis edge: the body follows the rung weapon's tier. Humans
   *  ride applyClaimedClass (the claim arg is dead under igun anyway);
   *  bots ride the roster's applyClass so its health-delta bookkeeping
   *  and the `classes` map stay consistent. */
  private igunClassSync(playerId: string): void {
    if (this.mods.igun !== true) {return;}
    const p = this.players.getPlayer(playerId);
    if (!p) {return;}
    if (p.isBot) {this.bots.syncIgunClass(playerId);}
    else {this.applyClaimedClass(playerId, '');}
  }

  /** Join/reclaim edge: seat the ladder rung - roster weapon + the owner
   *  push that locks the client's band. Call AFTER the handshake's
   *  gameState so the client's kit lock exists when the rung lands;
   *  reclaim re-reads the stored rung so a grace-window return keeps
   *  its climb. */
  gunGameSeat(playerId: string): void {
    if (this.mods.gungame !== true) {return;}
    const p = this.players.getPlayer(playerId);
    if (!p) {return;}
    const r = p.gunRung ?? 0;
    p.weapon = gunGameRoll(r, this.mods.igun === true, this.rng());
    this.igunClassSync(playerId);
    this.sendToPlayer(playerId, { type: 'gunRung', rung: r, wt: p.weapon });
  }

  /** New match = fresh ladders: every seat back to rung 0 (roster weapon
   *  + owner push), then respawnAll lands bodies on the new spec. */
  gunGameReset(): void {
    if (this.mods.gungame !== true) {return;}
    for (const p of this.players.getAllPlayers().values()) {
      p.gunRung = 0;
      p.weapon = gunGameRoll(0, this.mods.igun === true, this.rng());
      this.igunClassSync(p.id);
      this.sendToPlayer(p.id, { type: 'gunRung', rung: 0, wt: p.weapon });
    }
  }

  /** Gun-game ladder edges off the shared kill bus: a player frag
   *  advances the shooter one rung (climax holds - frag count decides
   *  the match), the victim drops to rung 0. Environment/self kills
   *  move nobody. Every damage funnel emits 'kill', so shells, beams,
   *  melee and deployables all feed the ladder. */
  private gunGameOnKill(targetId: string, shooterId: string): void {
    if (this.mods.gungame !== true) {return;}
    if (this.players.getPlayer(targetId)) {this.setGunRung(targetId, 0);}
    if (shooterId === 'environment' || shooterId === targetId) {return;}
    if (this.players.getPlayer(shooterId)) {this.setGunRung(shooterId, this.gunRungOf(shooterId) + 1);}
  }
  /** Spatial memory  -  kills/fights/gems/flags leave decaying scent the
   *  brains read for where-the-action-was. See influenceMap.ts. Sized to
   *  the map's tile span; resized by applySpec when that changes. */
  readonly influence: InfluenceMap;
  /** Per-player movement shadow  -  MoveSim fed by inputMove, reconciled
   *  against reported positions. Judge mode: reported pos stays truth,
   *  divergence is the anti-cheat signal. Authority mode
   *  (FPS_MOVE_AUTHORITY): sim pos IS truth  -  GameServer's tick commits
   *  it into the player record and reports only carry aim/ping/liveness. */
  readonly moveSim: RoomMoveSim;
  readonly moveAuthority: boolean;
  /** Match-results journal hook  -  GameServer writes matches.jsonl and
   *  feeds /matches from it. Fired on every win condition. */
  onMatchEnd?: (record: { room: string; mode: string; winner: string; scores: Record<string, number>; players: { id: string; team?: string; kills: number; deaths: number }[]; token?: import('../../shared/resultToken.ts').ResultToken }) => void;
  /** Map-rotation hook  -  GameServer returns the next same-mode spec at
   *  the horn, or null to replay the current map. */
  onRotate?: () => MapSpec | null;
  /** Terrain swap  -  GameServer owns the field cache and attaches the
   *  loaded heightfield to ballSim/moveSim/projectiles. applySpec calls
   *  this when the new spec names a different terrain; without it the
   *  sims keep the OLD map's field while clients load the new one  - 
   *  balls bounce on ground that doesn't exist (the rubberband storm). */
  onTerrain?: (spec: MapSpec) => void;

  /** Push the player's armor-class body into its shadow  -  ground speed,
   *  jet mass, and eye height all ride the same class row so the shadow
   *  sim produces the trajectory the client's prediction computes. */
  private applyClassScale(playerId: string): void {
    const cls = this.players.getPlayer(playerId)?.armorClass as ArmorClass | undefined;
    const st = CLASS_STATS[cls ?? 'medium'];
    this.moveSim.setSpeedScale(playerId, st?.speedScale ?? 1);
    this.moveSim.setBody(playerId, st?.mass ?? 1, st?.eyeHeight ?? 1.8, st?.radius ?? classCapsule().radius);
  }

  /** A reclaiming client's declared class, applied to the seat now  -  the
   *  reconnect IS the declared discontinuity (respawn re-arm for dead
   *  seats, shield for live). Without it a restart-restore blob's stale
   *  class leaves the client's real kit class-locked until death. Same
   *  field set respawnPlayer's pendingClass block touches. */
  applyClaimedClass(playerId: string, claim: string): void {
    const p = this.players.getPlayer(playerId);
    // Instagib has no class choice - every claim resolves to light. igun
    // resolves to the rung weapon's own tier (untiered = medium): the
    // chassis rides the ladder, so a reclaim's stale pick can't stick.
    if (this.mods.instagib === true) {claim = 'light';}
    else if (this.mods.igun === true) {claim = igunChassis(p?.weapon);}
    if (claim !== 'light' && claim !== 'medium' && claim !== 'heavy') {return;}
    if (!p || p.armorClass === claim) {return;}
    const prev = p.armorClass as ArmorClass;
    p.armorClass = claim;
    // pendingClass survives: it's the rejoiner's banked pick, still
    // owed at respawn — clearing it here would strand the client
    // shouldering the new tier's kit against the old enforced class.
    p.maxHealth = CONFIG.playerMaxHealth + perkMods(p.perk).maxHealth + CLASS_STATS[claim].maxHealth;
    // Chassis-up swaps grant the tier's extra pool like the bot roster's
    // delta heal; chassis-down just clamps into the smaller bar.
    p.health = Math.max(0, Math.min(p.maxHealth,
      p.health + Math.max(0, CLASS_STATS[claim].maxHealth - CLASS_STATS[prev].maxHealth)));
    this.applyClassScale(playerId);
  }

  /** Same stale-claim seam for perks: the seat's perk came from the blob,
   *  the handshake carries what the rejoiner actually picked. */
  applyClaimedPerk(playerId: string, claim: string): void {
    const p = this.players.getPlayer(playerId);
    if (!p || p.perk === claim || !isPerkId(claim)) {return;}
    p.perk = claim;
    p.pendingPerk = undefined;
    p.maxHealth = CONFIG.playerMaxHealth + perkMods(claim).maxHealth + CLASS_STATS[p.armorClass as ArmorClass].maxHealth;
    p.health = Math.min(p.health, p.maxHealth);
  }

  /** Room's current heightfield  -  GameServer updates it on terrain
   *  attach/rotation so gameplay code can resolve ground height. */
  field: Heightfield | null = null;

  /** Non-null while attachTerrain's load is in flight  -  joins defer
   *  seating to it rather than pick a spawn against the missing field
   *  (authored anchor y under the real surface = the buried-seat snap). */
  terrainReady: Promise<Heightfield | null> | null = null;

  /** Test seam, keyed by playerId: resolves once a terrain-deferred
   *  join's continuation has run (seated OR stale-skipped). Only set for
   *  deferred joins  -  awaiting it is the deterministic alternative to
   *  flushing microtasks or sleeping until connections catch up. */
  readonly joinDone = new Map<string, Promise<void>>();

  /** maps/<X>.json filename this room's spec came from  -  the scoreboard's
   *  map title when the spec has no authored `name`. Factory sets it at
   *  birth; mapCatalog's rotation + GameServer's reload keep it current. */
  mapSrc = '';

  /** Wall-clock mint - the match-results ledger reads it for
   *  startedAt/durationMs (room lifetime ≈ match length on single-
   *  match rooms). */
  readonly createdAt = wallNow();

  constructor(name: string, field: Heightfield | null, mode = '', spec?: MapSpec, moveAuthority = false, seed?: number, deferBots = false) {
    if (seed !== undefined) {
      // A minted seed drives this room's draws  -  the spawn layout the
      // ctor below scatters is then part of the replay record.
      this.rngSeed = seed >>> 0;
      this.rngStream = lcg32(this.rngSeed);
      this.rng = this.rngStream;
    }
    // Invariant violations land on the room health counters  -  /metrics
    // exposes them as inv:<name> totals next to the existing tallies.
    setInvariantSink((n, ctx): void => { this.healthBump(`inv:${n}`); logger.warn(`INVARIANT ${n}`, ctx ?? {}); });
    this.name = name;
    this.connections.setTopic(`room:${name}`);
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
    // FPS_JOURNAL=<path.ndjson> records every sim-affecting moveSim call
    // + periodic state hashes  -  the forensic file a desync leaves behind
    // (replayJournal drives a fresh sim with the same stream).
    const journalPath = process.env.FPS_JOURNAL;
    if (journalPath) {
      const j = new SimJournal();
      j.header = { map: this.spec?.name ?? name, seed: this.rngSeed };
      j.attachFile(journalPath);
      this.moveSim.journal = j;
    }
    // FPS_DEMO=<dir>  -  the server-side demo capture. Records the
    // authoritative wire stream (broadcast tap) + shadow samples into a
    // v7 DemoFile; flushes <dir>/<room>-<wallms>.demo on dispose.
    // Ground truth for desync forensics  -  no loss, no interp.
    const demoDir = process.env.FPS_DEMO;
    if (demoDir) {this.demo = new RoomDemo(this);}
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
    // seq for ≥3 reports  -  an input edge died in flight (dead-lane drop).
    // Ask it to re-emit its current input; cooldown lives on the shadow.
    this.moveSim.onInputGap = (pid, lastSeq): void => {
      this.health?.set('inputgap', (this.health?.get('inputgap') ?? 0) + 1);
      this.connections.sendToPlayer(pid, { type: 'inputSync', lastSeq });
    };
    // T1 collision damage: the shadow measured a hard contact  -  turn it
    // into hp through the same funnel a bite or blast uses so 'fell to
    // death' reads in the kill feed and respawns on schedule.
    this.moveSim.onLanding = (pid, impact): void => {
      const p = this.players.getPlayer(pid);
      if (!p || p.isDead) {return;}
      // T1 charges the full fractional hit  -  but anything under a
      // tenth of the bar is absorbed whole (a stubbed toe isn't a
      // wound; the client still sells dust + thud for the impact).
      // Everyone in earshot hears the slam  -  the owner's local sim
      // already dressed it; this echo is for remote observers only.
      // Unless the lander is cloaked: the impact pos is the same leak
      // the jump/teleport/record gates close.
      if (this.cloakHiddenOf(pid)) {return;}
      const landWid = this.wireIds.get(pid);
      if (landWid === undefined) {this.connections.broadcast({ type: 'landed', playerId: pid, pos: p.position, impact });}
      else {this.connections.broadcastBinaryReliable(encodeWidPos(WIRE_E_LANDED, landWid, p.position, impact), 'volatile');}
      let dmg = (impact - MOVEMENT_CONFIG.fallDamageMinSpeed) * MOVEMENT_CONFIG.fallDamageScale * p.maxHealth;
      // Featherfall: the soak burns the shadow's modeled tank (same pool
      // the jet econ owns) before the hit exists  -  a covered landing
      // fires nothing at all.
      const soak = perkMods(p.perk).fallSoak;
      if (soak > 0) {
        const covered = Math.min(dmg, (this.moveSim.energyOf(pid) ?? 0) * soak);
        if (covered > 0) {this.moveSim.drainEnergy(pid, covered / soak); dmg -= covered;}
      }
      if (dmg >= p.maxHealth * MOVEMENT_CONFIG.fallDamageAbsorbFrac) {this.messages.fallDamage(pid, dmg);}
    };
    // Kill zone  -  the shadow measured the body below the map's floor, so
    // there's nothing to validate: it goes straight into the environment
    // funnel and the player respawns like any other death.
    this.moveSim.onKillZone = (pid): void => {
      const p = this.players.getPlayer(pid);
      if (!p || p.isDead) {return;}
      this.messages.killZone(pid, p.maxHealth);
    };
    // Reclaim desync accounting  -  journal wraps and reclaim gaps are the
    // only ways a reconnected client silently loses event history.
    this.connections.onJournalWrap = (n): void => this.healthBump('journalWrap', n);
    this.connections.onReclaimGap = (_pid, n): void => this.healthBump('reclaimGap', n);
    // A drowned socket is a client-side or path failure  -  count each
    // forced close so it shows in room health, not just the close log.
    this.connections.onDrowned = (): void => this.healthBump('drownedSock', 1);
    this.connections.onReliableDropped = (): void => this.healthBump('reliableDrop', 1);
    // Register→intro-gate-open  -  join-burst drain latency under load.
    this.connections.onIntroDrained = (_pid, ms): void => {
      this.healthBump('introDrainMsSum', ms);
      this.healthBump('introDrainN', 1);
      if (ms > (this.health.get('introDrainMax') ?? 0)) {this.health.set('introDrainMax', ms);}
    };
    // Send-queue depth gauge (KB, worst sample this window)  -  the drown
    // cap only tells us the socket died; this shows it drowning first.
    this.connections.onBuffered = (_pid, bytes): void => {
      const kb = Math.round(bytes / 1024);
      if (kb > (this.health.get('bufMax') ?? 0)) {this.health.set('bufMax', kb);}
    };
    this.moveSim.attachStructures(this.structs.eff());
    this.moveSim.setWaterLevel(this.spec.water?.swim === false ? undefined : this.spec.water?.level);
    this.moveSim.setKillY(this.spec.killY);
    // Shield soak burns the same tank the jet model owns  -  without this
    // a shielded player under fire runs the sim tank ahead of the real one.
    this.players.energyBurn = (pid, n): boolean => this.moveSim.drainEnergy(pid, n);
    // Closure over this.field  -  a mid-match terrain swap must not leave
    // spawn anchors snapping to the old map.
    // Anchors lift to the drawn surface, not just the field  -  an authored
    // point under a chord bridge (gully apex) would otherwise respawn a
    // body whose wire pos sits under the mesh it renders on.
    this.players.groundAt = (x, z): number => (this.field ? Math.max(hmHeight(this.field, x, z), hmChord(this.field, x, z)) : 0);
    this.ballSim = new BallSim(
      this.players,
      (msg): void => this.connections.broadcast(msg),
      (data): void => this.connections.broadcastBinaryReliable(data),
    );
    if (this.mods.noBalls === true) {this.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
    else if (this.spec.balls) {this.ballSim.population = this.spec.balls;}
    this.ballSim.killY = this.spec.killY ?? -Infinity;
    this.ballSim.onKilled = (by, pos, variant): void => this.scoring.nonPlayerKill(by, pos, variant);
    this.ballSim.colliders = structureColliders(this.structs.eff());
    if (this.spec.ballMix) {this.ballSim.ballMix = this.spec.ballMix;}
    if (this.spec.spawns) {this.players.spawnPoints = this.spec.spawns;}
    // Authored team spheres are CTF-only - a spec that ships bases +
    // teamSpawns for CTF would otherwise seat DM/headhunt/etc spawns at
    // the pads instead of the free circles.
    this.players.teamSpawns = this.mode === 'ctf' ? (this.spec.teamSpawns ?? null) : null;
    this.players.spawnRng = (): number => this.rng();
    this.messages.setBallSim(this.ballSim);
    if (field) {this.ballSim.attachField(field);}
    this.creatureSim = this.initCreatures(field);
    this.bots = new ServerBots(this, field);
    // Event subscriptions  -  producers emit through RoomInfo.emit; each
    // consumer reads only the kinds it cares about. A spoken line is
    // itself an event worth a reply  -  the squad sees it on their own
    // think phases, so an answer lands a beat later like real chat.
    this.events.on((e): void => {
      switch (e.type) {
        case 'kill': { this.scoring.onKill(e.targetId, e.shooterId); const w = (e as { weapon?: number }).weapon; if (w !== undefined) {this.killsByWeapon.set(w, (this.killsByWeapon.get(w) ?? 0) + 1);} this.gunGameOnKill(e.targetId, e.shooterId); break;
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
          // A bot who spoke a command chord issued a real call  -  teammates
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
        // Blast aftermath  -  each emit once carried a bespoke RoomInfo
        // hook; the bus fans it out instead. Claimed blasts punt only
        // flags ('flag'): a client-claimed origin is untrusted, so it
        // must not punt loose pickups  -  'pickup' emits only come from
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
        case 'impulse': { this.moveSim.applyImpulse(e.playerId, e.dv, e.fallBoost); break;
        }
        case 'flagDrop': { this.flags?.dropIfCarrier(e.playerId); break;
        }
              default: { break; }
}
    });
    // Posted roles spawn at home  -  a defender materializing on a
    // front-line sphere 400m out spends the next minute hiking, which
    // reads as wandering on every post/flag metric. Runners keep pure
    // foe-clearance scoring so the forward spheres stay useful.
    this.players.spawnHomeBias = (id): 1.6 | undefined => {
      const role = this.bots?.roleOf(id);
      return role === 'hof' || role === 'ldefense' || role === 'defense' || role === 'technician' ? 1.6 : undefined;
    };
    // A tasked member materializes toward his JOB, not home  -  the wave
    // member who respawned at base re-ran the lethal transit and died
    // again (katabatic soak: wave d518m median, near1%, dead~850). The
    // pull is softer than the defenders'  -  foe clearance still scores,
    // so a spawn directly on the enemy blob loses on safety.
    this.players.spawnObjective = (id) => {
      const t = this.bots?.taskGoalFor(id);
      return t ? { pos: t.goal, w: 1.6 } : null;
    };
    // Mode module BEFORE populate  -  spawn pools it mints (conquest's
    // node-linked rings) must cover the bots' initial seating, not just
    // their respawns.
    this.modeModule = this.makeModeModule();
    // Bots populate before humans join so team balancing puts humans on
    // the emptier side. Factory rooms defer the seat to the terrain
    // attach  -  the pick lifts authored anchors via groundAt, which reads
    // 0 pre-field: populating here seats every bot at anchor y under the
    // real surface (announces go out buried, unbury warps them up after).
    if (this.spec.bots) {
      if (deferBots) {this.pendingBots = this.spec.bots;}
      else {this.bots.populate(this.spec.bots);}
    }
    this.wireModeFeatures();
    this.deployables = new RoomDeployables(this);
    this.intel = new RoomIntel(this);
    // Deployables are solid  -  the move shadows push bodies out of gear.
    this.moveSim.setDynamic(this.deployables.solidCols);
    if (this.spec.deploys) {
      // Ride structure floors: a generator seeded inside a genhouse must
      // stand on its deck (seated high over terrain), not drown in it.
      // max() keeps authored elevations  -  tower sentries never descend.
      this.deployables.seedBase(this.spec.deploys.map(e => Object.assign({}, e, {pos: Object.assign({}, e.pos, {y: Math.max(e.pos.y, this.flagPlacer.deployFloor(e.pos.x, e.pos.z, e.pos.y))})})));
    }
    this.projectiles = new RoomProjectiles(this, field);
    this.projectiles.attachStructures(this.structs.eff());
    this.registerSims();
  }

  /** Chat lines per speaker inside the spam window  -  a burst of fast
   *  typing is the trigger for a single 'quiet' callout. */
  private chatPace = new Map<string, number[]>();

  /** 4+ lines inside 8s reads as spam. The callout itself is rare (~12%)
   *  and goes to ONE random bot  -  VGQ works as a surprise, not a rule,
   *  and a squad chorus of "Quiet!" would spam the feed worse. */
  private noteChatPace(id: string): void {
    const now = simNow();
    const hits = (this.chatPace.get(id) ?? []).filter((t): boolean => now - t < 8000);
    hits.push(now);
    if (hits.length < 4) { this.chatPace.set(id, hits); return; }
    this.chatPace.delete(id); // burst spent  -  re-arm on the next run
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
    // 'carrier'  -  the thief holding OUR flag; beacon info, pos is public
    return ours && ours.state === 'carried' ? ours.pos : undefined;
  }

  /** Server-authoritative melee species  -  the crawl* wire events are the
   *  state-edge stream (retarget/windup/pounce/bite/die); clients replay
   *  the seeded hop sim between them. */
  private initCreatures(field: Heightfield | null): CreatureSim {
    const creatureSim = new CreatureSim(
      this.players,
      (msg): void => this.connections.broadcast(msg),
      (pid, msg): void => this.connections.sendToPlayer(pid, msg),
    );
    creatureSim.pops = this.mods.noCreatures === true ? {} : (this.spec.creatures ?? {});
    creatureSim.colliders = this.ballSim.colliders;
    creatureSim.onBite = (c, targetId): void => {
      // dep:N ids are deployables  -  gnaw their hp, not a player.
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

  // Team bases → spawn anchors, kill-confirmed pickups, CTF flags  -  the
  // per-mode feature set the spec + modeSpec select together.
  private wireModeFeatures(): void {
    const {bases} = this.spec;
    if (this.modeSpec?.teams && bases?.alpha && bases?.bravo) {
      // Spawn anchoring uses the SNAPPED stand positions  -  a defender
      // bias toward a floating/under-terrain authored base sends players
      // to where the flag was authored, not where it actually is.
      const snapped = this.flagPlacer.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
      this.players.teamBases = { alpha: Object.assign({}, snapped.alpha), bravo: Object.assign({}, snapped.bravo) };
    }
    this.pickups = new RoomPickups(this);
    this.pickups.onCollect = (pid, kind, val): void => {
      const p = this.players.getPlayer(pid);
      if (!p) {return;}
      if (kind === 'gem' || kind === 'tag') {
        // Gems also heal  -  server-declared now: the collect IS the intent,
        // so the heal applies here instead of waiting on a claim that a
        // drop could silently lose (credit stayed banked but unclaimed).
        if (kind === 'gem') {
          healPool(p, Math.min(25, Math.round(20 * perkMods(p.perk).healBoost)));
          p.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
          // Client refills half the energy tank on a gem  -  the shadow
          // must too or the next jet run diverges for honest reasons.
          this.moveSim.grantEnergy(pid, ENERGY.max * 0.5 * perkMods(p.perk).energyMax);
        }
        // Score pickups are the belt economy's income: one charge per
        // nugget, capped at the spawn stock. Gems bank only in a gems
        // mode  -  in CTF a gem is heal+credit, not a cap. Tags are tdm's
        // kill-confirmation point; they only ever spawn there.
        p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
        const {team} = p;
        if ((kind === 'tag' || this.modeSpec?.gems) && (team === 'alpha' || team === 'bravo')) {
          this.score(team);
          // Banker credit  -  without it nuggets/tdm leave the personal
          // PTS column blank and hauling objective pays zero honor.
          this.scoring.awardPersonal(pid, 1);
        }
        return;
      }
      if (kind === 'token') {
        // Headhunt: the gem's feel-good rewards (jet refill, belt income)
        // but no bank  -  the token goes in your pocket and your team's live
        // score grows by your holding it. Tiered flat bonus on pickup so
        // grabbing a token has immediate utility (green +40% hp, blue +40%
        // armor, purple +5 belt + 5s 90%-block shield)  -  on top of the
        // sustained hoard drip that still rewards a disengaged carrier.
        p.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
        this.moveSim.grantEnergy(pid, ENERGY.max * 0.5 * perkMods(p.perk).energyMax);
        if (val >= 27) {
          p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 5);
          p.shieldUntil = simMs(simNow() + 5000);
          this.connections.sendToPlayer(pid, { type: 'buff', kind: 'shield', until: p.shieldUntil } as ServerMessage);
        } else {
          p.beltCharges = Math.min(BELT_MAX, p.beltCharges + 1);
        }
        if (val >= 3) {
          p.health = Math.min(p.maxHealth, p.health + p.maxHealth * 0.4);
        }
        if (val >= 9) {
          p.armor = Math.min(POWERUP.maxArmor, p.armor + POWERUP.maxArmor * 0.4);
        }
        // White (1) token: small feel-good heal (legacy base).
        if (val < 3) {
          healPool(p, Math.min(25, Math.round(20 * perkMods(p.perk).healBoost)));
        }
        p.healthEchoAt = wallMs(0); // force an immediate yourHealth echo
        this.connections.sendToPlayer(pid, { type: 'yourHealth', health: p.health, armor: p.armor } as ServerMessage);
        this.scoring.setHeld(p, p.heldTokens + val);
        this.scoring.awardPersonal(pid, val);
        return;
      }
      this.scoring.applyPowerup(p, kind);
    };
    if (this.modeSpec?.flags) {
      if (this.mode === 'rabbit') {
        this.flags = new RoomFlags(this, { alpha: this.flagPlacer.rabbitFlagHome() });
      } else {
        // No authored bases  -  modes are map-agnostic: auto-place both
        // stands so any geometry can host a flag game.
        this.flags = new RoomFlags(this, bases?.alpha && bases?.bravo
          ? this.flagPlacer.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo })
          : this.flagPlacer.autoFlagBases());
      }
    }
    // What the wire currently carries  -  the join echo and every structure
    // push both emit eff(), so boot-time stands are the baseline
    // any later re-push compares against.
    this.structs.baseline();
  }

  /** The one seam where a gamemode becomes pluggable  -  registry lookup,
   *  null for every mode without a module (all the built-ins today). */
  private makeModeModule(): ModeModule | null {
    return MODE_MODULES[this.mode]?.(this) ?? null;
  }

  /** Re-snaps flag homes against the LIVE heightfield  -  terrain attach
   *  and applySpec re-run it (bases can move with the map). */
  refreshFlagHomes(broadcastUpdate = true): void {
    this.flagPlacer.refreshHomes(broadcastUpdate);
    // Terrain (re)attach  -  mode entities re-snap their positions against
    // the live field the same way flag homes do.
    this.modeModule?.onTerrain?.();
  }

  /** Generator state flips which shield panes exist  -  colliders and the
   *  wire echo share this list, so one call re-syncs every client. */
  refreshPowerStructures(): void {
    this.structs.refreshPower();
  }

  // The tick registry  -  GameServer steps every entry per tick; new
  // server-side systems (deployables, generators) register here instead
  // of editing the tick loop.
  private registerSims(): void {
    // world:'empty' modes (duel) skip the ambient sims  -  a 2-seat room
    // paying for wildlife it never renders is the 1v1 capacity penalty
    // (_docs/2026-10-23_DUEL_CAPACITY L1). The OBJECTS still exist, so
    // stateHash lanes emit empty rosters rather than undefined.
    const ambient = this.modeSpec?.world !== 'empty';
    // World sims step first  -  bots and downstream systems see post-step
    // wildlife positions inside the same tick.
    if (ambient) {
      this.sims.push({ name: 'balls', tick: (dt): void => this.ballSim.step(dt), worldState: () => [{ type: 'ballRoster', balls: this.ballSim.roster() }] });
      this.sims.push({ name: 'crawl', tick: (dt): void => this.creatureSim.step(dt), worldState: () => [{ type: 'crawlRoster', crawlers: this.creatureSim.roster() }] });
    }
    this.sims.push({ name: 'bots', tick: (dt): void => this.bots.tick(dt) });
    if (this.flags) {this.sims.push({ name: 'flags', tick: (dt): void => this.tickFlags(dt), worldState: () => [{ type: 'flagUpdate', flags: this.flags!.snapshot() }] });}
    // The pluggable mode's own sims (conquest's lattice, anything future
    // modules register)  -  same tick + join-replay funnel as built-ins.
    for (const s of this.modeModule?.sims?.() ?? []) {this.sims.push(s);}
    if (ambient && this.pickups) {this.sims.push({ name: 'pickups', tick: (dt): void => this.pickups!.tick(dt), worldState: (): ServerMessage[] => this.pickups!.snapshot().map((p) => ({ type: 'pickupSpawn', id: p.id, pos: p.pos, kind: p.kind, vel: p.vel }) as ServerMessage) });}
    this.sims.push({ name: 'unbury', tick: (dt): void => this.unburyTick(dt) });
    // IFF detection sweep - runs in every mode incl. duels: enemy markers
    // gate on it regardless of world content.
    this.sims.push({ name: 'intel', tick: (dt): void => this.intel.tick(dt) });
    if (this.spec.arena) {
      const arena = new RoomArena(this, this.spec.arena);
      this.sims.push({ name: 'arena', tick: (dt): void => arena.tick(dt) });
    }
    // Deployables join the worldState replay: only edges streamed before,
    // so a mid-game joiner saw a compound it never spawned  -  permanent
    // DEPLOY/flag/pickup hash desyncs until something happened to change.
    if (ambient) {this.sims.push({ name: 'deploy', tick: (dt): void => this.deployables.tick(dt), worldState: (): ServerMessage[] => this.deployables.snapshot().map((d) => ({ type: 'deploySpawn', id: d.id, owner: d.owner, kind: d.kind, pos: d.pos, team: d.team }) as ServerMessage) });}
    this.sims.push({ name: 'proj', tick: (dt): void => this.projectiles.tick(dt) });
    this.sims.push({ name: 'move', tick: (dt): void => this.moveSim.tick(dt) });
    this.sims.push({ name: 'health', tick: (dt): void => this.healthTick(dt) });
    // Server-side RTT probe: round-robin one human per cadence tick so
    // the move shadow's transit EMA has a channel the client can't
    // fabricate (it cross-checks the ping riding position frames).
    this.sims.push({ name: 'ping', tick: (): void => this.pingTick() });
    if (ambient) {this.sims.push({ name: 'influence', tick: (dt): void => this.influence.tick(dt) });}
    this.moveSim.health = this.health;
  }

  /** Server-issued ping: one human per cadence window, round-robin, so
   *  each player's transit EMA refreshes every ~500ms×roster. Bots are
   *  skipped  -  their shadow lives on this box, transit is zero. */
  private pingCycle = 0;
  /** Stamp of the ping each player last received  -  the pong must echo
   *  an actually-issued stamp or it could spoof an RTT (a client sending
   *  `pong{timestamp: now}` unprompted measures rtt≈0  -  the lowball
   *  exploit through the trusted channel). */
  private lastPingStamp = new Map<string, number>();
  private pingTick(): void {
    if ((this.pingCycle += 1) % 10 !== 0) {return;}
    const humans = [...this.players.getAllPlayers().values()].filter((p): boolean => !p.isBot);
    if (humans.length === 0) {return;}
    // Unmeasured humans jump the queue  -  the client channel stands alone
    // until the first pong lands, and join grace shouldn't outlast a
    // full round-robin sweep in a big room.
    const target = humans.find((p): boolean => !this.lastPingStamp.has(p.id))
      ?? humans[(Math.trunc(this.pingCycle / 10)) % humans.length]!;
    const stamp = wallNow();
    this.lastPingStamp.set(target.id, stamp);
    this.sendToPlayer(target.id, { type: 'ping', timestamp: stamp });
  }

  /** Flag tick  -  called from GameServer's room tick. Captures feed the
   *  same bank→teamScore→matchEnd funnel nuggets use (worth winAt/5-ish:
   *  one capture = one score point). */
  tickFlags(dt: number): void {
    const scoredBy = this.flags?.tick(dt);
    if (scoredBy) {this.score(scoredBy);}
  }

  /** Beam-intent resolution: the honest ray a Lightning tick strikes  - 
   *  earliest of terrain face, wall, player capsule, or creature wins
   *  (same math as botBeam.beamContact). A creature contact also picks
   *  the chain fork; payment stays in CombatHandler. */
  private beamSweep(shooterId: string, muzzle: Vec3, dir: Vec3, range: number, includeTeammates = false): BeamContact | null {
    // One cast for every authority shape  -  Room and P2PHost resolve the
    // same rays through shared beamSweep.ts.
    return beamSweepRay({
      players: this.players, field: this.field,
      solids: this.projectiles.solidColliders,
      dynSolids: this.deployables.solidCols,
      ballSim: this.ballSim, creatureSim: this.creatureSim,
      transitOf: (pid): number => this.moveSim.transitOf(pid),
      transitVarOf: (pid): number => this.moveSim.transitVarOf(pid),
    }, shooterId, muzzle, dir, range, includeTeammates);
  }

  /** Any player death drops a carried flag  -  called from the damage
   *  funnel. In rabbit the same hook doubles as the flag's birth: the
   *  first corpse of the match is where the flag enters play. */
  flagCarrierDied(playerId: string): void {
    this.flags?.dropIfCarrier(playerId);
    this.flags?.spawnAtCorpse(playerId);
  }

  /** The score/kill economy  -  creature drops, powerup grants, team/FFA
   *  scoring, match-end awards. Own file (roomScore.ts) via ScoreHost. */
  readonly scoring = new RoomScore(this);
  /** Per-player FFA scoreboard  -  lives on RoomScore now; kept as the
   *  public name GameServer/tests already read. */
  get ffaScores(): Map<string, number> { return this.scoring.ffaScores; }

  /** Match lifecycle  -  clock/leader/reset funnel lives in roomMatch.ts;
   *  matchHost adapts Room's fields to the leaf interface it takes. */
  readonly matchClock: MatchClock;
  /** MessageHandler's room-facing surface  -  same lazy-callback pattern
   *  as matchHost: moveSim/matchClock/ballSim are built after `messages`,
   *  so every reference resolves at call time, not at construction. */
  /** Wire-invisible cloak predicate — masked CLOAK claim, modeled tank
   *  alive, shoot-reveal window closed (lastFireSim is sim-ms domain). */
  cloakHiddenOf(pid: string): boolean {
    const tp = this.players.getPlayer(pid);
    return tp !== undefined
      && (tp.status & STATUS.CLOAK) !== 0
      && (this.moveSim.energyOf(pid) ?? 1) > 0
      && simNow() - tp.lastFireSim >= SHOOT_REVEAL_S * 1000;
  }

  private handlerInfo(roomName: string): RoomInfo {
    return {
      room: roomName,
      mode: this.mode,
      // Live reader, not a snapshot: roomFactory flips these flags on
      // reused Rooms after this RoomInfo was captured.
      mods: (): RoomMods => this.mods,
      // This authority sims every outcome  -  no client claim is legitimate.
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
      killY: this.spec.killY,
      ambient: this.spec.ambient,
      // Authored spec title wins; the maps/<X>.json source filename is the
      // fallback  -  set post-ctor by the factory, refreshed by rotation.
      mapName: (): string | undefined => this.spec.name ?? (this.mapSrc || undefined),
      // Effective spawn pools, live-read: mode modules re-mint spheres
      // mid-match (conquest node rings)  -  the spec's authored copy is stale.
      spawns: () => this.players.spawnPoints,
      teamSpawns: () => this.players.teamSpawns,
      terrain: this.spec.terrain,
      heightScale: this.spec.heightScale,
      tileSize: this.spec.tileSize,
      fog: this.spec.fog,
      water: this.spec.water,
      terrainTex: this.spec.terrainTex,
      terrainPreset: this.spec.terrainPreset,
      sky: this.spec.sky,
      weather: this.spec.weather,
      atmosphere: this.spec.atmosphere,
      interiors: this.spec.interiors,
      emit: this.events.emit,
      rng: (): number => this.rng(),
      flags: () => this.flags?.snapshot() ?? [],
      pickups: () => this.pickups?.snapshot() ?? [],
      // tickNack: reuse the introSeq full-window  -  every record goes full
      // for ~1s, which reseeds every client's baselines whether they
      // nacked or not (records are shared; scoping per-socket isn't
      // possible without per-socket encodes). 500ms room cooldown so a
      // nack-storm can't hold the room on fulls permanently.
      drainedForTicks: (pid): boolean => this.connections.drainedForTicks(pid),
      // A spectator's gap is scoped to their own intro window  -  spec
      // count is unbounded, so room-wide fulls per spec nack would be an
      // amplifier. Player nacks still take nackFulls (their basis
      // corruption is ambiguous, so everyone reseeds).
      nackFor: (pid): boolean => {
        if (!this.spectators.has(pid)) {return false;}
        // Re-arm cap: a spec nack storm would otherwise hold introPending
        // true forever  -  every record double-encodes rec.full at 20Hz
        // permanently. An open window still paying out covers the nack.
        if (this.tickSeq - (this.introPlayers.get(pid) ?? -100) < 20) {return true;}
        this.markIntro(pid);
        return true;
      },
      isSpectator: (pid): boolean => this.spectators.has(pid),
      nackFulls: (): void => {
        const now = wallNow();
        if (now - this.lastNackAt < 500) {return;}
        // A window still paying out covers every client  -  re-stamping
        // would let a nack every 500ms hold the room on fulls forever.
        if (this.tickSeq - this.introSeq < 20) {return;}
        this.lastNackAt = now;
        this.introSeq = this.tickSeq;
      },
      readySpawn: (pid): void => this.releaseReady(pid),
      admitQueue: (pid, ids): void => { this.admitPending.set(pid, ids); },
      floodPause: (pid, ms): void => this.connections.floodPause(pid, ms),
      fireProjectile: (pid, wt, origin, dir, vel, shotId, lagS): string | null => this.projectiles.spawn(pid, wt, origin, dir, vel, shotId, lagS),
      beamSweep: (pid, muzzle, dir, range, includeTeammates): BeamContact | null => this.beamSweep(pid, muzzle, dir, range, includeTeammates),
      ballHit: (pid, id, dmg) => this.ballSim.handleHit(pid, id, dmg),
      crawlerHit: (pid, id, dmg) => this.creatureSim.handleHit(pid, id, dmg),
      repairTarget: (pid, muz, dir, range): number | null => this.deployables.repairTarget(pid, muz, dir, range),
      onDeploy: (pid, kind, pos, vel): string | true => this.mods.instagib === true ? 'instagib' : this.mods.gungame === true ? 'gungame' : this.deployables.handleDeploy(pid, kind, pos, vel),
      onRepair: (pid, targetId): string | true => this.deployables.repair(pid, targetId),
      deployables: () => this.deployables.snapshot(),
      influence: this.influence,
      matchEndsAt: (): number => this.matchClock.timeLeftMs() > 0 ? simNow() + this.matchClock.timeLeftMs() : 0,
      moveInput: (pid, i, status, seq, ageMs): boolean => {
        const ok = this.moveSim.queueInput(pid, {
          forward: i.forward, right: i.right,
          jumpPressed: Boolean(i.jump), jumpHeld: Boolean(i.jump), skiHeld: Boolean(i.ski),
          jetHeld: Boolean(i.jet),
        }, status, seq, ageMs);
        return ok;
      },
      moveReport: (pid, pos, yaw, vel, inputSeq, rttMs) => this.moveSim.reconcile(pid, pos, yaw, vel, inputSeq, rttMs),
      inputSeqOf: (pid): number => this.moveSim.inputSeqOf(pid),
      transitOf: (pid): number => this.moveSim.transitOf(pid),
      transitVarOf: (pid): number => this.moveSim.transitVarOf(pid),
      transitNote: (pid, rtt, stamp): void => {
        if (this.lastPingStamp.get(pid) !== stamp) {return;}
        this.moveSim.feedTransit(pid, rtt);
        // Echo the server-measured RTT back  -  the client's own ping/pong
        // number includes its event-loop stall, so the pair reads as
        // "client/server" and splits a busy renderer from a slow wire.
        this.sendToPlayer(pid, { type: 'srvPing', rtt });
      },
      uplinkNote: (pid, fireAt): void => {
        // (arrival − declared instant) is this claim's uplink transit  - 
        // bounded so a wildly off clock (or forged stamp) degrades to the
        // ping/pong channel instead of poisoning the EMA.
        const uplink = wallNow() - fireAt;
        if (uplink >= 0 && uplink <= 2000) {this.moveSim.feedUplink(pid, uplink);}
      },
      // playerHit on the binary lane: one encodeHit per event rides the
      // same batch as the tick frame  -  ~20B vs ~160B JSON, the client's
      // own wireIds map resolves ids back. 'environment' encodes wid 0.
      wireHit: (e): boolean => {
        const targetWid = this.wireIds.get(e.targetId);
        if (targetWid === undefined) {return false;}
        const shooterWid = e.shooterId === 'environment' ? 0 : this.wireIds.get(e.shooterId);
        if (shooterWid === undefined) {return false;}
        if (e.shooterId !== 'environment') {this.noteEngagement(e.shooterId, e.targetId);}
        this.connections.broadcastBinaryReliable(encodeHit({ ...e, targetWid, shooterWid }), 'volatile'); // combat events journal  -  same 3s staleness window the JSON lane carried
        return true;
      },
      // Generic S→C binary relay plumbing  -  the wireId+pos event family
      // encodes at the emit site and rides the same batch/journal lanes.
      widOf: (pid): number | undefined => this.wireIds.get(pid),
      wireCast: (data, journaled, exclude): void => this.connections.broadcastBinaryReliable(data, journaled, exclude),
      wireTo: (pid, data, journaled): void => this.connections.sendBinToPlayerReliable(pid, data, journaled),
      earlyRelayed: (pid, shotId): boolean => this.earlyRelayed(pid, shotId),
      gunRungOf: (pid): number => this.gunRungOf(pid),
      gunGameHeld: (pid, wt): void => this.gunGameHeld(pid, wt),
      // The rabbit dep's presence IS the mode check  -  CombatHandler gates
      // all PvP damage on the carrier being one side of the pair.
      rabbitCarrier: this.mode === 'rabbit' ? (): string | null => this.flags?.carrierId() ?? null : undefined,
      rabbitFlagLive: this.mode === 'rabbit' ? (): boolean => this.flags?.spawned() ?? false : undefined,
      rabbitBottom: this.mode === 'rabbit' ? (): Set<string> => this.scoring.bottomFeeders() : undefined,
      drainEnergy: (pid, n): boolean => this.moveSim.drainEnergy(pid, n),
      // Blast occlusion through enemy domes  -  a shell detonating at the
      // shield's edge can't splash victims inside it.
      shieldBlocked: (from, to, shooterId): boolean =>
        this.deployables.shieldedPoint(to, shooterId, from),
      // Instant-skill claim: the client already spent the energy locally  - 
      // mirror the same ante on the shadow or the tank drifts 50 apart.
      onSkillUse: (pid, skill): true | "gone" => {
        const p = this.players.getPlayer(pid);
        if (!p) {return 'gone';}
        // Identity check: a claim naming a skill the seat never declared
        // is a forged press  -  declared skills are the only legal ones.
        // A seat with NO declared skill has nothing legal to press at
        // all; accepting there would stamp lastSkillUse and open the
        // authority teleport window without a real beacon.
        if (p.skill === undefined || (skill !== undefined && skill !== p.skill)) {return 'gone';}
        // Cooldown floor: client skills all sit at 1s; 850ms of slack
        // eats jitter, a faster claim is a script.
        const now = wallNow();
        if (p.lastSkillUse !== undefined && now - p.lastSkillUse < 850) {return 'gone';}
        if (!this.moveSim.drainEnergy(pid, ENERGY.skillCost)) {return 'gone';}
        p.lastSkillUse = now;
        return true;
      },
      onThrowFlag: (pid): void | undefined => this.flags?.throwFor(pid),
      energyOf: (pid): number | null => this.moveSim.energyOf(pid),
      groundedOf: (pid): boolean => this.moveSim.simState(pid)?.onGround ?? false,
      // Wire-invisible cloak predicate — same terms as the tickRecords
      // hidden flag: masked CLOAK claim, modeled tank alive, shoot-
      // reveal window closed (lastFireSim is sim-ms domain).
      cloakHidden: (pid): boolean => this.cloakHiddenOf(pid),
      moveResync: (pid, pos, yaw, fullEnergy): void => {
        this.moveSim.resync(pid, pos, yaw, fullEnergy);
        // Resync re-anchors the shadow  -  also refresh the class speed
        // scale so a respawn-applied tier swap propagates (moveTrack
        // only re-reads it at handshake).
        this.applyClassScale(pid);
      },
      moveTrack: (pid, pos, yaw): void => {
        const p = this.players.getPlayer(pid);
        this.moveSim.track(pid, pos, yaw, p?.perk, p?.team, p?.isBot, p?.armorClass);
        // Re-seats (room hop) have stale position frames in flight  -  arm
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
      // A spoken line is itself an event worth a reply  -  the squad sees
      // it on their own think phases, so an answer (if any) lands a beat
      // later like real chat, not a scripted call-and-response.

      moveAuthority: (): boolean => this.moveAuthority,
      health: this.health,
      envRange: (pid): number => {
        const p = this.players.getPlayer(pid);
        if (!p) {return Infinity;}
        // Crawlers count too  -  envDamage legitimately comes from bites,
        // not just balls; a balls-only check warned on every true pounce.
        let d = this.ballSim.nearestBallDist(p.position.x, p.position.y, p.position.z);
        for (const c of this.creatureSim.crawlers.values()) {
          if (c.dead) {continue;}
          const dc = Math.hypot(c.x - p.position.x, c.y - p.position.y, c.z - p.position.z);
          if (dc < d) {d = dc;}
        }
        // Mines/turrets count too  -  an untagged blastAtPlayer claim from a
        // tripped mine has no creature near, only the hull it stood next to.
        for (const dep of this.deployables.items.values()) {
          const dd = Math.hypot(dep.pos.x - p.position.x, dep.pos.y - p.position.y, dep.pos.z - p.position.z);
          if (dd < d) {d = dd;}
        }
        return d;
      },
      preyNear: (pos, shooterId): { ball: number; crawler: number; foe: number; } => {
        let crawler = Infinity;
        for (const c of this.creatureSim.crawlers.values()) {
          const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
          if (d < crawler) {crawler = d;}
        }
        // Nearest enemy body to the pop  -  a foe eating the shell at 5m
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

  /** Built in the constructor  -  field-initializer order would read
   *  mode/modeSpec before they're assigned. */
  private matchHost(): MatchHost {
    // Getters read through `self`  -  object-literal `this` would bind to
    // the literal itself (the recursion bug this fixes avoided).
    // oxlint-disable-next-line no-this-alias -- the returned literal's getters need this outer scope
    const self = this;
    return {
      room: this.name,
      mode: this.mode,
      modeSpec: this.modeSpec,
      scores: this.scores,
      ffaScores: this.scoring.ffaScores,
      getHumanCount: (): number => this.players.getHumanCount(),
      matchPlayers: (): { id: string; team?: string; kills: number; deaths: number; }[] => this.scoring.matchPlayers(),
      broadcast: (msg): void => this.broadcast(msg),
      get resultSigner(): import('./resultSigner.ts').ResultSigner | null | undefined { return self.resultSigner; },
      get mapSrc(): string | undefined { return self.mapSrc; },
      endCleanup: (): void => {
        this.flags?.reset();
        this.modeModule?.reset?.();
        this.pickups?.clear();
        this.deployables.clearAll();
        this.players.resetStats();
        // Fresh match means fresh pockets  -  held tokens don't carry over
        // (syncHeld flushes the 0s so overhead counters don't go stale).
        for (const p of this.players.getAllPlayers().values()) {p.heldTokens = 0;}
        this.scoring.syncHeld();
      },
      reshuffleBots: (): void => {
        const bots = [...this.players.getAllPlayers().values()].filter((p): boolean | undefined => p.isBot);
        if (bots.length < 2 || !this.modeSpec?.teams) {return;}
        // Fisher-Yates on botRand so harness replays stay deterministic,
        // then alternate alpha/bravo  -  sizes stay even, loyalties don't.
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
      respawnAll: (): void => {
        for (const p of this.players.getAllPlayers().values()) {this.players.respawnPlayer(p.id);}
      },
      rotate: (): MapSpec | null => this.onRotate?.() ?? null,
      applySpec: (s): void => this.applySpec(s),
      onMatchEnd: (r): void | undefined => {
        this.dumpResults('end');
        this.onMatchEnd?.(r);
      },
      // 'match' isn't a bot id  -  nobody's actor-excluded, so every bot
      // sees the gg notice on its own think phase and the usual dice
      // decide who bothers replying. matchEnd adds the staggered
      // outcome lines on top  -  the shared chatter cooldown keeps the
      // two paths from double-speaking the same bot.
      onEnded: (w): void => { this.bots.notice('gg', 'match'); this.bots.matchEnd(w); },
      // The opener half of the beat  -  gl-hf as the round goes live.
      onStarted: (): void => { this.bots.matchStart(); this.seedHeadhunt(); },
      // Intermission godmode: the scoreboard is up but the game runs on
      //  -  blasts still shove, nobody can deal damage (Overwatch-style).
      setIntermission: (on): void => { self.players.invulnerable = on; },
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

  endMatch(w: string): void { // public  -  ScoreHost calls it on a win
    this.matchClock.end(w);
  }

  /** Match-start token seeding  -  a field with zero tokens stays 0-0 to
   *  the horn, so every spawn point gets a pair scattered near it. */
  private seedHeadhunt(): void {
    if (this.mode !== 'headhunt' || !this.pickups) {return;}
    const spawns = this.players.spawnPoints ?? [];
    for (const s of spawns) {
      for (let i = 0; i < 2; i += 1) {
        this.pickups.spawn({
          x: s.x + (this.rng() - 0.5) * 12,
          y: s.y,
          z: s.z + (this.rng() - 0.5) * 12,
        }, 'token');
      }
    }
  }

  /** Team point from a server-observed objective (flag cap, gem touch). */
  score(team: TeamId, n = 1): void {
    this.scoring.score(team, n);
  }

  /** A Room-shaped send for host interfaces  -  RoomScore echoes buffs
   *  through the same path the ctor closures use. */
  sendToPlayer(playerId: string, msg: ServerMessage): void {
    this.connections.sendToPlayer(playerId, msg);
  }

  // Combat noise  -  a short-lived ring of recent loud events (shots,
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

  /** Blasts detonate server-side without a broadcast position  -  the sim
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
   *  keep a match alive  -  they exist to serve the humans in it.
   *  A pending terrainReady means a join is deferred on the map load  - 
   *  the seat hasn't registered yet, so the room reads "empty" and the
   *  sweep would dispose it mid-join, seating the joiner into a dead
   *  Room that's gone from gs.rooms (the zombie-seat soak bug: join
   *  burst lands, then no ticks/events/keepalives ever). */
  get empty(): boolean {
    return this.players.getHumanCount() === 0 && (this.sessions?.graceInRoom(this.name) ?? 0) === 0
      && this.spectators.size === 0 && this.terrainReady == null;
  }

  /** Seat cap: spec override (a 1v1 duel is 2) or the process-wide budget.
   *  Read off spec so a rotation applySpec re-caps without a field copy. */
  get maxPlayers(): number { return this.spec.maxPlayers ?? CONFIG.maxPlayers; }

  /** Standing lobby  -  minted at boot, exempt from the empty-room sweep.
   *  Hibernates while empty; spec-tracked so a rotation drops the flag
   *  with the spec that carried it. */
  get standing(): boolean { return this.spec.standing === true; }

  /** Balance pick: smallest team gets the newcomer. FFA modes return
   *  undefined. Split from assignTeam so GameServer can pass the pick to
   *  addPlayer  -  the join spawn itself is then already team-aware. */
  nextTeam(): TeamId | undefined {
    if (!this.modeSpec?.teams) {return undefined;}
    let alpha = 0, bravo = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.team === 'alpha') {alpha += 1;}
      else if (p.team === 'bravo') {bravo += 1;}
    }
    return pickTeam({ alpha, bravo });
  }

  /** Human join pick: humans-vs-humans first  -  nobody wants to be the
   *  second human stacked onto the side that already has one  -  then
   *  total size. Bots keep nextTeam; they don't read the human column. */
  nextHumanTeam(): TeamId | undefined {
    if (!this.modeSpec?.teams) {return undefined;}
    let aH = 0, bH = 0, aT = 0, bT = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.team === 'alpha') {aT += 1; if (!p.isBot) {aH += 1;}}
      else if (p.team === 'bravo') {bT += 1; if (!p.isBot) {bH += 1;}}
    }
    if (aH !== bH) {return aH < bH ? 'alpha' : 'bravo';}
    return pickTeam({ alpha: aT, bravo: bT });
  }

  /** Balance join for players added without a team (server bots populate
   *  this way). */
  assignTeam(player: PlayerState): void {
    player.team ??= this.nextTeam();
  }

  /** Admin hot-reload: swap in a re-read map spec without restarting the
   *  room. Mode stays locked (a mode change mid-match would invalidate
   *  scores/teams)  -  everything layout-side applies live: spawn points,
   *  structures, arena, ball mix/population, bot fill. Clients get a
   *  mapUpdate broadcast to rebuild their geometry. */
  applySpec(spec: MapSpec): void {
    const terrainChanged = spec.terrain !== this.spec.terrain || spec.heightScale !== this.spec.heightScale || spec.tileSize !== this.spec.tileSize;
    if (spec.tileSize !== this.spec.tileSize) {this.influence.resize(spec.tileSize ?? HM_WORLD_SCALE);}
    this.spec = spec;
    this.applySpecSeating(spec);
    this.applySpecPops(spec);
    // Players must follow the swap too: applySpecPops sets ballSim.killY,
    // but the move sim's plane is what ends a fall. Without this a room
    // swapped into the sky arenas has players dropping through to the plain
    // (and a room swapped out keeps killing on the old map's plane).
    this.moveSim.setKillY(spec.killY);
    // The echo carries the merged list too  -  joiners get stand hulls in
    // their gameState structures, and combat occlusion sees the dais.
    this.messages.setMap(Object.assign({}, spec, { structures: this.structs.eff() }));
    this.structs.baseline(); // the push below is what clients hold now
    this.broadcast({
      type: 'mapUpdate',
      mapName: spec.name ?? (this.mapSrc || undefined),
      bases: spec.bases,
      structures: this.structs.eff(),
      arena: spec.arena ?? null,
      killY: spec.killY,
      ambient: spec.ambient,
      spawns: this.players.spawnPoints ?? undefined,
      teamSpawns: this.players.teamSpawns ?? undefined,
      terrain: spec.terrain,
      heightScale: spec.heightScale,
      tileSize: spec.tileSize,
      fog: spec.fog,
      water: spec.water,
      terrainTex: spec.terrainTex,
      terrainPreset: spec.terrainPreset,
      sky: spec.sky,
      weather: spec.weather,
      atmosphere: spec.atmosphere,
      interiors: spec.interiors,
    });
    // Rotate the sims' heightfield WITH the broadcast  -  clients rebuild on
    // mapUpdate; a sim still running the old field disagrees about where
    // the ground is for the entire match.
    if (terrainChanged) {this.onTerrain?.(spec);}
    this.retuneBots(spec.bots ?? 0);
  }

  /** Spawn pools + seating: mode module re-stamps AFTER the spec-side
   *  pools land  -  a module that owns spawning (conquest's node rings)
   *  must win over authored spheres or a rotation would silently revert
   *  to flat-map seating. */
  private applySpecSeating(spec: MapSpec): void {
    if (spec.spawns) {this.players.spawnPoints = spec.spawns;}
    this.players.teamSpawns = this.mode === 'ctf' ? (spec.teamSpawns ?? null) : null;
    this.modeModule?.onSpec?.(spec);
    this.structs.attach(); // merged authored + stand hulls; refreshFlagHomes re-runs it post-snap
    // Bases can move with a new spec  -  re-snap homes (no update push: the
    // mapUpdate broadcast carries the post-snap list). If the terrain is
    // also rotating the attach below corrects them once it lands.
    this.refreshFlagHomes(false);
  }

  /** Ball/creature population pools for the swapped spec. */
  private applySpecPops(spec: MapSpec): void {
    if (this.mods.noBalls === true) {this.ballSim.population = { base: 0, perPlayer: 0, max: 0 };}
    else if (spec.balls) {this.ballSim.population = spec.balls;}
    if (spec.ballMix) {this.ballSim.ballMix = spec.ballMix;}
    this.ballSim.killY = spec.killY ?? -Infinity;
    this.creatureSim.pops = this.mods.noCreatures === true ? {} : (spec.creatures ?? {});
    this.creatureSim.colliders = this.ballSim.colliders;
  }

  /** Bot seats deferred at ctor (factory rooms wait out the async
   *  terrain load so the pick lifts against the real field)  -  populate
   *  once the attach lands. No-op when nothing was deferred. */
  populateDeferredBots(): void {
    const n = Math.max(0, this.pendingBots - this.bots.count);
    this.pendingBots = 0;
    if (n > 0) {this.bots.populate(n);}
  }
  private pendingBots = 0;

  /** Top up / retire bots toward a spec's bot count (admin reload). */
  private retuneBots(want: number): void {
    if (this.bots.count < want) { this.bots.populate(want - this.bots.count); return; }
    if (this.bots.count <= want) {return;}
    let excess = this.bots.count - want;
    // Snapshot first  -  removePlayerCompletely mutates the map we're walking.
    // oxlint-disable-next-line no-useless-spread
    for (const p of [...this.players.getAllPlayers().values()]) {
      if (excess <= 0) {break;}
      if (!p.isBot) {continue;}
      this.removePlayerCompletely(p.id, 'adminReload', (): void => { return; });
excess -= 1;
    }
  }

  /** Match-results dump: one JSON per end/close so balance reads come
   *  from a pile of real outcomes (map, mode, scores, per-seat kills/
   *  deaths/class/rung/skill/econ). Best-effort - a dump failure can
   *  never take a live room down with it. */
  dumpResults(reason: string): void {
    try {
      writeMatchResult(collectServerResult(this, reason, {
        skillOf: (id): unknown => this.bots?.skillOf?.(id),
        econOf: (id): unknown => this.moveSim?.econOf?.(id),
        locoOf: (id): unknown => this.bots?.watchdog?.statsOf?.(id),
      }));
    } catch (err) {
      logger.warn('match-results dump failed', { room: this.name, err: String(err) });
    }
  }

  dispose(): void {
    this.dumpResults('close');
    this.ballSim.stop();
    this.creatureSim.stop();
    this.messages.dispose();
    if (this.demo && process.env.FPS_DEMO) {
      try {
        const path = this.demo.flush(process.env.FPS_DEMO);
        logger.info('server demo written', { room: this.name, path });
      } catch (error) {
        logger.warn('server demo flush failed', { room: this.name, err: String(error) });
      }
    }
  }

  /** Full teardown  -  every store moves together or a slot/token leaks. */
  removePlayerCompletely(playerId: string, reason: string, log: (m: string, o?: object) => void): void {
    // Bot cleanup funnels here too  -  callers other than retire/adminReload
    // (idle reap on a hibernating room, future teardown paths) used to
    // leave the brain keyed on a gone player forever. Idempotent: retire
    // already untracked before reaching this.
    const wasBot = this.players.getPlayer(playerId)?.isBot;
    if (wasBot) {this.bots.untrack(playerId);}
    // A carrier leaving drops the flag  -  same rule as dying with it.
    this.flagCarrierDied(playerId);
    this.deployables.clearOwner(playerId);
    this.projectiles.clearOwner(playerId);
    // Headhunt: a carrier leaving scatters their held tokens where they
    // stood  -  same rule as dying with them, minus the corpse bounty.
    if (this.mode === 'headhunt') {
      const leaver = this.players.getPlayer(playerId);
      if (leaver && leaver.heldTokens > 0) {
        for (const val of decomposeTokens(leaver.heldTokens)) {
          this.pickups?.spawn({
            x: leaver.position.x + (this.rng() - 0.5) * 3,
            y: leaver.position.y,
            z: leaver.position.z + (this.rng() - 0.5) * 3,
          }, 'token', 0, val);
        }
        leaver.heldTokens = 0;
      }
    }
    this.players.removePlayer(playerId);
    this.scoring.dropPlayer(playerId);
    this.messages.onPlayerRemoved(playerId);
    this.sessionTokens.delete(playerId);
    this.reclaimShields.delete(playerId);
    // Removal-without-disconnect paths (kick, idle reap, bot retire)
    // never hit the onClose cleanup  -  the limiter's per-player buckets
    // would sit in this room's map for its life.
    this.rateLimiter.removePlayer(playerId);
    // A pending grace timer is part of the player's teardown: kick/room
    // hop/admin removal during the window would otherwise leave a zombie
    // timer that re-runs this whole funnel later (double playerLeft,
    // double leaves count  -  or worse, tearing down a rejoined player).
    // Terminating here (not only in GameServer's wrapper) keeps the funnel
    // complete when the room is driven directly  -  the session's armed
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
    this.admitPending.delete(playerId);
    for (const q of this.admitPending.values()) {q.delete(playerId);}
    this.lastSentPositions.delete(playerId);
    this.chatPace.delete(playerId);
    this.connections.broadcast(verbPayload(WORLD_MODEL.player!, 'gone', 'playerId', playerId, {}) as ServerMessage);
    this.balanceTeams();
    log('Player removed', { room: this.name, playerId, reason, remaining: this.playerCount() });
  }

  /** Even out team sizes after a departure by moving bots to the short
   *  side. Bots absorb the swing because flipping a human mid-match is
   *  hostile; a bot doesn't care which jersey it's wearing. No-op in
   *  non-team modes and when the delta is ≤1 (already balanced). */
  balanceTeams(): void {
    if (!this.modeSpec?.teams) {return;}
    const counts = this.players.teamCounts();
    const [big, small] =
      counts.alpha >= counts.bravo
        ? (['alpha', 'bravo'] as const)
        : (['bravo', 'alpha'] as const);
    if (counts[big] - counts[small] < 2) {return;}
    // Dead bots first  -  a corpse's team swap lands on its respawn, so the
    // flip is invisible. Only the bottom quartile is eligible: the team's
    // star mid-carry shouldn't vanish into the enemy jersey.
    const bots = [...this.players.getAllPlayers().values()]
      .filter((p): boolean => p.team === big && Boolean(p.isBot))
      .sort((a, b): number => Number(b.isDead) - Number(a.isDead) || (a.kills - a.deaths) - (b.kills - b.deaths));
    const pool = Math.max(1, Math.ceil(bots.length * 0.4));
    for (const p of bots.slice(0, pool)) {
      if (counts[big] - counts[small] < 2) {break;}
      // A flipped carrier would hold the flag in 'carried' forever  - 
      // tickCarried requires carrier.team !== flag.team, and the bot's
      // new own-team can't grab or return it. Drop it at their feet.
      this.flagCarrierDied(p.id);
      this.players.setTeam(p.id, small);
      this.moveSim.setTeam(p.id, small);
      this.broadcast(eventPayload(WORLD_MODEL.player!, 'teamUpdate', 'playerId', p.id, { team: small }) as ServerMessage);
counts[big] -= 1;
counts[small] += 1;
    }
    // A flipped carrier's tokens change sides  -  resync the live sums.
    this.scoring.syncHeld();
  }
}

