/**
 * botEscape — the get-out-of-the-way senses: no-progress sidesteps that
 * escalate to a jet escape burst, and the shell-dodge lateral hop. Both
 * rewrite the step destination after steering, so they live together —
 * brain.ts keeps hunting/firing; this file owns "the straight line is
 * wrong". State rides on the brain's flat fields via EscapeState.
 */
import type { BrainCtx } from './botBrain.ts';
import { BOT_EYE } from './botHunt.ts';

import { dist3, distSq, dirXZ, type BotVec } from './botVec.ts';
import { segSolidHit } from './solidWorld.ts';

const DODGE_RANGE = 12;  // m — only react to shells already inbound
const DODGE_STEP = 9;    // m — lateral hop, ~one body-length burst

/** Flat-field bag the brain declares — escape senses mutate these. */
export interface EscapeState {
  /** Consecutive no-progress windows — a sidestep that also fails means
   *  a wall pocket, so the streak escalates to a jet escape burst. */
  stuckStreak: number;
  /** Slow-window no-gain streak — separate from stuckStreak because an
   *  orbiter displaces real distance every fast window and would erase
   *  it the same tick it armed (the escalation never escalated). */
  orbitStreak: number;
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
  /** Treadmill anchor: a bot that wobbles ±1.5-2m inside a ~2m cell beats
   *  the per-window displacement check every window — each sample sees
   *  "moved" while the body never leaves the pocket. Net displacement
   *  from a 4s anchor is the pin the watchdog counts and the senses
   *  must too, otherwise the escape never arms on a lip grind. */
  pinX: number;
  pinZ: number;
  pinT: number;
  /** Consecutive 4s windows with <2m net displacement — unlike
   *  stuckStreak this never resets on micro-progress, so a bot the
   *  escapes keep wobbling inside a pocket still accumulates. Two
   *  windows ≈ the mobility watchdog's 5s/2m alarm. */
  pinStreak: number;
  /** goal is read-only here — the sidestep orbits it. */
  goal: BotVec;
}

/** How walkable a heading is: the worst local rise-per-meter inside the
 *  first `dist` meters. A ramp reads ~0.2-0.4, a hop lip ~0.5-1, a
 *  sheer face >>1 — the bot can't see shapes, but groundY along a ray
 *  IS the ramp sense: the walkable approach is the heading whose ground
 *  rises gently instead of jumping. */
function routeSlope(ctx: BrainCtx, pos: BotVec, dx: number, dz: number, dist: number): number {
  let worst = 0;
  let prevAt = 0;
  let prev = ctx.groundY(pos.x, pos.z);
  for (let f = 3; f <= dist; f += 3) {
    const g = ctx.groundY(pos.x + dx * f, pos.z + dz * f);
    worst = Math.max(worst, (g - prev) / (f - prevAt));
    prev = g;
    prevAt = f;
  }
  return worst;
}

/** Escape heading by route cost, not a blind perpendicular: a fan of
 *  headings centered on the goal, scored walkable-first / goal-aligned-
 *  second. A wall pocket sends the bot down the side where the ground
 *  stays climbable — the ramp or the low rim — which is how a player
 *  routes onto a structure instead of jetting the nearest face.
 *  Structure-aware when the map carries solids: terrain alone can't see
 *  a 17m curtain, so a heading that enters a hull within the hop distance
 *  pays a heavy penalty scaled by how soon it hits — the fan slides the
 *  bot along the wall face toward the opening instead of picking the
 *  "gently sloped" direction straight through the bastion kit. */
