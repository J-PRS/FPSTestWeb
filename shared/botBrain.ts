/**
 * BotBrain — the shared decision core for every fake player, offline
 * (client GameBot) and online (server_bun ServerBots). Pure logic on plain
 * vectors: no THREE, no sockets, no scene — both runtimes supply those at
 * the edges and consume the same "where to move / when to fire / where to
 * aim" answers, so bot personality is tuned once and ships to both.
 *
 * Contract: call think(dt, ctx) once per tick/frame with the bot's current
 * position and world snapshot; it returns a movement destination and, when
 * it wants to shoot, a fire command { targetId, aim }. The caller owns
 * locomotion, the visual, and resolving the hit.
 */

export interface BotVec { x: number; y: number; z: number }

export interface BotEnemy {
  id: string;
  pos: BotVec;
  vel: BotVec;
  alive: boolean;
}

export interface BrainCtx {
  /** The bot's own position. */
  pos: BotVec;
  enemies: BotEnemy[];
  /** Objective anchor (CTF flag/base) — outranks pickup and wander. */
  objective?: BotVec | null;
  /** Ground pickup to chase (nugget) — outranks wander. */
  pickup?: BotVec | null;
  /** Terrain height at x,z — wander waypoints clamp to ground. */
  groundY: (x: number, z: number) => number;
  /** Nearby bodies (allies, the local player, self ok — skipped by
   *  distance) for the separation sense. Optional; steering works
   *  without it. */
  others?: BotVec[];
  /** Wall/sim time in ms — brain cooldowns key off this, not frames. */
  now: number;
}

export interface BrainOut {
  /** Where the caller should move the bot this step. */
  dest: BotVec;
  /** Fire command when the bot wants to shoot this step. */
  fire?: { targetId: string; aim: BotVec };
}

export const BOT_EYE = 1.6;
export const BOT_FIRE_RANGE = 45;
const THINK_S = 0.3;
const ORBIT_FAR = 22;    // orbit the target inside this ring distance
const ORBIT_TOO_CLOSE = 12;
const STALE_MS = 1200;   // last-seen older than this = stop firing blind
const FLINCH_S = 0.4;
const FLINCH_DIST = 8;

// --- context steering senses ---
const SLOTS = 16;        // directions sampled around the circle
const PROBE_A = 4;       // m — near slope probe
const PROBE_B = 9;       // m — far probe catches ridgelines early
const STEP = 8;          // m — steering lookahead distance
const SEP_RANGE = 7;     // m — personal space vs other bodies
const MEM_MS = 4000;     // recently-visited ground repels for this long
const MEM_RANGE = 12;    // m — memory trail influence radius

/** Heightfield LOS — march the eye→target line, fail where ground rises
 *  above it. pos.y is eye-height on the client and near-feet on the
 *  server, so the eye point is whichever is higher of pos.y and
 *  ground+eye. Structures aren't modeled — callers don't hand them in —
 *  so this is "can I see over the terrain", not full occlusion. */
function losClear(ctx: BrainCtx, from: BotVec, to: BotVec): boolean {
  const dx = to.x - from.x, dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 4) return true; // point-blank: probes are coarser than the gap
  const steps = Math.ceil(dist / 3);
  const y0 = Math.max(from.y + 0.4, ctx.groundY(from.x, from.z) + BOT_EYE);
  const y1 = Math.max(to.y + 0.4, ctx.groundY(to.x, to.z) + BOT_EYE);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t, z = from.z + dz * t;
    if (ctx.groundY(x, z) > y0 + (y1 - y0) * t + 0.5) return false;
  }
  return true;
}

export class BotBrain {
  /** Set the spawn point as the initial goal. */
  constructor(spawn: BotVec) {
    this.goal = { ...spawn };
    this.lastSeen = { ...spawn };
  }

