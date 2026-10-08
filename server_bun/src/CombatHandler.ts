import type { ClientMessage, ServerMessage, Vec3, ClaimVerdict } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';
import { logger } from './logger.ts';
import { classCanFire } from '../../shared/botClasses.ts';
import { serverSimmed, BELT_THROW_WEAPONS, beltThrowCost, WeaponType, getWeaponStats, REPAIR_RANGE } from '../../shared/weapons.ts';
import { finiteVec } from '../../shared/wire.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import { rewindPos, shooterTransitMs } from './claimLedger.ts';
import { KillFeed } from './killFeed.ts';
import { RespawnManager } from './respawn.ts';
import { ChargeBank } from './combatCharge.ts';
import { BlastRunner, FORCE_SEND_MS } from './combatBlast.ts';
import { AoeClaims } from './combatAoe.ts';
import type { RoomEventSink } from './roomEvents.ts';
import { HitLedger } from './hitLedger.ts';
import { handleEnvironmentDamage, handleHeal } from './envClaims.ts';
import { crawlerAttack, botAttack } from './serverAttacks.ts';
import { simNow , simMs} from './simClock.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { weaponStats } from './weaponStats.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { tauntRand } from '../../shared/botRand.ts';
import { lgTickDamage, lgChargeAt, LG_RANGE, LG_CHAIN_DMG_SCALE, LG_POP_CHARGE_MULT } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import type { HitVerdict } from './types.ts';

/** What a beam intent's honest ray struck — the room resolves earliest
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
}

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

/** Optional room wiring — mirrors the subset of RoomInfo combat needs. */
export interface CombatDeps {
  /** Domain-event sink — kill/hit/fire/botSpoke notifications fan out
   *  to the room's subscribers (scoring, bot senses, influence). */
  emit?: RoomEventSink;
  /** Team-mode rooms block damage between teammates (knockback still
   *  applies — boosting off a teammate's splash is intentional). */
  teams?: boolean;
  /** Server option: set = teammates CAN damage each other — friendly()
   *  returns false even in team rooms. Splash knockback is unaffected. */
  friendlyFire?: boolean;
  /** Rabbit rooms: returns the flag carrier's id (null when the flag is
   *  loose). Presence of the dep IS the mode check — friendly() blocks
   *  damage unless one side of the pair is the rabbit. */
  rabbitCarrier?: () => string | null;
  /** Rabbit tie-in: ids sitting in last place — the bottom-feeder rule
   *  lets the worst-ranked hunter brawl with anyone. */
  rabbitBottom?: () => Set<string>;
  /** Jet-tank access for heal-beam ammo — the beam burns movement energy,
   *  server-side truth so a bot/client can't heal for free. */
  drainEnergy?: (playerId: string, amount: number) => void;
  energyOf?: (playerId: string) => number | null;
  /** Server-driven respawn is a declared discontinuity — reseat the
   *  shadow at the spawn or the corpse→spawn jump reads as divergence. */
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
  /** Room mode tag for balance telemetry ('ctf', 'nuggets', ...). */
  mode?: string;

  /** A bot chat line hit the wire — Room relays it as a 'reply' notice
   *  so squadmates can answer back. Emitted as 'botSpoke'. */
  /** Room heartbeat counters — claims/rejects/applied damage tally here
   *  so the periodic 'Room health' line shows the funnel at a glance. */
  health?: Map<string, number>;
  /** A real fire claim passed the gates — the sheep meter's ignore
   *  debit needs fire recency for humans (bots report their own).
   *  Emitted as 'fire'. */
  /** Nearest-creature distance for env-damage plausibility (melee-from-
   *  afar flagging). Absent = no creature sim to check against. */
  envRange?: (playerId: string) => number;
  /** Distance of the nearest ball / crawler to a point — self-frag
   *  autopsy discriminates a terrain lip from a body that hopped into
   *  the shell. */
  preyNear?: (pos: Vec3, shooterId?: string) => { ball: number; crawler: number; foe: number };