function pickDetour(s: EscapeState, ctx: BrainCtx, pos: BotVec, dist: number): BotVec {
  const gx = s.goal.x - pos.x, gz = s.goal.z - pos.z;
  const g = dirXZ(gx, gz);
  const gdx = g.x, gdz = g.z;
  const solids = ctx.solids?.length ? ctx.solids : null;
  let best: BotVec | null = null;
  let bestScore = Infinity;
  for (let a = -5; a <= 5; a += 1) {
    const ang = a * (Math.PI / 6);
    const c = Math.cos(ang), sn = Math.sin(ang);
    const dx = gdx * c - gdz * sn, dz = gdx * sn + gdz * c;
    let score = routeSlope(ctx, pos, dx, dz, dist) * 2 - c;
    if (solids) {
      const hit = segSolidHit(
        { x: pos.x, y: pos.y + 1, z: pos.z },
        { x: pos.x + dx * dist, y: pos.y + 1, z: pos.z + dz * dist },
        solids, ctx.solidIndex ?? undefined, ctx.team);
      if (hit) {score += 10 - hit.t * dist;}
    }
    if (score < bestScore) {
      bestScore = score;
      best = { x: pos.x + dx * dist, y: ctx.groundY(pos.x + dx * dist, pos.z + dz * dist) + BOT_EYE, z: pos.z + dz * dist };
    }
  }
  return best ?? s.goal;
}

/** Stuck break — no progress for 1.5s means the straight line is
 *  blocked (structure, cliff, another bot). Sidestep perpendicular to
 *  the goal for a beat; random side per incident keeps herds from
 *  detouring in lockstep. */