  private thinkT = Math.random() * THINK_S;
  private goal: BotVec;
  private hunt: BotEnemy | null = null;
  private lastSeen: BotVec;
  private lastSeenVel: BotVec = { x: 0, y: 0, z: 0 };
  private lastSeenAt = 0;
  private fireT = 0;
  private burstLeft = 0;
  private flinchT = 0;
  private flinchFrom: BotVec = { x: 0, y: 0, z: 0 };
  private wanderWp: BotVec = { x: 0, y: 0, z: 0 };
  private wanderT = 0;
  private progressPos: BotVec = { x: 0, y: 0, z: 0 };
  private progressT = 0;
  private detour: BotVec | null = null;
  private detourT = 0;
  private heading = { x: 1, z: 0 };
  private memory: { x: number; z: number; t: number }[] = [];
  private memT = 0;
  // Personality scalars — ±20-30% per bot so a squad doesn't read as one
  // centipede: different preferred ranges, wander appetites, tempers.
  private readonly orbitFar = ORBIT_FAR * (0.85 + Math.random() * 0.3);
  private readonly orbitClose = ORBIT_TOO_CLOSE * (0.85 + Math.random() * 0.3);
  private readonly wanderlust = 0.7 + Math.random() * 0.6;
  private readonly temper = 0.7 + Math.random() * 0.6; // fire-cadence scale
  private fightPos: BotVec | null = null; // combat spot from the last replan

  /** Getting shot makes the bot recoil — call from the damage funnel. */
  takeHit(from: BotVec): void {
    this.flinchT = FLINCH_S;
    this.flinchFrom = { ...from };
  }

