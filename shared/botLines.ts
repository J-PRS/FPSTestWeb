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

  /** Convert the raw goal into a committed landing spot for the steerer. */
  plan(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    const gd = Math.hypot(dest.x - pos.x, dest.z - pos.z);
    this.lineT -= dt;
    // A leg that moved real altitude is worth remembering: the ramp
    // down is the ramp up in reverse, and only terrain the bot itself
    // crossed gets filed — no map knowledge it never earned.
    if (Math.abs(pos.y - this.lastY) > 12 && gd < this.lastGd + 60) {
      this.passes.push({ x: pos.x, y: pos.y, z: pos.z });
      if (this.passes.length > 8) this.passes.shift();
    }
    this.lastY = pos.y;
    if (gd < MIN_GD) { this.wp = null; this.lastGd = Infinity; this.stale = 0; this.traverseDir = null; return dest; }

    const wpD = this.wp ? Math.hypot(this.wp.x - pos.x, this.wp.z - pos.z) : Infinity;
    const drifted = this.wpGoal ? Math.hypot(dest.x - this.wpGoal.x, dest.z - this.wpGoal.z) > REDEST : true;
    if (this.wp && this.lineT > 0 && wpD > ARRIVE && !drifted) return this.wp;

    // Stagnation meter: a route that re-plans without closing ground is
    // in an orbit trap — on a massif the energy-play exemption keeps
    // picking lateral downhill pockets and the bot laps the contour at
    // fixed radius forever (soak: bravo capper orbited the stand at
    // ~750m for the whole match). Two dead rolls drop the exemption;
    // the third gives up on terrain scoring entirely and beelines —
    // humans grind the climb when carving stops paying. A pass the bot
    // has actually made before outranks another face probe.
    if (gd > this.lastGd - 8) this.stale++; else { this.stale = 0; this.traverseDir = null; }
    this.lastGd = gd;
    if (this.stale >= 3) {
      let bestPass: BotVec | null = null, bestPassD = 250;
      for (const pass of this.passes) {
        const pd = Math.hypot(pass.x - pos.x, pass.z - pos.z);
        // Count only passes on the goal side of the bot — one it already
        // crossed backward is another lap of the same trap.
        if (pd < bestPassD && Math.hypot(dest.x - pass.x, dest.z - pass.z) < gd) { bestPass = pass; bestPassD = pd; }
      }
      const reach = Math.min(40, gd);
      let wp = bestPass;
      if (!wp) {
        // Contour traverse: when the goal sits across an unclimbable
        // face, the way out is sideways — walk perpendicular to the
        // steepest uphill until a gentler grade appears in the fan.
        // Beeline only when the terrain around is already flat.
        const g0 = ctx.groundY(pos.x, pos.z);
        let ux = 0, uz = 0, up = 0;
        for (let i = 0; i < 8; i++) {
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
            const scoreT = (c: { x: number; z: number }) => {
              const climb = ctx.groundY(c.x, c.z) - g0;
              return (gd - Math.hypot(dest.x - c.x, dest.z - c.z))
                + Math.min(Math.max(0, climb), 12) * 2
                - Math.max(0, climb - 12) * 3
                - Math.max(0, -climb) * 2;
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
      this.wpGoal = { ...dest };
      this.lineT = COMMIT_S;
      this.stale = 0;
      return this.wp;
    }

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
    // Far goals get far eyes: capped at ~128m a runner facing a
    // massif-crossing leg can only probe the wall in front of it —
    // the saddle pass sits beyond reach, so every roll lands another
    // pocket on the same face (the bravo capper's match-long orbit).
    // At long range extend the probe to ~half the remaining leg so the
    // pass shows up in the fan at all.
    const reach = Math.min(gd, ctx.runner && gd > 300 ? Math.max(REACH * 2.2, gd * 0.45) : REACH * (ctx.runner ? 2.2 : 1));
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
        if (gained < d * 0.4 && (eScore <= 12 || this.stale >= 2)) continue;
        // Apex setup (last leg, runners only): a landing above the goal
        // banks altitude the dive converts back into arrival speed —
        // the flank-crest-and-drop that makes a flag run survivable.
        // Gated to the last leg so mid-route stays direct instead of
        // carving side-hills forever.
        const apex = ctx.runner && gd < 220 ? Math.min(40, Math.max(0, drops[p]! - dest.y)) * 0.8 : 0;
        const score =
          gained * 0.9 +                      // progress toward the goal
          drop * dropW +                      // downhill buys ski speed
          Math.min(0, drop + 4) * 1.8 +       // climbs past ~4m get taxed hard
          eScore +                            // banked E beats burning it (runners)
          apex +
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