export function stuckBreak(s: EscapeState, dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
  s.progressT += dt;
  s.goalWinT += dt;
  s.pinT += dt;
  // "On the step" = arrived or holding by choice — posted anchors parked
  // at their post read this way (the step IS the post), and so does a
  // combat spot deliberately held. A bot 5m off its step and unmoving
  // is a real pin even when posted — an anchor that escaped its leash
  // and can't close the gap needs the escapes, not the exemption. Same
  // 2.5m test the mobility watchdog applies to "standing on the dest".
  const arrived = distSq(pos, dest) < 6.25;
  // Treadmill window: net coverage over ~4s. The fast pinned check below
  // measures per-window displacement — a 1.8m lip-grind oscillation
  // satisfies it every window while the bot goes nowhere; the mobility
  // watchdog counts the same stall by 2m anchor and was the only voice
  // reporting it.
  if (s.pinT >= 4) {
    s.pinT = 0;
    const net = Math.hypot(pos.x - s.pinX, pos.z - s.pinZ);
    s.pinX = pos.x;
    s.pinZ = pos.z;
    if (net < 2 && !arrived) {
s.stuckStreak += 1;
s.pinStreak += 1;
      if (s.detourT <= 0) {
        s.detour = pickDetour(s, ctx, pos, 14);
        s.detourT = 1.2;
      }
      // Pinned through a detour = every sideways probe is a face.
      if (s.stuckStreak >= 2) {s.escapeJetT = Math.max(s.escapeJetT, 1.1);}
    } else {
      s.pinStreak = 0;
    }
  }
  // Slow window: goal-distance gain over ~4s. Circling in place covers
  // real distance while closing nothing — this catches the orbit the
  // fast window below can't (seen in soaks: steerer tangent orbits).
  if (s.goalWinT >= 4) {
    s.goalWinT = 0;
    const gd = Math.hypot(s.goal.x - pos.x, s.goal.z - pos.z);
    // Same posted exemption as the pinned check below: an anchor
    // holding inside its leash isn't circling a wall, and the escape
    // burst this streak arms is exactly how a posted hof kept getting
    // flung 60-100m off post (hof-away probe: dest ~82m during home).
    if (s.progressGoalD > 20 && s.progressGoalD - gd < 4 && !arrived) {
s.orbitStreak += 1;
      // A 1.1s burst buys ~10m of climb — a wall that eats it and stays
      // up is met every 4s with the same sip, which top-dresses the
      // treadmill instead of cresting it (soak: capper cycling y45→81
      // →45 on a ~50m face all match). Consecutive failures escalate
      // the burn so the bot commits real fuel to a real climb.
      s.escapeJetT = Math.max(s.escapeJetT, Math.min(1.1 + s.orbitStreak * 0.7, 3));
      if (s.detourT <= 0) {
        s.detour = pickDetour(s, ctx, pos, 20);
        s.detourT = 2;
      }
    }
    s.progressGoalD = gd;
  }
  if (s.progressT < 1.5) {return s.detourT > 0 && s.detour ? s.detour : dest;}
  // On the step = arrived or a deliberate hold — stillness on post is
  // a hold, not a trap; counting it fires detour+jet escapes that fling
  // defenders off post in a loop.
  if (arrived) {
    s.stuckStreak = 0;
    s.orbitStreak = 0;
    s.detourT = 0;
    s.progressPos = Object.assign({}, pos);
    return dest;
  }
  if (distSq(pos, s.progressPos) < 2.25) {
s.stuckStreak += 1;
    if (s.detourT <= 0) {
      s.detour = pickDetour(s, ctx, pos, 14);
      s.detourT = 1.2;
    }
    // Pinned through a detour = a wall pocket every sideways probe
    // is a face — thrust up and over is the legal way out.
    if (s.stuckStreak >= 2) {s.escapeJetT = Math.max(s.escapeJetT, 1.1);}
  } else {
    s.stuckStreak = 0;
  }
  s.progressPos = Object.assign({}, pos);
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
  if (!nearest) {return dest;}
  // A runner on final approach doesn't juke — ANY dest tilt bleeds
  // arrival speed and arrival speed is what survives the shelling
  // (soak A/B: a 30% dodge lean took seed 4246 from 6 grabs/3 caps to
  // 0-0; the old stall was worse but the lean still kills the run).
  // Inside ~80m the run wins the feet. Same commit the carrier gets.
  if ((ctx.runner || ctx.running || ctx.wave) && ctx.objective && dist3(pos, ctx.objective) < 80) {return dest;}
  // A posted anchor's dodge is a hop, not a juke — the flag is also
  // the cover, and a 9m sidestep under steady bombardment parks him in
  // the 3-15m ring instead of back on the pole between shells.
  const dodgeStep = (hero ? DODGE_STEP * 1.4 : DODGE_STEP) * (ctx.posted ? 0.5 : 1);
  const tx = pos.x - nearest.x, tz = pos.z - nearest.z;
  const tl = Math.hypot(tx, tz) || 1; // |t| is reused as a scalar below
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

/** Tallest collider top covering (x,z), or null when open ground. */
function topCovering(ctx: BrainCtx, x: number, z: number): number | null {
  let top = -Infinity;
  for (const c of ctx.solids!) {
    const dx = x - c.cx, dz = z - c.cz;
    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    if (Math.abs(lx) <= c.hx + 0.5 && Math.abs(lz) <= c.hz + 0.5) {
      const t = c.cy + c.hy;
      if (t > top) {top = t;}
    }
  }
  return top === -Infinity ? null : top;
}



// dist3/distSq imported from botVec.ts — shared by the brain family.

/** First structure hit on the straight path pos→goal → the tallest
 *  collider top covering that impact point, or null when the path is
 *  clear. Wall-top lookup (not just "blocked?") is what decides whether
 *  a full-tank climb can crest the face or the waypoint should be
 *  forfeited. Linear scan — runs only on a matured stall (~once/4s). */
export function wallTopOnPath(ctx: BrainCtx, pos: BotVec, goal: BotVec | undefined): number | null {
  if (!ctx.solids?.length || !goal) {return null;}
  const hit = segSolidHit(
    { x: pos.x, y: pos.y + 1, z: pos.z },
    { x: goal.x, y: goal.y, z: goal.z },
    ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
  if (!hit) {return null;}
  return topCovering(ctx, hit.x, hit.z);
}

/** Nearest own-team gate shield in reach → a waypoint a few meters
 *  past the pane so walking the waypoint threads the door. Direction
 *  doesn't matter — when the goal line is walled, a pane that's air
 *  to us is the exit even if it means backtracking across the base.
 *  The colliders answer "which hole in the wall is mine" themselves —
 *  no authored gate metadata needed. */
export function ownGate(ctx: BrainCtx, pos: BotVec, goal: BotVec | undefined): BotVec | null {
  if (!ctx.solids?.length || !goal || !ctx.team) {return null;}
  const gx = goal.x - pos.x, gz = goal.z - pos.z;
  const g = Math.hypot(gx, gz) || 1;
  const ix = gx / g, iz = gz / g;
  let best: BotVec | null = null;
  let bestD = Infinity;
  let bestBlocked = Infinity;
  for (const c of ctx.solids) {
    if (c.passTeam !== ctx.team) {continue;}
    const dx = c.cx - pos.x, dz = c.cz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 140) {continue;}                             // no door in reach — climb/breach instead
    // The pane is only an exit if the bot can WALK to it: a compound
    // interior structure (genhouse, tower) between the bot and the pane
    // makes the nearest gate a waypoint nobody reaches — prefer a gate
    // whose approach lane is clear over a closer walled one (bastion:
    // capper lapped his own courtyard for minutes chasing a pane with
    // the genhouse in the way).
    const blocked = segSolidHit(
      { x: pos.x, y: pos.y + 1, z: pos.z },
      { x: c.cx, y: pos.y + 1, z: c.cz },
      ctx.solids, ctx.solidIndex ?? undefined, ctx.team) !== null;
    if (!blocked && d < bestD) {
      bestD = d;
      best = { x: c.cx + ix * 6, y: ctx.groundY(c.cx + ix * 6, c.cz + iz * 6) + 1, z: c.cz + iz * 6 };
    } else if (blocked && d < bestBlocked) {
      bestBlocked = d;
      if (!best) {
        best = { x: c.cx + ix * 6, y: ctx.groundY(c.cx + ix * 6, c.cz + iz * 6) + 1, z: c.cz + iz * 6 };
      }
    }
  }
  return best;
}

/** The wall on the goal line is too tall to climb — slide along the
 *  face instead. Probe laterally from the impact point: an open slot
 *  (no collider past the wall plane) is a gap to walk through; a
 *  section under the climb envelope is the hop spot. Returns the point
 *  the feet should visit next, or null when the face runs >60m both
 *  ways (fortress seam — forfeit is honest there). */
export function breachAlongWall(ctx: BrainCtx, pos: BotVec, goal: BotVec | undefined): BotVec | null {
  if (!ctx.solids?.length || !goal) {return null;}
  const from = { x: pos.x, y: pos.y + 1, z: pos.z };
  const hit = segSolidHit(from, goal, ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
  if (!hit) {return null;}
  const gx = goal.x - pos.x, gz = goal.z - pos.z;
  const g = Math.hypot(gx, gz) || 1;
  const ix = gx / g, iz = gz / g;         // inward — toward the goal
  const tx = -iz, tz = ix;                // wall tangent
  for (let s = 4; s <= 60; s += 4) {
    for (const sign of [1, -1] as const) {
      const px = hit.x + tx * sign * s, pz = hit.z + tz * sign * s;
      const qx = px + ix * 8, qz = pz + iz * 8;
      const h2 = segSolidHit({ x: px, y: pos.y + 1, z: pz }, { x: qx, y: pos.y + 1, z: qz },
        ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
      if (!h2) {return { x: qx, y: ctx.groundY(qx, qz) + 1, z: qz };} // open gap — walk through
      const top = topCovering(ctx, h2.x, h2.z);
      if (top !== null && top - pos.y < 24) {
        // Deck-grade lip (raised floor behind a door mouth — genhouse):
        // the waypoint belongs ON the deck inside the opening, not at
        // the face — a face waypoint lands inside the doorpost hull and
        // the stall loop re-arms forever (bastion besiegers parked at
        // the vault door for minutes).
        if (top - pos.y < 12) {return { x: qx, y: top + 0.5, z: qz };}
        // Low section — stand at the face and let the climb arm it.
        return { x: px + ix * 2, y: ctx.groundY(px, pz) + 1, z: pz + iz * 2 };
      }
    }
  }
  return null;
}
