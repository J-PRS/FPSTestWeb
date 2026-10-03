/**
 * botMoves — movement-hint intent for BotBrain: ski/jet/jump as the same
 * buttons a human presses. Committed jet windows (a player holds a burn,
 * not per-frame feathering), the Tribes hop read off the terrain probe,
 * and the anti-sheep momentum boost. Kept apart from destination logic
 * so "where to go" and "how to get there" each read on their own.
 */
import { botRand } from './botRand.ts';
import { BOT_TUNING as T } from './botTuning.ts';
import type { BotVec, BrainCtx, BrainOut } from './botBrain.ts';

export interface MovesHost {
  /** Escape burst arming — a stuck bot thrusts up and over the pocket. */
  escapeJetT(): number;
  /** Active hunt target, for the airborne-prey jet read. */
  huntPos(): BotVec | null;
}

export class BotMoves {
  constructor(private host: MovesHost) {}

  /** Committed jet window — a player holds RMB for a real burn
   *  (~0.5-1s), not per-frame feathering. Without the latch the slope
   *  probes flicker mid-climb and the jet strobes on/off, which reads
   *  as buzzing instead of thrusting. */
  private jetHold = 0;
  /** Last gate that armed a burn — harness telemetry reads this to tell
   *  climbs apart from boosts without parsing behavior logs. */
  jetWhy = '-';
  /** Last computed jet bit — what actually reached the input layer. */
  jetOut = false;
  /** Catch-breath state: a climber with an empty tank perches on the
   *  face (walk key released, friction holds the slide) while the tank
   *  refills — staged climbing, the human ledge-rest. Without it the
   *  held forward input pushes him down the whole face each cycle and
   *  a ~70m wall reads as an absolute ceiling (katabatic moat). */
  private breath = false;
  holdFor(): number { return this.jetHold; }

