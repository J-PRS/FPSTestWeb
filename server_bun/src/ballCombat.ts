/**
 * BallCombat — the damage/query surface of BallSim: hit-claim
 * validation, AOE splash, melee sweeps, armor plating, and proximity
 * lookups. Split out so BallSim owns flight/spawn/edges while this owns
 * "how the swarm takes damage".
 */
import type { Heightfield } from '../../shared/heightfield.ts';
import { type SimBall, type SimVec, type SegmentKind, applySimDamage } from '../../shared/ballSim.ts';
import { MAX_HIT_CLAIM_DMG } from '../../shared/weapons.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { ARMORNADE_OVERCAP } from '../../shared/weapons.ts';
import { segPointDist, segPointT } from '../../shared/projSim.ts';
import { aoeDamage } from '../../shared/combat.ts';
import { logger } from './logger.ts';

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
      if (b.dead) continue;
      const d = Math.hypot(x - b.x, y - b.y, z - b.z);
      if (d < best) best = d;
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
      if (b.dead) continue;
      const d2 = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2;
      if (d2 > r2) continue;
      b.health = Math.min(b.maxHealth * ARMORNADE_OVERCAP, b.health + amount);
    }
  }

  /** Live ball lookup for honest melee/contact checks. */
  ballAt(id: number): { x: number; y: number; z: number; radius: number } | null {
    const b = this.host.balls().get(id);
    return b && !b.dead ? { x: b.x, y: b.y, z: b.z, radius: b.radius } : null;
  }

  /** Earliest live-ball contact along a segment — same order rule the
   *  player sweep uses (terrain/walls are the caller's to check first). */
  sweepHit(from: SimVec, to: SimVec, extraReach: number): { id: number; t: number } | null {
    let best: { id: number; t: number } | null = null;
    for (const b of this.host.balls().values()) {
      if (b.dead) continue;
      const c = { x: b.x, y: b.y, z: b.z };
      if (segPointDist(from, to, c) > b.radius + extraReach) continue;
      const t = segPointT(from, to, c);
      if (!best || t < best.t) best = { id: b.id, t };
    }
    return best;
  }

  /** Splash into the swarm — same falloff curve the AOE funnel applies to
   *  players. skipId keeps a direct-hit ball from eating blast twice. */
  splashDamage(ownerId: string, pos: SimVec, radius: number, maxDamage: number, skipId?: number): void {
    for (const b of this.host.balls().values()) {
      if (b.dead || b.id === skipId) continue;
      const d = Math.max(0, Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z) - b.radius);
      const dmg = aoeDamage(maxDamage, d, radius);
      if (dmg >= 1) this.handleHit(ownerId, b.id, dmg);
    }
  }

  /** creatureHit claim. Lenient sanity clamps only — real validation is an
   *  anticheat-phase concern; a bogus claim costs a shoved ball, not state. */
  handleHit(playerId: string, id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    const b = this.host.balls().get(id);
    // A claim on a just-killed ball is the normal aim→claim race — the
    // corpse still rendered when the shot was fired. Debug, not warn.
    if (b?.dead) {
      logger.debug('creatureHit on dead ball (aim/claim race)', { playerId, id });
      return;
    }
    if (!b || !this.host.field()) {
      // Same race as the dead-ball path above: the ball was culled (kill,
      // TTL, roster swap) between the shot and this claim — the client
      // genuinely saw it live. Warn only when there IS no field, which
      // means the claim arrived before spec terrain attached — a real bug.
      const lvl = this.host.field() ? 'debug' : 'warn';
      logger[lvl]('creatureHit dropped: unknown ball', { playerId, id, known: this.host.balls().size, field: !!this.host.field() });
      return;
    }
    const claimer = this.host.players.getPlayer(playerId);
    if (!claimer) {
      logger.warn('creatureHit dropped: no claimer', { playerId });
      return;
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
      return;
    }

    // The claim carries no weapon ref — cap at the biggest legal one-hit
    // (direct+splash, perk-boosted) instead of a flat 300.
    const dmg = Math.max(1, Math.min(MAX_HIT_CLAIM_DMG, damage));

    let ix = 0, iy = 0, iz = 0;
    if (kx !== undefined && ky !== undefined && kz !== undefined) {
      const m = Math.hypot(kx, ky, kz);
      const cap = 60; // impulse magnitude ceiling
      if (m > 0.001) {
        const s = Math.min(cap, m) / m;
        ix = kx * s; iy = ky * s; iz = kz * s;
      }
    }
    if (applySimDamage(b, dmg, ix, iy, iz)) {
      this.host.kill(b, playerId);
    } else {
      this.host.segment(b, 'hit'); // the impulse IS a velocity discontinuity
    }
  }
}
