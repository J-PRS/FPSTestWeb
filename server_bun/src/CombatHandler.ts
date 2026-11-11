import type { ClientMessage, ServerMessage, Vec3, ClaimVerdict,PlayerState,HitVerdict } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { POWERUP } from '../../shared/pickups.ts';

import { logger } from './logger.ts';
import { classCanFire } from '../../shared/botClasses.ts';
import { serverSimmed, isInstagibWeapon, BELT_THROW_WEAPONS, beltThrowCost, WeaponType, getWeaponStats, REPAIR_RANGE, WEAPON_FIRE_INTERVAL_S, LANCE_RANGE, LANCE_CADENCE_S, HEALBEAM_RANGE, HEALBEAM_PER_TICK, HEALBEAM_ENERGY, HEALBEAM_MIN_TICK_S, payShotCost, spendAmmo, jitter01, coneDir, bloomRadius, bloomGrow } from '../../shared/weapons.ts';
import { gunGameAllows } from '../../shared/gunGame.ts';
import type { RoomMods } from '../../shared/protocol.ts';
import { idSeed } from '../../shared/weaponTable.ts';
import { finiteVec, encodeShotEv } from '../../shared/wire.ts';
import { dhypot3 } from '../../shared/dmath.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import { rewindPos, rewindNearest } from './claimLedger.ts';
import { KillFeed } from './killFeed.ts';
import { RespawnManager } from './respawn.ts';
import { ChargeBank } from './combatCharge.ts';
import { BlastRunner, FORCE_SEND_MS } from './combatBlast.ts';
import { AoeClaims } from './combatAoe.ts';
import type { RoomEventSink } from './roomEvents.ts';
import { HitLedger } from './hitLedger.ts';
import { handleEnvironmentDamage, handleHeal } from './envClaims.ts';
import { healPool } from './healPool.ts';
import { crawlerAttack, botAttack } from './serverAttacks.ts';
import { simNow , simMs} from './simClock.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { weaponStats } from './weaponStats.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { tauntRand } from '../../shared/botRand.ts';
import { lgTickDamage, lgChargeAt, LG_RANGE, LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';


/** What a beam intent's honest ray struck - the room resolves earliest
 *  contact; CombatHandler pays it. `contact` is the surface point (pop
 *  blasts and relays anchor there). Chain ids ride a second contact
 *  when the fork arcs to another creature. */
export interface BeamContact {
  playerId?: string;
  ballId?: number;
  crawlerId?: number;
  contact: Vec3;
  chainBallId?: number;
  chainCrawlerId?: number;
  chainContact?: Vec3;
  /** Damage multiplier - the terrain-bounce leg pays half. */
  dmgScale?: number;
}

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;
type ShotMsg = Extract<ClientMessage, { type: 'shotFired' }>;

/** Optional room wiring - mirrors the subset of RoomInfo combat needs. */
export interface CombatDeps {
  /** Domain-event sink - kill/hit/fire/botSpoke notifications fan out
   *  to the room's subscribers (scoring, bot senses, influence). */
  emit?: RoomEventSink;
  /** Team-mode rooms block damage between teammates (knockback still
   *  applies - boosting off a teammate's splash is intentional). */
  teams?: boolean;
  /** Server option: set = teammates CAN damage each other - friendly()
   *  returns false even in team rooms. Splash knockback is unaffected. */
  friendlyFire?: boolean;
  /** Rabbit rooms: returns the flag carrier's id (null when the flag is
   *  loose). Presence of the dep IS the mode check - friendly() blocks
   *  damage unless one side of the pair is the rabbit. */
  rabbitCarrier?: () => string | null;
  /** Rabbit: true once the flag exists (first corpse spawned it). Before
   *  that the mode is deliberately open season - hunters can't fight a
   *  rabbit that doesn't exist yet; after, a loose flag still enforces
   *  the pairing law. */
  rabbitFlagLive?: () => boolean;
  /** Rabbit tie-in: id sitting in last place - the bottom-feeder rule
   *  lets the worst-ranked hunter brawl with anyone. */
  rabbitBottom?: () => Set<string>;
  /** Jet-tank access for heal-beam ammo - the beam burns movement energy,
   *  server-side truth so a bot/client can't heal for free. */
  drainEnergy?: (playerId: string, amount: number) => void;
  energyOf?: (playerId: string) => number | null;
  /** Shadow-sim grounded state - groundedOnly weapons refuse otherwise. */
  groundedOf?: (playerId: string) => boolean;
  /** Dome occlusion for blast sweeps - the shell dies at the shield's
   *  edge, so its splash must not reach anyone inside that dome. */
  shieldBlocked?: (from: Vec3, to: Vec3, shooterId: string) => boolean;
  /** Server-driven respawn is a declared discontinuity - reseat the
   *  shadow at the spawn or the corpse→spawn jump reads as divergence. */
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
  /** Room mode tag for balance telemetry ('ctf', 'nuggets', ...). */
  mode?: string;
  /** Live room-modifier reader - instagib's weapon whitelist + rail
   *  overrides, gungame's per-player ladder gate (gunRungOf), igun's
   *  flat ~200 damage. A function because roomFactory can flip the
   *  flags on a reused Room after this deps snapshot was taken - a
   *  boolean here would be stale forever. */
  mods?: () => RoomMods;
  gunRungOf?: (playerId: string) => number;
  /** Bucket-pick edge: a passed gungame claim names the member the
   *  player actually shouldered - Room syncs roster weapon + igun
   *  chassis. Called from every admit site (shot/aoe/attacks). */
  gunGameHeld?: (playerId: string, weaponType: number) => void;

  /** A bot chat line hit the wire - Room relays it as a 'reply' notice
   *  so squadmates can answer back. Emitted as 'botSpoke'. */
  /** Room heartbeat counters - claims/rejects/applied damage tally here
   *  so the periodic 'Room health' line shows the funnel at a glance. */
  health?: Map<string, number>;
  /** A real fire claim passed the gates - the sheep meter's ignore
   *  debit needs fire recency for humans (bots report their own).
   *  Emitted as 'fire'. */
  /** Nearest-creature distance for env-damage plausibility (melee-from-
   *  afar flagging). Absent = no creature sim to check against. */
  envRange?: (playerId: string) => number;
  /** Distance of the nearest ball / crawler to a point - self-frag
   *  autopsy discriminates a terrain lip from a body that hopped into
   *  the shell. */
  preyNear?: (pos: Vec3, shooterId?: string) => { ball: number; crawler: number; foe: number };

  /** Spatial memory: hits and kills deposit danger scent on the victim's
   *  team layer; the map itself lives on Room. */
  influence?: InfluenceMap;
  /** Seeded room rng - absent = ambient Math.random (production). */
  rng?: () => number;
  /** Fire-intent → authoritative shell spawn (RoomProjectiles). Only
   *  SERVER_SIMMED_WEAPONS route here; returns the LiveProj id. */
  fireProjectile?: (ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3, shotId?: string, lagS?: number) => string | null;
  /** Beam-intent resolution - the honest ray against terrain, walls,
   *  players, and creatures; earliest contact wins. Absent = beam
   *  intents stay cosmetic relays only. */
  beamSweep?: (shooterId: string, muzzle: Vec3, dir: Vec3, range: number, includeTeammates?: boolean) => BeamContact | null;
  /** Creature damage sinks for beam contacts - BallSim/CreatureSim
   *  handleHit; absent when the room runs no creature sims. */
  ballHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  crawlerHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  /** Repair-beam intent: the server picks the weldable deployable the
   *  ray touches, then `repair` pays it (Room.deployables.repair). */
  repairTarget?: (playerId: string, muzzle: Vec3, dir: Vec3, range: number) => number | null;
  repair?: (playerId: string, targetId: number) => ClaimVerdict | void;
  /** Target uplink-transit estimate (ms) - blast lag-comp subtracts the
   *  same lead the tick broadcast shows shooters, so a point-blank-
   *  looking pop validates against the position actually rendered. */
  transitOf?: (playerId: string) => number;
  /** Link jitter EMA - bounds the shooter's claimed render lag. */
  transitVarOf?: (playerId: string) => number;
  /** Claim-declared trigger instant (server-clock estimate) - feeds the
   *  measured-uplink channel the transit EMA approximates. */
  uplinkNote?: (playerId: string, fireAt: number) => void;
  /** Binary playerHit lane (wireIds resolve → encodeHit once per event).
   *  Returns false when either id lacks a wireId - caller falls back to
   *  the JSON broadcast so test harnesses and env shooters still land. */
  wireHit?: (e: { shooterId: string; targetId: string; damage: number; health: number; armor?: number; seq?: number; shotId?: string; gd?: number }) => boolean;
  /** Room wireId lookup for S→C binary relays (u16 on the wire). */
  widOf?: (playerId: string) => number | undefined;
  /** Broadcast one pre-encoded binary frame (broadcastBinaryReliable). */
  wireCast?: (data: Uint8Array, journaled?: boolean | 'volatile', exclude?: string) => void;
  /** Single-recipient reliable binary (knockback - victim-only). */
  wireTo?: (playerId: string, data: Uint8Array, journaled?: boolean | 'volatile') => void;
  /** Arrival-time cosmetic relay already flashed this shotId - skip the
   *  drain's own emit or observers see a double muzzle. */
  earlyRelayed?: (playerId: string, shotId?: string) => boolean;
}

/**
 * Everything that can hurt a player: shot hit-claims, AOE blasts,
 * environmental damage, projectile tracking/destroy, and respawn timers.
 * Split from MessageHandler so the dispatch surface (movement, presence,
 * snapshots) stays a thin routing file. The projectile book-keeping lives
 * in claimLedger - this file keeps the damage policy.
 */
export class CombatHandler {
  /** The blast sweep - claimed AOE resolutions, trusted server blasts,
   *  plating sweeps, mine pops. Own file (combatBlast.ts) via BlastHost. */
  blast: BlastRunner; // public - aoeClaims drives it via AoeHost
  /** Cosmetic relay gate for shotFired - a hitscan pull has no damage
   *  semantics, so excess ones are silently dropped instead of rejected. */
  private lastFireNotify = new Map<string, number>();
  /** 1s sliding window of server-simmed fire intents - the flood gate. */
  private simmedFireTimes = new Map<string, number[]>();
  /** Beam intents (LG/Repair) get their own window - they already pay in
   *  the beam branch and never own a shell, so they must not also
   *  consume the projectile-spawn flood/cadence budget below. */
  private beamFireTimes = new Map<string, number[]>();
  /** Weapons whose shotFired resolves in the beam branches - never
   *  reach the projectile spawn gate (they'd double-count the window
   *  and only spawn-refuse anyway). */
  private static readonly BEAM_INTENT_WEAPONS = new Set<number>([WeaponType.Lightning, WeaponType.Shocklance, WeaponType.Repair, WeaponType.HealBeam]);
  /** Post-reclaim intent replays: shotId → wall time the pull spawned.
   *  A resend inside the window is a no-op (the first verdict already
   *  flew); outside it the intent is simply new. */
  private seenShots = new Map<string, Map<string, number>>();
  private static readonly SHOT_DEDUPE_MS = 10_000; // resync replays ride the whole journal - >5s hidden gaps are normal
  /** Cadence gate (registerMiss uses it): per `${playerId}:${weaponType}`
   *  burst window - start time + claims seen inside it. The client fire
   *  timer is feel; this is the law. A window holds up to `burst` spawn
   *  claims (fan weapons fire all pellets in one pull); hits don't need
   *  gating - the ledger already caps them at one per registered
   *  projectile. */
  fireWindows = new Map<string, { start: number; count: number; lastTs?: number; arr: number[]; violations: number }>();
  /** Heal-beam tick law - per `shooter|patient` pair last-tick stamp,
   *  the same rate shape the repair beam enforces. */
  healTicks = new Map<string, number>();
  /** The LG bank/ramp economy - own file (combatCharge.ts); this handler
   *  only supplies the detonation (a real processAOE blast). */
  chargeBank: ChargeBank; // public - aoeClaims banks LG ticks through it
  private aoe: AoeClaims;
  /** First-hit timestamps per shooter|victim pair - kill-side applies it
   *  as the engagement time (TTK), hit-side only refreshes it. */
  /** Map-structure colliders - claim validation rejects flights that
   *  would have to pass through a wall to reach their end point.
   *  solidIndex is public - BlastRunner marches through it too. */
  _solids: readonly StructureCollider[] = [];
  solidIndex: ColliderIndex | null = null;
  get solids(): readonly StructureCollider[] { return this._solids; }
  set solids(list: readonly StructureCollider[]) {
    this._solids = list;
    this.solidIndex = list.length > 0 ? new ColliderIndex(list) : null;
  }

  killFeed: KillFeed;
  private hitLedger = new HitLedger();
  respawner: RespawnManager;

  /** AoeHost surface - seeded rng rides deps so bomblet scatter replays
   *  under scenario seeds; ambient dice when uninjected. */
  rng(): number { return (this.deps.rng ?? Math.random)(); }

  constructor(
    public playerManager: PlayerManager,
    public broadcast: BroadcastFn,
    public sendToPlayer: SendToPlayerFn,
    public deps: CombatDeps = {},
  ) {
    // Late binding on the static - tests reassign tauntDelayMs after
    // construction and must still steer the delay.
    this.killFeed = new KillFeed(playerManager, broadcast, (): number => CombatHandler.tauntDelayMs(),
      (id, vgs): void | undefined => this.deps.emit?.({ type: 'botSpoke', id, vgs }), sendToPlayer);
    this.respawner = new RespawnManager(playerManager, broadcast, (pid, pos, yaw, full): void | undefined => this.deps.moveResync?.(pid, pos, yaw, full));
    this.blast = new BlastRunner(this);
    this.chargeBank = new ChargeBank((ownerId, target, amount): void => this.blast.pop(ownerId, target.position, amount));
    this.aoe = new AoeClaims(this);
  }

  hb(key: string, n = 1): void {
    if (this.deps.health) {this.deps.health.set(key, (this.deps.health.get(key) ?? 0) + n);}
  }

  /** The claim's measured uplink age (ms) - sendShotFired stamps fireAt
   *  on the client's server-clock estimate; absence = 0 (bot/legacy).
   *  Bounded by the MEASURED path, not the stamp itself: a forged deep-
   *  past fireAt would otherwise rewind the attack origin across the
   *  whole journal (peek, retreat, keep beaming "from" the exposed
   *  spot). transit is capped at TRANSIT_EMA_CAP_MS and jitter is pong-
   *  measured only (feedUplink never touches transitVar), so a claim
   *  can't inflate this bound; the floor covers join grace + resend
   *  slack on a clean link. */
  private uplinkMsOf(playerId: string, msg: { fireAt?: number; arrivedAt?: number }): number {
    if (typeof msg.fireAt !== 'number') {return 0;}
    const age = Math.max((msg.arrivedAt ?? wallNow()) - msg.fireAt, 0);
    const bound = (this.deps.transitOf?.(playerId) ?? 0)
      + 3 * (this.deps.transitVarOf?.(playerId) ?? 0) + 200;
    return Math.min(age, Math.max(bound, 400));
  }

  /** Claim-driven origin: the shooter's reported eye/muzzle point,
   *  bounded to honest reach of its uplink window - a teleported claim
   *  clamps to the nearest recorded body sample instead of being taken
   *  verbatim. No transit estimate: pos is claim truth, the window is
   *  measured uplink. */
  private claimOrigin(player: PlayerState, uplinkMs: number, pos: Vec3 | undefined): Vec3 {
    const at = rewindPos(player, uplinkMs);
    if (pos && finiteVec(pos)) {
      const bound = rewindNearest(player, uplinkMs + 150, 150, pos);
      const gap = dhypot3(bound.x - pos.x, bound.y - pos.y, bound.z - pos.z);
      // A real muzzle sits within ~muzzle-lead + a step of some recorded
      // body sample in the window - a bigger gap is a teleported claim.
      if (gap <= 3) {return { x: pos.x, y: pos.y, z: pos.z };}
    }
    return at;
  }

  /** Claim refused: server-side warn plus a shotRejected to the shooter so
   *  their client can log WHY predicted damage never happened. */
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number, shotId?: string): void {
    this.hb('rej');
    // Record rejected shots too - a journal replay of a REFUSED pull
    // must no-op, not re-arrive, heat the cadence window, and reject the
    // next legal pump (the shotgun cascade: rejected→resent→rejected).
    if (kind === 'Shot' && shotId) {
      let seen = this.seenShots.get(playerId);
      if (!seen) {seen = new Map(); this.seenShots.set(playerId, seen);}
      if (!seen.has(shotId)) {seen.set(shotId, wallNow());}
    }
    this.hb(`rej.${kind}`);
    // The verdict is expected traffic - a spray of out-of-reach claims
    // from one player is one signal, not N log lines (16-bot soak:
    // ~200 warns/4min, all stamped by a handful of senders). Throttle
    // per player+kind like notifyDrop does for the wire side; the exact
    // counts still land in the rej.* heartbeat keys.
    if (reason === 'shooter dead') {
      // A late volley is netcode working - verdict + drop.deadShot carry
      // the signal; a warn per race reads as soak jank at 64 clients.
      logger.debug(`${kind} rejected: ${playerId}: ${reason}`);
    } else {
      this.rejectWarn(`${playerId}:${kind}`,
        `${kind} rejected: ${playerId}${targetId ? ` → ${targetId}` : ''}: ${reason}`);
    }
    // Rejected claims can leave predicted self-damage stuck client-side -
    // ship our health value so the shooter resyncs instead of drifting.
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'shotRejected', reason: `${kind}: ${reason}`, targetId, weaponType, health, shotId });
  }

  /** Honest-lag drop, not a reject - but the shooter's client already
   *  predicted the damage, so it needs a clearing signal or its
   *  pending-hit ledger warns phantom. Throttled per player+kind+target:
   *  a beam held on a corpse would otherwise spam the channel at tic
   *  rate. Distinct from reject(): no warn, no rej counter - these are
   *  the drops the health map already tallies as drop.*. */
  /** Per player+kind warn throttle for reject() - see the comment there.
   *  Keyed like lastDropNotify and cleaned with it on disconnect. */
  private lastRejectWarn = new Map<string, { at: number; n: number }>();
  /** 2s coalescing warn: repeats inside the window count up and land on
   *  the next emitted line, so a claim flood is one signal, not N lines. */
  private rejectWarn(key: string, msg: string): void {
    const now = wallNow();
    const w = this.lastRejectWarn.get(key);
    if (w && now - w.at < 2000) {
w.n += 1;
    } else {
      const suppressed = w?.n ?? 0;
      this.lastRejectWarn.set(key, { at: now, n: 0 });
      logger.warn(`${msg}${suppressed > 0 ? ` (+${suppressed} suppressed)` : ''}`);
    }
  }
  private lastDropNotify = new Map<string, number>();
  notifyDrop(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number, shotId?: string): void {
    const key = `${playerId}:${kind}:${targetId ?? ''}`;
    const now = wallNow();
    if (now - (this.lastDropNotify.get(key) ?? 0) < 1000) {return;}
    this.lastDropNotify.set(key, now);
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'claimDropped', reason: `${kind}: ${reason}`, targetId, weaponType, health, shotId });
  }

  friendly(shooterId: string, targetId: string): boolean {
    if (this.deps.rabbitCarrier) {return this.rabbitFriendly(shooterId, targetId);}
    // friendlyFire server option opens the gate entirely; self-splash
    // stays allowed regardless (rocket jumps).
    if (!this.deps.teams || shooterId === targetId || this.deps.friendlyFire) {return false;}
    const t = this.playerManager.getPlayer(targetId);
    // Map-authored assets shoot under the virtual `base:<team>` owner -
    // no player row exists, so the team's own bodies must be exempted here
    // or a base turret's splash would chew its defenders.
    if (shooterId.startsWith('base:')) {return t?.team === shooterId.slice(5);}
    const s = this.playerManager.getPlayer(shooterId);
    return Boolean(s?.team && t?.team && s.team === t.team);
  }

  /** Rabbit law: pre-flag (first corpse hasn't spawned it) the lobby is
   *  open season - there is no rabbit to hunt yet. Once the flag exists,
   *  the only legal pairings include the carrier - hunter-vs-hunter is
   *  friendly fire, a dropped flag does NOT reopen the season. The
   *  bottom-feeder is exempt: last place can hit/be hit by anyone.
   *  Self-splash stays legal (rocket jumps). */
  private rabbitFriendly(shooterId: string, targetId: string): boolean {
    if (shooterId === targetId) {return false;}
    const c = this.deps.rabbitCarrier!();
    if (c && (shooterId === c || targetId === c)) {return false;}
    if (!c && !this.deps.rabbitFlagLive?.()) {return false;}
    const bottom = this.deps.rabbitBottom?.();
    return !(bottom?.has(shooterId) || bottom?.has(targetId));
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) - NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {

    this.killFeed.forget(playerId);
    // A pending respawn is part of the player's teardown too - removal
    // paths that skip onPlayerDisconnected (kick, room hop, admin reload)
    // would otherwise leave a zombie timer firing into a gone player.
    this.onPlayerDisconnected(playerId);
  }

  onPlayerDisconnected(playerId: string): void {
    this.respawner.cancel(playerId);
    // Grace keeps the player entity alive, but the flag must not ride a
    // ghost: a disconnecting carrier fumbles on the spot, same as a dead
    // one. Rejoin or not, the objective stays in play.
    this.deps.emit?.({ type: 'flagDrop', playerId });
    // Per-player fire-throttle state is per-connection like the room's
    // warn keys - a leaver's entry otherwise sits in the map for the
    // room's life.
    this.lastFireNotify.delete(playerId);
    this.simmedFireTimes.delete(playerId);
    for (const key of this.fireWindows.keys()) {
      if (key.startsWith(`${playerId}:`)) {this.fireWindows.delete(key);}
    }
    this.lastHeal.delete(playerId);
    for (const key of this.lastEnvCredit.keys()) {
      if (key.endsWith(`>${playerId}`) || key.startsWith(`${playerId}>`)) {this.lastEnvCredit.delete(key);}
    }
    this.chargeBank.delete(playerId);
    for (const key of this.healTicks.keys()) {
      if (key.startsWith(`${playerId}|`) || key.endsWith(`|${playerId}`)) {this.healTicks.delete(key);}
    }
    for (const key of this.lastDropNotify.keys()) {
      if (key.startsWith(`${playerId}:`)) {this.lastDropNotify.delete(key);}
    }
    for (const key of this.lastRejectWarn.keys()) {
      if (key.startsWith(`${playerId}:`)) {this.lastRejectWarn.delete(key);}
    }
  }

  /** Hitscan fire leaves no projectile for observers to see - relay a
   *  cosmetic 'playerShot' so other clients render muzzle audio/visual.
   *  Origin is server-stamped (rewound to fire time, like spawn sanity
   *  checks) so a forged claim can't paint shots from arbitrary points;
   *  dir stays cosmetic - observers only use it to aim a beam flash. */
  handleShotFired(playerId: string, msg: ShotMsg): void {
    const admit = this.shotAdmit(playerId, msg);
    if (admit === null) {return;}
    const { player, now, dir, fireProjectile } = admit;
    if (msg.weaponType === WeaponType.Melee && dir) {
      this.meleeIntent(playerId, player, msg, dir);
      return;
    }
    if (this.beamIntents(playerId, player, msg, dir, now)) {return;}
    if (fireProjectile) {
      // Intents spawn real sims + broadcasts, so they need a real flood
      // gate - the fastest legit simmed weapon is ~13/s; 20/s is spam.
      if (!this.simmedFireGate(playerId, msg, now)) {return;}
    // Cosmetic relay only - throttled: a dropped relay costs a muzzle
    // flash, but a dropped intent would orphan a predicted shell.
    // The stamp lands at the relay emit below so the intent
    // fall-through shares ONE throttle per player.
    } else if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) {return;}
    this.deps.emit?.({ type: 'fire', playerId });
    // Spawn epoch from the CLAIM, not a transit heuristic: the shooter
    // reports the muzzle pos it drew from + a fireAt stamp; uplinkMs is
    // the measured claim age (also the lagS lead below).
    const uplinkMs = this.uplinkMsOf(playerId, msg);
    const at = this.claimOrigin(player, uplinkMs, msg.pos);
    // Claimless pilot: a server-simmed intent spawns an authoritative
    // shell - the intent IS the whole claim; contact/blast outcomes
    // arrive as broadcasts, never as client claims. projectileCreated
    // covers observers' visuals, so the playerShot relay is skipped.
    if (fireProjectile && this.simmedShot(playerId, player, msg, { dir: dir!, at }, now, fireProjectile) === 'stop') {return;}
    this.relayShot(playerId, msg, at, now);
  }

  /** Admission gates, in order: dead shooter, uplink stamp, dir
   *  sanitize, shotId dedupe, the simmed-weapon predicate, and the
   *  class lock that beams/melee can't dodge. Null = the intent is
   *  dead (verdict or silent drop already emitted). */
  private shotAdmit(playerId: string, msg: ShotMsg): { player: PlayerState; now: number; dir: Vec3 | undefined; fireProjectile: NonNullable<CombatDeps['fireProjectile']> | undefined } | null {
    const player = this.playerManager.getPlayer(playerId);
    // A dead-shooter claim is a client dead-gate breach - counted on the
    // handler ledger (inv stays out: handler-level tests legitimately
    // exercise this path, the breach signal is the reject verdict).
    if (!player || player.isDead) {
      this.hb('drop.deadShot');
      this.reject(playerId, 'Shot', 'shooter dead', undefined, msg.weaponType, msg.shotId);
      return null;
    }
    const now = wallNow();
    if (typeof msg.fireAt === 'number' && Number.isFinite(msg.fireAt)) {this.deps.uplinkNote?.(playerId, msg.fireAt);}
    const dir = msg.dir && finiteVec(msg.dir) ? msg.dir : undefined;
    // Reclaim replays resend recent fire intents - a pull already spawned
    // under this nonce is a no-op, not a second shell. Dropping silently
    // (not rejecting) is correct: the first intent's verdict already flew.
    if (this.shotDup(playerId, msg.shotId, now)) {return null;}
    const fireProjectile = dir && serverSimmed(msg.weaponType) && !CombatHandler.BEAM_INTENT_WEAPONS.has(msg.weaponType!) ? this.deps.fireProjectile : undefined;
    // Weapon gate, in order: gungame's ladder owns the check outright
    // (it crosses class tiers on purpose); every other room keeps the
    // class lock + instagib whitelist. Beams and melee can't dodge it.
    if (msg.weaponType !== undefined) {
      const mods = this.deps.mods?.() ?? {};
      const gg = mods.gungame === true;
      const allowed = gg
        ? gunGameAllows(this.deps.gunRungOf?.(playerId) ?? 0, msg.weaponType, mods.igun === true)
        : classCanFire(player.armorClass, msg.weaponType)
          && (mods.instagib !== true || isInstagibWeapon(msg.weaponType));
      if (!allowed) {
        this.reject(playerId, 'Shot', gg ? 'gun-game weapon' : 'class-locked weapon', undefined, msg.weaponType, msg.shotId);
        return null;
      }
      if (gg) {this.deps.gunGameHeld?.(playerId, msg.weaponType);}
    }
    return { player, now, dir, fireProjectile };
  }

  /** shotId replay gate: true when this nonce already spawned inside
   *  the dedupe window (reclaim resend = no-op, not a second shell). */
  private shotDup(playerId: string, shotId: string | undefined, now: number): boolean {
    if (!shotId) {return false;}
    const seenAt = this.seenShots.get(playerId)?.get(shotId);
    return seenAt !== undefined && now - seenAt < CombatHandler.SHOT_DEDUPE_MS;
  }

  /** Melee intent: the swing point is server-derived (rewound origin +
   *  aim offset), so a forged position can't widen the arc - the old
   *  aoeShot claim carried a client position for exactly this math. */
  private meleeIntent(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3): void {
    const meleeStats = getWeaponStats(WeaponType.Melee);
    const reach = meleeStats ? meleeStats.aoeRadius * 0.7 : 2.2;
    const l = dhypot3(dir.x, dir.y, dir.z) || 1;
    const mpos = this.claimOrigin(player, this.uplinkMsOf(playerId, msg), msg.pos);
    // The creature half of the swing pays here too - same derived
    // origin, same dir - so the client's predicted contact never
    // needs a creatureHit claim.
    this.deps.emit?.({ type: 'meleeSweep', playerId, pos: mpos, dir: { x: dir.x / l, y: dir.y / l, z: dir.z / l } });
    this.aoe.handleAOEShot(playerId, {
      type: 'aoeShot',
      position: { x: mpos.x + (dir.x / l) * reach, y: mpos.y + 1.2 + (dir.y / l) * reach, z: mpos.z + (dir.z / l) * reach },
      weaponType: WeaponType.Melee, excludeTargetId: null,
    });
    const meleeWid = this.deps.widOf?.(playerId);
    const muzzle = { x: mpos.x, y: mpos.y, z: mpos.z };
    if (this.deps.earlyRelayed?.(playerId, msg.shotId)) { /* flashed at arrival */ }
    else if (meleeWid !== undefined && this.deps.wireCast) {
      this.deps.wireCast(encodeShotEv(meleeWid, msg.weaponType, muzzle, msg.dir), 'volatile', playerId);
    } else {
      this.broadcast({
        type: 'playerShot', id: playerId, weaponType: msg.weaponType,
        pos: muzzle, dir: msg.dir,
      }, playerId);
    }
  }

  /** The four beam intents - each tick IS the shot for these weapons:
   *  the room's honest ray decides the contact and the economy pays
   *  here, so neither a creatureHit claim nor a per-tick aoeShot is
   *  needed. Returns true when a flood/cadence gate ate the intent
   *  (the handler must not relay it); false lets the cosmetic tail
   *  run. weaponType is single-valued, so at most one block fires. */
  private beamIntents(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3 | undefined, now: number): boolean {
    if (this.lightningIntent(playerId, player, msg, dir, now)) {return true;}
    if (this.shocklanceIntent(playerId, player, msg, dir, now)) {return true;}
    if (this.repairIntent(playerId, player, msg, dir, now)) {return true;}
    if (this.healBeamIntent(playerId, player, msg, dir, now)) {return true;}
    return false;
  }

  /** Shared 30/s flood gate for the beam intents - a burst of beam
   *  ticks is a flood, not a stream of shots. True = intent refused. */
  private beamFloodGate(playerId: string, now: number): boolean {
    const recent = (this.beamFireTimes.get(playerId) ?? []).filter((t): boolean => now - t < 1000);
    if (recent.length >= 30) { this.hb('drop.beamFlood'); return true; }
    recent.push(now);
    this.beamFireTimes.set(playerId, recent);
    return false;
  }

  /** Beam intent (Lightning): each tick IS the intent - the room's
   *  honest ray decides the contact and the ramp/bank economy pays
   *  here, so neither a creatureHit claim nor a per-tick aoeShot is
   *  needed. Falls through to the cosmetic playerShot relay below. */
  private lightningIntent(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3 | undefined, now: number): boolean {
    const sweep = this.deps.beamSweep;
    if (msg.weaponType !== WeaponType.Lightning || !dir || !sweep) {return false;}
    if (this.beamFloodGate(playerId, now)) {return true;}
    player.protectedUntil = simMs(0);
    const mpos = this.claimOrigin(player, this.uplinkMsOf(playerId, msg), msg.pos);
    const l = dhypot3(dir.x, dir.y, dir.z) || 1;
    this.beamPay(playerId, player, sweep(playerId,
      { x: mpos.x, y: mpos.y, z: mpos.z },
      { x: dir.x / l, y: dir.y / l, z: dir.z / l }, LG_RANGE));
    return false;
  }

  /** Beam intent (Shocklance): one zap per pull-out cycle - the intent
   *  IS the shot; the honest ray resolves the contact and pays the flat
   *  lance damage. No ramp/bank economy - that's the LG's business. */
  private shocklanceIntent(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3 | undefined, now: number): boolean {
    const sweep = this.deps.beamSweep;
    if (msg.weaponType !== WeaponType.Shocklance || !dir || !sweep) {return false;}
    const lastL = this.lastLance.get(playerId) ?? 0;
    // The gate sits 150ms UNDER the client's cadence (the old pair was
    // 1.0s client / 850ms server) - arrival jitter must never refuse a
    // shot the honest trigger just released.
    if (now - lastL < LANCE_CADENCE_S * 1000 - 150) { this.hb('drop.lanceCadence'); return true; }
    this.lastLance.set(playerId, now);
    player.protectedUntil = simMs(0);
    const mpos = this.claimOrigin(player, this.uplinkMsOf(playerId, msg), msg.pos);
    const l = dhypot3(dir.x, dir.y, dir.z) || 1;
    this.lancePay(playerId, player, sweep(playerId,
      { x: mpos.x, y: mpos.y, z: mpos.z },
      { x: dir.x / l, y: dir.y / l, z: dir.z / l }, LANCE_RANGE));
    return false;
  }

  /** Beam intent (Repair): same shape - the tick is the intent and the
   *  server names the weld target off the honest ray, so the per-tick
   *  `repair` claim isn't needed. Falls through to the cosmetic relay. */
  private repairIntent(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3 | undefined, now: number): boolean {
    const { repairTarget } = this.deps;
    if (msg.weaponType !== WeaponType.Repair || !dir || !repairTarget) {return false;}
    if (this.beamFloodGate(playerId, now)) {return true;}
    const mpos = this.claimOrigin(player, this.uplinkMsOf(playerId, msg), msg.pos);
    const l = dhypot3(dir.x, dir.y, dir.z) || 1;
    const id = repairTarget(playerId,
      { x: mpos.x, y: mpos.y, z: mpos.z },
      { x: dir.x / l, y: dir.y / l, z: dir.z / l }, REPAIR_RANGE);
    if (id !== null) {this.deps.repair?.(playerId, id);}
    return false;
  }

  /** Beam intent (HealBeam): same tick-is-intent shape, but the honest
   *  ray's first contact must be a TEAMMATE - anything earlier (enemy,
   *  creature, wall) shadows the patient and the tick pays nothing.
   *  The ammo is the shooter's own jet tank: pocket-healing a push
   *  costs the medic their climb out. healTicks paces per shooter|
   *  patient pair - the same rate law the repair beam enforces. */
  private healBeamIntent(playerId: string, player: PlayerState, msg: ShotMsg, dir: Vec3 | undefined, now: number): boolean {
    const sweep = this.deps.beamSweep;
    if (msg.weaponType !== WeaponType.HealBeam || !dir || !sweep) {return false;}
    if (this.beamFloodGate(playerId, now)) {return true;}
    const mpos = this.claimOrigin(player, this.uplinkMsOf(playerId, msg), msg.pos);
    const l = dhypot3(dir.x, dir.y, dir.z) || 1;
    // includeTeammates: the honest ray must CONTACT the patient - damage
    // beams skip friendly bodies, but the heal contact IS a teammate.
    const c = sweep(playerId,
      { x: mpos.x, y: mpos.y, z: mpos.z },
      { x: dir.x / l, y: dir.y / l, z: dir.z / l }, HEALBEAM_RANGE, true);
    if (c?.playerId && this.friendly(playerId, c.playerId)) {
      this.healBeamTick(playerId, c.playerId, now);
    }
    return false;
  }

  /** One heal tick on a resolved teammate contact: pair-paced, tank-
   *  paid, and only lands on a living patient. */
  private healBeamTick(playerId: string, patientId: string, now: number): void {
    const key = `${playerId}|${patientId}`;
    if (now - (this.healTicks.get(key) ?? -1) < HEALBEAM_MIN_TICK_S * 1000) { this.hb('drop.healPace'); return; }
    this.healTicks.set(key, now);
    if ((this.deps.energyOf?.(playerId) ?? 0) < HEALBEAM_ENERGY) { this.hb('drop.tankDry'); return; }
    this.deps.drainEnergy?.(playerId, HEALBEAM_ENERGY);
    const target = this.playerManager.getPlayer(patientId);
    if (target && !target.isDead) {
      healPool(target, HEALBEAM_PER_TICK);
      target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
      this.hb('heal.beam');
    }
  }

  /** Simmed-intent flood + cadence gates. Returns false when a reject
   *  already went out (the handler must not relay the shot). */
  private simmedFireGate(playerId: string, msg: ShotMsg, now: number): boolean {
    const recent = (this.simmedFireTimes.get(playerId) ?? []).filter((t): boolean => now - t < 1000);
    if (recent.length >= 20) { this.reject(playerId, 'Shot', 'fire rate (flood)', undefined, msg.weaponType, msg.shotId); return false; }
    recent.push(now);
    this.simmedFireTimes.set(playerId, recent);
    // Per-weapon cadence law - revived from the retired shotClaims: the
    // flat 20/s flood gate alone lets a mortar (2.0s interval) claim
    // ~13 simmed shells/sec. Rolling-second arrival bound per
    // `${playerId}:${weaponType}`; 0.85× interval slack absorbs input
    // bunching under loss, so legit burst catch-up passes.
    const interval = msg.weaponType === undefined ? undefined : WEAPON_FIRE_INTERVAL_S[msg.weaponType as WeaponType];
    if (interval !== undefined) {
      const key = `${playerId}:${msg.weaponType}`;
      const win = this.fireWindows.get(key) ?? { start: now, count: 0, lastTs: undefined, arr: [] as number[], violations: 0 };
      this.fireWindows.set(key, win);
      win.arr = win.arr.filter((t): boolean => now - t < 1000);
      win.arr.push(now);
      if (win.arr.length >= Math.ceil(1000 / (interval * 850)) + 2) {
win.violations += 1;
        this.reject(playerId, 'Shot', `fire rate (cadence: ${win.arr.length}/s)`, undefined, msg.weaponType, msg.shotId);
        return false;
      }
    }
    return true;
  }

  /** The simmed spawn path: cost gates then shell shaping + the
   *  authoritative fireProjectile call. 'stop' = spawned or hard-
   *  rejected (handler ends); 'relay' = spawn declined, fall through
   *  to the cosmetic playerShot tail. */
  private simmedShot(playerId: string, player: PlayerState, msg: ShotMsg, aim: { dir: Vec3; at: Vec3 }, now: number, fireProjectile: NonNullable<CombatDeps['fireProjectile']>): 'relay' | 'stop' {
    if (!this.shotCosts(playerId, player, msg, now)) {return 'stop';}
    player.protectedUntil = simMs(0); // firing breaks your own spawn shield
    const l = dhypot3(aim.dir.x, aim.dir.y, aim.dir.z) || 1;
    const base = { x: aim.dir.x / l, y: aim.dir.y / l, z: aim.dir.z / l };
    // Launcher recoil (howitzer): authority applies the same kick the
    // client predicted - aimed up off dirt it's the shooter's own
    // fall damage. Rides the impulse event so the moveSim shadow AND
    // the sim journal see the delta, not just the wire position.
    const recoil = msg.weaponType === undefined ? 0 : (getWeaponStats(msg.weaponType).recoilImpulse ?? 0);
    if (recoil > 0) {
      this.deps.emit?.({ type: 'impulse', playerId,
        dv: { x: -base.x * recoil, y: -base.y * recoil, z: -base.z * recoil }, fallBoost: 3 });
    }
    const ndir = this.bloomAim(playerId, player, msg, base, now);
    const ownerVel = this.ownerVelOf(player, msg);
    // Back-date the shell's age by the MEASURED uplink transit - the
    // EMA fed by pongs + bounded claim samples, not this claim's stamp
    // (a stale/forged fireAt only re-anchors the ORIGIN above; it may
    // not buy seconds of shell age). Without a measurement the honest
    // age is arrival-time - transitOf returns 0 in join grace.
    const lagS = (this.deps.transitOf?.(playerId) ?? 0) / 1000;
    const id = fireProjectile(playerId, msg.weaponType!,
      { x: aim.at.x, y: aim.at.y, z: aim.at.z },
      ndir,
      ownerVel, msg.shotId, lagS);
    if (id) {
      this.noteShot(playerId, msg.shotId, now);
      this.hb('shot.serverSim');
      if (msg.weaponType !== undefined) {weaponStats.recordShot(this.deps.mode ?? '', `w${msg.weaponType}`);}
      return 'stop';
    }
    // spawn() declined - a silent no-spawn leaves a predicted shell
    // waiting forever. Hitscan-class (speed<=0) never owns a shell:
    // its damage settled in the beam intent above, and the reject
    // would misreport a refused shot, so it falls through to relay.
    const hs = msg.weaponType === undefined ? undefined : getWeaponStats(msg.weaponType);
    if (hs === undefined || hs.speed > 0) {this.reject(playerId, 'Shot', 'spawn refused', undefined, msg.weaponType, msg.shotId);}
    return 'relay';
  }

  /** Cost gates for a simmed intent - belt charges, jet-tank energy,
   *  pool ammo, grounded-only. False = a reject already went out. */
  private shotCosts(playerId: string, player: PlayerState, msg: ShotMsg, now: number): boolean {
    // Belt throws pay the same charge the spawn claim would deduct -
    // skipping it would make free ordnance a forged intent away.
    if (msg.weaponType !== undefined && BELT_THROW_WEAPONS.has(msg.weaponType)) {
      const cost = beltThrowCost(msg.weaponType);
      // Silent drops orphan the shooter's predicted shell - it binds
      // nothing and reads as a ghost hit. Verdict back so the ledger
      // closes instead of waiting out the bind grace.
      if (player.beltCharges < cost) { this.hb('drop.beltDry'); this.reject(playerId, 'Shot', 'belt charges dry', undefined, msg.weaponType, msg.shotId); return false; }
      player.beltCharges -= cost;
    }
    // Energy-paid weapons (Blaster): the jet tank IS the magazine -
    // one shared cost formula (payShotCost) so bots, clients and the
    // server never disagree on the bill. Verdict back so the shooter's
    // predicted bolt doesn't ghost.
    if (!payShotCost(msg.weaponType, playerId,
      (id): number | null => this.deps.energyOf?.(id) ?? 0,
      (id, n): void => this.deps.drainEnergy?.(id, n))) {
      this.hb('drop.tankDry'); this.reject(playerId, 'Shot', 'energy dry', undefined, msg.weaponType, msg.shotId); return false;
    }
    // Pool ammo (PlasmaGun pilot): lazy fractional regen on the claim's
    // own arrival clock - a dry pool rejects the intent and the verdict
    // closes the shooter's predicted ledger instead of ghosting a bolt.
    if (msg.weaponType !== undefined && !spendAmmo(player.ammoPool, msg.weaponType, now / 1000)) {
      this.hb('drop.ammoDry'); this.reject(playerId, 'Shot', 'ammo dry', undefined, msg.weaponType, msg.shotId); return false;
    }
    // Deploy weapons (howitzer): grounded and not skiing, or the pull
    // is dead - the predicted gate is on the same row, so a refused
    // intent never costs ammo either way.
    const st = msg.weaponType === undefined ? undefined : getWeaponStats(msg.weaponType);
    if (st?.groundedOnly && (!(this.deps.groundedOf?.(playerId) ?? false) || player.skiing !== 0)) {
      this.hb('drop.notGrounded'); this.reject(playerId, 'Shot', 'needs ground', undefined, msg.weaponType, msg.shotId); return false;
    }
    return true;
  }

  /** Server-owned bloom cone (chaingun): the client claims a RAW aim
   *  dir - we draw the seeded cone its predicted shell used, so a
   *  forged "center" claim still lands inside the same scatter.
   *  No shotId = no shared seed = no cone (old clients, relays). */
  private bloomAim(playerId: string, player: PlayerState, msg: ShotMsg, base: Vec3, now: number): Vec3 {
    const bs = bloomRadius(player.bloom, player.bloomAt, msg.weaponType ?? -1, now / 1000);
    let ndir = base;
    if (bs.radius > 0) {
      // Server-side sequence seed, NOT the claimed shotId - a client
      // that brute-forces favorable seeds gains nothing (the CSGO
      // random_seed hole). It predicts the same counter per pull.
      const seq = player.bloomSeq;
      player.bloomSeq += 1;
      const [u1, u2] = jitter01(idSeed(playerId) ^ seq);
      ndir = coneDir(base, u1 * Math.PI * 2, Math.sqrt(u2) * bs.radius);
    }
    player.bloom = bloomGrow(bs.bloom, msg.weaponType ?? -1);
    player.bloomAt = now / 1000;
    return ndir;
  }

  /** Velocity inherit: the predicted shell draws playerVel*0.5 - using
   *  the shadow velocity here diverges the echo by uplink-of-accel and
   *  shows as a mid-air reanchor jink. Adopt the claim's vel verbatim
   *  within an honest window (accel×lag can't legit exceed ~20m/s);
   *  a forged vel beyond that clamps to shadow - worst cheat is a
   *  half-weighted 20m/s nudge, not a free speedline. */
  private ownerVelOf(player: PlayerState, msg: ShotMsg): Vec3 {
    return msg.vel && finiteVec(msg.vel)
        && dhypot3(msg.vel.x - player.velocity.x, msg.vel.y - player.velocity.y, msg.vel.z - player.velocity.z) <= 20
      ? msg.vel : player.velocity;
  }

  /** shotId → spawn bookkeeping: dedupe record, stale-entry trim,
   *  64-entry cap. */
  private noteShot(playerId: string, shotId: string | undefined, now: number): void {
    if (!shotId) {return;}
    let seen = this.seenShots.get(playerId);
    if (!seen) {seen = new Map(); this.seenShots.set(playerId, seen);}
    for (const [k, t] of seen) {if (now - t >= CombatHandler.SHOT_DEDUPE_MS) {seen.delete(k);}}
    seen.set(shotId, now);
    if (seen.size > 64) {seen.delete(seen.keys().next().value!);}
  }

  /** The cosmetic relay tail: one 50ms throttle per player shared by
   *  the intent fall-through and refused spawns, then wireCast when a
   *  wireId exists else the playerShot broadcast. pos.y IS the eye
   *  (screen center) - the muzzle relays right off it, Quake-style,
   *  no bump (a +1.6 would double-offset over the crosshair). */
  private relayShot(playerId: string, msg: ShotMsg, at: Vec3, now: number): void {
    // Same 50ms cosmetic gate for the intent fall-through: a refused
    // spawn relaying every claim would spam the room (claimless combat
    // moved simmed weapons off the else-branch throttle).
    if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) {return;}
    this.lastFireNotify.set(playerId, now);
    const shotWid = this.deps.widOf?.(playerId);
    if (this.deps.earlyRelayed?.(playerId, msg.shotId)) {return;} // flashed at arrival
    if (shotWid !== undefined && this.deps.wireCast) {
      this.deps.wireCast(encodeShotEv(shotWid, msg.weaponType, { x: at.x, y: at.y, z: at.z }, msg.dir), 'volatile', playerId);
    } else {
      this.broadcast({
        type: 'playerShot', id: playerId, weaponType: msg.weaponType,
        pos: { x: at.x, y: at.y, z: at.z }, dir: msg.dir,
      }, playerId);
    }
  }

  /** Slam landing intent - the client's dive speed is never trusted;
   *  power comes off the move shadow's own velocity (the landing claim
   *  lands while the pre-impact speed is still the freshest sample).
   *  Position gets a loose plausibility gate against the shadow - a
   *  slam teleported across the map is rejected, not adjudicated. */
  handleSlam(playerId: string, msg: Extract<ClientMessage, { type: 'slam' }>): ClaimVerdict {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) { this.hb('drop.deadSlam'); return 'shooter dead'; }
    if (!Number.isFinite(msg.position.x + msg.position.y + msg.position.z)) { this.hb('drop.slamNonFinite'); return 'landing non-finite'; }
    const dx = msg.position.x - player.position.x, dy = msg.position.y - player.position.y, dz = msg.position.z - player.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 60 * 60) { this.hb('drop.slamFar'); this.reject(playerId, 'Slam', `landing ${Math.sqrt(d2).toFixed(0)}m from shadow`, undefined, WeaponType.Slam); return `landing ${Math.sqrt(d2).toFixed(0)}m from shadow`; }
    const speed = dhypot3(player.velocity.x, player.velocity.y, player.velocity.z);
    const power = Math.min(Math.max((speed - 30) / 50, 0.2), 1.8);
    this.blast.serverBlast(playerId, msg.position, WeaponType.Slam, null, { power });
    this.hb('slam.server');
    return true;
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    if (this.playerManager.getPlayer(playerId)?.isDead) {
      this.hb('drop.deadShooter');
      this.notifyDrop(playerId, 'AOE', 'shooter dead', undefined, msg.weaponType, msg.shotId);
      return;
    }
    if (typeof msg.fireAt === 'number' && Number.isFinite(msg.fireAt)) {this.deps.uplinkNote?.(playerId, msg.fireAt);}
    this.deps.emit?.({ type: 'fire', playerId });
    this.aoe.handleAOEShot(playerId, msg);
  }

  /** Server-owned blast - the room's projectile/deployable sims decided
   *  where this pops, so the shooter-distance sanity check doesn't apply. */
  serverBlast(ownerId: string, position: Vec3, weaponType: number, excludeTargetId?: string | null, opts?: { shotId?: string; attribWeaponType?: number; power?: number; air?: number; radiusScale?: number }): void {
    this.blast.serverBlast(ownerId, position, weaponType, excludeTargetId, opts);
  }

  /** Rope-dart contact - the projectile sim resolved the hook's connect
   *  point; blast owns the impulse. */
  grapple(ownerId: string, anchor: Vec3, victimId: string | null): void {
    this.blast.grapple(ownerId, anchor, victimId);
  }

  // Client-reported environmental damage (crawler pounces, etc.) - self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
  handleEnvironmentDamage(playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): ClaimVerdict {
    return handleEnvironmentDamage(this, playerId, msg);
  }

  /** Heal claim cadence gate - see envClaims.handleHeal. */
  lastHeal = new Map<string, number>();
  /** Per-attacker env-splash credit clock - see envClaims EnvHost. */
  lastEnvCredit = new Map<string, number>();

  // Client-claimed heal - self-only; team-mode needs a server-granted
  // credit, elsewhere the claim stays free-form.
  handleHeal(playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): ClaimVerdict {
    return handleHeal(this, playerId, msg);
  }

  handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    // Every shell is server-simmed - the sim owns its lifecycle end to
    // end, so a client projectileDestroy can never be legal. Drop it
    // (heartbeat so a forged client shows in the health map).
    this.hb('drop.destroy');
    logger.debug(`projectileDestroy dropped - shells are server-owned`, { playerId, projectileId: msg.projectileId, shotId: msg.shotId });
  }

  // One funnel for the hit-or-kill outcome: broadcast the damage, or credit
  // the kill and start the respawn timer. Keeps the three damage paths in
  // lockstep - a fix here can't drift between shot/AOE/environment.
  /** Server-bot hitscan - no wire claim to validate, the server IS the
   *  shooter, so this goes straight to damage. Distance/hit-chance live in
   *  ServerBots; this just runs the shared outcome funnel so bot kills,
   *  knockback bookkeeping and respawns match player-caused ones. */
  /** Server-owned sentry hit - owner is the shooter for scoring/friendly
   *  checks, but the sim drives the trigger, not a client claim. */
  /** Server-owned mine blast - owner is the shooter for scoring/friendly
   *  checks, but the sim decided to detonate. Position check skipped: the
   *  blast center is the mine's own spot, not the owner's. */
  mineBlast(ownerId: string, pos: Vec3, maxDamage: number, radius: number, knockback: number): void {
    this.blast.mineBlast(ownerId, pos, maxDamage, radius, knockback);
  }

  /** Single-target server-authored hits (bot shots, sentry bolts, creature
   *  bites) share one funnel: target liveness, optional friendly gate, dd
   *  multiplier off the shooter, applyDamage + forceSend + applyHit.
   *  'environment' = no shooter, no friendly check - a crawler bites
   *  whoever it landed on. */
  serverHit(
    ownerId: string, targetId: string, damage: number, label: string,
    opts: { hb?: string; weapon?: number; shotId?: string; air?: number } = {},
  ): void {
    const target = this.playerManager.getPlayer(targetId);
    if (!target || target.isDead) { this.hb('drop.deadTarget'); return; }
    if (ownerId !== 'environment' && this.friendly(ownerId, targetId)) { this.hb('drop.friendly'); return; }
    if (opts.hb) {this.hb(opts.hb);}
    const owner = ownerId === 'environment' ? null : this.playerManager.getPlayer(ownerId);
    const dmg = damage * (owner ? this.ddMult(owner) : 1);
    const result = this.playerManager.applyDamage(targetId, dmg);
    target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
    this.applyHit(ownerId, targetId, dmg, result, { label, weapon: opts.weapon, shotId: opts.shotId, air: opts.air });
  }

  /** Beam tick payout - the contact is already the honest earliest, so
   *  this only runs the economy: player victims ride ChargeBank like a
   *  bot beam (ramp → tick → bank → serverHit); creatures bank their
   *  withheld charge on a per-creature map and pop it on a beam kill,
   *  the same corpse-burst players get. */
  private creatureCharge = new Map<string, { charge: number; t: number }>();

  private beamPay(playerId: string, player: PlayerState, c: BeamContact | null): void {
    if (!c) {return;}
    if (c.playerId) {
      const n = this.chargeBank.step(playerId, c.playerId);
      const victim = this.playerManager.getPlayer(c.playerId);
      const scale = c.dmgScale ?? 1;
      const dmg = lgTickDamage(n) * perkMods(player.perk).directDamage * scale;
      if (victim && !victim.isDead && !this.friendly(playerId, c.playerId)) {
        this.chargeBank.bank(victim, this.chargeBank.withheldFor(n) * scale);
      }
      this.serverHit(playerId, c.playerId, dmg, 'Lightning', { hb: 'beam.lg', weapon: WeaponType.Lightning });
      return;
    }
    const s = c.dmgScale ?? 1;
    if (c.ballId !== undefined) {this.creatureTick(playerId, 'ball', c.ballId, c.contact, s);}
    if (c.crawlerId !== undefined) {this.creatureTick(playerId, 'crawl', c.crawlerId, c.contact, s);}
    if (c.chainBallId !== undefined && c.chainContact) {this.creatureTick(playerId, 'ball', c.chainBallId, c.chainContact, LG_CHAIN_DMG_SCALE * s);}
    if (c.chainCrawlerId !== undefined && c.chainContact) {this.creatureTick(playerId, 'crawl', c.chainCrawlerId, c.chainContact, LG_CHAIN_DMG_SCALE * s);}
  }

  /** Shocklance - flat zap on the swept contact: player pays
   *  directDamage (perk-scaled), creatures take the same number through
   *  the standard hit deps. No ramp - the cadence gate IS the economy. */
  private lastLance = new Map<string, number>();

  private lancePay(playerId: string, player: PlayerState, c: BeamContact | null): void {
    if (!c) {return;}
    const stats = getWeaponStats(WeaponType.Shocklance);
    const dmg = stats.directDamage * perkMods(player.perk).directDamage * (c.dmgScale ?? 1);
    if (c.playerId) {
      this.serverHit(playerId, c.playerId, dmg, 'Shocklance', { hb: 'beam.lance', weapon: WeaponType.Shocklance });
      return;
    }
    if (c.ballId !== undefined) {this.deps.ballHit?.(playerId, c.ballId, dmg);}
    if (c.crawlerId !== undefined) {this.deps.crawlerHit?.(playerId, c.crawlerId, dmg);}
  }

  private creatureTick(playerId: string, kind: 'ball' | 'crawl', id: number, at: Vec3, scale: number): void {
    const key = `${kind}:${id}`;
    const n = this.chargeBank.step(playerId, key);
    const nowS = simNow() / 1000;
    const prev = this.creatureCharge.get(key);
    const acc = (prev ? lgChargeAt(prev.charge, prev.t, nowS) : 0)
      + this.chargeBank.withheldFor(n) * scale * LG_POP_CHARGE_MULT;
    this.creatureCharge.set(key, { charge: acc, t: nowS });
    if (this.creatureCharge.size > 64) {
      for (const [k, e] of this.creatureCharge) {
        if (nowS - e.t > 30) {this.creatureCharge.delete(k);}
      }
    }
    const verdict = kind === 'ball'
      ? this.deps.ballHit?.(playerId, id, lgTickDamage(n) * scale)
      : this.deps.crawlerHit?.(playerId, id, lgTickDamage(n) * scale);
    if (verdict?.killed) {
      this.creatureCharge.delete(key);
      if (acc > 0) {this.blast.pop(playerId, at, acc);}
      this.hb('beam.kill');
    }
  }

  /** Deliberate respawn (the client's K bind) - routed through the same
   *  self-hit funnel as a self-frag so the kill feed, corpse charge-pop,
   *  respawn timer, and any pending class/perk all behave identically.
   *  Damage is far over the kill line on purpose: shield/regen buffs
   *  shouldn't half-eat a player's own respawn request. */
  respawnRequest(id: string, hold = false): void {
    const p = this.playerManager.getPlayer(id);
    if (p?.isDead) {
      // Dead press releases a die-and-spectate hold - it never skips a
      // live countdown (a click-beats-timer hole made the delay decorative).
      this.respawner.respawnNow(id);
      return;
    }
    // Arm BEFORE the kill so the timer the death schedules inherits it.
    if (hold) {this.respawner.hold(id);}
    this.serverHit(id, id, 99_999, 'Respawn', { hb: 'respawn.req' });
  }

  /** Server-authored creature bite (CreatureSim). */
  crawlerAttack(targetId: string, damage: number, species = 'crawler', from?: { x: number; y: number; z: number }): void {
    crawlerAttack(this, targetId, damage, species, from);
  }

  turretAttack(ownerId: string, targetId: string, damage: number): void {
    this.serverHit(ownerId, targetId, damage, 'Turret hit');
  }

  botAttack(shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string): void {
    botAttack(this, shooterId, targetId, weaponType, airtime, shotId);
  }

  // Double-damage pickup: multiplies OUTGOING damage while the buff lasts.
  // Applies to every path that already routes through applyHit.
  ddMult(shooter: PlayerState): number {
    return shooter.ddUntil > simNow() ? POWERUP.ddMult : 1;
  }

  applyHit(shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number; endedStreak?: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; shotId?: string; air?: number }): void {
    this.hitLedger.applyHit(this, shooterId, targetId, damage, result, opts);
  }

  // Spree callouts ride matchNotice (system chat line). killTotal()===1 pins
  // first blood exactly - stats are wiped at match boundaries, so a 1 can
  // only mean the opening frag.


  /** Room teardown - pending respawns and queued taunts die with the
   *  room or a hibernating room fires broadcasts into an empty world. */
  dispose(): void {
    this.respawner.dispose();
    this.killFeed.dispose();
  }

  /** Typing-beat delay - a scenario test steps sim-time only, so it
   *  stubs this to 0 to see taunts inside the frag loop. */
  static tauntDelayMs: () => number = (): number => 1200 + tauntRand() * 1800;

  ensureRespawn(playerId: string): void {
    this.respawner.ensure(playerId);
  }

  ensureRespawnScheduled(playerId: string): void {
    this.respawner.ensureScheduled(playerId);
  }
}