  /** Spatial memory: hits and kills deposit danger scent on the victim's
   *  team layer; the map itself lives on Room. */
  influence?: InfluenceMap;
  /** Seeded room rng — absent = ambient Math.random (production). */
  rng?: () => number;
  /** Fire-intent → authoritative shell spawn (RoomProjectiles). Only
   *  SERVER_SIMMED_WEAPONS route here; returns the LiveProj id. */
  fireProjectile?: (ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3, shotId?: string) => string | null;
  /** Beam-intent resolution — the honest ray against terrain, walls,
   *  players, and creatures; earliest contact wins. Absent = beam
   *  intents stay cosmetic relays only. */
  beamSweep?: (shooterId: string, muzzle: Vec3, dir: Vec3, range: number) => BeamContact | null;
  /** Creature damage sinks for beam contacts — BallSim/CreatureSim
   *  handleHit; absent when the room runs no creature sims. */
  ballHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  crawlerHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  /** Repair-beam intent: the server picks the weldable deployable the
   *  ray touches, then `repair` pays it (Room.deployables.repair). */
  repairTarget?: (playerId: string, muzzle: Vec3, dir: Vec3, range: number) => number | null;
  repair?: (playerId: string, targetId: number) => ClaimVerdict | void;
  /** Target uplink-transit estimate (ms) — blast lag-comp subtracts the
   *  same lead the tick broadcast shows shooters, so a point-blank-
   *  looking pop validates against the position actually rendered. */
  transitOf?: (playerId: string) => number;
  /** Claim-declared trigger instant (server-clock estimate) — feeds the
   *  measured-uplink channel the transit EMA approximates. */
  uplinkNote?: (playerId: string, fireAt: number) => void;
}

/**
 * Everything that can hurt a player: shot hit-claims, AOE blasts,
 * environmental damage, projectile tracking/destroy, and respawn timers.
 * Split from MessageHandler so the dispatch surface (movement, presence,
 * snapshots) stays a thin routing file. The projectile book-keeping lives
 * in claimLedger — this file keeps the damage policy.
 */
export class CombatHandler {
  /** The blast sweep — claimed AOE resolutions, trusted server blasts,
   *  plating sweeps, mine pops. Own file (combatBlast.ts) via BlastHost. */
  blast: BlastRunner; // public — aoeClaims drives it via AoeHost
  /** Cosmetic relay gate for shotFired — a hitscan pull has no damage
   *  semantics, so excess ones are silently dropped instead of rejected. */
  private lastFireNotify = new Map<string, number>();
  /** 1s sliding window of server-simmed fire intents — the flood gate. */
  private simmedFireTimes = new Map<string, number[]>();
  /** Cadence gate (registerMiss uses it): per `${playerId}:${weaponType}`
   *  burst window — start time + claims seen inside it. The client fire
   *  timer is feel; this is the law. A window holds up to `burst` spawn
   *  claims (fan weapons fire all pellets in one pull); hits don't need
   *  gating — the ledger already caps them at one per registered
   *  projectile. */
  fireWindows = new Map<string, { start: number; count: number; lastTs?: number; arr: number[]; violations: number }>();
  /** Heal-beam tick law — per `shooter|patient` pair last-tick stamp,
   *  the same rate shape the repair beam enforces. */
  healTicks = new Map<string, number>();
  /** The LG bank/ramp economy — own file (combatCharge.ts); this handler
   *  only supplies the detonation (a real processAOE blast). */
  chargeBank: ChargeBank; // public — aoeClaims banks LG ticks through it
  private aoe: AoeClaims;
  /** First-hit timestamps per shooter|victim pair — kill-side applies it
   *  as the engagement time (TTK), hit-side only refreshes it. */
  /** Map-structure colliders — claim validation rejects flights that
   *  would have to pass through a wall to reach their end point.
   *  solidIndex is public — BlastRunner marches through it too. */
  _solids: readonly StructureCollider[] = [];
  solidIndex: ColliderIndex | null = null;
  get solids(): readonly StructureCollider[] { return this._solids; }
  set solids(list: readonly StructureCollider[]) {
    this._solids = list;
    this.solidIndex = list.length ? new ColliderIndex(list) : null;
  }

  killFeed: KillFeed;
  private hitLedger = new HitLedger();
  respawner: RespawnManager;

  /** AoeHost surface — seeded rng rides deps so bomblet scatter replays
   *  under scenario seeds; ambient dice when uninjected. */
  rng(): number { return (this.deps.rng ?? Math.random)(); }

