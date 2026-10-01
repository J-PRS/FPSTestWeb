import type { ClientMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { PlayerState } from './types.ts';
import type { WeaponStats } from '../../shared/weapons.ts';
import { getWeaponStats, WeaponType, directHitAoeBonus } from '../../shared/weapons.ts';
import { validateAoeClaim, lgTickDamage, LG_TICK_BASE } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { segSolidHit, type ColliderIndex } from '../../shared/solidWorld.ts';
import type { ClaimLedger } from './claimLedger.ts';
import type { ChargeBank } from './combatCharge.ts';
import type { BlastRunner } from './combatBlast.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';

// AOE claim adjudication — the blast detonation a client claims: pop the
// named shell, sanity-check the blast point per weapon contract (named
// projectile, self-positioned swing, or clear-of-structures beam), then
// hand the resolved stats to the blast funnel. Split out of
// CombatHandler so the claim-ledger surface stays the only join.

export interface AoeHost {
  playerManager: PlayerManager;
  blast: BlastRunner;
  ledger: ClaimLedger;
  chargeBank: ChargeBank;
  readonly solids: readonly StructureCollider[];
  solidIndex: ColliderIndex | null;
  hb(key: string, n?: number): void;
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number): void;
  friendly(shooterId: string, targetId: string): boolean;
  ddMult(shooter: PlayerState): number;
  /** Seeded room rng — bomblet scatter must replay under scenario seeds. */
  rng(): number;
}

export class AoeClaims {
  constructor(private h: AoeHost) {}

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    const player = this.h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.h.hb('aoe');
    if (msg.weaponType !== undefined && HEAVY_ONLY_WEAPONS.has(msg.weaponType) && player.armorClass !== 'heavy') {
      this.h.reject(playerId, 'AOE', 'class-locked weapon', undefined, msg.weaponType);
      return;
    }
    player.protectedUntil = 0; // firing breaks your own spawn shield
    const stats = getWeaponStats(msg.weaponType);

    if (msg.weaponType === WeaponType.Melee) {
      this.aoeMelee(playerId, player, msg, stats);
      return;
    }

    if (msg.weaponType === WeaponType.Slam) {
      this.aoeSlam(playerId, player, msg, stats);
      return;
    }

    if (stats.speed <= 0) {
      this.aoeBeam(playerId, player, msg, stats);
      return;
    }

