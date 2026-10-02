import type { ClientMessage, ServerMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';
import { logger } from './logger.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { ColliderIndex } from '../../shared/solidWorld.ts';
import { ClaimLedger, clampPing, rewindPos, CLAIM_DEFER_MS, type ClaimDefer } from './claimLedger.ts';
export type { ClaimDefer };
import { KillFeed } from './killFeed.ts';
import { RespawnManager } from './respawn.ts';
import { ChargeBank } from './combatCharge.ts';
import { BlastRunner, FORCE_SEND_MS } from './combatBlast.ts';
import { AoeClaims } from './combatAoe.ts';
import { HitLedger } from './hitLedger.ts';
import { handleEnvironmentDamage, handleHeal } from './envClaims.ts';
import { crawlerAttack, botAttack } from './serverAttacks.ts';
import { hitClaim, registerMiss } from './shotClaims.ts';

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
  onKill?: (targetId: string, shooterId: string) => void;
  onHit?: (targetId: string, shooterId: string) => void;
  /** Team-mode rooms block damage between teammates (knockback still
   *  applies — boosting off a teammate's splash is intentional). */
  teams?: boolean;
  /** Server option: set = teammates CAN damage each other — friendly()
   *  returns false even in team rooms. Splash knockback is unaffected. */
  friendlyFire?: boolean;
  /** Movement shadow sim — gets the same impulse deltas we apply to
   *  target.velocity so a legit blast doesn't read as divergence. */
  moveImpulse?: (playerId: string, dv: Vec3) => void;
  /** Server-driven respawn is a declared discontinuity — reseat the
   *  shadow at the spawn or the corpse→spawn jump reads as divergence. */
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
  /** Room mode tag for balance telemetry ('ctf', 'nuggets', ...). */
  mode?: string;
  /** Deployable blast sweep — Room.deployables.applyBlast. Absent on
   *  rooms without structures (offline-style lobbies). */
  deployBlast?: (pos: Vec3, damage: number, radius: number, shooterId: string) => void;
  /** A bot chat line hit the wire — Room relays it as a 'reply' notice
   *  so squadmates can answer back. */
  onBotSpoke?: (id: string) => void;
  /** Room heartbeat counters — claims/rejects/applied damage tally here
   *  so the periodic 'Room health' line shows the funnel at a glance. */
  health?: Map<string, number>;
  /** A real fire claim passed the gates — the sheep meter's ignore
   *  debit needs fire recency for humans (bots report their own). */
  onFire?: (playerId: string) => void;
  /** Nearest-creature distance for env-damage plausibility (melee-from-
   *  afar flagging). Absent = no creature sim to check against. */
  envRange?: (playerId: string) => number;
  /** Armor-grenade plating sweep — grants `amount` armor to every sim
   *  creature inside `radius` of the blast point (overcap health). */
  creatureArmor?: (pos: Vec3, amount: number, radius: number) => void;
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
  fireWindows = new Map<string, { start: number; count: number }>();
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
    if (d.left <= 0 || Date.now() - d.at > CLAIM_DEFER_MS) {
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
      (id) => this.deps.onBotSpoke?.(id), sendToPlayer);
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
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number): void {
    this.hb('rej');
    this.hb(`rej.${kind}`);
    logger.warn(`${kind} rejected: ${playerId}${targetId ? ` → ${targetId}` : ''}: ${reason}`);
    // Rejected claims can leave predicted self-damage stuck client-side —
    // ship our health value so the shooter resyncs instead of drifting.
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'shotRejected', reason: `${kind}: ${reason}`, targetId, weaponType, health });
  }

  friendly(shooterId: string, targetId: string): boolean {
    // friendlyFire server option opens the gate entirely; self-splash
    // stays allowed regardless (rocket jumps).
    if (!this.deps.teams || shooterId === targetId || this.deps.friendlyFire) return false;
    const s = this.playerManager.getPlayer(shooterId);
    const t = this.playerManager.getPlayer(targetId);
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
    // Per-player fire-throttle state is per-connection like the room's
    // warn keys — a leaver's entry otherwise sits in the map for the
    // room's life.
    this.lastFireNotify.delete(playerId);
    for (const key of this.fireWindows.keys()) {
      if (key.startsWith(`${playerId}:`)) this.fireWindows.delete(key);
    }
    this.lastHeal.delete(playerId);
    this.chargeBank.delete(playerId);
    const held = this.pendingClaims.filter(p => p.playerId === playerId).length;
    if (held) {
      this.hb('drop.claim', held);
      logger.warn(`dropped ${held} deferred claim(s) on disconnect: ${playerId}`);
      this.pendingClaims = this.pendingClaims.filter(p => p.playerId !== playerId);
    }
  }

  handleShot(playerId: string, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) { this.hb('drop.deadShooter'); return; }
    this.hb('shot');
    // Any new claim activity is also a retry opportunity for deferred
    // ones — and the expiry trigger for claims whose spawn never lands.
    this.flushClaims(playerId);
    // Tier-locked ordnance — the menu filter is client-side convenience;
    // this is the real boundary for doctored clients.
    if (msg.weaponType !== undefined && HEAVY_ONLY_WEAPONS.has(msg.weaponType) && player.armorClass !== 'heavy') {
      this.reject(playerId, 'Shot', 'class-locked weapon', undefined, msg.weaponType);
      return;
    }
    player.protectedUntil = 0; // firing breaks your own spawn shield

    this.deps.onFire?.(playerId);
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
    const now = Date.now();
    if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) return;
    this.lastFireNotify.set(playerId, now);
    this.deps.onFire?.(playerId);
    const at = rewindPos(player, clampPing(player.ping));
    this.broadcast({
      type: 'playerShot', id: playerId, weaponType: msg.weaponType,
      pos: { x: at.x, y: at.y + 1.6, z: at.z }, dir: msg.dir,
    }, playerId);
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    this.flushClaims(playerId);
    this.deps.onFire?.(playerId);
    this.aoe.handleAOEShot(playerId, msg);
  }

  /** Server-owned blast — the room's projectile/deployable sims decided
   *  where this pops, so the shooter-distance sanity check doesn't apply. */
  serverBlast(ownerId: string, position: Vec3, weaponType: number, excludeTargetId?: string | null): void {
    this.blast.serverBlast(ownerId, position, weaponType, excludeTargetId);
  }

  // Client-reported environmental damage (crawler pounces, etc.) — self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
  handleEnvironmentDamage(playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): void {
    handleEnvironmentDamage(this, playerId, msg);
  }

  /** Heal claim cadence gate — see envClaims.handleHeal. */
  lastHeal = new Map<string, number>();

  // Client-claimed heal — self-only; team-mode needs a server-granted
  // credit, elsewhere the claim stays free-form.
  handleHeal(playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): void {
    handleHeal(this, playerId, msg);
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
    opts: { hb?: string; weapon?: number } = {},
  ): void {
    const target = this.playerManager.getPlayer(targetId);
    if (!target || target.isDead) { this.hb('drop.deadTarget'); return; }
    if (ownerId !== 'environment' && this.friendly(ownerId, targetId)) { this.hb('drop.friendly'); return; }
    if (opts.hb) this.hb(opts.hb);
    const owner = ownerId === 'environment' ? null : this.playerManager.getPlayer(ownerId);
    const dmg = damage * (owner ? this.ddMult(owner) : 1);
    const result = this.playerManager.applyDamage(targetId, dmg);
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;
    this.applyHit(ownerId, targetId, dmg, result, { label, weapon: opts.weapon });
    // Same charge rule as client claims: a non-beam direct hit detonates
    // min(banked, damage). 'environment' can't own a blast — skip it.
    if (!result.killed && opts.weapon !== WeaponType.Lightning && ownerId !== 'environment') {
      const acc = this.chargeBank.of(target);
      if (acc > 0) this.chargeBank.discharge(ownerId, target, Math.min(acc, dmg));
    }
  }

  /** Server-authored creature bite (CreatureSim). */
  crawlerAttack(targetId: string, damage: number, species = 'crawler', from?: { x: number; y: number; z: number }): void {
    crawlerAttack(this, targetId, damage, species, from);
  }

  turretAttack(ownerId: string, targetId: string, damage: number): void {
    this.serverHit(ownerId, targetId, damage, 'Turret hit');
  }

  botAttack(shooterId: string, targetId: string, weaponType: number, airtime?: number): void {
    botAttack(this, shooterId, targetId, weaponType, airtime);
  }

  // Double-damage pickup: multiplies OUTGOING damage while the buff lasts.
  // Applies to every path that already routes through applyHit.
  ddMult(shooter: PlayerState): number {
    return shooter.ddUntil > Date.now() ? POWERUP.ddMult : 1;
  }

  applyHit(shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, opts: { label: string; extra?: Record<string, unknown>; weapon?: number }): void {
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
  static tauntDelayMs: () => number = () => 1200 + Math.random() * 1800;

  ensureRespawn(playerId: string): void {
    this.respawner.ensure(playerId);
  }

  ensureRespawnScheduled(playerId: string): void {
    this.respawner.ensureScheduled(playerId);
  }
}
