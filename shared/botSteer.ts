/**
 * BotSteer — context steering for the shared bot brain. Every direction
 * is scored instead of testing just the goal line: interest comes from
 * goal alignment and current heading (momentum); danger comes from
 * slope probes, bodies in the way, and the recently-visited memory
 * trail (what lets a bot escape a local minimum instead of orbiting it).
 * Danger masks interest; the best surviving slot wins, and the result
 * is blended with the last heading so slot granularity never shows as
 * jitter. Split out of botBrain so the decision ladder reads as a
 * pipeline (goal → steer → stuck-break → dodge) rather than one
 * monolith of senses.
 */
import type { BotVec, BrainCtx } from './botBrain.ts';
import { wrapAngleDelta } from './angles.ts';
import { botRand } from './botRand.ts';
import { BOT_TUNING as T } from './botTuning.ts';

// --- context steering senses ---
        // directions sampled around the circle
       // m — near slope probe
       // m — far probe catches ridgelines early
          // m — steering lookahead distance
     // m — personal space vs other bodies
     // recently-visited ground repels for this long
    // m — memory trail influence radius

export class BotSteer {
  private heading = { x: 1, z: 0 };
  private memory: { x: number; z: number; t: number }[] = [];
  private memT = 0;
  /** A point the brain wants approached but NOT closed on yet (a
   *  defended stand the wave hasn't converged on). Steps toward it cost
   *  danger inside `radius`; `strength` is how hard the field repels —
   *  fading it lets the approach resume gradually, not on a switch. */
  private standoff: { x: number; z: number; radius: number; strength: number } | null = null;
  setStandoff(s: { x: number; z: number; radius: number; strength: number } | null): void { this.standoff = s; }
  /** Holding a point: humans sway on the spot, never stand a perfect
   *  statue — a slow small orbit around the goal, per-bot phase. */
  private swayT = botRand() * Math.PI * 2;

  /** Committed wander lines read off the same heading the steerer keeps —
   *  the cone roll needs "current facing", which is the heading state. */
  headingVec(): { x: number; z: number } { return this.heading; }

  /** Score every direction; the blended winner becomes the step dest. */
  steer(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    let gx = dest.x - pos.x, gz = dest.z - pos.z;
    const gd = Math.hypot(gx, gz);
    if (gd < 0.5) return dest;
    // Arrived: drift a lazy figure around the point instead of freezing
    // — statues are how bots out themselves on a held position. The
    // radius breathes so it's a wander, not a metronome circle. Not on
    // the objective's doorstep: a flag touch is worth a still beat.
    if (gd < 4 && (!ctx.objective || Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) > 15)) {
      this.swayT += dt * 0.5;
      const r = 1.5 + Math.sin(this.swayT * 0.31) * 1.0;
      const ax = dest.x + Math.cos(this.swayT) * r - pos.x;
      const az = dest.z + Math.sin(this.swayT) * r - pos.z;
      const al = Math.hypot(ax, az) || 1;
      const step0 = Math.min(al, T.steer.step * 0.3);
      this.heading.x = ax / al; this.heading.z = az / al;
      return { x: pos.x + (ax / al) * step0, y: pos.y, z: pos.z + (az / al) * step0 };
    }
    gx /= gd; gz /= gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    // Committed final approach: a runner inside the last stretch aims
    // dead at the objective. Slot scoring deflects it — a defender
    // standing on the flag repels via personal space, and the 4 rad/s
    // turn cap makes a fast arrival circle the point instead of
    // correcting (soak: 37m/s flybys orbiting at ~20-60m, zero touches).
    const objD = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : Infinity;
    if (objD < (ctx.runner ? 60 : 40) || ctx.posted) {
      // Posted anchors take the beeline at any range: slot scoring can
      // mask every goalward slot (slope probes on a ridgeline stand) and
      // the least-dangerous fallback walks the defender hundreds of
      // meters along the ridge — the soak's 300m away-step excursions.
      // A jam on the straight line is stuckBreak's problem, not a
      // reason to wander.
      this.heading.x = gx; this.heading.z = gz;
      const step0 = Math.min(gd, T.steer.step);
      return { x: pos.x + gx * step0, y: pos.y, z: pos.z + gz * step0 };
    }
    const now = ctx.now;

    // Lay the trail, then drop crumbs that are stale or out of range.
    this.memT -= dt;
    if (this.memT <= 0) {
      this.memT = 0.4;
      this.memory.push({ x: pos.x, z: pos.z, t: now });
      if (this.memory.length > 24) this.memory.shift();
    }
    this.memory = this.memory.filter(
      (m) => now - m.t < T.steer.memMs && (m.x - pos.x) ** 2 + (m.z - pos.z) ** 2 < T.steer.memRange * T.steer.memRange,
    );

    // Separation bodies are the only others a slot can ever see —
    // gather them once instead of scanning the full roster per slot.
    const sep2 = T.steer.sepRange * T.steer.sepRange;
    let near: BotVec[] | null = null;
    if (ctx.others) {
      for (const o of ctx.others) {
        const od2 = (o.x - pos.x) ** 2 + (o.z - pos.z) ** 2;
        if (od2 <= sep2 && od2 > 0.0001) (near ??= []).push(o);
      }
    }

    let bestX = gx, bestZ = gz, bestScore = -1;
    let safeX = gx, safeZ = gz, safeDanger = 2;
    for (let i = 0; i < T.steer.slots; i++) {
      const a = (i / T.steer.slots) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);