  think(dt: number, ctx: BrainCtx): BrainOut {
    const pos = ctx.pos;
    const now = ctx.now;

    // --- pick a hunt target / refresh the goal (slow cadence) ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = THINK_S;
      let best: BotEnemy | null = null;
      let bestD = BOT_FIRE_RANGE;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const d = dist3(pos, e.pos);
        // No wallhack: only acquire what the eye line can actually see.
        // An occluded enemy clears the hunt entirely — breaking LOS behind
        // a ridge shakes pursuit like it would a human.
        if (d < bestD && losClear(ctx, pos, e.pos)) { bestD = d; best = e; }
      }
      this.hunt = best;
      if (best) {
        this.lastSeen = { ...best.pos };
        this.lastSeenVel = { ...best.vel };
        this.lastSeenAt = now;
      }
      // Combat replan rides the slow cadence — the ring eval is the
      // expensive part (LOS per candidate per enemy) and 3Hz is plenty
      // for position keeping.
      this.fightPos = null;
      if (best && dist3(pos, best.pos) <= this.orbitFar) {
        this.fightPos = this.pickFightPos(ctx, pos, best);
      }
      if (!best && ctx.objective) {
        this.goal = { ...ctx.objective };
      } else if (!best && ctx.pickup) {
        this.goal = { ...ctx.pickup };
      } else if (!best && (this.wanderT <= 0 || distSq(pos, this.wanderWp) < 9)) {
        this.wanderT = (3 + Math.random() * 4) / this.wanderlust;
        const a = Math.random() * Math.PI * 2;
        const r = (15 + Math.random() * 40) * this.wanderlust;
        this.wanderWp = {
          x: pos.x + Math.cos(a) * r,
          y: ctx.groundY(pos.x + Math.cos(a) * r, pos.z + Math.sin(a) * r) + BOT_EYE,
          z: pos.z + Math.sin(a) * r,
        };
        this.goal = { ...this.wanderWp };
      }
    }
    this.wanderT -= dt;
    // detourT decays here, with the other timers — decrementing it inside
    // the dest block below would let the setting call's dt eat the window.
    this.detourT -= dt;

    // --- choose the step destination ---
    let dest: BotVec;
    if (this.flinchT > 0) {
      this.flinchT -= dt;
      const fx = pos.x - this.flinchFrom.x, fz = pos.z - this.flinchFrom.z;
      const l = Math.hypot(fx, fz) || 1;
      dest = { x: pos.x + (fx / l) * FLINCH_DIST, y: pos.y, z: pos.z + (fz / l) * FLINCH_DIST };
    } else if (this.hunt) {
      const t = this.hunt;
      const d = dist3(pos, t.pos);
      if (d > this.orbitFar) {
        dest = { ...t.pos };
      } else {
        // fightPos comes from the last replan tick — no pick yet (or the
        // pick was "hold") means stand and shoot.
        dest = this.fightPos ?? { ...pos };
      }
    } else {
      dest = this.goal;
    }

    // --- context steering: senses score every direction ---
    dest = this.steer(dt, ctx, pos, dest);

    // Stuck break — no progress for 1.5s means the straight line is
    // blocked (structure, cliff, another bot). Sidestep perpendicular to
    // the goal for a beat; random side per incident keeps herds from
    // detouring in lockstep.
    this.progressT += dt;
    if (this.progressT >= 1.5) {
      this.progressT = 0;
      if (distSq(pos, this.progressPos) < 2.25 && this.detourT <= 0) {
        const gx = this.goal.x - pos.x, gz = this.goal.z - pos.z;
        const gl = Math.hypot(gx, gz) || 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const dx = (-gz / gl) * side * 14, dz = (gx / gl) * side * 14;
        this.detour = { x: pos.x + dx, y: ctx.groundY(pos.x + dx, pos.z + dz) + BOT_EYE, z: pos.z + dz };
        this.detourT = 1.2;
      }
      this.progressPos = { ...pos };
    }
    if (this.detourT > 0 && this.detour) {
      dest = this.detour;
    }

    // --- fire ---
    let fire: BrainOut['fire'];
    if (this.hunt && now - this.lastSeenAt <= STALE_MS) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        if (this.burstLeft <= 0) this.burstLeft = 3;
        this.burstLeft--;
        this.fireT = (this.burstLeft > 0 ? 0.85 : 1.6 + Math.random()) / this.temper;
        const d = dist3(pos, this.lastSeen);
        const err = 0.5 + Math.hypot(this.lastSeenVel.x, this.lastSeenVel.y, this.lastSeenVel.z) * 0.1 + d * 0.02;
        fire = {
          targetId: this.hunt.id,
          aim: {
            x: this.lastSeen.x + this.lastSeenVel.x * (d / 60) + (Math.random() - 0.5) * err,
            y: this.lastSeen.y + this.lastSeenVel.y * (d / 60) + (Math.random() - 0.5) * err * 0.5,
            z: this.lastSeen.z + this.lastSeenVel.z * (d / 60) + (Math.random() - 0.5) * err,
          },
        };
      }
    }

    return { dest, fire };
  }

  /** Killzone-style position pick: score a ring of candidate spots by
   *  LOS to the target, preferred range band, exposure to the rest of
   *  the enemy roster, and climbable ground. Standing still is candidate
   *  0 with an inertia bonus, so a good spot is kept instead of orbiting
   *  for orbit's sake. Returns null to hold position. */
  private pickFightPos(ctx: BrainCtx, pos: BotVec, t: BotEnemy): BotVec | null {
    const mid = (this.orbitFar + this.orbitClose) * 0.5;
    const g0 = ctx.groundY(pos.x, pos.z);
    let bx = pos.x, bz = pos.z;
    let bs = this.scorePos(ctx, pos, pos, t, mid, g0) + 0.4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const cx = pos.x + Math.cos(a) * 10, cz = pos.z + Math.sin(a) * 10;
      const cy = ctx.groundY(cx, cz);
      if (cy - g0 > 4) continue; // can't stand there
      const s = this.scorePos(ctx, pos, { x: cx, y: cy + BOT_EYE, z: cz }, t, mid, cy);
      if (s > bs) { bs = s; bx = cx; bz = cz; }
    }
    if (Math.hypot(bx - pos.x, bz - pos.z) < 3) return null;
    return { x: bx, y: pos.y, z: bz };
  }

  /** Score one candidate position for the combat picker: LOS to the hunt
   *  target (a spot that can't see it is cover — mildly bad on offense),
   *  closeness to the preferred range band, exposure to every OTHER enemy
   *  that could see the spot, and how much vertical scrambling it needs. */
  private scorePos(ctx: BrainCtx, self: BotVec, cand: BotVec, t: BotEnemy, mid: number, candGround: number): number {
    const dt = dist3(cand, t.pos);
    let s = losClear(ctx, cand, t.pos) ? 2 : -1.5;
    s -= Math.abs(dt - mid) * 0.08;
    for (const e of ctx.enemies) {
      if (!e.alive || e === t) continue;
      if (losClear(ctx, cand, e.pos)) s -= 0.6; // a second gun covers this spot
    }
    s -= Math.abs(candGround - ctx.groundY(self.x, self.z)) * 0.05;
    return s;
  }

  /** Context steering — every direction is scored instead of testing
   *  just the goal line. Interest comes from goal alignment and current
   *  heading (momentum); danger comes from slope probes, bodies in the
   *  way, and recently-visited ground (the memory trail, which is what
   *  lets a bot escape a local minimum instead of orbitting it).
   *  Danger masks interest; the best surviving slot wins, and the result
   *  is blended with the last heading so 22.5° slot granularity never
   *  shows as jitter. */
  private steer(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    let gx = dest.x - pos.x, gz = dest.z - pos.z;
    const gd = Math.hypot(gx, gz);
    if (gd < 0.5) return dest;
    gx /= gd; gz /= gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    const now = ctx.now;

    // Lay the trail, then drop crumbs that are stale or out of range.
    this.memT -= dt;
    if (this.memT <= 0) {
      this.memT = 0.4;
      this.memory.push({ x: pos.x, z: pos.z, t: now });
      if (this.memory.length > 24) this.memory.shift();
    }
    this.memory = this.memory.filter(
      (m) => now - m.t < MEM_MS && (m.x - pos.x) ** 2 + (m.z - pos.z) ** 2 < MEM_RANGE * MEM_RANGE,
    );

    let bestX = gx, bestZ = gz, bestScore = -1;
    let safeX = gx, safeZ = gz, safeDanger = 2;
    for (let i = 0; i < SLOTS; i++) {
      const a = (i / SLOTS) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);

      const align = dx * gx + dz * gz;
      let interest = Math.max(0, align);
      interest *= interest; // sharpen: prefer near-goal arcs over drift
      interest += 0.25 * Math.max(0, dx * this.heading.x + dz * this.heading.z);

      let danger = 0;
      const riseA = ctx.groundY(pos.x + dx * PROBE_A, pos.z + dz * PROBE_A) - g0;
      const riseB = ctx.groundY(pos.x + dx * PROBE_B, pos.z + dz * PROBE_B) - g0;
      const slope = Math.max(riseA / PROBE_A, riseB / PROBE_B);
      if (slope > 0.45) danger = Math.min(1, danger + (slope - 0.45) * 2);
      if (riseA < -12) danger = Math.min(1, danger + 0.5); // sheer drop

      if (ctx.others) {
        for (const o of ctx.others) {
          const ox = o.x - pos.x, oz = o.z - pos.z;
          const od = Math.hypot(ox, oz);
          if (od > SEP_RANGE || od < 0.01) continue;
          const toward = dx * (ox / od) + dz * (oz / od);
          if (toward > 0.5) danger = Math.min(1, danger + toward * (1 - od / SEP_RANGE));
        }
      }
      for (const m of this.memory) {
        const mx = m.x - pos.x, mz = m.z - pos.z;
        const md = Math.hypot(mx, mz);
        if (md > MEM_RANGE || md < 0.5) continue;
        const toward = dx * (mx / md) + dz * (mz / md);
        if (toward > 0.5) {
          danger = Math.min(1, danger + toward * 0.2 * (1 - md / MEM_RANGE) * (1 - (now - m.t) / MEM_MS));
        }
      }

      const score = interest * (1 - danger);
      if (score > bestScore) { bestScore = score; bestX = dx; bestZ = dz; }
      if (danger < safeDanger) { safeDanger = danger; safeX = dx; safeZ = dz; }
    }

    // Every slot masked → take the least-dangerous one; a standstill is
    // worse than a sideways shuffle.
    if (bestScore <= 0.001) { bestX = safeX; bestZ = safeZ; }

    // Blend with the previous heading — smooths slot-to-slot jitter while
    // the momentum term above keeps real turns responsive.
    const mx = bestX * 0.7 + this.heading.x * 0.3;
    const mz = bestZ * 0.7 + this.heading.z * 0.3;
    const ml = Math.hypot(mx, mz) || 1;
    this.heading.x = mx / ml; this.heading.z = mz / ml;
    const step = Math.min(gd, STEP);
    return { x: pos.x + this.heading.x * step, y: pos.y, z: pos.z + this.heading.z * step };
  }
}

function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
