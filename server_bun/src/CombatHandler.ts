import type { ClientMessage, ServerMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { getWeaponStats, WeaponType } from '../../shared/weapons.ts';
import { perkMods } from '../../shared/perks.ts';
import { validateHitClaim, lgTickDamage } from '../../shared/combat.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';
import { logger } from './logger.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { segSolidHit, ColliderIndex } from '../../shared/solidWorld.ts';
import { ClaimLedger, clampPing, rewindPos } from './claimLedger.ts';
import { KillFeed } from './killFeed.ts';
import { RespawnManager } from './respawn.ts';
import { ChargeBank } from './combatCharge.ts';
import { BlastRunner, FORCE_SEND_MS } from './combatBlast.ts';
import { AoeClaims } from './combatAoe.ts';
import { HitLedger } from './hitLedger.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

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
  /** Room heartbeat counters — claims/rejects/applied damage tally here
   *  so the periodic 'Room health' line shows the funnel at a glance. */
  health?: Map<string, number>;
  /** Nearest-creature distance for env-damage plausibility (melee-from-
   *  afar flagging). Absent = no creature sim to check against. */
  envRange?: (playerId: string) => number;
  /** Armor-grenade plating sweep — grants `amount` armor to every sim
   *  creature inside `radius` of the blast point (overcap health). */
  creatureArmor?: (pos: Vec3, amount: number, radius: number) => void;
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
  /** The LG bank/ramp economy — own file (combatCharge.ts); this handler
   *  only supplies the detonation (a real processAOE blast). */
  chargeBank: ChargeBank; // public — aoeClaims banks LG ticks through it
  private aoe: AoeClaims;
  /** First-hit timestamps per shooter|victim pair — kill-side applies it
   *  as the engagement time (TTK), hit-side only refreshes it. */
  /** Map-structure colliders — claim validation rejects flights that
   *  would have to pass through a wall to reach their end point.
   *  solidIndex is public — BlastRunner marches through it too. */
  private _solids: readonly StructureCollider[] = [];
  solidIndex: ColliderIndex | null = null;
  get solids(): readonly StructureCollider[] { return this._solids; }
  set solids(list: readonly StructureCollider[]) {
    this._solids = list;
    this.solidIndex = list.length ? new ColliderIndex(list) : null;
  }

  killFeed: KillFeed;
  private hitLedger = new HitLedger();
  respawner: RespawnManager;

  constructor(
    public playerManager: PlayerManager,
    public broadcast: BroadcastFn,
    public sendToPlayer: SendToPlayerFn,
    public deps: CombatDeps = {},
  ) {
    // Late binding on the static — tests reassign tauntDelayMs after
    // construction and must still steer the delay.
    this.killFeed = new KillFeed(playerManager, broadcast, () => CombatHandler.tauntDelayMs());
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
    this.lastHeal.delete(playerId);
    this.chargeBank.delete(playerId);
  }

  handleShot(playerId: string, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.hb('shot');
    // Tier-locked ordnance — the menu filter is client-side convenience;
    // this is the real boundary for doctored clients.
    if (msg.weaponType !== undefined && HEAVY_ONLY_WEAPONS.has(msg.weaponType) && player.armorClass !== 'heavy') {
      this.reject(playerId, 'Shot', 'class-locked weapon', undefined, msg.weaponType);
      return;
    }
    player.protectedUntil = 0; // firing breaks your own spawn shield

    if (msg.targetId) {
      this.hitClaim(playerId, player, msg, msg.targetId);
    } else {
      this.registerMiss(playerId, player, msg);
    }
  }

  /** A claim naming a target: every legality gate, then damage through
   *  the shared outcome funnel. */
  private hitClaim(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>, targetId: string): void {
    // Reject self-damage — client should never send its own ID as targetId
    if (targetId === playerId) {
      this.reject(playerId, 'Shot', 'self-target');
      return;
    }

    const target = this.playerManager.getPlayer(targetId);
    if (!target) {
      this.reject(playerId, 'Shot', 'unknown target', targetId, msg.weaponType);
      return;
    }
    // Dead targets are untouchable — without this, corpse hits still
    // broadcast playerHit and can stack phantom damage past respawn.
    if (target.isDead) {
      this.reject(playerId, 'Shot', 'target already dead', targetId, msg.weaponType);
      return;
    }
    // Friendly fire: no damage (and no playerHit) between teammates.
    if (this.friendly(playerId, targetId)) {
      this.reject(playerId, 'Shot', 'friendly fire', targetId, msg.weaponType);
      return;
    }

    // Hit claims must name the projectile that landed them. The claimed
    // id may be null if the hit raced the server's projectileCreated —
    // fall back to the shooter's most recent spawn of that weapon type.
    const proj = this.ledger.resolve(playerId, msg.projectileId, msg.weaponType, 'shot');
    if (!proj) {
      this.reject(playerId, 'Shot', `no known projectile (id=${msg.projectileId ?? 'null'})`, targetId, msg.weaponType);
      return;
    }
    if (msg.position === undefined || msg.airtime === undefined) {
      this.reject(playerId, 'Shot', 'missing position/airtime', targetId, msg.weaponType);
      return;
    }
    // Lag compensation: validate against where the target was when the
    // shooter saw it (now - ping), not where it is now — otherwise a
    // 100ms client aims at ghosts by design.
    const verdict = validateHitClaim({
      projectile: proj,
      hitPos: msg.position,
      targetPos: rewindPos(target, clampPing(player.ping)),
      airtime: msg.airtime,
      shooterVel: player.velocity,
      now: Date.now(),
      solids: this.solids,
    });
    if (!verdict.ok) {
      this.reject(playerId, 'Shot', verdict.reason, targetId, msg.weaponType);
      return;
    }
    const shotDamage = getWeaponStats(proj.weaponType).directDamage * perkMods(player.perk).directDamage * this.ddMult(player);
    const result = this.playerManager.applyDamage(targetId, shotDamage);
    // Full-rate tick updates for the hit window — the shooter's client is
    // extrapolating this target's knockback and needs real positions to
    // converge on (suppression would leave it predicting blind).
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;

    this.applyHit(playerId, targetId, shotDamage, result, { label: 'Player hit', weapon: proj.weaponType });
    // LG charge detonation: a non-beam hit sparks min(banked, damage)
    // off the victim's bank — the rest keeps smoldering.
    if (!result.killed && proj.weaponType !== WeaponType.Lightning) {
      const acc = this.chargeBank.of(target);
      if (acc > 0) this.chargeBank.discharge(playerId, target, Math.min(acc, shotDamage));
    }
  }

  /** A claim with no target: a miss. If it carries spawn coordinates it
   *  also registers a tracked projectile observers can render. */
  private registerMiss(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    logger.debug('Shot fired (miss)', { shooter: playerId });
    if (!msg.position || !msg.velocity) return;

    // Spawn sanity: the claimed muzzle position must be near where the
    // shooter was WHEN THEY FIRED — rewind by their ping (respawn,
    // knockback and teleports all legitimately move the server-side
    // position between "fire" and "claim arrives"), and the claimed
    // velocity near a real launch speed — weapon cap 250 m/s plus
    // inherited player velocity (≤300) plus slack. An uncapped claim
    // would make the reach check in validateHitClaim tautological.
    const shooterAt = rewindPos(player, clampPing(player.ping));
    const odx = msg.position.x - shooterAt.x;
    const ody = msg.position.y - shooterAt.y;
    const odz = msg.position.z - shooterAt.z;
    const vmag = Math.sqrt(
      msg.velocity.x * msg.velocity.x + msg.velocity.y * msg.velocity.y + msg.velocity.z * msg.velocity.z,
    );
    if (odx * odx + ody * ody + odz * odz > 1600 || vmag > 600) {
      this.reject(playerId, 'Shot', `implausible spawn (origin ${Math.sqrt(odx * odx + ody * ody + odz * odz).toFixed(0)}m off, v=${vmag.toFixed(0)})`, undefined, msg.weaponType);
      return;
    }
    const projectileId = this.ledger.register(playerId, msg.weaponType ?? 0, msg.position, msg.velocity);
    this.broadcast({
      type: 'projectileCreated',
      projectileId,
      ownerId: playerId,
      position: msg.position,
      velocity: msg.velocity,
      weaponType: msg.weaponType,
    });
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
    const at = rewindPos(player, clampPing(player.ping));
    this.broadcast({
      type: 'playerShot', id: playerId, weaponType: msg.weaponType,
      pos: { x: at.x, y: at.y + 1.6, z: at.z }, dir: msg.dir,
    }, playerId);
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
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
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.hb('envdmg');
    // Melee-from-afar check: creature contact damage needs a creature
    // nearby. Past ~15m there's no legal pounce — flag it in the
    // heartbeat + warn (damage still applies: this is a self-report, and
    // a bugged client shouldn't be silently maimed).
    // Attacker-tagged claims come from host-simmed sources the server has
    // no creature-range check for (team bots, deployables) — skip the
    // melee-from-afar warn and let a heavier cap cover bot melee (60).
    const attacker = typeof msg.attacker === 'string' && /^[\w: .-]{1,32}$/.test(msg.attacker)
      ? msg.attacker : undefined;
    if (!attacker) {
      const range = this.deps.envRange?.(playerId);
      if (range !== undefined && range > 15) {
        this.hb('envdmg.far');
        logger.warn('Environment damage implausible: no creature near', { playerId, dist: Math.round(range) });
      }
    }
    const damage = Math.min(attacker ? 80 : 40, Math.max(1, Math.round(msg.amount)));
    const result = this.playerManager.applyDamage(playerId, damage);
    player.forceSendUntil = Date.now() + FORCE_SEND_MS;
    this.applyHit(attacker ?? 'environment', playerId, damage, result, { label: 'Player hit' });
  }

  /** Free-form heal claims still need a cadence — without a credit gate
   *  (non-team rooms) a spammed claim is infinite regen. 1.5s matches the
   *  fastest honest gem-touch rhythm. */
  private lastHeal = new Map<string, number>();

  // Client-claimed heal — self-only. Team-mode rooms require credit the
  // server granted on a gem touch; elsewhere the claim stays free-form
  // (local nuggets in non-team rooms have no server backing). No
  // broadcast: health rides the next tickUpdate; forceSend makes sure
  // it isn't delta-suppressed.
  handleHeal(playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const now = Date.now();
    if ((this.lastHeal.get(playerId) ?? 0) > now) return;
    const heal = Math.min(25, Math.max(1, Math.round(msg.amount * perkMods(player.perk).healBoost)));
    if (this.deps.teams) {
      if (player.healCredit <= 0) return;
      const applied = Math.min(heal, player.healCredit);
      player.healCredit -= applied;
      player.health = Math.min(player.maxHealth, player.health + applied);
    } else {
      player.health = Math.min(player.maxHealth, player.health + heal);
    }
    this.lastHeal.set(playerId, now + 1500); // a heal that landed sets the cadence; a refused one doesn't
    player.forceSendUntil = Date.now() + FORCE_SEND_MS;
    logger.info('Player healed', { playerId, heal, health: player.health });
  }

  handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    // Ownership check: any client could otherwise destroy every other
    // player's in-flight projectiles (grief vector — silently suppresses
    // weapons). Unknown IDs are allowed through so client-side-only IDs
    // still work.
    const owner = this.ledger.ownerOf(msg.projectileId);
    if (owner !== undefined && owner !== playerId) {
      logger.warn(`projectileDestroy rejected: ${playerId} doesn't own ${msg.projectileId}`);
      return;
    }
    this.ledger.destroy(msg.projectileId);

    this.broadcast({
      type: 'projectileDestroyed',
      projectileId: msg.projectileId,
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
  private serverHit(
    ownerId: string, targetId: string, damage: number, label: string,
    opts: { hb?: string; weapon?: number } = {},
  ): void {
    const target = this.playerManager.getPlayer(targetId);
    if (!target || target.isDead) return;
    if (ownerId !== 'environment' && this.friendly(ownerId, targetId)) return;
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
    // A creature wedged inside/behind geometry can't bite through it —
    // contact range is the sim's gate; the wall is ours.
    if (from && this._solids.length) {
      const target = this.playerManager.getPlayer(targetId);
      if (target) {
        const eye = { x: target.position.x, y: target.position.y + 1.0, z: target.position.z };
        if (segSolidHit(from, eye, this._solids, this.solidIndex ?? undefined)) return;
      }
    }
    const label = `${species[0]!.toUpperCase()}${species.slice(1)} bite`;
    this.serverHit('environment', targetId, damage, label, { hb: 'crawlbite' });
  }

  turretAttack(ownerId: string, targetId: string, damage: number): void {
    this.serverHit(ownerId, targetId, damage, 'Turret hit');
  }

  botAttack(shooterId: string, targetId: string, weaponType: number): void {
    const shooter = this.playerManager.getPlayer(shooterId);
    if (!shooter || shooter.isDead) return;
    shooter.protectedUntil = 0; // firing breaks your own spawn shield
    // Melee carries its damage on the aoe line (instant cone, directDamage 0)
    // — falling back to it keeps bot punches non-zero.
    const stats = getWeaponStats(weaponType);
    let damage = (stats.directDamage || stats.aoeDamage) * perkMods(shooter.perk).directDamage;
    // Bot beams ramp down like human ones — the beam-rider loadout pays
    // the same hold-decay a client's beam does.
    if (weaponType === WeaponType.Lightning) {
      const n = this.chargeBank.step(shooterId, targetId);
      damage = lgTickDamage(n) * perkMods(shooter.perk).directDamage;
      const victim = this.playerManager.getPlayer(targetId);
      if (victim && !victim.isDead && !this.friendly(shooterId, targetId)) this.chargeBank.bank(victim, this.chargeBank.withheldFor(n));
    }
    this.serverHit(shooterId, targetId, damage, 'Bot hit', { weapon: weaponType });
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
