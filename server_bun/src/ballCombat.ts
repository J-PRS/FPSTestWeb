/**
 * BallCombat — the damage/query surface of BallSim: hit-claim
 * validation, AOE splash, melee sweeps, armor plating, and proximity
 * lookups. Split out so BallSim owns flight/spawn/edges while this owns
 * "how the swarm takes damage".
 */
import type { Heightfield } from '../../shared/heightfield.ts';
import { type SimBall, type SimVec, type SegmentKind, applySimDamage, BALL_GRAVITY } from '../../shared/ballSim.ts';
import { MAX_HIT_CLAIM_DMG, getWeaponStats, WeaponType, MELEE_ARC_DOT, MELEE_CREATURE_DAMAGE,ARMORNADE_OVERCAP } from '../../shared/weapons.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { HitVerdict } from './types.ts';

import { segPointDist, segPointT } from '../../shared/projSim.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { logger } from './logger.ts';
import { healPool } from './healPool.ts';

export interface BallCombatHost {
  balls(): Map<number, SimBall>;
  field(): Heightfield | null;
  players: PlayerManager;
  segment(b: SimBall, kind: SegmentKind): void;
  kill(b: SimBall, by?: string): void;
}

export class BallCombat {
  constructor(private host: BallCombatHost) {}

