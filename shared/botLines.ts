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

const RAYS = 7;          // fan of candidate directions around the goal
const CONE = 1.4;        // rad — half-angle of the fan
const PTS = 4;           // probes per ray
const REACH = 58;        // m — farthest landing probe
const NEAR = 15;         // m — nearest landing probe
const COMMIT_S = 2.4;    // hold a line this long before re-planning
const ARRIVE = 6;        // m — closer than this counts as reached
const MIN_GD = 34;       // don't line-plan close work — steerer owns that
const REDEST = 22;       // m — goal drift that forces an early re-roll

export class BotLines {
  private wp: BotVec | null = null;
  private wpGoal: BotVec | null = null;
  private lineT = 0;

  /** Convert the raw goal into a committed landing spot for the steerer. */
  plan(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    const gd = Math.hypot(dest.x - pos.x, dest.z - pos.z);
    this.lineT -= dt;
    if (gd < MIN_GD) { this.wp = null; return dest; }

    const wpD = this.wp ? Math.hypot(this.wp.x - pos.x, this.wp.z - pos.z) : Infinity;
    const drifted = this.wpGoal ? Math.hypot(dest.x - this.wpGoal.x, dest.z - this.wpGoal.z) > REDEST : true;
    if (this.wp && this.lineT > 0 && wpD > ARRIVE && !drifted) return this.wp;

    this.wp = this.roll(ctx, pos, dest, gd);
    this.wpGoal = { ...dest };
    this.lineT = COMMIT_S;
    return this.wp ?? dest;
  }

  /** Fan the goal cone, profile each ray's terrain, keep the best run. */
  private roll(ctx: BrainCtx, pos: BotVec, dest: BotVec, gd: number): BotVec | null {
    const g0 = ctx.groundY(pos.x, pos.z);
    const gx = (dest.x - pos.x) / gd, gz = (dest.z - pos.z) / gd;
    // Runners read the terrain farther out: a 300m massif on the line
    // is invisible at normal reach, and skiing over it costs more than
    // the long way around.
    const reach = Math.min(REACH * (ctx.runner ? 2.2 : 1), gd);
    // Runners (carriers, cappers) get a wider fan and harder downhill
    // pull — a momentum run arcs around climbs rather than over them.
    const cone = CONE * (ctx.runner ? 2.0 : 1);
    const dropW = ctx.runner ? 2.0 : 1.4;
    const straightW = ctx.runner ? 4 : 8;
    // A runner's real currency is mechanical energy — ½v²+g·h totalled,
    // not the momentary speed. Landings priced above the bot's energy
    // budget can't be reached without spending on jets or slope work,
    // so lines that keep E banked score ahead of raw drop-chasing.
    const vNow = ctx.runner && ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.y, ctx.vel.z) : 0;
    const eNow = 0.5 * vNow * vNow + 28 * pos.y;

    let best: BotVec | null = null, bestScore = 0;
    for (let r = 0; r < RAYS; r++) {
      const a = (r / (RAYS - 1) - 0.5) * 2 * cone;
      const dx = gx * Math.cos(a) - gz * Math.sin(a);
      const dz = gx * Math.sin(a) + gz * Math.cos(a);

      // Terrain profile along the ray — the run's shape decides its
      // worth, not just where it lands.
      let earlyClimb = 0;
      let prevG = g0, prevD = 0;
      const drops: number[] = [];
      for (let p = 1; p <= PTS; p++) {
        const d = NEAR + ((reach - NEAR) * p) / PTS;
        const g = ctx.groundY(pos.x + dx * d, pos.z + dz * d);
        const seg = (g - prevG) / (d - prevD);
        if (prevD < NEAR && seg > earlyClimb) earlyClimb = seg;
        drops.push(g);
        prevG = g; prevD = d;
      }
      const sheer = Math.min(...drops.map((g, i) => g - (i ? drops[i - 1]! : g0)));
      if (sheer < -16) continue; // cliff face — don't route bots off sheers

      // Best landing on this ray: the deepest pocket that still gains
      // on the goal. Downhill pockets buy speed; the goal term keeps
      // the run pointed at the objective.
      for (let p = 0; p < PTS; p++) {
        const d = NEAR + ((reach - NEAR) * (p + 1)) / PTS;
        const wx = pos.x + dx * d, wz = pos.z + dz * d;
        const gained = gd - Math.hypot(dest.x - wx, dest.z - wz);
        const drop = g0 - drops[p]!;
        // Energy-conserving endpoint: the landing's E is the launch E
        // shifted between kinetic and potential — a landing priced
        // above what E affords reads as spent, keeping the run inside
        // its real budget instead of over-climbing.
        const vEndSq = vNow * vNow + 56 * (pos.y - drops[p]!);
        const eScore = ctx.runner ? (28 * drops[p]! + 0.5 * Math.max(0, vEndSq) - eNow) * 0.2 : 0;
        // Progress floor: a run has to close a real share of its own
        // travel toward the goal — unless it's an energy play, banking
        // speed off a side valley to convert later (that's a legit ski
        // setup, not a loop). Without the floor a deep side valley
        // always outscores the route and the bot orbits midfield
        // forever (soak: align=0.00, prog=0).
        if (gained < d * 0.4 && eScore <= 12) continue;
        const score =
          gained * 0.9 +                      // progress toward the goal
          drop * dropW +                      // downhill buys ski speed
          Math.min(0, drop + 4) * 1.8 +       // climbs past ~4m get taxed hard
          eScore +                            // banked E beats burning it (runners)
          (p === PTS - 1 ? 3 : 0) -           // prefer committing long when tied
          earlyClimb * 26 -                   // a climb in the first stretch kills the run
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
