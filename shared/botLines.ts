/**
 * BotLines — meso-scale line picking for the shared bot brain. The
 * steerer sees ~9m: enough to avoid a bump, not enough to see a valley
 * trap. This layer samples candidate runs 15–60m out against the live
 * heightfield each commitment window and hands the steerer a landing
 * spot instead of the raw goal — a downhill-biased choice that keeps
 * speed up and reads as skiing rather than point-blank beelining.
 *
 * Everything is probed live — no waypoints, no nav mesh, no A*. A bot
 * facing a crater re-plans from where it stands every few seconds, so
 * the same code adapts to any terrain the field throws at it.
 */
import type { BotVec, BrainCtx } from './botBrain.ts';
import { BOT_TUNING as T } from './botTuning.ts';
import { sharedEnv } from './env.ts';
import { dirXZ } from './botVec.ts';
import { segSolidHit } from './solidWorld.ts';

          // fan of candidate directions around the goal
        // rad — half-angle of the fan
           // probes per ray
        // m — farthest landing probe
         // m — nearest landing probe
    // hold a line this long before re-planning
        // m — closer than this counts as reached
       // don't line-plan close work — steerer owns that
       // m — goal drift that forces an early re-roll

/** Lookahead along the flow route scales with speed: at 40 m/s a 34m
 *  waypoint is under a second of travel, so a fast bot steers into
 *  terrain the route already priced around. Reading the line further
 *  out keeps the fast line on the flood's corridor — slow walkers keep
 *  the corridor-scale 34m the bend-heavy maps need. */
function aheadFor(ctx: BrainCtx): number {
  const v = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
  return T.graph.ahead + Math.max(0, v - T.graph.aheadSpeedFree) * T.graph.aheadSpeedK;
}

export class BotLines {
  private wp: BotVec | null = null;
  private wpGoal: BotVec | null = null;
  private lineT = 0;
  private lastGd = Infinity;
  private stale = 0;
  /** Pass memory: points where this bot's own climb actually converted
   *  to altitude — experience, not a path table. When the cone can't
   *  find a way over, a remembered pass beats another wall probe. */
  private passes: BotVec[] = [];
  private lastY = -Infinity;
  /** Traverse direction lock — without it every re-plan re-picks the
   *  "goal-side" end of the contour and the bot zigzags around the ring
   *  instead of walking it monotonically until the grade opens. */
  private traverseDir: 1 | -1 | null = null;
  /** Orbit-escape latch: goal distance when the give-up path armed.
   *  A massif ring pays ~8m of "progress" per pocket lap — small gains
   *  released the latch instantly and reset the traverse lock, which is
   *  exactly the treadmill (kata: 180s circling ~160m short of the
   *  stand). Escape needs a real net gain, not a lap dividend. */
  private orbitGd = Infinity;
  /** Escape picks rolled while the orbit latch is armed — enough of them
   *  without the 30m release means the terrain itself owns the trap
   *  (basin treadmill) and the answer stops being terrain-aware. */
  private orbitFails = 0;
  /** Goal the orbit latch armed for — the release radius belongs to that
   *  goal, so a dest that moved (flag grab flips enemy→home stand
   *  mid-think) can't inherit a latch whose radius never releases:
   *  the carrier crawled the whole return leg in 40m beeline hops
   *  because gd-to-home stayed above the outbound arm (kata autopsy:
   *  ~100m in 70s latched, then 500m in 15s once it let go). */
  private orbitGoal: BotVec | null = null;

