import { simMs } from './simClock.ts';
import type { ClientMessage, Vec3,PlayerState } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';

import {type WeaponStats, getWeaponStats, WeaponType} from '../../shared/weapons.ts';
import { lgTickDamage, LG_TICK_BASE } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { segSolidHit, type ColliderIndex } from '../../shared/solidWorld.ts';
import type { ChargeBank } from './combatCharge.ts';
import type { BlastRunner } from './combatBlast.ts';
import { renderLagOf } from './rewind.ts';
import { classCanFire } from '../../shared/botClasses.ts';

// AOE claim adjudication - what remains after the server took over
// projectiles: self-positioned skills (melee arc, slam, clear-of-
// structures beams) whose "shot" has no shell to sim. Sanity-check the
// swing point per skill contract, then hand the resolved stats to the
// blast funnel.

export interface AoeHost {
  playerManager: PlayerManager;
  blast: BlastRunner;
  chargeBank: ChargeBank;
  readonly solids: readonly StructureCollider[];
  solidIndex: ColliderIndex | null;
  hb(key: string, n?: number): void;
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number): void;
  notifyDrop(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number, shotId?: string): void;
  friendly(shooterId: string, targetId: string): boolean;
  ddMult(shooter: PlayerState): number;
  /** Seeded room rng - bomblet scatter must replay under scenario seeds. */
  rng(): number;
}

export class AoeClaims {
  constructor(private h: AoeHost) {}

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    const player = this.h.playerManager.getPlayer(playerId);
    if (!player || player.isDead) { this.h.hb('drop.deadShooter'); return; }
    this.h.hb('aoe');
    if (msg.weaponType !== undefined && !classCanFire(player.armorClass, msg.weaponType)) {
      this.h.reject(playerId, 'AOE', 'class-locked weapon', undefined, msg.weaponType);
      return;
    }
    player.protectedUntil = simMs(0); // firing breaks your own spawn shield
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

    // Every weapon with a real shell is server-simmed — a projectile
    // aoeShot can't arrive legitimately anymore; the authority's shell
    // declares its own detonation.
    this.h.hb('aoe.legacyProj');
    this.h.reject(playerId, 'AOE', 'projectile blasts are server-simmed', undefined, msg.weaponType);
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
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, stats, { weapon: msg.weaponType });
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
    const power = msg.power === undefined
      ? 1
      : Math.min(Math.max(msg.power, 0.2), 1.8);
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, Object.assign({}, stats, {aoeDamage: stats.aoeDamage * power,aoeRadius: stats.aoeRadius * power,knockbackForce: stats.knockbackForce * power}), { weapon: msg.weaponType });
  }

  /** Hitscan-class (Lightning beam): the claim names no projectile —
   *  same self-positioned contract as Melee/Slam, tightened to the
   *  beam's range. The tip also can't sit through a wall: the eye→tip
   *  ray must be clear of structures. */
  private aoeBeam(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats): void {
    // Per-branch counters: hb('aoe') alone can't split "claims arriving
    // but failing a gate" from "claims never arriving" in the health map.
    this.h.hb('aoe.beam');
    const eye = { x: player.position.x, y: player.position.y, z: player.position.z };
    const dist = AoeClaims.distTo(eye, msg.position);
    if (dist > 70) { // LG_RANGE 55 + lag slack
      this.h.hb('aoe.beam.tip');
      this.h.reject(playerId, 'AOE', `beam tip ${dist.toFixed(0)}m from eye`, undefined, msg.weaponType);
      return;
    }
    if (this.h.solids.length > 0 && segSolidHit(eye, msg.position, this.h.solids, this.h.solidIndex ?? undefined, player.team)) {
      this.h.hb('aoe.beam.occluded');
      this.h.reject(playerId, 'AOE', 'beam tip behind structure', undefined, msg.weaponType);
      return;
    }
    // Same stepped ramp the client applies: consecutive ticks on one
    // target decay, a target switch or miss window resets to full.
    const n = this.h.chargeBank.step(playerId, msg.excludeTargetId ?? null);
    // The withheld tick damage banks ON the victim — bank before the
    // blast resolves so this tick's share counts if it kills.
    const victim = msg.excludeTargetId ? this.h.playerManager.getPlayer(msg.excludeTargetId) : null;
    if (victim?.isDead) {
      // Beam on a corpse: honest aim→death race, but the client's
      // predicted tic still needs clearing or its ledger warns phantom.
      this.h.notifyDrop(playerId, 'AOE', 'target dead', victim.id, msg.weaponType, msg.shotId);
    }
    if (victim && !victim.isDead && !this.h.friendly(playerId, victim.id)) {this.h.chargeBank.bank(victim, this.h.chargeBank.withheldFor(n));}
    // The victim sits in excludeTargetId — projectile semantics would skip
    // them in the blast, but the beam has no paired `shot` claim. Apply the
    // tick directly (lag-comp'd, occluded, pin shove) — same ramp botAttack
    // uses, so a held beam on one player decays identically either side.
    this.beamTickHit(playerId, player, msg, stats, victim, n);
    const scale = lgTickDamage(n) / LG_TICK_BASE;
    this.h.blast.processAOE(playerId, msg.position, msg.excludeTargetId, Object.assign({}, stats, {aoeDamage: stats.aoeDamage * scale}), { weapon: msg.weaponType });
  }

  // The victim sits in excludeTargetId — projectile semantics would skip
  // them in the blast, but the beam has no paired `shot` claim. Apply the
  // tick directly (lag-comp'd, occluded, pin shove) — same ramp botAttack
  // uses, so a held beam on one player decays identically either side.
  private beamTickHit(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'aoeShot' }>, stats: WeaponStats, victim: PlayerState | null | undefined, n: number): void {
    if (!victim || victim.isDead) {return;}
    const dmg = lgTickDamage(n) * perkMods(player.perk).directDamage * this.h.ddMult(player);
    this.h.hb('aoe.beam.hit');
    this.h.blast.splashOne({
      shooterId: playerId, ping: player.ping, bot: Boolean(player.isBot), pos: msg.position,
      lagMs: player.isBot ? 0 : renderLagOf(player, this.h.blast.lagBoundOf(playerId)),
      lagMap: player.isBot ? undefined : player.clientStats?.renderLag,
      lagBound: this.h.blast.lagBoundOf(playerId),
      radius: stats.aoeRadius, baseDamage: dmg,
      impulse: stats.knockbackForce, pull: stats.forceMode === 'pull',
      label: 'LG beam hit', weapon: msg.weaponType,
    }, victim.id, victim, false, dmg);
  }

}
