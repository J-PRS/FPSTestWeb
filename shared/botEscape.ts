/**
 * botEscape — the get-out-of-the-way senses: no-progress sidesteps that
 * escalate to a jet escape burst, and the shell-dodge lateral hop. Both
 * rewrite the step destination after steering, so they live together —
 * brain.ts keeps hunting/firing; this file owns "the straight line is
 * wrong". State rides on the brain's flat fields via EscapeState.
 */
import { botRand } from './botRand.ts';
import type { BrainCtx } from './botBrain.ts';
import { BOT_EYE } from './botHunt.ts';

import { dist3, distSq, type BotVec } from './botVec.ts';

const DODGE_RANGE = 12;  // m — only react to shells already inbound
const DODGE_STEP = 9;    // m — lateral hop, ~one body-length burst

/** Flat-field bag the brain declares — escape senses mutate these. */
export interface EscapeState {
  /** Consecutive no-progress windows — a sidestep that also fails means
   *  a wall pocket, so the streak escalates to a jet escape burst. */
  stuckStreak: number;
  escapeJetT: number;
  detour: BotVec | null;
  detourT: number;
  progressPos: BotVec;
  progressT: number;
  /** Slow-window timer — independent of progressT's 1.5s cadence so a
   *  slow-window rollover can't starve the fast pinned check. */
  goalWinT: number;
  /** Long-window anchor: how close to the goal the bot was ~4s ago.
   *  An orbiting bot covers distance but never closes — displacement-
   *  based stuck tests are beaten by circling, goal-distance isn't. */
  progressGoalD: number;
  /** goal is read-only here — the sidestep orbits it. */
  goal: BotVec;
}

/** Stuck break — no progress for 1.5s means the straight line is
 *  blocked (structure, cliff, another bot). Sidestep perpendicular to
 *  the goal for a beat; random side per incident keeps herds from
 *  detouring in lockstep. */
export function stuckBreak(s: EscapeState, dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
  s.progressT += dt;
  s.goalWinT += dt;
  // Slow window: goal-distance gain over ~4s. Circling in place covers
  // real distance while closing nothing — this catches the orbit the
  // fast window below can't (seen in soaks: steerer tangent orbits).
  if (s.goalWinT >= 4) {
    s.goalWinT = 0;
    const gd = Math.hypot(s.goal.x - pos.x, s.goal.z - pos.z);
    if (s.progressGoalD > 20 && s.progressGoalD - gd < 4) {
      s.stuckStreak++;
      // A 1.1s burst buys ~10m of climb — a wall that eats it and stays
      // up is met every 4s with the same sip, which top-dresses the
      // treadmill instead of cresting it (soak: capper cycling y45→81
      // →45 on a ~50m face all match). Consecutive failures escalate
      // the burn so the bot commits real fuel to a real climb.
      s.escapeJetT = Math.max(s.escapeJetT, Math.min(1.1 + s.stuckStreak * 0.7, 3.0));
      if (s.detourT <= 0) {
        const gx = s.goal.x - pos.x, gz = s.goal.z - pos.z;
        const gl = Math.hypot(gx, gz) || 1;
        const side = botRand() < 0.5 ? -1 : 1;
        s.detour = { x: pos.x + (-gz / gl) * side * 20, y: ctx.groundY(pos.x, pos.z) + BOT_EYE, z: pos.z + (gx / gl) * side * 20 };
        s.detourT = 2.0;
      }
    }
    s.progressGoalD = gd;
  }
  if (s.progressT < 1.5) return s.detourT > 0 && s.detour ? s.detour : dest;
  // A parked anchor reads as "stuck" to the pinned check — zero
  // displacement is the whole point of the brake, and counting it fires
  // a detour+jet escape that flings the defender 60-100m off post in a
  // loop. Stillness on post is a hold, not a trap.
  if (ctx.posted && ctx.objective
    && distSq(pos, ctx.objective) < (ctx.posted + 12) * (ctx.posted + 12)) {
    s.stuckStreak = 0;
    s.detourT = 0;
    s.progressPos = { ...pos };
    return dest;
  }
  if (distSq(pos, s.progressPos) < 2.25) {
    s.stuckStreak++;
    if (s.detourT <= 0) {
      const gx = s.goal.x - pos.x, gz = s.goal.z - pos.z;
      const gl = Math.hypot(gx, gz) || 1;
      const side = botRand() < 0.5 ? -1 : 1;
      const dx = (-gz / gl) * side * 14, dz = (gx / gl) * side * 14;
      s.detour = { x: pos.x + dx, y: ctx.groundY(pos.x + dx, pos.z + dz) + BOT_EYE, z: pos.z + dz };
      s.detourT = 1.2;
    }
    // Pinned through a detour = a wall pocket every sideways probe
    // is a face — thrust up and over is the legal way out.
    if (s.stuckStreak >= 2) s.escapeJetT = Math.max(s.escapeJetT, 1.1);
  } else {
    s.stuckStreak = 0;
  }
  s.progressPos = { ...pos };
  return s.detourT > 0 && s.detour ? s.detour : dest;
}

