/**
 * botGoals — idle-goal selection for BotBrain. Reflex overrides run
 * first (revenge, rally, the cloak-fuel errand), then the goal itself is
 * utility-scored: every candidate — objective, gem, heard fight, wander —
 * gets weight × distance-falloff × danger-discount, argmax wins with a
 * hysteresis margin so goals don't dither. Runs on the slow think
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
    // Utility pick — nothing is first-past-the-post anymore: a gem 30m
    // out can outscore a flag 400m off, a distant objective beats a
    // death-scented fight. duty tempers the danger discount (dutiful
    // bots press through scent, sightseers route around it); weight is
    // each drive's pull; distance folds to a falloff curve.
    const wander = this.wanderCandidate(ctx, pos);
    const heard = this.heardGoal(ctx, pos);
    const cands: Array<{ goal: BotVec; score: number }> = [];
    const offer = (goal: BotVec | null | undefined, weight: number) => {
      if (!goal) return;
      const d = Math.sqrt(distSq(pos, goal));
      const reach = 1 / (1 + d / 140);
      // Experience memory on top of the shared scent: a spot where THIS
      // bot already died reads extra dangerous to it personally — the
      // map's graveyard is everyone else's history, this one is mine.
      const personal = this.nearDeath(goal) ? 0.2 : 0;
      const scent = Math.min(0.85, (ctx.imapDanger?.(goal) ?? 0) * 0.22 * (1.5 - Math.min(1, this.duty())) + personal);
      cands.push({ goal, score: weight * reach * (1 - scent) });
    };
    // A runner's objective is a commitment, not a candidate: the cap
    // route is the job, so midfield noise has to beat a heavy weight to
    // pull the legs. Fights en route get answered by the fire layer
    // while the feet keep the line — humans run and shoot.
    offer(ctx.objective, ctx.runner ? 3.5 : 1.0);
    offer(ctx.pickup, 0.8);
    if (heard) offer(heard, 0.2 + this.duty() * 0.5);
    if (wander) offer(wander, 0.35);
    if (cands.length > 0) {
      let best = cands[0]!;
      for (const c of cands) if (c.score > best.score) best = c;
      // Hysteresis: the incumbent needs beating by a margin — flipping
      // goals on a 1% re-score reads as bot dithering, not judgment.
      const incumbent = cands.find((c) => distSq(c.goal, s.goal) < 25);
      s.goal = incumbent && incumbent.score > best.score * 0.85 ? incumbent.goal : { ...best.goal };
      return;
    }
    // Wander always offers a candidate, so an empty board only happens
    // when even the roll produced nothing — hold the line.
  }

  /** The wander slot as a utility candidate — a fresh roll when the
   *  pacing clock says so, else the leg already underway. */
  private wanderCandidate(ctx: BrainCtx, pos: BotVec): BotVec | null {
    const s = this.s();
    if (s.wanderT <= 0 || distSq(pos, s.wanderWp) < 9) {
      s.wanderT = (3 + botRand() * 4) / this.wanderlust();
      const best = this.rollWander(ctx, pos);
      if (best) s.wanderWp = best;
    }
    return s.wanderWp;
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