  hints(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BrainOut['move'] {
    const dx = dest.x - pos.x, dz = dest.z - pos.z;
    const gd = Math.hypot(dx, dz);
    if (gd < 0.5) return { ski: false, jet: false, jump: false };
    const spd0 = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    // The parking brake: a posted anchor that arrives at stand speed
    // overshoots the pole by 10-20m and orbits it forever — soaks read
    // ~3% inside the flag hitbox while hovering the 15m ring. The brake
    // window is the stopping distance (friction ~50m/s² with margin)
    // so the slide lands him ON the pole, not in an orbit around it.
    // `park` releases the walk key too — forward input would override
    // friction and keep the orbit alive.
    // Measure against the objective, not the step dest — the dest is a
    // ~8m steer step so gd is always small and a radius on it brakes
    // mid-route. The base ring covers the ~10-14m orbit an overshooting
    // anchor falls into; v²/60 adds the slide distance to the pole.
    const od = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : gd;
    // Only brake when the step actually heads at the pole — a mortar
    // sidestep is perpendicular and must keep its legs. Two rings:
    // fast arrivals brake wide to kill the overshoot-orbit; already
    // slow ones brake tight so the creep lands ON the pole — a single
    // wide ring parked him at 5-13m and flag% never passed the ring.
    const toward = ctx.objective && ((dest.x - pos.x) * (ctx.objective.x - pos.x) + (dest.z - pos.z) * (ctx.objective.z - pos.z)) > 0;
    const ring = spd0 > T.moves.parkSpeedSplit ? Math.min((ctx.posted ?? 0) + 1, T.moves.parkRingFast) : Math.min((ctx.posted ?? 0) + 1, T.moves.parkRingSlow);
    if (ctx.posted && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
      return { ski: false, jet: false, jump: false, park: true };
    }
    const nx = dx / gd, nz = dz / gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    const rise = ctx.groundY(pos.x + nx * 6, pos.z + nz * 6) - g0;
    const speed = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    const airborne = pos.y - g0 > 2;
    // Jet when the way ahead climbs faster than running covers — or the
    // hunt target is clearly airborne and pursuit needs altitude.
    const uphill = rise > T.moves.climbRise;
    // Catch breath mid-face: tank dry on a steep uphill → stand the wall
    // (park releases the walk key so ground
    // friction fights the slide instead of pushing downhill) until the
    // tank refills, then burn again. Each cycle banks net altitude.
    // Gate on the face, not the target: a moat wall sits between the bot
    // and a goal that's downhill of the crest — altitude-of-goal would
    // never arm the perch.
    // Runners don't perch — the breath gate exists to stage a climb,
    // and a runner arriving on an apron rise isn't climbing, he's
    // arriving. Parking him 25m out is a free pick for the ring.
    if (!ctx.posted && !ctx.runner && ctx.energy !== undefined && !airborne && rise > T.moves.breathRise) {
      if (this.breath) this.breath = ctx.energy < T.moves.breathHold;
      else this.breath = ctx.energy < T.moves.breathArm;
      if (this.breath) { this.jetHold = 0; this.jetOut = false; return { ski: false, jet: false, jump: false, park: true }; }
    } else this.breath = false;
    // Jet respects the tank — below the reserve the bot saves energy for
    // skills rather than hovering dry at the wall.
    const tanked = ctx.energy === undefined || ctx.energy > T.moves.tankedMin;
    this.jetHold = Math.max(0, this.jetHold - dt);
    // Re-arm while the reason holds (a long climb = one long burn),
    // plus a minimum pulse so a gate flicker can't chop the burn.
    if (this.wantJet(ctx, pos, dest, rise, speed, gd, airborne) && tanked) {
      this.jetHold = Math.max(this.jetHold, T.moves.jetHoldBase + botRand() * T.moves.jetHoldRand);
    }
    // The dive: a destination at or below the bot wants gravity, not
    // thrust — a capper jets to the stand's zip code, then lets
    // momentum carry the touch. The runway scales with what has to
    // happen before arrival: altitude to shed (~2m runway per meter of
    // drop on a steep ski line) plus a beat of speed — at 40m/s a flat
    // 45m window is ~1s, not enough to fall 40m, which is exactly the
    // overfly the katabatic bravo stand showed (bots orbiting 30-90m
    // over a deck-level flag).
    // A prey burn survives the dive read: chasing something airborne
    // needs altitude even when the current destination sits below.
    // Altitude reads the route, not the step: every pipeline stage
    // flattens the step's y to pos.y, so judging off `dest` declares
    // every route "downhill" and diveRun vetoes all jetting forever —
    // bots could never climb, only the escape burst fired (soak: bots
    // orbiting under a 50m plateau rim). The objective carries truth.
    const tgtY = Math.max(dest.y, ctx.objective?.y ?? -Infinity);
    const drop = pos.y - tgtY;
    const runway = T.moves.runwayBase + Math.max(0, drop) * T.moves.runwayDropK + speed * T.moves.runwaySpeedK;
    // A level stand isn't a dive — gravity buys nothing across the flat
    // apron, which is exactly where soaks show pushes bleeding to
    // ~10-14m/s and dying in the ring. A runner keeps the burn on a
    // flat approach: thrust is the only accelerator left out there.
    const flatRun = ctx.runner === true && drop < T.moves.flatRunDrop;
    const diveRun = gd < runway && tgtY < pos.y + T.moves.diveArriveMargin && this.jetWhy !== 'prey' && this.jetWhy !== 'block' && !flatRun;
    if (diveRun) this.jetHold = 0;
    const jet = !diveRun && (this.jetHold > 0 || this.host.escapeJetT() > 0) && tanked;
    this.jetOut = jet;
    return {
      // Tribes default: ski is held whenever the bot has somewhere to
      // be. Momentum is life — a bot that only skis downhill reads as a
      // pedestrian, which is exactly the sheep behavior the watchdog
      // now flags. Friction/jets sort out the uphill cost.
      // Posted anchors are the exception with feet on the flag: a hop
      // or blast that lands them on the stand's ridge face turns ski
      // into a 250m downhill slide the walk key can't out-argue (soak:
      // 16 straight seconds at 15m/s away from the pole), so their
      // boots stay planted and ground friction owns every landing.
      // Steep climbs too: ski is frictionless, so a bot that skis UP a
      // ridge it can't jet over slides back down and re-climbs forever
      // (soak: capper Sisyphus-orbit cycling y45→81→45 for a match).
      // Humans let go of ski on a steep grade and walk-hop-jet it.
      ski: !ctx.posted && !(rise > T.moves.skiVetoRise && speed < T.moves.skiVetoSpeed && !airborne),
      jet,
      // Uphill + near-stationary = hop it; autohop chains the rest.
      // The momentum hop is the second case: held space while skiing
      // keeps the run airborne and frictionless — without it a bot's
      // ceiling is ~12m/s of slide speed while a human hop-chains
      // down the route at 30+ (soak: pushes arrived at ~15m/s and
      // died inside the ring; speed IS the capper's armor).
      // The gd floor exists so a walker doesn't hop past its goal —
      // but for a runner the overshoot IS the play: a capper flies
      // through the flag and grabs on the way past, then turns
      // around outside the ring. Dropping the hop at 60m read as a
      // decelerated 10m/s walk-in that fed every defender (soak:
      // pushes arrived @10-18m/s, died inside the ring in ~6s).
      jump: (uphill && speed < T.moves.jumpUphillSpeed && !airborne)
        || (!ctx.posted && !airborne && speed > T.moves.hopSpeed && (gd > T.moves.hopGdFar ? rise <= T.moves.hopRiseFar : (ctx.runner && gd > T.moves.runnerHopGd))),
    };
  }

  /** Whether the situation calls for a burn: genuine climbs, airborne
   *  prey, a high destination — or discretionary speed plays when the
   *  tank is comfortable. */
  private wantJet(ctx: BrainCtx, pos: BotVec, dest: BotVec, rise: number, speed: number, gd: number, airborne: boolean): boolean {
    // Posted anchors burn only to climb back onto the post — every
    // discretionary burn (boost to speed, hop, airborne-prey chase) is
    // altitude+momentum off the stand, and the chase is the gun's job.
    // The one exception is the bodyblock hop: a stand touch is a sphere
    // check, so a runner skimming in at head height sails clean over a
    // planted heavy's feet. Meet the flyer — the T2 HoF answer is a
    // timed pop into his lane the beat before he crosses.
    if (ctx.posted) {
      const obj = ctx.objective;
      const selfD = obj ? Math.hypot(obj.x - pos.x, obj.z - pos.z) : Infinity;
      if (obj && selfD < T.moves.blockSelfD && ctx.enemies) {
        for (const e of ctx.enemies) {
          if (!e.alive || !e.vel) continue;
          const ox = e.pos.x - obj.x, oz = e.pos.z - obj.z;
          const od = Math.hypot(ox, oz);
          if (od > T.moves.blockOd) continue;
          const closing = -(e.vel.x * ox + e.vel.z * oz) / (od || 1);
          if (closing < T.moves.blockClosing || od / closing > T.moves.blockEta) continue;
          this.jetWhy = 'block';
          return true;
        }
      }
      this.jetWhy = rise > T.moves.climbRise ? 'climb' : '-';
      return rise > T.moves.climbRise;
    }
    // Prey burns are for hunters — a route-committed bot that chases
    // airborne foes spends its whole tank off-mission (cap-stall
    // autopsy: runners arriving en≈0 after prey burns, grabE~22 at
    // the touch). Fire on them, don't fly after them.
    const targetHigh = !ctx.runner && !ctx.wave &&
      (this.host.huntPos()?.y ?? -Infinity) - pos.y > T.moves.preyRise;
    // The objective only enters the deficit inside its climb window —
    // far out it was treating "the stand is 20m up" as needing a burn
    // while still 250m away on a plateau, re-arming on every dip and
    // arriving at the stand with E≈100 (surreal autopsy). Inside the
    // window the climb is real; outside it, only the immediate waypoint
    // rise matters, and even that needs a deficit that grows with
    // remaining range so a far wall earns jets but a dip doesn't.
    const od = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : Infinity;
    const climbY = od < T.moves.destHighNear ? Math.max(dest.y, ctx.objective!.y) : dest.y;
    const destDeficit = climbY - pos.y;
    const destHigh = destDeficit > T.moves.destHighRise + Math.min(30, gd * 0.08);
    // Hard ceiling: past ~30m AGL a held burn is ballooning, not skiing —
    // featherjets turned a shallow hop chain into a 250m balloon ride.
    // High prey still earns altitude; everything else glides back down.
    if (!targetHigh && pos.y - ctx.groundY(pos.x, pos.z) > T.moves.ceilingAgl) return false;
    // Discretionary spending asks for a healthier tank — boosting to
    // speed is nice-to-have, climbing out of a hole is not.
    const comfy = ctx.energy === undefined || ctx.energy > T.moves.comfyEnergy;
    // The Tribes hop: on gentle rises, ski through the approach and jet-
    // assist over the lip — the up-over-down rhythm that converts energy
    // into speed. A bot that only jets on cliffs never gets dynamic.
    const hop = rise > T.moves.hopRiseLo && rise <= T.moves.hopRiseHi;
    // The anti-sheep move: a bot at walking pace with ground to cover
    // jets to build momentum — but only flat-or-downhill from the
    // deck. Burn while facing uphill buys altitude, not speed (the
    // cap run showed a featherjets bot jetting 200m up on spawn);
    // burn already fast in the air just empties the tank.
    const boost = speed < T.moves.boostSpeedMax && gd > T.moves.boostGdMin && comfy && rise <= T.moves.boostRise && !airborne;
    // Run-in burn: a committed runner closing on a near-level objective
    // keeps thrusting to ~26m/s — the human play is arriving through
    // the flag at speed, not floating in at hop-chain pace. Jets add
    // forward thrust too, so the burn buys real m/s on the flat.
    // Airborne is fine — the hop chain spends most of the approach off
    // the deck, and dir thrust buys speed mid-hop too (the AGL ceiling
    // above already vetoes a burn that would balloon).
    // Wave members too: the flood transits at hop-chain pace (~12m/s)
    // while its capper now burns at ~20 — escorts and push bodies have
    // to arrive inside the same window or there is no wave. Marshal
    // staging never trips it: the 110m orbit sits past the gd window.
    const runIn = (ctx.runner === true || ctx.wave === true) && gd > T.moves.runInGdMin && gd < T.moves.runInGdMax &&
      (ctx.objective?.y ?? dest.y) - pos.y < T.moves.runInRise && speed < T.moves.runInSpeed && comfy;
    this.jetWhy = rise > T.moves.climbRise ? 'climb' : targetHigh ? 'prey' : destHigh ? 'destHigh' : hop ? 'hop' : runIn ? 'runIn' : boost ? 'boost' : '-';
    return this.jetWhy !== '-';
  }
}