/** Sidestep the nearest closing shell — a perpendicular step dodges a
 *  ballistic arc without abandoning the fight; the side that keeps
 *  current momentum wins (dodging backward through your own velocity
 *  reads as a stumble, not a juke). Hero sharpens both senses: it sees
 *  the shell sooner and hops farther. */
export function dodge(ctx: BrainCtx, pos: BotVec, dest: BotVec, hero: boolean): BotVec {
  let nearest: BotVec | null = null;
  let nearestD = hero ? DODGE_RANGE * 1.7 : DODGE_RANGE;
  for (const t of ctx.threats ?? []) {
    const d = dist3(pos, t);
    if (d < nearestD) { nearestD = d; nearest = t; }
  }
  if (!nearest) return dest;
  // A runner on final approach doesn't juke — ANY dest tilt bleeds
  // arrival speed and arrival speed is what survives the shelling
  // (soak A/B: a 30% dodge lean took seed 4246 from 6 grabs/3 caps to
  // 0-0; the old stall was worse but the lean still kills the run).
  // Inside ~80m the run wins the feet. Same commit the carrier gets.
  if ((ctx.runner || ctx.running || ctx.wave) && ctx.objective && dist3(pos, ctx.objective) < 80) return dest;
  // A posted anchor's dodge is a hop, not a juke — the flag is also
  // the cover, and a 9m sidestep under steady bombardment parks him in
  // the 3-15m ring instead of back on the pole between shells.
  const dodgeStep = (hero ? DODGE_STEP * 1.4 : DODGE_STEP) * (ctx.posted ? 0.5 : 1);
  const tx = pos.x - nearest.x, tz = pos.z - nearest.z;
  const tl = Math.hypot(tx, tz) || 1;
  const vx = ctx.vel?.x ?? 0, vz = ctx.vel?.z ?? 0;
  const side = (vx * -tz + vz * tx) * tl >= 0 ? 1 : -1; // keep momentum
  const dx = pos.x + (-tz / tl) * side * dodgeStep;
  const dz = pos.z + (tx / tl) * side * dodgeStep;
  // The hop still can't leave the leash — repeated shell dodges on a
  // posted anchor ratchet him off the pole one 4m step at a time.
  if (ctx.posted && ctx.objective) {
    const ox = dx - ctx.objective.x, oz = dz - ctx.objective.z;
    const od = Math.hypot(ox, oz);
    if (od > ctx.posted) {
      const k = ctx.posted / od;
      return { x: ctx.objective.x + ox * k, y: pos.y, z: ctx.objective.z + oz * k };
    }
  }
  return { x: dx, y: pos.y, z: dz };
}

// dist3/distSq imported from botVec.ts — shared by the brain family.
