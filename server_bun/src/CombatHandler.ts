import type { ClientMessage, ServerMessage, Vec3, ClaimVerdict } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';
import { logger } from './logger.ts';
import { classCanFire } from '../../shared/botClasses.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import { ClaimLedger, clampPing, rewindPos, CLAIM_DEFER_MS, type ClaimDefer } from './claimLedger.ts';
export type { ClaimDefer };
import { KillFeed } from './killFeed.ts';
import { RespawnManager } from './respawn.ts';
import { ChargeBank } from './combatCharge.ts';
import { BlastRunner, FORCE_SEND_MS } from './combatBlast.ts';
import { AoeClaims } from './combatAoe.ts';
import type { RoomEventSink } from './roomEvents.ts';
import { HitLedger } from './hitLedger.ts';
import { handleEnvironmentDamage, handleHeal } from './envClaims.ts';
import { crawlerAttack, botAttack } from './serverAttacks.ts';
import { hitClaim, registerMiss } from './shotClaims.ts';
import { simNow } from './simClock.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { weaponStats } from './weaponStats.ts';
import { wallNow } from './wallClock.ts';
import { tauntRand } from '../../shared/botRand.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

interface PendingClaim {
  playerId: string;
  kind: string;
  d: ClaimDefer;
  run: (d: ClaimDefer) => void;
  targetId?: string;
  weaponType?: number;
}

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
}

/**
 * Everything that can hurt a player: shot hit-claims, AOE blasts,
 * environmental damage, projectile tracking/destroy, and respawn timers.
 * Split from MessageHandler so the dispatch surface (movement, presence,
 * snapshots) stays a thin routing file. The projectile book-keeping lives
 * in claimLedger — this file keeps the damage policy.
 */
export class CombatHandler {
  ledger = new ClaimLedger(); // public — claim families read it via hosts
  /** The blast sweep — claimed AOE resolutions, trusted server blasts,
   *  plating sweeps, mine pops. Own file (combatBlast.ts) via BlastHost. */
  blast: BlastRunner; // public — aoeClaims drives it via AoeHost
  /** Cosmetic relay gate for shotFired — a hitscan pull has no damage
   *  semantics, so excess ones are silently dropped instead of rejected. */
  private lastFireNotify = new Map<string, number>();
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

  /** Claims that name a projectile the ledger doesn't know yet — on
   *  unordered transports (WT/RTC datagrams) the hit can land BEFORE the
   *  spawn registration. They wait here for the next register() for that
   *  player; expiry or exhaustion is a LOUD reject, never a silent drop.
   *  This is the fix for "half the damage instances don't work": a
   *  reordered shot/aoeShot pair used to bounce as 'no known projectile'. */
  private pendingClaims: PendingClaim[] = [];
  private static CLAIM_DEFER_CAP = 64;

  deferClaim(playerId: string, kind: string, d: ClaimDefer, run: (d: ClaimDefer) => void, targetId?: string, weaponType?: number): void {
    if (d.left <= 0 || wallNow() - d.at > CLAIM_DEFER_MS) {
      this.reject(playerId, kind, 'no known projectile — spawn claim never arrived', targetId, weaponType);
      return;
    }
    if (this.pendingClaims.length >= CombatHandler.CLAIM_DEFER_CAP) {
      this.reject(playerId, kind, 'defer queue full', targetId, weaponType);
      return;
    }
    this.hb('defer');
    this.pendingClaims.push({ playerId, kind, d, run, targetId, weaponType });
  }

