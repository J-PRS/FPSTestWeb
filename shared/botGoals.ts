/**
 * botGoals — idle-goal selection for BotBrain: the priority ladder
 * (revenge > rally > objective > pickup > heard fight > wander) plus the
 * wander roll, rally fold, and heard-noise probe. Runs on the slow think
 * cadence; botBrain keeps the per-tick destination resolution. The
 * picker writes into the brain-owned GoalState bag, so the mutable
 * fields stay private to the brain while the ordering lives here.
 */
import { botRand } from './botRand.ts';
import { BOT_EYE } from './botHunt.ts';
import { ENERGY } from './movement.ts';
import type { BotVec, BrainCtx } from './botBrain.ts';

/** Mutable goal/wander/revenge state — the brain owns the bag, the
 *  picker mutates it in place. */
export interface GoalState {
  /** The committed destination think() reads when nothing presses. */
  goal: BotVec;
  /** Revenge timer — being shot by an unseen attacker outranks every
   *  idle drive until it decays. */
  revengeT: number;
  revengeFrom: BotVec;
  /** Wander pacing — personal clock so a squad doesn't caravan. */
  wanderT: number;
  wanderWp: BotVec;
}

export class BotGoals {
  constructor(
    private s: () => GoalState,
    private wanderlust: () => number,
    private headingVec: () => { x: number; z: number },
    private nearDeath: (p: { x: number; z: number }) => boolean,
    private duty: () => number = () => 1,
  ) {}

  /** Idle-goal selection, in priority order: revenge > rally > objective >
   *  pickup > heard fight > wander. */
  pick(ctx: BrainCtx, pos: BotVec): void {
    const s = this.s();
    if (s.revengeT > 0) {
      // Hit from somewhere unseen: push toward the shooter rather than
      // continue a patrol — the flinch already spent the recoil.
      s.goal = { ...s.revengeFrom };
      return;
    }
    if ((ctx.healthFrac ?? 1) < 0.15 && ctx.allies && ctx.allies.length > 0) {
      const rally = this.rallyGoal(ctx, pos);
      if (rally) s.goal = rally;
      return;
    }
    // A dry infiltrator can't hold the veil — the nugget loop IS its
    // stealth economy, so feeding the tank outranks pressing the stand.
    if (ctx.infiltrating && ctx.energy !== undefined && ctx.energy < ENERGY.cloakCost + 30 && ctx.pickup) {
      s.goal = { ...ctx.pickup }; return;
    }
    if (ctx.objective) { s.goal = { ...ctx.objective }; return; }
    if (ctx.pickup) { s.goal = { ...ctx.pickup }; return; }
    if (ctx.sounds && ctx.sounds.length > 0) {
      const heard = this.heardGoal(ctx, pos);
      if (heard) { s.goal = heard; return; }
      // No objective on the board: the fight IS the goal. The curiosity
      // roll said no, but a dutiful bot in a DM still drifts toward the
      // nearest heard shot instead of skiing scenery — second-chance
      // pull scaled by duty, never a sure thing (that keeps it human).
      if (!ctx.objective && botRand() < this.duty() * 0.4) {
        let hot: BotVec | null = null, hd = Infinity;
        for (const snd of ctx.sounds) {
          const d = distSq(pos, snd);
          if (d < hd) { hd = d; hot = snd; }
        }
        if (hot) {
          const t = Math.min(1, 55 / Math.sqrt(hd || 1));
          s.goal = { x: pos.x + (hot.x - pos.x) * t, y: pos.y, z: pos.z + (hot.z - pos.z) * t };
        }
      }
      // Noise in earshot holds the attention slot even when both rolls
      // pass on it — wandering off mid-fight sounds next door is how
      // bots used to read as deaf tourists.
      return;
    }
    if (s.wanderT <= 0 || distSq(pos, s.wanderWp) < 9) {
      s.wanderT = (3 + botRand() * 4) / this.wanderlust();
      const best = this.rollWander(ctx, pos);
      if (best) {
        s.wanderWp = best;
        s.goal = { ...s.wanderWp };
      }
    }
  }

  /** Roll a few candidate waypoints; downhill lines win — picking the
   *  low ground is what makes wander read as skiing runs instead of a
   *  jog across flats. Death spots are skipped outright. */
  private rollWander(ctx: BrainCtx, pos: BotVec): BotVec | null {
    const g0 = ctx.groundY(pos.x, pos.z);
    let best: BotVec | null = null;
    let bestDrop = -Infinity;
    for (let tries = 0; tries < 3; tries++) {
      // Committed lines: a skier picks a direction and holds it — the
      // roll is a forward cone off the current heading with real run
      // length, not a fresh random bearing that reverses mid-carve.
      const hv = this.headingVec();
      const a = Math.atan2(hv.z, hv.x) + (botRand() - 0.5) * 2.4;
      const r = (25 + botRand() * 55) * this.wanderlust();
      const wp = { x: pos.x + Math.cos(a) * r, z: pos.z + Math.sin(a) * r };
      if (this.nearDeath(wp)) continue;
      const drop = g0 - ctx.groundY(wp.x, wp.z);
      if (drop > bestDrop) {
        bestDrop = drop;
        best = { x: wp.x, y: ctx.groundY(wp.x, wp.z) + BOT_EYE, z: wp.z };
      }
    }
    return best;
  }

  /** Hurt with nobody shooting back at: fold toward the nearest ALLY —
   *  folding onto an enemy while at 15% hp was worse than running solo. */
  private rallyGoal(ctx: BrainCtx, pos: BotVec): BotVec | null {
    if ((ctx.healthFrac ?? 1) >= 0.15 || !ctx.allies || ctx.allies.length === 0) return null;
    let ally: BotVec | null = null;
    let ad = Infinity;
    for (const o of ctx.allies) {
      const d = distSq(pos, o);
      if (d < ad && d > 4) { ad = d; ally = o; }
    }
    return ally ? { ...ally } : null;
  }

  /** Heard a fight: investigate the nearest noise. Curiosity is a
   *  personality roll so a squad doesn't stampede as one. */
  private heardGoal(ctx: BrainCtx, pos: BotVec): BotVec | null {
    if (!ctx.sounds || ctx.sounds.length === 0) return null;
    let loudest: BotVec | null = null;
    let ld = Infinity;
    for (const s of ctx.sounds) {
      const d = distSq(pos, s);
      if (d < ld) { ld = d; loudest = s; }
    }
    // Duty tempers wanderlust: the professional hears the fight, the
    // tourist hears the call of the mountain.
    return loudest && botRand() < (0.15 + this.duty() * 0.5) ? { ...loudest } : null;
  }
}

function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