      const align = dx * gx + dz * gz;
      let interest = Math.max(0, align);
      interest *= interest; // sharpen: prefer near-goal arcs over drift
      interest += 0.25 * Math.max(0, dx * this.heading.x + dz * this.heading.z);

      // Final approach overrides the trail memory: crumbs exist to break
      // local minima, but a goal this close IS the destination — repelling
      // off it parked every stand press ~8m short of the flag pickup ring.
      const danger = this.slotDanger(ctx, pos, dx, dz, { g0, now, nearGoal: gd < T.steer.memRange, near, standoff: this.standoff });
      const score = interest * (1 - danger);
      if (score > bestScore) { bestScore = score; bestX = dx; bestZ = dz; }
      if (danger < safeDanger) { safeDanger = danger; safeX = dx; safeZ = dz; }
    }

    // Every slot masked → take the least-dangerous one; a standstill is
    // worse than a sideways shuffle.
    if (bestScore <= 0.001) { bestX = safeX; bestZ = safeZ; }

    // Carve, don't flick: a human swings their view at wrist speed —
    // ~4 rad/s — so the heading can only rotate that far per tick and
    // slot flips become smooth arcs instead of tick-to-tick skitter.
    // dodge/detour bypass this (they should read as decisive jukes).
    const cur = Math.atan2(this.heading.x, this.heading.z);
    const tgt = Math.atan2(bestX, bestZ);
    const dYaw = wrapAngleDelta(tgt - cur);
    const maxTurn = T.steer.turnRate * dt;
    const a = cur + Math.max(-maxTurn, Math.min(maxTurn, dYaw));
    this.heading.x = Math.sin(a); this.heading.z = Math.cos(a);
    const step = Math.min(gd, T.steer.step);
    return { x: pos.x + this.heading.x * step, y: pos.y, z: pos.z + this.heading.z * step };
  }

  /** Danger score [0..1] for one steering slot: slope probes (climbs,
   *  sheer drops), bodies in the way, and the recently-visited memory
   *  trail that lets a bot escape a local minimum. */
  private slotDanger(ctx: BrainCtx, pos: BotVec, dx: number, dz: number, probe: { g0: number; now: number; nearGoal: boolean; near: BotVec[] | null; standoff: { x: number; z: number; radius: number; strength: number } | null }): number {
    const { g0, now, nearGoal, near, standoff } = probe;
    let danger = 0;
    const riseA = ctx.groundY(pos.x + dx * T.steer.probeA, pos.z + dz * T.steer.probeA) - g0;
    const riseB = ctx.groundY(pos.x + dx * T.steer.probeB, pos.z + dz * T.steer.probeB) - g0;
    // A bounded lip (dais skirt, deck edge, box face) is not a wall: the
    // legs' step-mount hops+jets straight over it, but masking the slot
    // steered the step tangent — the mount probe never faced the lip and
    // the bot rim-orbited the stand forever (soak: HALO/MARA pinned vs
    // the henge base dais). A face that stops rising within mount range
    // keeps the slot open; a real slope keeps rising past it.
    const boundedStep = riseA > 0 && riseA <= T.steer.mountRise && riseB - riseA < T.steer.mountCrest;
    const slope = Math.max(boundedStep ? 0 : riseA / T.steer.probeA, riseB / T.steer.probeB);
    if (slope > T.steer.slopeThresh) danger = Math.min(1, danger + (slope - T.steer.slopeThresh) * T.steer.slopeW);
    if (riseA < T.steer.sheerDrop) danger = Math.min(1, danger + T.steer.sheerDanger); // sheer drop

    // Commitment leash: a posted anchor's field is bounded by its post —
    // steps that would carry it out of the leash read as danger, so the
    // feet hold the zone whatever the dest says (fight orbits, fear
    // retreats, flinch knocks all stop mattering where the leash ends).
    if (ctx.posted && ctx.objective) {
      const s = T.steer.probeA;
      const px = pos.x - ctx.objective.x, pz = pos.z - ctx.objective.z;
      const fromPost = Math.hypot(px, pz);
      const out = (px * dx + pz * dz) / Math.max(fromPost, 0.01);
      if (fromPost + Math.max(0, out) * s > ctx.posted) danger = 1;
    }

    // Standoff repeller: a defended point the wave isn't ready for.
    // The hold radius is never written anywhere — the field's own
    // balance against goal interest decides where the bot circles.
    if (standoff) {
      const sx = pos.x - standoff.x, sz = pos.z - standoff.z;
      const sd = Math.hypot(sx, sz) || 1;
      const after = sd - ((sx * dx + sz * dz) / sd) * T.steer.probeA;
      if (after < standoff.radius) {
        danger = Math.min(1, danger + standoff.strength * (1 - after / standoff.radius));
      }
    }

    if (near) {
      for (const o of near) {
        const ox = o.x - pos.x, oz = o.z - pos.z;
        const od = Math.hypot(ox, oz);
        if (od < 0.01) continue;
        const toward = dx * (ox / od) + dz * (oz / od);
        if (toward > 0.5) danger = Math.min(1, danger + toward * (1 - od / T.steer.sepRange));
      }
    }
    for (const m of nearGoal ? [] : this.memory) {
      const mx = m.x - pos.x, mz = m.z - pos.z;
      const md = Math.hypot(mx, mz);
      if (md > T.steer.memRange || md < 0.5) continue;
      const toward = dx * (mx / md) + dz * (mz / md);
      if (toward > 0.5) {
        danger = Math.min(1, danger + toward * 0.2 * (1 - md / T.steer.memRange) * (1 - (now - m.t) / T.steer.memMs));
      }
    }
    return danger;
  }
}
