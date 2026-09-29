import type { ClientMessage, ServerMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { WeaponStats } from '../../shared/weapons.ts';
import { getWeaponStats, WeaponType, directHitAoeBonus } from '../../shared/weapons.ts';
import { perkMods } from '../../shared/perks.ts';
import { aoeDamage, aoeImpulse, KNOCKBACK_SCALE, validateHitClaim, validateAoeClaim, type TrackedProjectile } from '../../shared/combat.ts';
import { POWERUP } from '../../shared/pickups.ts';
import type { PlayerState } from './types.ts';
import { CONFIG } from './config.ts';
import { logger } from './logger.ts';
import { weaponStats } from './weaponStats.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { segSolidHit, blastOccluded } from '../../shared/solidWorld.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 250;
function clampPing(ping: number): number {
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
function rewindPos(target: PlayerState, backMs: number): { x: number; y: number; z: number } {
  const h = target.history;
  if (h.length === 0) return target.position;
  const tAt = Date.now() - backMs;
  if (tAt <= h[0]!.t) return h[0]!;
  const last = h[h.length - 1]!;
  if (tAt >= last.t) return target.position;
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1]!.t <= tAt) {
      const a = h[i - 1]!, b = h[i]!;
      const f = (tAt - a.t) / Math.max(b.t - a.t, 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  return last;
}

// How long a hit/knocked-back player stays on the unsuppressed full-rate
// tick path — covers the shooter's predicted-knockback window (~0.6s)
// plus margin so the real trajectory replaces the prediction.
const FORCE_SEND_MS = 900;

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

/**
 * Everything that can hurt a player: shot hit-claims, AOE blasts,
 * environmental damage, projectile tracking/destroy, and respawn timers.
 * Split from MessageHandler so the dispatch surface (movement, presence,
 * snapshots) stays a thin routing file.
 */
export class CombatHandler {
  private projectileCounter = 0;
  private projectiles: Map<string, TrackedProjectile> = new Map();
  /** Claimed-once projectiles — a detonating shell produces TWO claims
   *  (direct `shot` + blast `aoeShot`) naming the same id; the first claim
   *  used to delete the record so the second bounced with "no known
   *  projectile" and splash damage silently never applied. Spent entries
   *  resolve ONE claim of each kind, then are dead. 5s staleness cap. */
  private spentProjectiles = new Map<string, { proj: TrackedProjectile; shot: boolean; aoe: boolean; at: number }>();
  private respawnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Cosmetic relay gate for shotFired — a hitscan pull has no damage
   *  semantics, so excess ones are silently dropped instead of rejected. */
  private lastFireNotify = new Map<string, number>();
  /** First-hit timestamps per shooter|victim pair — kill-side applies it
   *  as the engagement time (TTK), hit-side only refreshes it. */
  private duelStart = new Map<string, number>();
  /** Map-structure colliders — claim validation rejects flights that
   *  would have to pass through a wall to reach their end point. */
  solids: readonly StructureCollider[] = [];

  constructor(
    private playerManager: PlayerManager,
    private broadcast: BroadcastFn,
    private sendToPlayer: SendToPlayerFn,
    private onKill?: (targetId: string, shooterId: string) => void,
    private onHit?: (targetId: string, shooterId: string) => void,
    // Team-mode rooms block damage between teammates (knockback still
    // applies — boosting off a teammate's splash is intentional).
    private teamMode = false,
    /** Movement shadow sim — gets the same impulse deltas we apply to
     *  target.velocity so a legit blast doesn't read as divergence. */
    private moveImpulse?: (playerId: string, dv: Vec3) => void,
    /** Server-driven respawn is a declared discontinuity — reseat the
     *  shadow at the spawn or the corpse→spawn jump reads as divergence. */
    private moveResync?: (playerId: string, pos: Vec3, yaw: number) => void,
    /** Room mode tag for balance telemetry ('ctf', 'nuggets', ...). */
    private modeTag = '',
    /** Deployable blast sweep — Room.deployables.applyBlast. Absent on
     *  rooms without structures (offline-style lobbies). */
    private deployBlast?: (pos: Vec3, damage: number, radius: number, shooterId: string) => void,
    /** Room heartbeat counters — claims/rejects/applied damage tally here
     *  so the periodic 'Room health' line shows the funnel at a glance. */
    private health?: Map<string, number>,
    /** Nearest-creature distance for env-damage plausibility (melee-from-
     *  afar flagging). Absent = no creature sim to check against. */
    private envRange?: (playerId: string) => number,
  ) {}

  private hb(key: string, n = 1): void {
    if (this.health) this.health.set(key, (this.health.get(key) ?? 0) + n);
  }

  /** Claim refused: server-side warn plus a shotRejected to the shooter so
   *  their client can log WHY predicted damage never happened. */
  private reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number): void {
    this.hb('rej');
    this.hb(`rej.${kind}`);
    logger.warn(`${kind} rejected: ${playerId}${targetId ? ` → ${targetId}` : ''}: ${reason}`);
    // Rejected claims can leave predicted self-damage stuck client-side —
    // ship our health value so the shooter resyncs instead of drifting.
    const health = this.playerManager.getPlayer(playerId)?.health;
    this.sendToPlayer(playerId, { type: 'shotRejected', reason: `${kind}: ${reason}`, targetId, weaponType, health });
  }

  private friendly(shooterId: string, targetId: string): boolean {
    if (!this.teamMode || shooterId === targetId) return false; // self-splash = rocket jumps
    const s = this.playerManager.getPlayer(shooterId);
    const t = this.playerManager.getPlayer(targetId);
    return !!(s?.team && t?.team && s.team === t.team);
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === playerId) this.projectiles.delete(id);
    }
    for (const [id, rec] of this.spentProjectiles) {
      if (rec.proj.ownerId === playerId) this.spentProjectiles.delete(id);
    }
  }

  /** Cancel a pending respawn on disconnect — the player might rejoin during
   *  the grace window, and a stale timer would fire on the new session (or
   *  double-respawn if they died again after reconnecting). */
  onPlayerDisconnected(playerId: string): void {
    const pending = this.respawnTimers.get(playerId);
    if (pending) {
      clearTimeout(pending);
      this.respawnTimers.delete(playerId);
    }
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

    const { targetId } = msg;

    if (targetId) {
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
      const proj = this.resolveClaimedProjectile(playerId, msg.projectileId, msg.weaponType, 'shot');
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

      this.applyHit(playerId, targetId, shotDamage, result, 'Player hit', undefined, proj.weaponType);
    } else {
      logger.debug('Shot fired (miss)', { shooter: playerId });

      if (msg.position && msg.velocity) {
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
        const projectileId = `proj_${++this.projectileCounter}`;
        this.projectiles.set(projectileId, {
          ownerId: playerId,
          weaponType: msg.weaponType ?? 0,
          origin: { ...msg.position },
          velocity: { ...msg.velocity },
          spawnAt: Date.now(),
        });
        if (this.projectiles.size > 512) {
          // Evict oldest — a live game never has >512 in-flight projectiles;
          // the cap bounds memory if clients never send destroys
          const oldest = this.projectiles.keys().next().value;
          if (oldest) this.projectiles.delete(oldest);
        }
        this.broadcast({
          type: 'projectileCreated',
          projectileId,
          ownerId: playerId,
          position: msg.position,
          velocity: msg.velocity,
          weaponType: msg.weaponType,
        });
      }
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
    const now = Date.now();
    if (now - (this.lastFireNotify.get(playerId) ?? 0) < 50) return;
    this.lastFireNotify.set(playerId, now);
    const at = rewindPos(player, clampPing(player.ping));
    this.broadcast({
      type: 'playerShot', id: playerId, weaponType: msg.weaponType,
      pos: { x: at.x, y: at.y + 1.6, z: at.z }, dir: msg.dir,
    }, playerId);
  }

  /**
   * Find the tracked projectile a hit claim refers to. The client echoes the
   * server-assigned id when it has it; when the hit outraced the
   * projectileCreated reply it can't, so we fall back to the shooter's most
   * recently spawned projectile of the claimed weapon type.
   */
  private resolveClaimedProjectile(
    playerId: string,
    projectileId: string | null | undefined,
    weaponType: number | undefined,
    claim: 'shot' | 'aoe',
  ): TrackedProjectile | undefined {
    // A live projectile's first claim moves it to `spent` — the same shell
    // can then satisfy the paired claim (a rocket's direct hit AND its
    // blast name one id). Each spent id fuels one shot claim and one AOE
    // claim, so a cheater can't double-dip either kind.
    const take = (rec: { proj: TrackedProjectile; shot: boolean; aoe: boolean }) => {
      if (claim === 'shot' ? rec.shot : rec.aoe) return undefined;
      if (claim === 'shot') rec.shot = true; else rec.aoe = true;
      return rec.proj;
    };
    if (projectileId) {
      const live = this.projectiles.get(projectileId);
      if (live) {
        if (live.ownerId !== playerId) return undefined;
        this.projectiles.delete(projectileId);
        const rec = { proj: live, shot: false, aoe: false, at: Date.now() };
        this.spentProjectiles.set(projectileId, rec);
        this.sweepSpent();
        return take(rec);
      }
      const spent = this.spentProjectiles.get(projectileId);
      if (spent && spent.proj.ownerId === playerId && Date.now() - spent.at < 5000) {
        return take(spent);
      }
      return undefined;
    }
    // Null-id fallback (claim outraced projectileCreated): latest projectile
    // the shooter owns, of the claimed type — live first, then spent.
    let latest: { proj: TrackedProjectile; shot: boolean; aoe: boolean; at: number } | undefined;
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId !== playerId) continue;
      if (weaponType !== undefined && proj.weaponType !== weaponType) continue;
      this.projectiles.delete(id);
      latest = { proj, shot: false, aoe: false, at: Date.now() };
      this.spentProjectiles.set(id, latest);
    }
    if (latest) return take(latest);
    for (const rec of this.spentProjectiles.values()) {
      if (rec.proj.ownerId !== playerId) continue;
      if (weaponType !== undefined && rec.proj.weaponType !== weaponType) continue;
      if (Date.now() - rec.at >= 5000) continue;
      latest = rec;
    }
    return latest ? take(latest) : undefined;
  }

  /** Bound the spent map — same 512 cap as live projectiles, plus a lazy
   *  age sweep so stale ids can't resolve hours later. */
  private sweepSpent(): void {
    const now = Date.now();
    for (const [id, rec] of this.spentProjectiles) {
      if (now - rec.at > 10000) this.spentProjectiles.delete(id);
    }
    while (this.spentProjectiles.size > 512) {
      this.spentProjectiles.delete(this.spentProjectiles.keys().next().value!);
    }
  }

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.hb('aoe');
    if (msg.weaponType !== undefined && HEAVY_ONLY_WEAPONS.has(msg.weaponType) && player.armorClass !== 'heavy') {
      this.reject(playerId, 'AOE', 'class-locked weapon', undefined, msg.weaponType);
      return;
    }
    player.protectedUntil = 0; // firing breaks your own spawn shield
    const stats = getWeaponStats(msg.weaponType);

    if (msg.weaponType === WeaponType.Melee) {
      // The punch is a skill, not a projectile — same self-positioned
      // contract as Slam, tightened to melee reach. No projectile to
      // resolve, no airtime to check: the swing point just has to sit
      // in front of the swinger.
      const dx = player.position.x - msg.position.x;
      const dy = player.position.y - msg.position.y;
      const dz = player.position.z - msg.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > stats.aoeRadius + 10) {
        this.reject(playerId, 'AOE', `melee ${dist.toFixed(0)}m from player`, undefined, msg.weaponType);
        return;
      }
      this.processAOE(playerId, msg.position, msg.excludeTargetId, stats, msg.weaponType);
      return;
    }

    if (msg.weaponType === WeaponType.Slam) {
      // Slam is a skill, not a projectile — the blast must land where the
      // player is (they slam into the ground under themselves). Power is a
      // client-reported impact-speed scaler; clamped to the same range the
      // client uses so a forged value can't exceed a max-dive blast.
      const dx = player.position.x - msg.position.x;
      const dy = player.position.y - msg.position.y;
      const dz = player.position.z - msg.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > stats.aoeRadius + 20) {
        this.reject(playerId, 'AOE', `slam ${dist.toFixed(0)}m from player`, undefined, msg.weaponType);
        return;
      }
      const power = msg.power !== undefined
        ? Math.min(Math.max(msg.power, 0.2), 1.8)
        : 1;
      this.processAOE(playerId, msg.position, msg.excludeTargetId, {
        ...stats,
        aoeDamage: stats.aoeDamage * power,
        aoeRadius: stats.aoeRadius * power,
        knockbackForce: stats.knockbackForce * power,
      }, msg.weaponType);
      return;
    }

    if (stats.speed <= 0) {
      // Hitscan-class (Lightning beam): the claim names no projectile —
      // same self-positioned contract as Melee/Slam, tightened to the
      // beam's range. The tip also can't sit through a wall: the eye→tip
      // ray must be clear of structures.
      const eye = { x: player.position.x, y: player.position.y + 1.6, z: player.position.z };
      const dx = eye.x - msg.position.x;
      const dy = eye.y - msg.position.y;
      const dz = eye.z - msg.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 70) { // LG_RANGE 55 + lag slack
        this.reject(playerId, 'AOE', `beam tip ${dist.toFixed(0)}m from eye`, undefined, msg.weaponType);
        return;
      }
      if (this.solids.length && segSolidHit(eye, msg.position, this.solids)) {
        this.reject(playerId, 'AOE', 'beam tip behind structure', undefined, msg.weaponType);
        return;
      }
      this.processAOE(playerId, msg.position, msg.excludeTargetId, stats, msg.weaponType);
      return;
    }

    // Projectile AOEs must name the tracked projectile that detonated —
    // same fallback resolution as direct-hit claims (race vs projectileCreated).
    const proj = this.resolveClaimedProjectile(playerId, msg.projectileId, msg.weaponType, 'aoe');
    if (!proj) {
      this.reject(playerId, 'AOE', `blast with no known projectile (id=${msg.projectileId ?? 'null'})`, undefined, msg.weaponType);
      return;
    }
    if (msg.airtime === undefined) {
      this.reject(playerId, 'AOE', 'blast claim missing airtime', undefined, msg.weaponType);
      return;
    }
    const verdict = validateAoeClaim({
      projectile: proj,
      blastPos: msg.position,
      airtime: msg.airtime,
      shooterVel: player.velocity,
      now: Date.now(),
      solids: this.solids,
    });
    if (!verdict.ok) {
      this.reject(playerId, 'AOE', verdict.reason, undefined, msg.weaponType);
      return;
    }
    // (The id stays resolvable in spentProjectiles for the paired claim —
    // deletion happens via projectileDestroy, the 5s staleness cap, or
    // the eviction sweep.)

    // Canonical launchers (Bolt/Disc): a claimed direct hit blooms the
    // blast. Server re-derives the bonus from the shared table — the
    // client can't widen the radius past what the weapon allows.
    const bloom = msg.directHit ? directHitAoeBonus(msg.weaponType ?? -1) : 1;
    this.processAOE(playerId, msg.position, msg.excludeTargetId,
      bloom === 1 ? stats : { ...stats, aoeRadius: stats.aoeRadius * bloom }, msg.weaponType);

    // Cluster carrier: the carrier's blast is only the delivery pop — the
    // real damage is `count` bomblet blasts scattered inside `radius`, each
    // rolled with ClusterBomblet stats. Client bomblets are visual-only.
    if (stats.cluster) {
      const bomblet = getWeaponStats(WeaponType.ClusterBomblet);
      for (let i = 0; i < stats.cluster.count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * stats.cluster.radius;
        this.processAOE(playerId, {
          x: msg.position.x + Math.cos(ang) * r,
          y: msg.position.y, // bomblets scatter on the blast plane
          z: msg.position.z + Math.sin(ang) * r,
        }, msg.excludeTargetId, bomblet, WeaponType.ClusterBomb);
      }
    }
  }

  /** Server-owned blast — the room's projectile/deployable sims decided
   *  where this pops, so the shooter-distance sanity check doesn't apply. */
  serverBlast(ownerId: string, position: Vec3, weaponType: number, excludeTargetId?: string | null): void {
    const stats = getWeaponStats(weaponType);
    if (!stats || stats.aoeRadius <= 0) return;
    this.processAOE(ownerId, position, excludeTargetId, stats, weaponType, true);
  }

  private processAOE(playerId: string, position: Vec3, excludeTargetId: string | null | undefined, stats: WeaponStats, weapon?: number, trusted = false): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;

    // Cheat prevention: AOE position must be within 200m of shooter
    const dx = player.position.x - position.x;
    const dy = player.position.y - position.y;
    const dz = player.position.z - position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (!trusted && distSq > 40000) { // 200m squared
      this.reject(playerId, 'AOE', `blast too far from shooter (${Math.sqrt(distSq).toFixed(0)}m)`, undefined, weapon);
      return;
    }

    const pull = stats.forceMode === 'pull';
    // Perk modifies the blast envelope, not the damage numbers — a
    // Sharpshooter's rocket lands tighter, not weaker.
    const radius = stats.aoeRadius * perkMods(player.perk).aoeRadius;
    const baseDamage = stats.aoeDamage * this.ddMult(player);
    const impulseForce = stats.knockbackForce;
    const logLabel = pull ? 'disc AOE' : 'AOE';

    for (const [targetId, target] of this.playerManager.getAllPlayers()) {
      if (targetId === playerId) continue; // Don't damage self
      if (targetId === excludeTargetId) continue; // Skip direct hit target
      if (target.isDead) continue;

      // Lag-comp the victim position the same as hitscan — a rocket
      // that exploded on the shooter's screen should hit the ghost.
      const tpos = rewindPos(target, clampPing(player.ping));
      const dx = tpos.x - position.x;
      const dy = tpos.y - position.y;
      const dz = tpos.z - position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist <= radius) {
        // Wall occlusion — a blast outside a structure doesn't splash
        // targets inside it (and vice versa). Blasts can legitimately
        // sit INSIDE geometry (shell popped at the face), so a contact
        // at t≈0 is stepped past rather than counted.
        if (this.solids.length && this.blastBlocked(position, tpos)) continue;

        // shared/combat.ts — same formula the client predicts with
        const damage = aoeDamage(baseDamage, dist, radius);
        if (damage <= 0) continue;

        // Apply impulse to target velocity (server-authoritative)
        const impulseMag = aoeImpulse(impulseForce, dist, radius) * KNOCKBACK_SCALE * perkMods(target.perk).knockbackTaken;
        if (dist > 0) {
          const dv: Vec3 = pull
            ? { x: -(dx / dist) * impulseMag, y: 0.3 * impulseMag, z: -(dz / dist) * impulseMag }
            : { x: (dx / dist) * impulseMag, y: 0.5 * impulseMag, z: (dz / dist) * impulseMag };
          target.velocity.x += dv.x;
          target.velocity.y += dv.y;
          target.velocity.z += dv.z;
          this.moveImpulse?.(targetId, dv);
        }

        // Notify the target player to apply impulse to their local player
        target.forceSendUntil = Date.now() + FORCE_SEND_MS;
        this.sendToPlayer(targetId, {
          type: 'knockback',
          targetId,
          position,
          force: impulseMag,
          pull: pull || undefined,
        });

        // Splash still displaces teammates (jump-boost assists); it just
        // never deals damage to them in team rooms.
        if (!this.friendly(playerId, targetId)) {
          const result = this.playerManager.applyDamage(targetId, damage);
          this.applyHit(playerId, targetId, damage, result, `Player ${logLabel} hit`, { dist: +dist.toFixed(2) }, weapon);
        }
      }
    }

    // Deployables in the blast envelope eat the same scaled splash —
    // sentries aren't immortal, you clear a stand with explosives.
    this.deployBlast?.(position, baseDamage, radius, playerId);
  }

  /** True when a wall stands between blast point and target chest.
   *  The blast point itself may sit inside geometry (a shell that just
   *  kissed a face) — step 0.4m past each t=0 contact, up to 3 hops,
   *  before concluding the target is really occluded. */
  private blastBlocked(from: Vec3, toEye: Vec3): boolean {
    return blastOccluded(from, toEye, this.solids);
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
    const range = this.envRange?.(playerId);
    if (range !== undefined && range > 15) {
      this.hb('envdmg.far');
      logger.warn('Environment damage implausible: no creature near', { playerId, dist: Math.round(range) });
    }
    const damage = Math.min(40, Math.max(1, Math.round(msg.amount)));
    const result = this.playerManager.applyDamage(playerId, damage);
    player.forceSendUntil = Date.now() + FORCE_SEND_MS;
    this.applyHit('environment', playerId, damage, result, 'Player hit');
  }

  // Client-claimed heal — self-only. Team-mode rooms require credit the
  // server granted on a gem touch; elsewhere the claim stays free-form
  // (local nuggets in non-team rooms have no server backing). No
  // broadcast: health rides the next tickUpdate; forceSend makes sure
  // it isn't delta-suppressed.
  handleHeal(playerId: string, msg: Extract<ClientMessage, { type: 'heal' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const heal = Math.min(25, Math.max(1, Math.round(msg.amount * perkMods(player.perk).healBoost)));
    if (this.teamMode) {
      if (player.healCredit <= 0) return;
      const applied = Math.min(heal, player.healCredit);
      player.healCredit -= applied;
      player.health = Math.min(player.maxHealth, player.health + applied);
    } else {
      player.health = Math.min(player.maxHealth, player.health + heal);
    }
    player.forceSendUntil = Date.now() + FORCE_SEND_MS;
    logger.info('Player healed', { playerId, heal, health: player.health });
  }

  handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    // Ownership check: any client could otherwise destroy every other
    // player's in-flight projectiles (grief vector — silently suppresses
    // weapons). Unknown IDs are allowed through so client-side-only IDs
    // still work.
    const proj = this.projectiles.get(msg.projectileId);
    const spent = this.spentProjectiles.get(msg.projectileId);
    const owner = proj?.ownerId ?? spent?.proj.ownerId;
    if (owner !== undefined && owner !== playerId) {
      logger.warn(`projectileDestroy rejected: ${playerId} doesn't own ${msg.projectileId}`);
      return;
    }
    this.projectiles.delete(msg.projectileId);
    // The spent tombstone survives — and a still-live projectile gets one
    // now too: on unordered transports (WT/RTC datagram lanes) this
    // destroy can land BEFORE the shot/aoeShot it pairs with, and the
    // tombstone is the only thing resolving those reordered claims.
    // Deleting outright here was the "blast with no known projectile"
    // storm. sweepSpent's age/size caps bound it instead.
    if (proj) {
      this.spentProjectiles.set(msg.projectileId, { proj, shot: false, aoe: false, at: Date.now() });
      this.sweepSpent();
    }

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
    const owner = this.playerManager.getPlayer(ownerId);
    const baseDamage = maxDamage * (owner ? this.ddMult(owner) : 1);
    for (const [targetId, target] of this.playerManager.getAllPlayers()) {
      if (target.isDead) continue;
      const dx = target.position.x - pos.x;
      const dy = target.position.y - pos.y;
      const dz = target.position.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      // Falloff + shove from shared formulas — client predicts the same hit.
      const damage = targetId === ownerId ? 0 : aoeDamage(baseDamage, dist, radius);
      const impulseMag = aoeImpulse(knockback, dist, radius) * KNOCKBACK_SCALE * perkMods(target.perk).knockbackTaken;
      if (dist > 0) {
        const dv: Vec3 = { x: (dx / dist) * impulseMag, y: 0.5 * impulseMag, z: (dz / dist) * impulseMag };
        target.velocity.x += dv.x;
        target.velocity.y += dv.y;
        target.velocity.z += dv.z;
        this.moveImpulse?.(targetId, dv);
        target.forceSendUntil = Date.now() + FORCE_SEND_MS;
        this.sendToPlayer(targetId, { type: 'knockback', targetId, position: pos, force: impulseMag });
      }
      // Owner eats the blast too — mines don't pick friends.
      if (!this.friendly(ownerId, targetId) && damage > 0) {
        const result = this.playerManager.applyDamage(targetId, damage);
        target.forceSendUntil = Date.now() + FORCE_SEND_MS;
        this.applyHit(ownerId, targetId, damage, result, 'Mine hit', { dist: +dist.toFixed(2) });
      }
    }
  }

  turretAttack(ownerId: string, targetId: string, damage: number): void {
    const owner = this.playerManager.getPlayer(ownerId);
    const target = this.playerManager.getPlayer(targetId);
    if (!target || target.isDead) return;
    if (this.friendly(ownerId, targetId)) return;
    const dmg = damage * (owner ? this.ddMult(owner) : 1);
    const result = this.playerManager.applyDamage(targetId, dmg);
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;
    this.applyHit(ownerId, targetId, dmg, result, 'Turret hit');
  }

  botAttack(shooterId: string, targetId: string, weaponType: number): void {
    const shooter = this.playerManager.getPlayer(shooterId);
    const target = this.playerManager.getPlayer(targetId);
    if (!shooter || shooter.isDead || !target || target.isDead) return;
    if (this.friendly(shooterId, targetId)) return;
    const damage = getWeaponStats(weaponType).directDamage * perkMods(shooter.perk).directDamage * this.ddMult(shooter);
    const result = this.playerManager.applyDamage(targetId, damage);
    target.forceSendUntil = Date.now() + FORCE_SEND_MS;
    this.applyHit(shooterId, targetId, damage, result, 'Bot hit', undefined, weaponType);
  }

  // Double-damage pickup: multiplies OUTGOING damage while the buff lasts.
  // Applies to every path that already routes through applyHit.
  private ddMult(shooter: PlayerState): number {
    return shooter.ddUntil > Date.now() ? POWERUP.ddMult : 1;
  }

  private applyHit(shooterId: string, targetId: string, damage: number, result: { killed: boolean; newHealth: number; newArmor: number }, hitLabel: string, extra?: Record<string, unknown>, weapon?: number): void {
    this.hb('hit');
    this.hb('dmg', Math.round(damage));
    if (result.killed) this.hb('kill');
    this.onHit?.(targetId, shooterId);
    const src = weapon !== undefined ? `w${weapon}` : hitLabel;
    weaponStats.record(this.modeTag, src, damage, result.killed, shooterId.startsWith('BOT-'));
    if (result.killed) {
      const victim = this.playerManager.getPlayer(targetId);
      if (victim) weaponStats.recordDeath(this.modeTag, victim.position);
      weaponStats.recordKillSpeed(this.modeTag,
        this.playerManager.getPlayer(shooterId)?.velocity ?? null,
        victim?.velocity ?? null);
      // Duel engagement: first-hit→kill time per shooter+victim pair.
      const duelKey = `${shooterId}|${targetId}`;
      const started = this.duelStart.get(duelKey);
      if (started !== undefined) weaponStats.recordTtk(this.modeTag, src, Date.now() - started);
      this.duelStart.delete(duelKey);
    } else {
      this.duelStart.set(`${shooterId}|${targetId}`, this.duelStart.get(`${shooterId}|${targetId}`) ?? Date.now());
      if (this.duelStart.size > 512) this.duelStart.clear(); // leak cap — entries die with their duels anyway
    }
    if (!result.killed) {
      logger.info(hitLabel, { shooter: shooterId, target: targetId, damage, targetHealth: result.newHealth, ...extra });
      this.broadcast({ type: 'playerHit', shooterId, targetId, damage, health: result.newHealth, armor: result.newArmor });
      return;
    }
    if (shooterId !== 'environment') this.playerManager.addKill(shooterId);
    logger.info(`${hitLabel} → kill`, { shooter: shooterId, target: targetId, damage, ...extra });
    const shooterStreak = shooterId === 'environment' ? undefined
      : (this.playerManager.getPlayer(shooterId)?.streak ?? 0) + 1;
    this.broadcast({ type: 'playerKill', shooterId, targetId, weapon, streak: shooterStreak });
    this.announceKill(shooterId, targetId);
    this.onKill?.(targetId, shooterId);
    this.scheduleRespawn(targetId);
  }

  // Spree callouts ride matchNotice (system chat line). killTotal()===1 pins
  // first blood exactly — stats are wiped at match boundaries, so a 1 can
  // only mean the opening frag.
  private static readonly SPREE_TIERS: [number, string][] = [
    [3, 'killing spree'], [5, 'rampage'], [8, 'dominating'], [12, 'unstoppable'],
  ];

  private announceKill(shooterId: string, targetId: string): void {
    const victim = this.playerManager.getPlayer(targetId);
    const ended = victim?.streak ?? 0;
    if (victim) victim.streak = 0;
    if (shooterId === 'environment') return;

    const shooter = this.playerManager.getPlayer(shooterId);
    if (!shooter) return;
    shooter.streak++;

    if (this.playerManager.killTotal() === 1) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} draws first blood` });
    }
    const tier = CombatHandler.SPREE_TIERS.find(([n]) => n === shooter.streak);
    if (tier) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is on a ${tier[1]} (${tier[0]})` });
    } else if (shooter.streak > 12 && shooter.streak % 4 === 0) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} is godlike (${shooter.streak})` });
    }
    if (ended >= 3) {
      this.broadcast({ type: 'matchNotice', text: `${shooterId} ended ${targetId}'s ${ended}-kill streak` });
    }
  }

  /** Reconnect restores state verbatim — including isDead. If the disconnect
   *  cancelled a pending respawn (it did), a restored-dead player would stay
   *  dead forever without this re-arm. */
  ensureRespawn(playerId: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (player?.isDead && !this.respawnTimers.has(playerId)) {
      this.scheduleRespawn(playerId);
    }
  }

  /** Re-arm respawn for a rejoining dead player — disconnect cancels the
   *  timer, so without this a socket flap mid-death strands them dead. */
  ensureRespawnScheduled(playerId: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (player?.isDead) this.scheduleRespawn(playerId);
  }

  private scheduleRespawn(playerId: string): void {
    // One respawn timer per player — a second kill while dead replaces it
    // instead of stacking.
    const existing = this.respawnTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.respawnTimers.delete(playerId);
      const result = this.playerManager.respawnPlayer(playerId);
      if (!result) return;

      const player = this.playerManager.getPlayer(playerId);
      if (!player) return;

      logger.info('Player respawned', { playerId, position: result.position });
      this.moveResync?.(playerId, result.position, result.rotation.yaw);
      // The respawn broadcast and the honest post-snap report are both in
      // flight — the client's snap to spawn (and any straggler reports
      // from the corpse spot) read as impossible speed/divergence against
      // the reseated anchors. Same drain window a correction gets.
      player.correctionGraceUntil = Date.now() + 500;

      this.broadcast({
        type: 'playerRespawn',
        playerId,
        internalId: player.internalId,
        position: result.position,
        rotation: result.rotation,
        // A banked classUpdate may have just applied — remotes rebuild the
        // silhouette off this rather than learning it on the next join.
        armorClass: result.armorClass,
      });
    }, CONFIG.respawnDelayMs);
    this.respawnTimers.set(playerId, timer);
  }
}