  /** Convert the raw goal into a committed landing spot for the steerer. */
  plan(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    const gd = Math.hypot(dest.x - pos.x, dest.z - pos.z);
    // A structure on the goal ray is invisible to the terrain fan —
    // the flood is the only layer that priced the walls. One probe per
    // plan buys two things: short legs still consult the route, and the
    // close-in homing squash can't flatten a real detour into a hull.
    const solidAhead = Boolean(ctx.solids?.length) && gd > 1 && Boolean(segSolidHit(
      { x: pos.x, y: pos.y + 1, z: pos.z },
      { x: dest.x, y: pos.y + 1, z: dest.z },
      ctx.solids ?? [], ctx.solidIndex ?? undefined, ctx.team));
    this.lineT -= dt;
    // A leg that moved real altitude is worth remembering: the ramp
    // down is the ramp up in reverse, and only terrain the bot itself
    // crossed gets filed — no map knowledge it never earned.
    if (Math.abs(pos.y - this.lastY) > 12 && gd < this.lastGd + 60) {
      this.passes.push({ x: pos.x, y: pos.y, z: pos.z });
      if (this.passes.length > 8) {this.passes.shift();}
    }
    this.lastY = pos.y;
    // Runner close-out reaches further than minGd: inside the stand's
    // apron a pocket waypoint is just another lap of the ring — aim the
    // pole itself and let the moves layer own the touch.
    if (gd < (ctx.runner ? T.lines.runnerDirectGd : T.lines.minGd) && !solidAhead) {
      this.wp = null; this.lastGd = Infinity; this.stale = 0;
      this.traverseDir = null; this.orbitGd = Infinity; this.orbitFails = 0; this.orbitGoal = null;
      return dest;
    }

    // Ballistic descent aims at the objective itself: a runner high
    // over the approach doesn't need a terrain pocket — steering at the
    // flag converts the apex into a landing ON the stand instead of
    // touching down a field away and walking the last leg (surreal
    // autopsy: a clean 300m apex landed ~150m off-target because the
    // planner kept committing downhill pockets under the glide).
    const od0 = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : Infinity;
    const objIsDest = ctx.objective && Math.hypot(ctx.objective.x - dest.x, ctx.objective.z - dest.z) < 40;
    if (ctx.runner && ctx.objective && objIsDest && pos.y - ctx.groundY(pos.x, pos.z) > T.lines.diveAgl && od0 < pos.y * T.lines.diveGlideK) {
      this.wp = { x: ctx.objective.x, y: ctx.objective.y, z: ctx.objective.z };
      this.wpGoal = Object.assign({}, dest);
      this.lineT = T.lines.commitS;
      return this.wp;
    }

    const wpD = this.wp ? Math.hypot(this.wp.x - pos.x, this.wp.z - pos.z) : Infinity;
    const drifted = this.wpGoal ? Math.hypot(dest.x - this.wpGoal.x, dest.z - this.wpGoal.z) > T.lines.redest : true;
    // A roll that found no line (all rays vetoed or floor-failed) still
    // costs the whole fan — without a latch the same dead roll re-ran
    // every think (~83% of the think stage on soak). Hold the empty
    // result for the commit window like a real waypoint.
    if (!this.wp && this.lineT > 0 && !drifted) {return dest;}
    if (this.wp && this.lineT > 0 && wpD > T.lines.arrive) {
      if (!drifted) {return this.wp;}
      // Goal drifted: keep the committed line while it still runs inside
      // the fan cone of the new goal. Live-lead destinations (escort
      // intercept, carrier follow) slide every think — re-rolling the
      // whole probe fan on each jitter was ~83% of the think stage.
      const gx = (dest.x - pos.x) / gd, gz = (dest.z - pos.z) / gd;
      const wx = (this.wp.x - pos.x) / wpD, wz = (this.wp.z - pos.z) / wpD;
      if (wx * gx + wz * gz > Math.cos(T.lines.cone)) {
        this.wpGoal = Object.assign({}, dest);
        return this.wp;
      }
    }

    // Eyes ahead, not scars behind: the goal line's worst rise-per-meter
    // is probed before spending any momentum — a face that exceeds the
    // mountable band engages the traverse pick NOW instead of after the
    // stagnation ladder bleeds a few hundred E into it (katabatic soaks:
    // sheep warns carrying 400-1100 bleed).
    const faceAhead = gd > T.lines.faceProbeMin && this.routeRise(ctx, pos, dest, Math.min(gd, 40)) > T.lines.faceRise;
    // Stagnation meter: a route that re-plans without closing ground is
    // in an orbit trap — on a massif the energy-play exemption keeps
    // picking lateral downhill pockets and the bot laps the contour at
    // fixed radius forever (soak: bravo capper orbited the stand at
    // ~750m for the whole match). Two dead rolls drop the exemption;
    // the third gives up on terrain scoring entirely and beelines —
    // humans grind the climb when carving stops paying. A pass the bot
    // has actually made before outranks another face probe.
    if (gd > this.lastGd - 8) {this.stale += 1;}
    else { this.stale = 0; if (this.orbitGd === Infinity) {this.traverseDir = null;} }
    this.lastGd = gd;
    // Release the orbit latch only on net progress from where it armed —
    // or when the goal itself moved: a latch armed for the enemy stand
    // has no authority over the homeward leg.
    if (this.orbitGoal && Math.hypot(dest.x - this.orbitGoal.x, dest.z - this.orbitGoal.z) > T.lines.redest) {
      this.orbitGd = Infinity; this.orbitFails = 0; this.traverseDir = null; this.orbitGoal = null;
    }
    if (this.orbitGd !== Infinity && gd < this.orbitGd - 30) {
      this.orbitGd = Infinity; this.stale = 0; this.traverseDir = null; this.orbitFails = 0; this.orbitGoal = null;
    }
    const prof = sharedEnv.thinkProf;
    let tp = prof ? sharedEnv.wallPerf!() : 0;
    if (faceAhead || this.stale >= T.lines.staleLimit || this.orbitGd !== Infinity) {
      if (this.orbitGd === Infinity) { this.orbitGd = gd; this.orbitFails = 0; this.orbitGoal = Object.assign({}, dest); }
      else {this.orbitFails += 1;}
      let bestPass: BotVec | null = null, bestPassD = 250;
      for (const pass of this.passes) {
        const pd = Math.hypot(pass.x - pos.x, pass.z - pos.z);
        // Count only passes on the goal side of the bot — one it already
        // crossed backward is another lap of the same trap.
        if (pd < bestPassD && Math.hypot(dest.x - pass.x, dest.z - pass.z) < gd) { bestPass = pass; bestPassD = pd; }
      }
      const reach = Math.min(40, gd);
      let wp = bestPass;
      if (!wp && ctx.route && (gd > T.graph.minGd || solidAhead)) {
        // The flood already priced every saddle map-wide — a myopic
        // traverse guesses at the exit direction while the route walks
        // the pass it found. Consult it inside the escape, not just on
        // the happy path (kata outbound: the apron's face dance burned
        // ~100s of ratcheting where the flood knew the way around).
        wp = ctx.route(pos.x, pos.z, dest.x, dest.z, aheadFor(ctx));
        // A route that just re-feeds the face is no escape: only take
        // it when it points meaningfully off the goal line.
        if (wp) {
          const w = dirXZ(wp.x - pos.x, wp.z - pos.z);
          const offLine = w.x * ((dest.x - pos.x) / gd) + w.z * ((dest.z - pos.z) / gd) < 0.75;
          if (!offLine) {wp = null;}
        }
      }
      if (this.orbitFails >= 2) {
        // Two escape picks without release = the trap isn't a wall the
        // traverse can walk, it's a basin. Stop scoring terrain — beeline
        // the goal and let the moves layer jet-hop whatever's in the way
        // (humans grind the climb when carving stops paying).
        wp = { x: pos.x + (dest.x - pos.x) / gd * reach, y: pos.y, z: pos.z + (dest.z - pos.z) / gd * reach };
      } else if (!wp) {
        // Contour traverse: when the goal sits across an unclimbable
        // face, the way out is sideways — walk perpendicular to the
        // steepest uphill until a gentler grade appears in the fan.
        // Beeline only when the terrain around is already flat.
        const g0 = ctx.groundY(pos.x, pos.z);
        let ux = 0, uz = 0, up = 0;
        for (let i = 0; i < 8; i += 1) {
          const ang = (i / 8) * Math.PI * 2;
          const rise = ctx.groundY(pos.x + Math.cos(ang) * 12, pos.z + Math.sin(ang) * 12) - g0;
          if (rise > up) { up = rise; ux = Math.cos(ang); uz = Math.sin(ang); }
        }
        if (up > 6) {
          const px = -uz, pz = ux;
          const t = Math.min(50, gd);
          const a = { x: pos.x + px * t, z: pos.z + pz * t };
          const b = { x: pos.x - px * t, z: pos.z - pz * t };
          if (this.traverseDir === null) {
            // First traverse: a switchback, not a level contour — the
            // escape buys altitude a few meters per leg, so ends that
            // climb moderately beat ends that hold flat; diving is
            // always bad. Afterwards the direction is fixed so the bot
            // walks the ring monotonically instead of zigzagging back.
            // Rim scout: on each candidate arm, march the line toward
            // the goal and take the highest terrain on it — the side
            // with the lower crest is the saddle a human would scan
            // for, which beats walking whichever contour feels flat
            // (both arms of a moat read equally flat while one ends
            // at the pass).
            const crest = (c: { x: number; z: number }) => {
              const ddx = dest.x - c.x, ddz = dest.z - c.z;
              const dd = Math.hypot(ddx, ddz);
              if (dd < 1) {return 0;}
              const steps = Math.min(12, Math.ceil(dd / 30));
              let m = 0;
              for (let s = 1; s <= steps; s += 1) {
                const h = ctx.groundY(c.x + ddx * s / steps, c.z + ddz * s / steps) - g0;
                if (h > m) {m = h;}
              }
              return m;
            };
            const scoreT = (c: { x: number; z: number }) => {
              const climb = ctx.groundY(c.x, c.z) - g0;
              return (gd - Math.hypot(dest.x - c.x, dest.z - c.z))
                + Math.min(Math.max(0, climb), 12) * 2
                - Math.max(0, climb - 12) * 3
                - Math.max(0, -climb) * 2
                - crest(c) * 1.5;
            };
            this.traverseDir = scoreT(a) >= scoreT(b) ? 1 : -1;
          }
          const c = this.traverseDir === 1 ? a : b;
          wp = { x: c.x, y: pos.y, z: c.z };
        } else {
          this.traverseDir = null;
          wp = { x: pos.x + (dest.x - pos.x) / gd * reach, y: pos.y, z: pos.z + (dest.z - pos.z) / gd * reach };
        }
      }
      this.wp = wp;
      this.wpGoal = Object.assign({}, dest);
      this.lineT = T.lines.commitS;
      this.stale = 0;
      if (prof) {prof.set('lines:orbit', (prof.get('lines:orbit') ?? 0) + sharedEnv.wallPerf!() - tp);}
      return this.wp;
    }

    // Long legs consult the flow field first: the fan's reach can't
    // see a saddle a few hundred meters off the beeline, but the shared
    // flood already priced the whole map. Short legs keep the fan —
    // its energy scoring reads what a coarse grid can't.
    tp = prof ? sharedEnv.wallPerf!() : 0;
    let routed: BotVec | null = null;
    if (ctx.route && (gd > T.graph.minGd || solidAhead)) {
      routed = ctx.route(pos.x, pos.z, dest.x, dest.z, aheadFor(ctx));
      // Inside the homing band a bending polyline overshoots: the route
      // aim rides the flood's terrain-following bend PAST the goal and
      // the bot spends the next 20s climbing back. When the goal ray
      // itself is clear, cut to it — the human line is nearly straight
      // in close, jets absorb the small stuff. A solid on the ray makes
      // the bend real: the flood is detouring a wall, not terrain.
      if (routed && gd < 150 && !faceAhead && !solidAhead) {
        const r = dirXZ(routed.x - pos.x, routed.z - pos.z);
        const offLine = r.x * ((dest.x - pos.x) / gd)
          + r.z * ((dest.z - pos.z) / gd);
        if (offLine < 0.92) {
          const reach = Math.min(40, gd);
          routed = { x: pos.x + (dest.x - pos.x) / gd * reach, y: pos.y, z: pos.z + (dest.z - pos.z) / gd * reach };
        }
      }
      if (prof) { const t1 = sharedEnv.wallPerf!(); prof.set('lines:route', (prof.get('lines:route') ?? 0) + t1 - tp); tp = t1; }
    }
    this.wp = routed ?? this.roll(ctx, pos, dest, gd);
    if (prof) {prof.set('lines:roll', (prof.get('lines:roll') ?? 0) + sharedEnv.wallPerf!() - tp);}
    // A fresh roll that lands inside `arrive` is no waypoint at all —
    // latching it would re-roll every think (the residual fan storm);
    // commit the empty result like a null roll: walk at the goal.
    if (this.wp && Math.hypot(this.wp.x - pos.x, this.wp.z - pos.z) <= T.lines.arrive) {this.wp = null;}
    this.wpGoal = Object.assign({}, dest);
    this.lineT = T.lines.commitS;
    return this.wp ?? dest;
  }