  /** Distance to the nearest live ball — env-damage plausibility wants to
   *  know whether a melee claim has any creature near it. */
  nearestBallDist(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const b of this.host.balls().values()) {
      if (b.dead) {continue;}
      const d = Math.hypot(x - b.x, y - b.y, z - b.z);
      if (d < best) {best = d;}
    }
    return best;
  }

  /** Armor-grenade plating: every live ball inside the blast wears the
   *  grant as overcap health (≤ ARMORNADE_OVERCAP × maxHealth — same
   *  trick as deployable armor, so the soak needs no armor field). No
   *  segment: ball hp never rides the wire, so nothing to propagate. */
  armorBlast(pos: SimVec, radius: number, amount: number): void {
    const r2 = radius * radius;
    for (const b of this.host.balls().values()) {
      if (b.dead) {continue;}
      const d2 = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2;
      if (d2 > r2) {continue;}
      healPool(b, amount, b.maxHealth * ARMORNADE_OVERCAP);
    }
  }

  /** Live ball lookup for honest melee/contact checks. */
  ballAt(id: number): { x: number; y: number; z: number; radius: number } | null {
    const b = this.host.balls().get(id);
    return b && !b.dead ? { x: b.x, y: b.y, z: b.z, radius: b.radius } : null;
  }

  /** Earliest live-ball contact along a segment — same order rule the
   *  player sweep uses (terrain/walls are the caller's to check first).
   *  backMs rewinds each ball along its velocity (gravity-corrected) —
   *  shooter-aimed rays validate against the rendered ghost, which
   *  rides ping+renderDelay behind sim-now. */
  sweepHit(from: SimVec, to: SimVec, extraReach: number, backMs = 0): { id: number; t: number; d: number } | null {
    const back = backMs / 1000;
    let best: { id: number; t: number; d: number } | null = null;
    for (const b of this.host.balls().values()) {
      if (b.dead) {continue;}
      const c = back === 0 ? { x: b.x, y: b.y, z: b.z }
        : { x: b.x - b.vx * back, y: b.y - b.vy * back - 0.5 * BALL_GRAVITY * back * back, z: b.z - b.vz * back };
      const d = segPointDist(from, to, c);
      if (d > b.radius + extraReach) {continue;}
      const t = segPointT(from, to, c);
      if (!best || t < best.t) {best = { id: b.id, t, d };}
    }
    return best;
  }

  /** Splash into the swarm — same falloff curve the AOE funnel applies to
   *  players. skipId keeps a direct-hit ball from eating blast twice. */
  splashDamage(ownerId: string, pos: SimVec, radius: number, maxDamage: number, skipId?: number): void {
    for (const b of this.host.balls().values()) {
      if (b.dead || b.id === skipId) {continue;}
      const d = Math.max(0, Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z) - b.radius);
      const dmg = aoeDamage(maxDamage, d, radius);
      if (dmg >= 1) {this.handleHit(ownerId, b.id, dmg);}
    }
  }

  /** Server-derived melee swing — the intent already validated pos/dir,
   *  so the cone pays full damage + radial shove with no claim. Mirrors
   *  the client's cone (reach + body radius, MELEE_ARC_DOT). */
  meleeSweep(ownerId: string, pos: SimVec, dir: SimVec): void {
    const stats = getWeaponStats(WeaponType.Melee);
    const reach = stats.aoeRadius, dmg = MELEE_CREATURE_DAMAGE, force = stats.knockbackForce;
    for (const b of this.host.balls().values()) {
      if (b.dead) {continue;}
      const dx = b.x - pos.x, dy = b.y - pos.y, dz = b.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > reach + b.radius || d < 1e-6) {continue;}
      if ((dx / d) * dir.x + (dy / d) * dir.y + (dz / d) * dir.z < MELEE_ARC_DOT) {continue;}
      this.handleHit(ownerId, b.id, dmg, (dx / d) * force, (dy / d) * force, (dz / d) * force);
    }
  }

  /** Blast shove on the swarm — mirrors the client's predicted
   *  Ball.applyKnockback (flat dir*force inside radius+body, pull flips
   *  it). Without it the client throws the ball and the next segment
   *  yanks it back. */
  knock(pos: SimVec, radius: number, force: number, pull = false): void {
    if (!Number.isFinite(pos.x + pos.y + pos.z + radius + force)) {return;}
    const s = pull ? -1 : 1;
    for (const b of this.host.balls().values()) {
      if (b.dead) {continue;}
      const dx = b.x - pos.x, dy = b.y - pos.y, dz = b.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius + b.radius || d < 1e-6) {continue;}
      b.vx += (dx / d) * force * s;
      b.vy += (dy / d) * force * s;
      b.vz += (dz / d) * force * s;
    }
  }

  /** creatureHit claim. Lenient sanity clamps only — real validation is an
   *  anticheat-phase concern; a bogus claim costs a shoved ball, not state.
   *  `killed` feeds kill-edge telemetry; `reason` names a claim the sim
   *  never touched (echoed to the claimant inside claimAck). */
  handleHit(playerId: string, id: number, damage: number, kx?: number, ky?: number, kz?: number): HitVerdict {
    const b = this.host.balls().get(id);
    // A claim on a just-killed ball is the normal aim→claim race — the
    // corpse still rendered when the shot was fired. Debug, not warn.
    if (b?.dead) {
      logger.debug('creatureHit on dead ball (aim/claim race)', { playerId, id });
      return { killed: false, reason: 'deadball' };
    }
    if (!b || !this.host.field()) {
      // Same race as the dead-ball path above: the ball was culled (kill,
      // TTL, roster swap) between the shot and this claim — the client
      // genuinely saw it live. Warn only when there IS no field, which
      // means the claim arrived before spec terrain attached — a real bug.
      const lvl = this.host.field() ? 'debug' : 'warn';
      logger[lvl]('creatureHit dropped: unknown ball', { playerId, id, known: this.host.balls().size, field: Boolean(this.host.field()) });
      return { killed: false, reason: 'unknown' };
    }
    const claimer = this.host.players.getPlayer(playerId);
    if (!claimer) {
      logger.warn('creatureHit dropped: no claimer', { playerId });
      return { killed: false, reason: 'noclaimer' };
    }
    // Loose plausibility: claimer within engagement envelope of the ball
    const dx = claimer.position.x - b.x;
    const dy = claimer.position.y - b.y;
    const dz = claimer.position.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 600 * 600) {
      logger.warn('creatureHit dropped: out of range', {
        playerId, id, dist: Math.round(Math.sqrt(d2)),
        claimerPos: { x: Math.round(claimer.position.x), y: Math.round(claimer.position.y), z: Math.round(claimer.position.z) },
        ballPos: { x: Math.round(b.x), y: Math.round(b.y), z: Math.round(b.z) },
        claimerDead: claimer.isDead,
      });
      return { killed: false, reason: 'range' };
    }

    // The claim carries no weapon ref — cap at the biggest legal one-hit
    // (direct+splash, perk-boosted) instead of a flat 300.
    const dmg = Math.max(1, Math.min(MAX_HIT_CLAIM_DMG, damage));

    // Directed shoves (melee sweep, lightning pin) carry their impulse on
    // the claim — the client already predicted it, so authority must apply
    // the same push or the ball rubberbands on the next segment. AoE blast
    // knock never rides claims ('knock' kind 'prey' event covers it), so a
    // claimed impulse can't double-shove. Cap keeps a forged claim honest.
    let ix = kx ?? 0, iy = ky ?? 0, iz = kz ?? 0;
    const im = Math.hypot(ix, iy, iz);
    if (im > 60) { const k = 60 / im; ix *= k; iy *= k; iz *= k; }
    if (applySimDamage(b, dmg, ix, iy, iz)) {
      this.host.kill(b, playerId);
      return { killed: true };
    }
    return { killed: false };
  }
}