    this.aoeProjectile(playerId, player, msg, stats);
  }

  /** Projectile detonation claim: the blast must name the tracked shell
   *  that popped (same fallback resolution as direct-hit claims — the
   *  hit can race the server's projectileCreated). */
  private aoeProjectile(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats): void {
    const proj = this.h.ledger.resolve(playerId, msg.projectileId, msg.weaponType, 'aoe');
    if (!proj) {
      this.h.reject(playerId, 'AOE', `blast with no known projectile (id=${msg.projectileId ?? 'null'})`, undefined, msg.weaponType);
      return;
    }
    if (msg.airtime === undefined) {
      this.h.reject(playerId, 'AOE', 'blast claim missing airtime', undefined, msg.weaponType);
      return;
    }
    const verdict = validateAoeClaim({
      projectile: proj,
      blastPos: msg.position,
      airtime: msg.airtime,
      shooterVel: player.velocity,
      now: Date.now(),
      solids: this.h.solids,
    });
    if (!verdict.ok) {
      this.h.reject(playerId, 'AOE', verdict.reason, undefined, msg.weaponType);
      return;
    }
    // (The id stays resolvable in spentProjectiles for the paired claim —
    // deletion happens via projectileDestroy, the 5s staleness cap, or
    // the eviction sweep.)

    // Canonical launchers (Bolt/Disc): a claimed direct hit blooms the
    // blast. Server re-derives the bonus from the shared table — the
    // client can't widen the radius past what the weapon allows.
    const bloom = msg.directHit ? directHitAoeBonus(msg.weaponType ?? -1) : 1;
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId,
      bloom === 1 ? stats : { ...stats, aoeRadius: stats.aoeRadius * bloom }, msg.weaponType);

    if (stats.cluster) this.aoeCluster(playerId, msg, stats.cluster);
  }

  /** Swing distance to the player — self-positioned skills (melee, slam)
   *  and the beam eye measure from different heights, so the caller picks
   *  the reference point. */
  private static distTo(from: Vec3, to: Vec3): number {
    return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
  }

  /** The punch is a skill, not a projectile — same self-positioned
   *  contract as Slam, tightened to melee reach. No projectile to
   *  resolve, no airtime to check: the swing point just has to sit
   *  in front of the swinger. */
  private aoeMelee(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats): void {
    const dist = AoeClaims.distTo(player.position, msg.position);
    if (dist > stats.aoeRadius + 10) {
      this.h.reject(playerId, 'AOE', `melee ${dist.toFixed(0)}m from player`, undefined, msg.weaponType);
      return;
    }
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, stats, msg.weaponType);
  }

  /** Slam is a skill, not a projectile — the blast must land where the
   *  player is (they slam into the ground under themselves). Power is a
   *  client-reported impact-speed scaler; clamped to the same range the
   *  client uses so a forged value can't exceed a max-dive blast. */
  private aoeSlam(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats): void {
    const dist = AoeClaims.distTo(player.position, msg.position);
    if (dist > stats.aoeRadius + 20) {
      this.h.reject(playerId, 'AOE', `slam ${dist.toFixed(0)}m from player`, undefined, msg.weaponType);
      return;
    }
    const power = msg.power !== undefined
      ? Math.min(Math.max(msg.power, 0.2), 1.8)
      : 1;
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, {
      ...stats,
      aoeDamage: stats.aoeDamage * power,
      aoeRadius: stats.aoeRadius * power,
      knockbackForce: stats.knockbackForce * power,
    }, msg.weaponType);
  }

  /** Hitscan-class (Lightning beam): the claim names no projectile —
   *  same self-positioned contract as Melee/Slam, tightened to the
   *  beam's range. The tip also can't sit through a wall: the eye→tip
   *  ray must be clear of structures. */
  private aoeBeam(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats): void {
    const eye = { x: player.position.x, y: player.position.y + 1.6, z: player.position.z };
    const dist = AoeClaims.distTo(eye, msg.position);
    if (dist > 70) { // LG_RANGE 55 + lag slack
      this.h.reject(playerId, 'AOE', `beam tip ${dist.toFixed(0)}m from eye`, undefined, msg.weaponType);
      return;
    }
    if (this.h.solids.length && segSolidHit(eye, msg.position, this.h.solids, this.h.solidIndex ?? undefined)) {
      this.h.reject(playerId, 'AOE', 'beam tip behind structure', undefined, msg.weaponType);
      return;
    }
    // Same stepped ramp the client applies: consecutive ticks on one
    // target decay, a target switch or miss window resets to full.
    const n = this.h.chargeBank.step(playerId, msg.excludeTargetId ?? null);
    // The withheld tick damage banks ON the victim — bank before the
    // blast resolves so this tick's share counts if it kills.
    const victim = msg.excludeTargetId ? this.h.playerManager.getPlayer(msg.excludeTargetId) : null;
    if (victim && !victim.isDead && !this.h.friendly(playerId, victim.id)) this.h.chargeBank.bank(victim, this.h.chargeBank.withheldFor(n));
    // The victim sits in excludeTargetId — projectile semantics would skip
    // them in the blast, but the beam has no paired `shot` claim. Apply the
    // tick directly (lag-comp'd, occluded, pin shove) — same ramp botAttack
    // uses, so a held beam on one player decays identically either side.
    if (victim && !victim.isDead) {
      const dmg = lgTickDamage(n) * perkMods(player.perk).directDamage * this.h.ddMult(player);
      this.h.blast.splashOne({
        shooterId: playerId, ping: player.ping, pos: msg.position,
        radius: stats.aoeRadius, baseDamage: dmg,
        impulse: stats.knockbackForce, pull: false,
        label: 'LG beam hit', weapon: msg.weaponType,
      }, victim.id, victim, false, dmg);
    }
    const scale = lgTickDamage(n) / LG_TICK_BASE;
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, { ...stats, aoeDamage: stats.aoeDamage * scale }, msg.weaponType);
  }

  /** Cluster carrier: the carrier's blast is only the delivery pop — the
   *  real damage is `count` bomblet blasts scattered inside `radius`, each
   *  rolled with ClusterBomblet stats. Client bomblets are visual-only. */
  private aoeCluster(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>, cluster: { count: number; radius: number }): void {
    // Each carrier names its own child stats — the belt's ClusterBomb
    // scatters ClusterBomblets, the MRVLauncher scatters MRVBomblets.
    const bomblet = getWeaponStats(
      msg.weaponType === WeaponType.MRVLauncher ? WeaponType.MRVBomblet : WeaponType.ClusterBomblet);
    for (let i = 0; i < cluster.count; i++) {
      const ang = this.h.rng() * Math.PI * 2;
      const r = this.h.rng() * cluster.radius;
      this.h.blast.processAOE(playerId, {
        x: msg.position.x + Math.cos(ang) * r,
        y: msg.position.y, // bomblets scatter on the blast plane
        z: msg.position.z + Math.sin(ang) * r,
      }, msg.excludeTargetId, bomblet, msg.weaponType);
    }
  }
}