  /** Worst local rise-per-meter along the goal line out to `dist` —
   *  a ramp reads ~0.2-0.4, a bounded lip ~0.5-1, a sheer face >>1.
   *  Same metric botEscape's pickDetour scores candidate routes on. */
  private routeRise(ctx: BrainCtx, pos: BotVec, dest: BotVec, dist: number): number {
    const dx = (dest.x - pos.x) / dist, dz = (dest.z - pos.z) / dist;
    let worst = 0;
    for (let d = 3; d <= dist; d += 3) {
      const g = ctx.groundY(pos.x + dx * d, pos.z + dz * d);
      const prev = ctx.groundY(pos.x + dx * (d - 3), pos.z + dz * (d - 3));
      const seg = (g - prev) / 3;
      if (seg > worst) {worst = seg;}
    }
    return worst;
  }

  /** Fan the goal cone, profile each ray's terrain, keep the best run. */
  private roll(ctx: BrainCtx, pos: BotVec, dest: BotVec, gd: number): BotVec | null {
    const g0 = ctx.groundY(pos.x, pos.z);
    const gx = (dest.x - pos.x) / gd, gz = (dest.z - pos.z) / gd;
    // Runners read the terrain farther out: a 300m massif on the line
    // is invisible at normal reach, and skiing over it costs more than
    // the long way around.
    // Far goals get far eyes: capped at ~128m a runner facing a
    // massif-crossing leg can only probe the wall in front of it —
    // the saddle pass sits beyond reach, so every roll lands another
    // pocket on the same face (the bravo capper's match-long orbit).
    // At long range extend the probe to ~half the remaining leg so the
    // pass shows up in the fan at all.
    const reach = Math.min(gd, ctx.runner && gd > T.lines.farReachGd ? Math.max(T.lines.reach * T.lines.runnerReachK, gd * T.lines.farReachK) : T.lines.reach * (ctx.runner ? T.lines.runnerReachK : 1));
    // Runners (carriers, cappers) get a wider fan and harder downhill
    // pull — a momentum run arcs around climbs rather than over them.
    const cone = T.lines.cone * (ctx.runner ? T.lines.runnerConeK : 1);
    const dropW = ctx.runner ? T.lines.runnerDropW : T.lines.dropW;
    const straightW = ctx.runner ? T.lines.runnerStraightW : T.lines.straightW;
    // A runner's real currency is mechanical energy — ½v²+g·h totalled,
    // not the momentary speed. Landings priced above the bot's energy
    // budget can't be reached without spending on jets or slope work,
    // so lines that keep E banked score ahead of raw drop-chasing.
    const vNow = ctx.runner && ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.y, ctx.vel.z) : 0;
    const eNow = 0.5 * vNow * vNow + 28 * pos.y;