  constructor(
    public playerManager: PlayerManager,
    public broadcast: BroadcastFn,
    public sendToPlayer: SendToPlayerFn,
    public deps: CombatDeps = {},
  ) {
    // Late binding on the static — tests reassign tauntDelayMs after
    // construction and must still steer the delay.
    this.killFeed = new KillFeed(playerManager, broadcast, () => CombatHandler.tauntDelayMs(),
      (id) => this.deps.emit?.({ type: 'botSpoke', id }), sendToPlayer);
    this.respawner = new RespawnManager(playerManager, broadcast, (pid, pos, yaw, full) => this.deps.moveResync?.(pid, pos, yaw, full));
    this.blast = new BlastRunner(this);
    this.chargeBank = new ChargeBank((ownerId, target, amount) => this.blast.pop(ownerId, target.position, amount));
    this.aoe = new AoeClaims(this);
  }

  hb(key: string, n = 1): void {
    if (this.deps.health) this.deps.health.set(key, (this.deps.health.get(key) ?? 0) + n);
  }

  /** Claim refused: server-side warn plus a shotRejected to the shooter so
   *  their client can log WHY predicted damage never happened. */
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number, shotId?: string): void {
    this.hb('rej');
    this.hb(`rej.${kind}`);
    // The verdict is expected traffic — a spray of out-of-reach claims
    // from one player is one signal, not N log lines (16-bot soak:
    // ~200 warns/4min, all stamped by a handful of senders). Throttle
    // per player+kind like notifyDrop does for the wire side; the exact
    // counts still land in the rej.* heartbeat keys.
    this.rejectWarn(`${playerId}:${kind}`,
      `${kind} rejected: ${playerId}${targetId ? ` → ${targetId}` : ''}: ${reason}`);
    // Rejected claims can leave predicted self-damage stuck client-side —
    // ship our health value so the shooter resyncs instead of drifting.
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'shotRejected', reason: `${kind}: ${reason}`, targetId, weaponType, health, shotId });
  }

  /** Honest-lag drop, not a reject — but the shooter's client already
   *  predicted the damage, so it needs a clearing signal or its
   *  pending-hit ledger warns phantom. Throttled per player+kind+target:
   *  a beam held on a corpse would otherwise spam the channel at tic
   *  rate. Distinct from reject(): no warn, no rej counter — these are
   *  the drops the health map already tallies as drop.*. */
  /** Per player+kind warn throttle for reject() — see the comment there.
   *  Keyed like lastDropNotify and cleaned with it on disconnect. */
  private lastRejectWarn = new Map<string, { at: number; n: number }>();
  /** 2s coalescing warn: repeats inside the window count up and land on
   *  the next emitted line, so a claim flood is one signal, not N lines. */
  private rejectWarn(key: string, msg: string): void {
    const now = wallNow();
    const w = this.lastRejectWarn.get(key);
    if (w && now - w.at < 2000) {
      w.n++;
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
    if (now - (this.lastDropNotify.get(key) ?? 0) < 1000) return;
    this.lastDropNotify.set(key, now);
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'claimDropped', reason: `${kind}: ${reason}`, targetId, weaponType, health, shotId });
  }

  friendly(shooterId: string, targetId: string): boolean {
    // Rabbit law: once a rabbit exists, the only legal pairings are ones
    // that include the rabbit — hunter-vs-hunter is friendly fire. The
    // bottom-feeder is exempt: last place can hit/be hit by anyone. No
    // rabbit at all (flag unspawned or loose) = open season. Self-splash
    // stays legal (rocket jumps).
    if (this.deps.rabbitCarrier) {
      if (shooterId === targetId) return false;
      const c = this.deps.rabbitCarrier();
      if (!c || shooterId === c || targetId === c) return false;
      const bottom = this.deps.rabbitBottom?.();
      return !(bottom?.has(shooterId) || bottom?.has(targetId));
    }
    // friendlyFire server option opens the gate entirely; self-splash
    // stays allowed regardless (rocket jumps).
    if (!this.deps.teams || shooterId === targetId || this.deps.friendlyFire) return false;
    const t = this.playerManager.getPlayer(targetId);
    // Map-authored assets shoot under the virtual `base:<team>` owner —
    // no player row exists, so the team's own bodies must be exempted here
    // or a base turret's splash would chew its defenders.
    if (shooterId.startsWith('base:')) return t?.team === shooterId.slice(5);
    const s = this.playerManager.getPlayer(shooterId);
    return !!(s?.team && t?.team && s.team === t.team);
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {

    this.killFeed.forget(playerId);
    // A pending respawn is part of the player's teardown too — removal
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
    // warn keys — a leaver's entry otherwise sits in the map for the
    // room's life.
    this.lastFireNotify.delete(playerId);
    this.simmedFireTimes.delete(playerId);
    for (const key of this.fireWindows.keys()) {
      if (key.startsWith(`${playerId}:`)) this.fireWindows.delete(key);
    }
    this.lastHeal.delete(playerId);
    this.chargeBank.delete(playerId);
    for (const key of this.healTicks.keys()) {
      if (key.startsWith(`${playerId}|`) || key.endsWith(`|${playerId}`)) this.healTicks.delete(key);
    }
    for (const key of this.lastDropNotify.keys()) {
      if (key.startsWith(`${playerId}:`)) this.lastDropNotify.delete(key);
    }
    for (const key of this.lastRejectWarn.keys()) {
      if (key.startsWith(`${playerId}:`)) this.lastRejectWarn.delete(key);
    }
  }

  /** Hitscan fire leaves no projectile for observers to see — relay a
   *  cosmetic 'playerShot' so other clients render muzzle audio/visual.
   *  Origin is server-stamped (rewound to fire time, like spawn sanity
   *  checks) so a forged claim can't paint shots from arbitrary points;
   *  dir stays cosmetic — observers only use it to aim a beam flash. */
  handleShotFired(playerId: string, msg: Extract<ClientMessage, { type: 'shotFired' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const now = wallNow();
    if (typeof msg.fireAt === 'number' && Number.isFinite(msg.fireAt)) this.deps.uplinkNote?.(playerId, msg.fireAt);
    const dir = msg.dir && finiteVec(msg.dir) ? msg.dir : undefined;
    const fireProjectile = dir && serverSimmed(msg.weaponType) ? this.deps.fireProjectile : undefined;
    // Class lock applies to every fire intent — beams and melee skip the
    // projectile branch but must not dodge it.
    if (msg.weaponType !== undefined && !classCanFire(player.armorClass, msg.weaponType)) {
      this.reject(playerId, 'Shot', 'class-locked weapon', undefined, msg.weaponType, msg.shotId);
      return;
    }
    // Melee intent: the swing point is server-derived (rewound origin +
    // aim offset), so a forged position can't widen the arc — the old
    // aoeShot claim carried a client position for exactly this math.
    if (msg.weaponType === WeaponType.Melee && dir) {
      const meleeStats = getWeaponStats(WeaponType.Melee);
      const reach = meleeStats ? meleeStats.aoeRadius * 0.7 : 2.2;
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const mpos = rewindPos(player, shooterTransitMs(this.deps.transitOf, playerId, player.ping));
      // The creature half of the swing pays here too — same derived
      // origin, same dir — so the client's predicted contact never
      // needs a creatureHit claim.
      this.deps.emit?.({ type: 'meleeSweep', playerId, pos: mpos, dir: { x: dir.x / l, y: dir.y / l, z: dir.z / l } });
      this.aoe.handleAOEShot(playerId, {
        type: 'aoeShot',
        position: { x: mpos.x + (dir.x / l) * reach, y: mpos.y + 1.2 + (dir.y / l) * reach, z: mpos.z + (dir.z / l) * reach },
        weaponType: WeaponType.Melee, excludeTargetId: null,
      });
      this.broadcast({
        type: 'playerShot', id: playerId, weaponType: msg.weaponType,
        pos: { x: mpos.x, y: mpos.y + 1.6, z: mpos.z }, dir: msg.dir,
      }, playerId);
      return;
    }
    // Beam intent (Lightning): each tick IS the intent — the room's
    // honest ray decides the contact and the ramp/bank economy pays
    // here, so neither a creatureHit claim nor a per-tick aoeShot is
    // needed. Falls through to the cosmetic playerShot relay below.
    if (msg.weaponType === WeaponType.Lightning && dir && this.deps.beamSweep) {
      const recent = (this.simmedFireTimes.get(playerId) ?? []).filter(t => now - t < 1000);
      if (recent.length >= 30) { this.hb('drop.beamFlood'); return; }
      recent.push(now);
      this.simmedFireTimes.set(playerId, recent);
      player.protectedUntil = simMs(0);
      const mpos = rewindPos(player, shooterTransitMs(this.deps.transitOf, playerId, player.ping));
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      this.beamPay(playerId, player, this.deps.beamSweep(playerId,
        { x: mpos.x, y: mpos.y + 1.6, z: mpos.z },
        { x: dir.x / l, y: dir.y / l, z: dir.z / l }, LG_RANGE));
    }
    // Beam intent (Repair): same shape — the tick is the intent and the
    // server names the weld target off the honest ray, so the per-tick
    // `repair` claim isn't needed. Falls through to the cosmetic relay.
    if (msg.weaponType === WeaponType.Repair && dir && this.deps.repairTarget) {
      const recent = (this.simmedFireTimes.get(playerId) ?? []).filter(t => now - t < 1000);
      if (recent.length >= 30) { this.hb('drop.beamFlood'); return; }
      recent.push(now);
      this.simmedFireTimes.set(playerId, recent);
      const mpos = rewindPos(player, shooterTransitMs(this.deps.transitOf, playerId, player.ping));
      const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const id = this.deps.repairTarget(playerId,
        { x: mpos.x, y: mpos.y + 1.6, z: mpos.z },
        { x: dir.x / l, y: dir.y / l, z: dir.z / l }, REPAIR_RANGE);
      if (id !== null) this.deps.repair?.(playerId, id);
    }
    if (!fireProjectile) {
      // Cosmetic relay only — throttled: a dropped relay costs a muzzle
      // flash, but a dropped intent would orphan a predicted shell.
      if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) return;
      this.lastFireNotify.set(playerId, now);
    } else {
      // Intents spawn real sims + broadcasts, so they need a real flood
      // gate — the fastest legit simmed weapon is ~13/s; 20/s is spam.
      const recent = (this.simmedFireTimes.get(playerId) ?? []).filter(t => now - t < 1000);
      if (recent.length >= 20) { this.reject(playerId, 'Shot', 'fire rate (flood)', undefined, msg.weaponType, msg.shotId); return; }
      recent.push(now);
      this.simmedFireTimes.set(playerId, recent);
    }
    this.deps.emit?.({ type: 'fire', playerId });
    const at = rewindPos(player, shooterTransitMs(this.deps.transitOf, playerId, player.ping));
    // Claimless pilot: a server-simmed intent spawns an authoritative
    // shell — the intent IS the whole claim; contact/blast outcomes
    // arrive as broadcasts, never as client claims. projectileCreated
    // covers observers' visuals, so the playerShot relay is skipped.
    if (fireProjectile) {
      // Belt throws pay the same charge the spawn claim would deduct —
      // skipping it would make free ordnance a forged intent away.
      if (msg.weaponType !== undefined && BELT_THROW_WEAPONS.has(msg.weaponType)) {
        const cost = beltThrowCost(msg.weaponType);
        if (player.beltCharges < cost) { this.hb('drop.beltDry'); return; }
        player.beltCharges -= cost;
      }
      player.protectedUntil = simMs(0); // firing breaks your own spawn shield
      const l = Math.hypot(dir!.x, dir!.y, dir!.z) || 1;
      const id = fireProjectile(playerId, msg.weaponType!,
        { x: at.x, y: at.y + 1.6, z: at.z },
        { x: dir!.x / l, y: dir!.y / l, z: dir!.z / l },
        player.velocity, msg.shotId);
      if (id) {
        this.hb('shot.serverSim');
        if (msg.weaponType !== undefined) weaponStats.recordShot(this.deps.mode ?? '', `w${msg.weaponType}`);
        return;
      }
    }
    this.broadcast({
      type: 'playerShot', id: playerId, weaponType: msg.weaponType,
      pos: { x: at.x, y: at.y + 1.6, z: at.z }, dir: msg.dir,
    }, playerId);
  }

  /** Slam landing intent — the client's dive speed is never trusted;
   *  power comes off the move shadow's own velocity (the landing claim
   *  lands while the pre-impact speed is still the freshest sample).
   *  Position gets a loose plausibility gate against the shadow — a
   *  slam teleported across the map is rejected, not adjudicated. */
  handleSlam(playerId: string, msg: Extract<ClientMessage, { type: 'slam' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) { this.hb('drop.deadSlam'); return; }
    const dx = msg.position.x - player.position.x, dy = msg.position.y - player.position.y, dz = msg.position.z - player.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 60 * 60) { this.hb('drop.slamFar'); this.reject(playerId, 'Slam', `landing ${Math.sqrt(d2).toFixed(0)}m from shadow`, undefined, WeaponType.Slam); return; }
    const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
    const power = Math.min(Math.max((speed - 30) / 50, 0.2), 1.8);
    this.blast.serverBlast(playerId, msg.position, WeaponType.Slam, null, undefined, undefined, power);
    this.hb('slam.server');
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    if (this.playerManager.getPlayer(playerId)?.isDead) {
      this.hb('drop.deadShooter');
      this.notifyDrop(playerId, 'AOE', 'shooter dead', undefined, msg.weaponType, msg.shotId);
      return;
    }
    if (typeof msg.fireAt === 'number' && Number.isFinite(msg.fireAt)) this.deps.uplinkNote?.(playerId, msg.fireAt);
    this.deps.emit?.({ type: 'fire', playerId });
    this.aoe.handleAOEShot(playerId, msg);
  }

  /** Server-owned blast — the room's projectile/deployable sims decided
   *  where this pops, so the shooter-distance sanity check doesn't apply. */
  serverBlast(ownerId: string, position: Vec3, weaponType: number, excludeTargetId?: string | null, shotId?: string, attribWeaponType?: number): void {
    this.blast.serverBlast(ownerId, position, weaponType, excludeTargetId, shotId, attribWeaponType);
  }

  // Client-reported environmental damage (crawler pounces, etc.) — self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
  handleEnvironmentDamage(playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): ClaimVerdict {
    return handleEnvironmentDamage(this, playerId, msg);
  }

  /** Heal claim cadence gate — see envClaims.handleHeal. */
  lastHeal = new Map<string, number>();

  // Client-claimed heal — self-only; team-mode needs a server-granted
  // credit, elsewhere the claim stays free-form.
  handleHeal(playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): ClaimVerdict {
    return handleHeal(this, playerId, msg);
  }

  handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    // Every shell is server-simmed — the sim owns its lifecycle end to
    // end, so a client projectileDestroy can never be legal. Drop it
    // (heartbeat so a forged client shows in the health map).
    this.hb('drop.destroy');
    logger.debug(`projectileDestroy dropped — shells are server-owned`, { playerId, projectileId: msg.projectileId, shotId: msg.shotId });
  }

  // One funnel for the hit-or-kill outcome: broadcast the damage, or credit
  // the kill and start the respawn timer. Keeps the three damage paths in
  // lockstep — a fix here can't drift between shot/AOE/environment.
  /** Server-bot hitscan — no wire claim to validate, the server IS the
   *  shooter, so this goes straight to damage. Distance/hit-chance live in
   *  ServerBots; this just runs the shared outcome funnel so bot kills,
   *  knockback bookkeeping and respawns match player-caused ones. */
  /** Server-owned sentry hit — owner is the shooter for scoring/friendly
   *  checks, but the sim drives the trigger, not a client claim. */
  /** Server-owned mine blast — owner is the shooter for scoring/friendly
   *  checks, but the sim decided to detonate. Position check skipped: the
   *  blast center is the mine's own spot, not the owner's. */
  mineBlast(ownerId: string, pos: Vec3, maxDamage: number, radius: number, knockback: number): void {
    this.blast.mineBlast(ownerId, pos, maxDamage, radius, knockback);
  }

  /** Single-target server-authored hits (bot shots, sentry bolts, creature
   *  bites) share one funnel: target liveness, optional friendly gate, dd
   *  multiplier off the shooter, applyDamage + forceSend + applyHit.
   *  'environment' = no shooter, no friendly check — a crawler bites
   *  whoever it landed on. */
  serverHit(
    ownerId: string, targetId: string, damage: number, label: string,
    opts: { hb?: string; weapon?: number; shotId?: string; air?: number } = {},
  ): void {
    const target = this.playerManager.getPlayer(targetId);
    if (!target || target.isDead) { this.hb('drop.deadTarget'); return; }
    if (ownerId !== 'environment' && this.friendly(ownerId, targetId)) { this.hb('drop.friendly'); return; }
    if (opts.hb) this.hb(opts.hb);
    const owner = ownerId === 'environment' ? null : this.playerManager.getPlayer(ownerId);
    const dmg = damage * (owner ? this.ddMult(owner) : 1);
    const result = this.playerManager.applyDamage(targetId, dmg);
    target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
    this.applyHit(ownerId, targetId, dmg, result, { label, weapon: opts.weapon, shotId: opts.shotId, air: opts.air });
  }

  /** Beam tick payout — the contact is already the honest earliest, so
   *  this only runs the economy: player victims ride ChargeBank like a
   *  bot beam (ramp → tick → bank → serverHit); creatures bank their
   *  withheld charge on a per-creature map and pop it on a beam kill,
   *  the same corpse-burst players get. */
  private creatureCharge = new Map<string, { charge: number; t: number }>();

  private beamPay(playerId: string, player: PlayerState, c: BeamContact | null): void {
    if (!c) return;
    if (c.playerId) {
      const n = this.chargeBank.step(playerId, c.playerId);
      const victim = this.playerManager.getPlayer(c.playerId);
      const dmg = lgTickDamage(n) * perkMods(player.perk).directDamage;
      if (victim && !victim.isDead && !this.friendly(playerId, c.playerId)) {
        this.chargeBank.bank(victim, this.chargeBank.withheldFor(n));
      }
      this.serverHit(playerId, c.playerId, dmg, 'Lightning', { hb: 'beam.lg', weapon: WeaponType.Lightning });
      return;
    }
    if (c.ballId !== undefined) this.creatureTick(playerId, 'ball', c.ballId, c.contact, 1);
    if (c.crawlerId !== undefined) this.creatureTick(playerId, 'crawl', c.crawlerId, c.contact, 1);
    if (c.chainBallId !== undefined && c.chainContact) this.creatureTick(playerId, 'ball', c.chainBallId, c.chainContact, LG_CHAIN_DMG_SCALE);
    if (c.chainCrawlerId !== undefined && c.chainContact) this.creatureTick(playerId, 'crawl', c.chainCrawlerId, c.chainContact, LG_CHAIN_DMG_SCALE);
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
        if (nowS - e.t > 30) this.creatureCharge.delete(k);
      }
    }
    const verdict = kind === 'ball'
      ? this.deps.ballHit?.(playerId, id, lgTickDamage(n) * scale)
      : this.deps.crawlerHit?.(playerId, id, lgTickDamage(n) * scale);
    if (verdict?.killed) {
      this.creatureCharge.delete(key);
      if (acc > 0) this.blast.pop(playerId, at, acc);
      this.hb('beam.kill');
    }
  }

  /** Deliberate respawn (the client's K bind) — routed through the same
   *  self-hit funnel as a self-frag so the kill feed, corpse charge-pop,
   *  respawn timer, and any pending class/perk all behave identically.
   *  Damage is far over the kill line on purpose: shield/regen buffs
   *  shouldn't half-eat a player's own respawn request. */
  respawnRequest(id: string, hold = false): void {
    const p = this.playerManager.getPlayer(id);
    if (p?.isDead) {
      // Dead press releases a die-and-spectate hold — it never skips a
      // live countdown (a click-beats-timer hole made the delay decorative).
      this.respawner.respawnNow(id);
      return;
    }
    // Arm BEFORE the kill so the timer the death schedules inherits it.
    if (hold) this.respawner.hold(id);
    this.serverHit(id, id, 99999, 'Respawn', { hb: 'respawn.req' });
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

  applyHit(shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number; shotId?: string; air?: number }): void {
    this.hitLedger.applyHit(this, shooterId, targetId, damage, result, opts);
  }

  // Spree callouts ride matchNotice (system chat line). killTotal()===1 pins
  // first blood exactly — stats are wiped at match boundaries, so a 1 can
  // only mean the opening frag.


  /** Room teardown — pending respawns and queued taunts die with the
   *  room or a hibernating room fires broadcasts into an empty world. */
  dispose(): void {
    this.respawner.dispose();
    this.killFeed.dispose();
  }

  /** Typing-beat delay — a scenario test steps sim-time only, so it
   *  stubs this to 0 to see taunts inside the frag loop. */
  static tauntDelayMs: () => number = () => 1200 + tauntRand() * 1800;

  ensureRespawn(playerId: string): void {
    this.respawner.ensure(playerId);
  }

  ensureRespawnScheduled(playerId: string): void {
    this.respawner.ensureScheduled(playerId);
  }
}
