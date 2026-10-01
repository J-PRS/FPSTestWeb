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

type BotVec = { x: number; y: number; z: number };

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
  /** goal is read-only here — the sidestep orbits it. */
  goal: BotVec;
}

/** Stuck break — no progress for 1.5s means the straight line is
 *  blocked (structure, cliff, another bot). Sidestep perpendicular to
 *  the goal for a beat; random side per incident keeps herds from
 *  detouring in lockstep. */
export function stuckBreak(s: EscapeState, dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
  s.progressT += dt;
  if (s.progressT < 1.5) return s.detourT > 0 && s.detour ? s.detour : dest;
  s.progressT = 0;
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
  const dodgeStep = hero ? DODGE_STEP * 1.4 : DODGE_STEP;
  const tx = pos.x - nearest.x, tz = pos.z - nearest.z;
  const tl = Math.hypot(tx, tz) || 1;
  const vx = ctx.vel?.x ?? 0, vz = ctx.vel?.z ?? 0;
  const side = (vx * -tz + vz * tx) * tl >= 0 ? 1 : -1; // keep momentum
  return {
    x: pos.x + (-tz / tl) * side * dodgeStep,
    y: pos.y,
    z: pos.z + (tx / tl) * side * dodgeStep,
  };
}

function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