  /** Retry this player's deferred claims — call right after a new
   *  projectile registers so out-of-order claim→spawn pairs resolve. */
  flushClaims(playerId: string): void {
    if (!this.pendingClaims.length) return;
    const mine: PendingClaim[] = [];
    this.pendingClaims = this.pendingClaims.filter(p =>
      p.playerId === playerId ? (mine.push(p), false) : true);
    for (const p of mine) p.run({ at: p.d.at, left: p.d.left - 1 });
  }

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
    this.chargeBank = new ChargeBank((ownerId, target, amount) => this.blast.pop(ownerId, target, amount));
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
    logger.warn(`${kind} rejected: ${playerId}${targetId ? ` → ${targetId}` : ''}: ${reason}`);
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
    this.ledger.removePlayer(playerId);
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
    const held = this.pendingClaims.filter(p => p.playerId === playerId).length;
    if (held) {
      this.hb('drop.claim', held);
      logger.warn(`dropped ${held} deferred claim(s) on disconnect: ${playerId}`);
      this.pendingClaims = this.pendingClaims.filter(p => p.playerId !== playerId);
    }
  }

  handleShot(playerId: string, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {
      this.hb('drop.deadShooter');
      if (player) this.notifyDrop(playerId, 'Shot', 'shooter dead', undefined, msg.weaponType, msg.shotId);
      return;
    }
    this.hb('shot');
    // Any new claim activity is also a retry opportunity for deferred
    // ones — and the expiry trigger for claims whose spawn never lands.
    this.flushClaims(playerId);
    // Tier-locked ordnance — the menu filter is client-side convenience;
    // this is the real boundary for doctored clients.
    if (msg.weaponType !== undefined && !classCanFire(player.armorClass, msg.weaponType)) {
      this.reject(playerId, 'Shot', 'class-locked weapon', undefined, msg.weaponType, msg.shotId);
      return;
    }
    player.protectedUntil = 0; // firing breaks your own spawn shield

    if (msg.weaponType !== undefined) weaponStats.recordShot(this.deps.mode ?? '', `w${msg.weaponType}`);
    this.deps.emit?.({ type: 'fire', playerId });
    if (msg.targetId) {
      this.hitClaim(playerId, player, msg, msg.targetId);
    } else {
      this.registerMiss(playerId, player, msg);
    }
  }

  /** A claim naming a target: every legality gate, then damage through
   *  the shared outcome funnel. */
  private hitClaim(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>, targetId: string): void {
    hitClaim(this, playerId, player, msg, targetId);
  }

  /** A claim with no target: a miss. If it carries spawn coordinates it
   *  also registers a tracked projectile observers can render. */
  private registerMiss(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    registerMiss(this, playerId, player, msg);
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
    if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) return;
    this.lastFireNotify.set(playerId, now);
    this.deps.emit?.({ type: 'fire', playerId });
    const at = rewindPos(player, clampPing(player.ping));
    this.broadcast({
      type: 'playerShot', id: playerId, weaponType: msg.weaponType,
      pos: { x: at.x, y: at.y + 1.6, z: at.z }, dir: msg.dir,
    }, playerId);
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    if (this.playerManager.getPlayer(playerId)?.isDead) {
      this.hb('drop.deadShooter');
      this.notifyDrop(playerId, 'AOE', 'shooter dead', undefined, msg.weaponType, msg.shotId);
      return;
    }
    this.flushClaims(playerId);
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
    // Ownership check: any client could otherwise destroy every other
    // player's in-flight projectiles (grief vector — silently suppresses
    // weapons). Unknown IDs now drop entirely: a replica can only exist
    // for a ledger-minted id, so destroying one nobody knows just relayed
    // fake pops — including for server-owned 'sp-' shells, which live
    // outside the ledger by design and must never be client-destroyable.
    let pid: string | undefined = msg.projectileId || undefined;
    if (pid === undefined || this.ledger.ownerOf(pid) === undefined) {
      pid = msg.shotId ? this.ledger.idForClientShot(playerId, msg.shotId) : pid;
    }
    if (pid === undefined || this.ledger.ownerOf(pid) === undefined) {
      this.hb('drop.destroy');
      logger.debug(`projectileDestroy for unknown id`, { playerId, projectileId: msg.projectileId, shotId: msg.shotId });
      return;
    }
    const owner = this.ledger.ownerOf(pid);
    if (owner !== playerId) {
      logger.warn(`projectileDestroy rejected: ${playerId} doesn't own ${pid}`);
      return;
    }
    this.ledger.destroy(pid);

    this.broadcast({
      type: 'projectileDestroyed',
      projectileId: pid,
      shotId: msg.shotId,
    });
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
    target.forceSendUntil = wallNow() + FORCE_SEND_MS;
    this.applyHit(ownerId, targetId, dmg, result, { label, weapon: opts.weapon, shotId: opts.shotId, air: opts.air });
  }

  /** Deliberate respawn (the client's K bind) — routed through the same
   *  self-hit funnel as a self-frag so the kill feed, corpse charge-pop,
   *  respawn timer, and any pending class/perk all behave identically.
   *  Damage is far over the kill line on purpose: shield/regen buffs
   *  shouldn't half-eat a player's own respawn request. */
  respawnRequest(id: string): void {
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
