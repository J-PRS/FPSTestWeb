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
import { dirXZ, distSqXZ } from './botVec.ts';
import { segSolidHit } from './solidWorld.ts';

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
  /** Lateral weave drive: a runner crossing open ground wants his line
   *  to curve — an oscillating side-pull on interest so the carved path
   *  reads as jinking instead of a laser beeline. Strength is how hard
   *  it bends; the phase advances inside steer(). */
  private weave = 0;
  private weaveT = 0;
  setWeave(strength: number): void { this.weave = strength; }
  /** Holding a point: humans sway on the spot, never stand a perfect
   *  statue — a slow small orbit around the goal, per-bot phase. */
  private swayT = botRand() * Math.PI * 2;
  /** Progress memory: slot scoring can mask every goalward slot and
   *  hold the bot on a tangent orbit (moving fast, going nowhere).
   *  The leg's closest approach so far; a leg that isn't closing
   *  earns the beeline back - a human who circles a ridge too long
   *  picks the hard line, not a bigger circle. */
  private legBest = Infinity;
  private noProgress = 0;

  /** Committed wander lines read off the same heading the steerer keeps —
   *  the cone roll needs "current facing", which is the heading state. */
  headingVec(): { x: number; z: number } { return this.heading; }

  /** Score every direction; the blended winner becomes the step dest. */
  steer(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    let gx = dest.x - pos.x, gz = dest.z - pos.z;
    const gd = Math.hypot(gx, gz);
    this.legLen = gd;
    if (gd < 0.5) {return dest;}
    // Arrived: drift a lazy figure around the point instead of freezing
    // — statues are how bots out themselves on a held position. The
    // radius breathes so it's a wander, not a metronome circle. Not on
    // the objective's doorstep: a flag touch is worth a still beat.
    if (gd < 4 && (!ctx.objective || Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) > 15)) {
      this.swayT += dt * 0.5;
      const r = 1.5 + Number(Math.sin(this.swayT * 0.31));
      const ax = dest.x + Math.cos(this.swayT) * r - pos.x;
      const az = dest.z + Math.sin(this.swayT) * r - pos.z;
      const al = Math.hypot(ax, az) || 1;
      const step0 = Math.min(al, T.steer.step * 0.3);
      const hd = dirXZ(ax, az);
      this.heading.x = hd.x; this.heading.z = hd.z;
      return { x: pos.x + hd.x * step0, y: pos.y, z: pos.z + hd.z * step0 };
    }
    gx /= gd; gz /= gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    this.weaveT += dt * 1.3;
    // Committed final approach: a runner inside the last stretch aims
    // dead at the objective. Slot scoring deflects it — a defender
    // standing on the flag repels via personal space, and the 4 rad/s
    // turn cap makes a fast arrival circle the point instead of
    // correcting (soak: 37m/s flybys orbiting at ~20-60m, zero touches).
    const objD = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : Infinity;
    // Beeline only when the line is actually clear — a shield pane or
    // wall between the bot and the objective used to be invisible here,
    // so the commit drove dead-straight into the glass until the stall
    // machinery noticed. Blocked → fall through to slot scoring, which
    // now prices the solid face itself.
    const beelineClear = !ctx.solids?.length || !segSolidHit(
      { x: pos.x, y: pos.y + 1, z: pos.z },
      { x: dest.x, y: pos.y + 1, z: dest.z },
      ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
    // The carrier's beeline covers flagGoal's whole direct-home window
    // (~200m): "route owns the feet" means the stand's slope/memory
    // repellers can't mask every goalward slot and hold him on an
    // 80-160m tangent orbit (katabatic capRun: 300s circling, 0 caps).
    // The outbound runner's approach has the same hole: flagGoal hands
    // quiet-approach ring waypoints ~140m out, and at 60-160m the slot
    // scorer could orbit him around the stand for minutes (katabatic
    // grab@218s — the return-leg fix has to be symmetric).
    // Routed legs beeline at ANY range: dest is already the flood's
    // next hop (~40-90m), so gating on objective distance (~600m) meant
    // the slot scorer orbited the carrier between every hop forever.
    // Un-routed legs (offline — no flood) keep the old 160m window.
    // beelineClear still gates on real structure in the way.
    if (beelineClear && (ctx.posted || objD < 40
      || (ctx.runner || ctx.running) && (ctx.route || objD < 160))) {
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
    // Orbit-breaker: slot scoring below can repel every goalward
    // direction (slope probes, body space, the memory trail itself)
    // and hold the bot carving a circle at full speed - the live
    // bowl-lock: fast 1s windows, zero 15s displacement. If this leg
    // isn't closing at real pace, the goal direction gets the beeline
    // back until progress resumes. A fresh leg re-arms the tracker.
    if (gd < this.legBest - 1) { this.legBest = gd; this.noProgress = 0; }
    else if (gd > this.legBest * 1.6 + 30) { this.legBest = gd; this.noProgress = 0; } // new leg picked - the goal moved, not orbited
    else { this.noProgress += dt; }
    if (this.noProgress > 3 && beelineClear) {
      this.heading.x = gx; this.heading.z = gz;
      const step0 = Math.min(gd, T.steer.step);
      return { x: pos.x + gx * step0, y: pos.y, z: pos.z + gz * step0 };
    }
    const {now} = ctx;

    // Lay the trail, then drop crumbs that are stale or out of range.
    this.memT -= dt;
    if (this.memT <= 0) {
      this.memT = 0.4;
      this.memory.push({ x: pos.x, z: pos.z, t: now });
      if (this.memory.length > 24) {this.memory.shift();}
    }
    this.memory = this.memory.filter(
      (m): boolean => now - m.t < T.steer.memMs && distSqXZ(m, pos) < T.steer.memRange * T.steer.memRange,
    );

    // Separation bodies are the only others a slot can ever see —
    // gather them once instead of scanning the full roster per slot.
    const sep2 = T.steer.sepRange * T.steer.sepRange;
    let near: BotVec[] | null = null;
    if (ctx.others) {
      for (const o of ctx.others) {
        const od2 = distSqXZ(o, pos);
        if (od2 <= sep2 && od2 > 0.0001) {(near ??= []).push(o);}
      }
    }

    // Eyes scale with speed: fixed 4-9m probes are ~0.1s of warning at
    // ski pace — a 68m/s skier face-plants the massif before the slots
    // ever see the wall (katabatic bleed autopsy: KE->0 into the face,
    // then a walking grind). Look ahead by reaction distance instead:
    // faster legs get deeper eyes, capped so a parked bot isn't blind.
    const spd = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    const pa = Math.min(T.steer.probeAMax, Math.max(T.steer.probeA, spd * T.steer.probeNearK));
    const pb = Math.min(T.steer.probeBMax, Math.max(T.steer.probeB, spd * T.steer.probeFarK));

    // Landing instinct: airborne + falling → steer the touchdown onto
    // the slope that best swallows the arc. JP's rule: the free speed
    // comes from WHERE you land — a steep downslope redirects the fall
    // into ski speed, and the entry has to GRAZE (arc slope ≈ ground
    // grade) or the impact eats the KE it's meant to convert.
    const agl = pos.y - g0;
    const falling = agl > 3 && (ctx.vel?.y ?? 0) < -1 && spd > 4;
    const arcSlope = falling ? Math.abs(ctx.vel!.y) / spd : 0;

    let bestX = gx, bestZ = gz, bestScore = -1;
    let safeX = gx, safeZ = gz, safeDanger = 2;
    for (let i = 0; i < T.steer.slots; i += 1) {
      const a = (i / T.steer.slots) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);

      const align = dx * gx + dz * gz;
      let interest = Math.max(0, align);
      interest *= interest; // sharpen: prefer near-goal arcs over drift
      interest += 0.25 * Math.max(0, dx * this.heading.x + dz * this.heading.z);
      // Landing graze: score a slot by how well the ground's fall along
      // it matches the arc's slope — peak at tangency (graze), fades to
      // both splat (too steep) and glide-over (too shallow). Gated to
      // goal-aligned slots: it picks WHICH landing on the route, never
      // lures off it (an ungated pull cost a capper a 295s leg chasing
      // a pretty slope away from the line).
      if (falling && align > 0.3) {
        const landY = ctx.groundY(pos.x + dx * pb, pos.z + dz * pb);
        const grade = (g0 - landY) / pb;
        if (grade > 0.15) {
          const ratio = grade / arcSlope;
          // JP's rule priced: a landing whose ground keeps FALLING past
          // the touchdown pays more than an equally-grazed dip that
          // bottoms out — descent length IS the gravity budget the
          // landing buys. Diverting to it is free within the goal arc;
          // braking to reach one is a different (speed-for-energy)
          // trade this doesn't make.
          const chain = (landY - ctx.groundY(pos.x + dx * pb * 2, pos.z + dz * pb * 2)) / pb;
          const payoff = 1 + Math.min(2, Math.max(0, chain) * 4);
          interest += T.steer.landW * Math.min(ratio, 1 / ratio) * payoff;
        }
      }
      // Weave: a side-pull perpendicular to the goal, oscillating so the
      // carve alternates — the emergent serpentine a runner throws.
      if (this.weave > 0) {
        interest += this.weave * Math.sin(this.weaveT) * (dx * -gz + dz * gx);
      }

      // Final approach overrides the trail memory: crumbs exist to break
      // local minima, but a goal this close IS the destination — repelling
      // off it parked every stand press ~8m short of the flag pickup ring.
      const danger = this.slotDanger(ctx, pos, dx, dz, { g0, now, nearGoal: gd < T.steer.memRange, near, standoff: this.standoff, pa, pb });
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
  /** A/B flag: downhill charge scoring. Off = legacy (slopes only repel). */
  skiCharge = false;
  legLen = 0; // dest distance for this steer - fed by steer() each call

  private slotDanger(ctx: BrainCtx, pos: BotVec, dx: number, dz: number, probe: { g0: number; now: number; nearGoal: boolean; near: BotVec[] | null; standoff: { x: number; z: number; radius: number; strength: number } | null; pa: number; pb: number }): number {
    const { g0, now, nearGoal, near, standoff, pa, pb } = probe;
    let danger = 0;
    const riseA = ctx.groundY(pos.x + dx * pa, pos.z + dz * pa) - g0;
    const riseB = ctx.groundY(pos.x + dx * pb, pos.z + dz * pb) - g0;
    // Ski-drive hypothesis: on a long leg a downhill slot is a SPEED
    // line, not just a safe one - negative danger amplifies the slot's
    // interest instead of merely clearing it. Only off uphill faces
    // (rise<0), only when the leg is long enough for speed to matter.
    if (this.skiCharge && this.legLen > 60) {
      const fall = Math.min(riseA / pa, riseB / pb); // worst probe still falls
      if (fall < -0.05) {danger -= Math.min(0.5, -fall * 0.4);}
    }
    // A bounded lip (dais skirt, deck edge, box face) is not a wall: the
    // legs' step-mount hops+jets straight over it, but masking the slot
    // steered the step tangent — the mount probe never faced the lip and
    // the bot rim-orbited the stand forever (soak: HALO/MARA pinned vs
    // the henge base dais). A face that stops rising within mount range
    // keeps the slot open; a real slope keeps rising past it.
    const boundedStep = riseA > 0 && riseA <= T.steer.mountRise && riseB - riseA < T.steer.mountCrest;
    const slope = Math.max(boundedStep ? 0 : riseA / T.steer.probeA, riseB / T.steer.probeB);
    if (slope > T.steer.slopeThresh) {danger = Math.min(1, danger + (slope - T.steer.slopeThresh) * T.steer.slopeW);}
    if (riseA < T.steer.sheerDrop) {danger = Math.min(1, danger + T.steer.sheerDanger);} // sheer drop

    // Solid faces price like terrain — the steerer used to see only the
    // heightfield, so a shield pane or curtain was clear air until the
    // body bounced off it. Probed at body height so a jetting bot still
    // flies OVER a low wall (the pane's 80m face blocks anyway); own-team
    // gate panes pass through ctx.team and cost nothing.
    if (ctx.solids?.length) {
      const hit = segSolidHit(
        { x: pos.x, y: pos.y + 1, z: pos.z },
        { x: pos.x + dx * pa, y: pos.y + 1, z: pos.z + dz * pa },
        ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
      if (hit) {danger = Math.min(1, danger + 1.2 - hit.t);}
    }

    // Commitment leash: a posted anchor's field is bounded by its post —
    // steps that would carry it out of the leash read as danger, so the
    // feet hold the zone whatever the dest says (fight orbits, fear
    // retreats, flinch knocks all stop mattering where the leash ends).
    if (ctx.posted && ctx.objective) {
      const s = T.steer.probeA;
      const px = pos.x - ctx.objective.x, pz = pos.z - ctx.objective.z;
      const fromPost = Math.hypot(px, pz);
      const out = (px * dx + pz * dz) / Math.max(fromPost, 0.01);
      if (fromPost + Math.max(0, out) * s > ctx.posted) {danger = 1;}
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

    // Piñata kiting: a rich hoarder plays keep-away - slots that close
    // on the nearest hunter read as danger scaled by the pile. The
    // regen drip refills a disengaged carrier, so steering off contact
    // IS the play; a 60m comfort gap keeps it from sprinting at walls.
    const heldTokens = ctx.held ?? 0;
    if (heldTokens >= 15 && ctx.enemies) {
      let ex = 0, ez = 0, ed = Infinity;
      for (const e of ctx.enemies) {
        if (!e.alive) {continue;}
        const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
        if (d < ed) { ed = d; ex = e.pos.x - pos.x; ez = e.pos.z - pos.z; }
      }
      if (ed < 60) {
        const toward = (dx * ex + dz * ez) / ed;
        if (toward > 0.2) {
          danger = Math.min(1, danger + toward * Math.min(0.6, heldTokens * 0.01) * (1 - ed / 60));
        }
      }
    }

    // Separation and trail memory are transit instincts — a posted body
    // holds ground: it stacks on the stand with its squad and re-walks
    // its own patrol arc, so neither applies while posted.
    if (near && !ctx.posted) {
      for (const o of near) {
        const ox = o.x - pos.x, oz = o.z - pos.z;
        const od = Math.hypot(ox, oz);
        if (od < 0.01) {continue;}
        const toward = dx * (ox / od) + dz * (oz / od);
        if (toward > 0.5) {danger = Math.min(1, danger + toward * (1 - od / T.steer.sepRange));}
      }
    }
    for (const m of nearGoal || ctx.posted ? [] : this.memory) {
      const mx = m.x - pos.x, mz = m.z - pos.z;
      const md = Math.hypot(mx, mz);
      if (md > T.steer.memRange || md < 0.5) {continue;}
      const toward = dx * (mx / md) + dz * (mz / md);
      if (toward > 0.5) {
        danger = Math.min(1, danger + toward * 0.2 * (1 - md / T.steer.memRange) * (1 - (now - m.t) / T.steer.memMs));
      }
    }
    return danger;
  }
}