    let best: BotVec | null = null, bestScore = 0;
    for (let r = 0; r < T.lines.rays; r += 1) {
      const a = (r / (T.lines.rays - 1) - 0.5) * 2 * cone;
      const dx = gx * Math.cos(a) - gz * Math.sin(a);
      const dz = gx * Math.sin(a) + gz * Math.cos(a);

      // Terrain profile along the ray — the run's shape decides its
      // worth, not just where it lands.
      let earlyClimb = 0;
      let prevG = g0, prevD = 0;
      const drops: number[] = [];
      for (let p = 1; p <= T.lines.pts; p += 1) {
        const d = T.lines.near + ((reach - T.lines.near) * p) / T.lines.pts;
        const g = ctx.groundY(pos.x + dx * d, pos.z + dz * d);
        const seg = (g - prevG) / (d - prevD);
        if (prevD < T.lines.near && seg > earlyClimb) {earlyClimb = seg;}
        drops.push(g);
        prevG = g; prevD = d;
      }
      const sheer = Math.min(...drops.map((g, i) => g - (i ? drops[i - 1]! : g0)));
      if (sheer < T.lines.sheerVeto) {continue;} // cliff face — don't route bots off sheers

      // Best landing on this ray: the deepest pocket that still gains
      // on the goal. Downhill pockets buy speed; the goal term keeps
      // the run pointed at the objective.
      for (let p = 0; p < T.lines.pts; p += 1) {
        const d = T.lines.near + ((reach - T.lines.near) * (p + 1)) / T.lines.pts;
        const wx = pos.x + dx * d, wz = pos.z + dz * d;
        const gained = gd - Math.hypot(dest.x - wx, dest.z - wz);
        const drop = g0 - drops[p]!;
        // Energy-conserving endpoint: the landing's E is the launch E
        // shifted between kinetic and potential — a landing priced
        // above what E affords reads as spent, keeping the run inside
        // its real budget instead of over-climbing.
        const vEndSq = vNow * vNow + 56 * (pos.y - drops[p]!);
        const eScore = ctx.runner ? (28 * drops[p]! + 0.5 * Math.max(0, vEndSq) - eNow) * T.lines.eScoreW : 0;
        // Progress floor: a run has to close a real share of its own
        // travel toward the goal — unless it's an energy play, banking
        // speed off a side valley to convert later (that's a legit ski
        // setup, not a loop). Without the floor a deep side valley
        // always outscores the route and the bot orbits midfield
        // forever (soak: align=0.00, prog=0).
        if (gained < d * T.lines.gainedFloor && (eScore <= T.lines.eScoreEscape || this.stale >= 2)) {continue;}
        // Apex setup (last leg, runners only): a landing above the goal
        // banks altitude the dive converts back into arrival speed —
        // the flank-crest-and-drop that makes a flag run survivable.
        // Gated to the last leg so mid-route stays direct instead of
        // carving side-hills forever.
        const apex = ctx.runner && gd < T.lines.apexGd ? Math.min(T.lines.apexMax, Math.max(0, drops[p]! - dest.y)) * T.lines.apexW : 0;
        const score =
          gained * T.lines.progressW +                      // progress toward the goal
          drop * dropW +                      // downhill buys ski speed
          Math.min(0, drop + T.lines.climbTaxRise) * T.lines.climbTaxW +       // climbs past ~4m get taxed hard
          eScore +                            // banked E beats burning it (runners)
          apex +
          (p === T.lines.pts - 1 ? T.lines.longCommitBonus : 0) -           // prefer committing long when tied
          earlyClimb * T.lines.earlyClimbW -                   // a climb in the first stretch kills the run
          Math.abs(a) * straightW;            // straighter lines beat carving sideways
        if (score > bestScore) {
          bestScore = score;
          best = { x: wx, y: pos.y, z: wz };
        }
      }
    }
    return best;
  }
}
