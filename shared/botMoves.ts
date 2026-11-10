/**
 * botMoves — movement-hint intent for BotBrain: ski/jet/jump as the same
 * buttons a human presses. Committed jet windows (a player holds a burn,
 * not per-frame feathering), the Tribes hop read off the terrain probe,
 * and the anti-sheep momentum boost. Kept apart from destination logic
 * so "where to go" and "how to get there" each read on their own.
 */
import { botRand } from './botRand.ts';
import { GRAVITY, MOVEMENT_CONFIG } from './movement.ts';
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
  /** Glide-tap cooldown - downhill hops are bursts, not a burn. */
  private glideTapT = 0;
  /** Last gate that armed a burn — harness telemetry reads this to tell
   *  climbs apart from boosts without parsing behavior logs. */
  jetWhy = '-';
  /** Last computed jet bit — what actually reached the input layer. */
  jetOut = false;
  /** Set while the mount-perch holds for tank — statusIntent sheds
   *  drain skills so the refill can actually land (a shield-clamped
   *  tank oscillates at the sputter floor and the lip never mounts). */
  mountWait = false;
  /** Perched by design (breath refill or mount-staging) — the mobility
   *  watchdog must not read a deliberate stand-still as a pin. */
  get perched(): boolean { return this.breath || this.mountWait; }
  /** Catch-breath state: a climber with an empty tank perches on the
   *  face (walk key released, friction holds the slide) while the tank
   *  refills — staged climbing, the human ledge-rest. Without it the
   *  held forward input pushes him down the whole face each cycle and
   *  a ~70m wall reads as an absolute ceiling (katabatic moat). */
  private breath = false;
  /** Orbit-brake trackers — the best (smallest) objective distance
   *  reached since entering the watch ring, the best at the current
   *  window's start, and the window clock. Progress is measured against
   *  the best-yet mark, not the window's instantaneous start: a chaotic
   *  orbit swinging 5→80m fakes per-window "gain" every pass where a
   *  monotone progress bar trips the brake (katabatic: 40s of lapping
   *  the ring before the crawl finally armed). */
  private odBest = Infinity;
  private odWindowBest = Infinity;
  private odT = 0;
  /** One-shot brake demand from the closure-rate window; consumed the
   *  moment the bot reaches crawl speed. */
  private brakeNow = false;
  /** Recon-climb cooldown - free-roaming bots periodically buy altitude
   *  for no tactical reason (the human "pop up and look"). Staggered
   *  spawn offset keeps a squad from burning in sync. */
  private reconT = 4 + botRand() * 10;
  /** Live recon burn window - separate from jetWhy so a concurrent
   *  hop/boost reason can't hand the hold back to the dive veto. */
  private reconHoldT = 0;
  /** Short latch letting an apex-extension burn survive the diveRun
   *  veto - same role reconHoldT plays for recon climbs. */
  private apexHoldT = 0;
  /** Same latch for cruise burns - wander dests flatten to pos.y, so a
   *  cruising roamer always reads "dest below = dive" and diveRun would
   *  kill every ascend boost the tick after it arms. */
  private cruiseHoldT = 0;
  /** Burn-glide cycle: enforced no-discretionary-jet window after a
   *  committed burn ends on a free roamer. Chaos soak (_tools/_chaos3.ts)
   *  showed pulse-burn-then-glide beat scattered taps - the descent
   *  converts bought altitude to speed for free while the tank refills.
   *  Combat/mission burns (prey/block/runIn/tail/escape) bypass it. */
  private glideT = 0;
  /** Crawl latch — armed after a parked stop inside the grab ring;
   *  keeps the walk key but forbids ski/jet so a downhill stand can't
   *  re-spin the orbit the brake just killed. */
  private crawl = false;
  /** Tactical ski-release timer — brief friction tap before a steep hill
   *  at high speed, so the bot bleeds a little speed and slides over
   *  instead of slamming into the face. Tribes energy management:
   *  decel only when it costs less than the impact. (User insight:
   *  "decel is only used if you are about to overshoot a hill.") */
  private skiReleaseT = 0;
  holdFor(): number { return this.jetHold; }

  // oxlint-disable-next-line complexity -- a decision table the sweep history tunes as one surface
  hints(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BrainOut['move'] {
    this.mountWait = false;
    const dx = dest.x - pos.x, dz = dest.z - pos.z;
    const gd = Math.hypot(dx, dz);
    if (gd < 0.5) {return { ski: false, jet: false, jump: false };}
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
    const nx = dx / gd, nz = dz / gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    let rise = ctx.groundY(pos.x + nx * 6, pos.z + nz * 6) - g0;
    // The mount sense must read the GOAL LINE, not only the steerer's
    // step: a pinned bot's rim orbit feeds the memory trail and the
    // step deflects tangent, so a step-only probe never sees the lip —
    // mount gates stay dark and the orbit self-reinforces (soak: rim
    // pins with jet=-/off while the stand face was dead ahead). When
    // the objective crosses a face, that's the rise that matters.
    if (ctx.objective) {
      const odx = ctx.objective.x - pos.x, odz = ctx.objective.z - pos.z;
      const olen = Math.hypot(odx, odz);
      if (olen > 1) {
        const probeD = Math.min(6, olen);
        const riseGoal = ctx.groundY(pos.x + (odx / olen) * probeD, pos.z + (odz / olen) * probeD) - g0;
        if (riseGoal > rise) {rise = riseGoal;}
      }
    }
    const speed = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    const airborne = pos.y - g0 > 2;
    // Tactical ski-release (Tribes energy management): a carrier going
    // fast toward a steep rise releases ski briefly (friction tap) to
    // bleed a little speed and slide over the hill instead of slamming
    // into the face and losing more. Decel is a last resort, not a
    // general strategy — only arms when speed is high AND the grade is
    // steep, and only for ~0.15s before re-engaging ski.
    if (ctx.running && !airborne && rise > T.moves.skiVetoRise && speed > 25) {
      this.skiReleaseT = Math.max(this.skiReleaseT, 0.15);
    }
    this.skiReleaseT = Math.max(0, this.skiReleaseT - dt);
    // Altitude above the objective — hops and burns are cut while a
    // runner is overhead inside its glide window, because every one
    // balloons it past the touch ring (flagprobe: capper orbited dy
    // 8-21, planar 10-46, never touched).
    const dyAbove = ctx.objective ? pos.y - ctx.objective.y : -Infinity;
    const hopRing = Math.max(T.moves.runnerHopGd, dyAbove > 6 ? dyAbove * T.lines.diveGlideK : 0);
    // Capper grab-orbit brake: the flag touch ring is ~2.2m and a runner
    // arriving at 25+ m/s can't turn inside it — soaks show whole seconds
    // spent lapping the pole at 4-9m radius (katabatic). Track real od
    // progress: a clean fly-through keeps closing and never trips this;
    // a lap that stops tightening drops every input so ground friction
    // slides the skid onto the pole, then the walk-in earns the touch.
    // The watch ring is wider than the lap ring — an orbit swinging
    // 15-25m out reset odBest on every exit before (katabatic 9002:
    // 110s of 5-25m orbits), so the latch arms inside grabWatchGd.
    // `!ctx.running`: a carrier's objective is his OWN stand — lapping it
    // is not a grab orbit, and braking him 20-30m short of home dropped
    // flags on the doorstep (oasis s1: 90s parked at odHome 20-32).
    // Exception: a carrier stuck BELOW an elevated home stand is in the
    // same vertical orbit a runner gets on a tall enemy stand — crests
    // the rim, slides off, circles. The lap detector is the brake he
    // needs; a clean fly-through still never trips it. His lap radius is
    // wider than a grab orbit's (peaks: 40-90m under the stand), so the
    // ring widens for the below-flag case.
    // Carrier exception bounds: below the flag enough to prove he's in
    // the vertical orbit (-6), but not so far below that the stand face
    // is a cliff — past ~-25 the crawler can never mount it anyway and
    // beelining the wall is worse than letting the routed leg walk the
    // long way up (peaks carry: parked 30m under home burning 40E into
    // a 33m face, en 40→5, slide, repeat).
    const belowFlag = dyAbove < -6 && dyAbove > -25;
    const watchGd = ctx.running && belowFlag ? T.moves.grabWatchGd * 3 : T.moves.grabWatchGd;
    if (ctx.runner && (!ctx.running || belowFlag) && !ctx.posted && ctx.objective && od < watchGd) {
      if (od < this.odBest) {this.odBest = od;}
      // Each grabOrbitS window must close grabOrbitMinGain toward the
      // pole — an orbit that dips a little nearer each lap keeps making
      // "progress" forever otherwise (katabatic: 110s of improving-miss
      // laps), while a clean fly-through at 20m/s closes >5m/s easily.
      // Skipped while crawling: walk-speed closure is slower than the
      // window gain by design, and re-arming it would thrash park/walk.
      if (!this.crawl) {
        this.odT += dt;
        if (this.odT >= T.moves.grabOrbitS) {
          // A window that didn't set a NEW best by minGain is a lap —
          // equal-best dips don't count: they re-attest the same line.
          if (this.odWindowBest - this.odBest < T.moves.grabOrbitMinGain) {this.brakeNow = true;}
          this.odWindowBest = this.odBest; this.odT = 0;
        }
      }
      if (this.brakeNow) {
        if (spd0 > 1.5) {return { ski: false, jet: false, jump: false, park: true };}
        // Parked to a stop: switch to crawl — keep the walk key and
        // hops (dais stands need a jet hop to mount) but stay off the
        // skis, or the same downhill that made the orbit re-fires it.
        this.crawl = true;
        this.brakeNow = false;
      }
      // Parked to a stop OR still sliding along a hull face — hop the
      // lip either way (the deck lip is a free jump, the skirt pays a
      // tap). spd0<1 alone let a 4-15m/s wall-slide orbit the dais for
      // ~20s before a hop ever fired. The jet respects the same signed
      // ceiling as wantJet's runner veto — a crawler already overhead
      // falls to the flag on gravity, it doesn't thrust further past.
      // Hops are for MOUNTING, not the last meters: a jump arriving
      // with residual speed clears the whole 9m deck and lands past
      // the pole again (katabatic: 3-7m misses on every bounce). Close
      // in, feet on the boards.
      if (this.crawl) {
        // Same mount-wait as the hop branch: the crawl's raw jet flag
        // has no tank floor, so a dry crawler sputters against the lip
        // forever — park and bank a real tap first. The floor scales
        // with the gap: a 2m dais lip mounts on mountE, a CARRIER's flag
        // 20m+ overhead needs a breathHold burn or the crawl fizzles on
        // the face forever (peaks carrier: 60s parked 30m under home). A
        // runner stays on mountE — the deep-orbit sputter veto can't
        // bank 38 while the approach leg keeps spending (peaks grabber:
        // en oscillated 2-32 for 240s, mountCommit never fired).
        const mountFloor = dyAbove < -20 && ctx.running ? T.moves.breathHold : T.moves.mountE;
        if (rise > T.moves.stepJetRise && ctx.energy !== undefined && ctx.energy < mountFloor) {
          this.mountWait = true;
          return { ski: false, jet: false, jump: false, park: true };
        }
        return { ski: false, jet: pos.y - (ctx.objective?.y ?? -Infinity) <= 6, jump: od > T.moves.crawlHopGd && (spd0 < 1 || rise > T.moves.stepRise) };
      }
    // Hysteresis: the brake/crawl state resets only past the release
    // radius — an orbit swinging 35-80m out used to wipe the whole
    // detector every lap (odRef/odT/crawl all reset), so the watch
    // re-armed fresh on each dip back in and never accumulated the
    // stall it exists to catch.
    } else if (od > watchGd * 1.5) { this.odBest = Infinity; this.odWindowBest = Infinity; this.odT = 0; this.crawl = false; this.brakeNow = false; }
    // Only brake when the step actually heads at the pole — a mortar
    // sidestep is perpendicular and must keep its legs. Two rings:
    // fast arrivals brake wide to kill the overshoot-orbit; already
    // slow ones brake tight so the creep lands ON the pole — a single
    // wide ring parked him at 5-13m and flag% never passed the ring.
    const toward = ctx.objective && ((dest.x - pos.x) * (ctx.objective.x - pos.x) + (dest.z - pos.z) * (ctx.objective.z - pos.z)) > 0;
    const ring = spd0 > T.moves.parkSpeedSplit ? Math.min((ctx.posted ?? 0) + 1, T.moves.parkRingFast) : Math.min((ctx.posted ?? 0) + 1, T.moves.parkRingSlow);
    if (ctx.posted && !ctx.running && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
      return { ski: false, jet: false, jump: false, park: true };
    }
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
    // Wave members skipping the breath tried and reverted: same-seed
    // soak 9g/2c->8g/1c with hold collapsing — a perched member banks a
    // full tank and arrives strong; a burning one arrives dry and dies.
    if (!ctx.posted && !ctx.runner && ctx.energy !== undefined && !airborne && rise > T.moves.breathRise) {
      if (this.breath) {this.breath = ctx.energy < T.moves.breathHold;}
      else {this.breath = ctx.energy < T.moves.breathArm;}
      if (this.breath) { this.jetHold = 0; this.jetOut = false; return { ski: false, jet: false, jump: false, park: true }; }
    } else {this.breath = false;}
    // Jet respects the tank — below the reserve the bot saves energy for
    // skills rather than hovering dry at the wall. A runner's airborne
    // tap burns deeper: speed on a flat transit IS his skill reserve —
    // arrive fast and dry beats arrive slow and tanked.
    const odTap = ctx.objective ? Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z) : Infinity;
    const strikeTap = ctx.runner === true && odTap < T.moves.strikeGd;
    let tapFloor = T.moves.tankedMin;
    if (this.jetWhy === 'tap' || this.jetWhy === 'tail') {
      tapFloor = strikeTap ? T.moves.strikeTapMin : T.moves.tapEnergyMin;
    }
    // Sputter-lock veto: a runner orbiting BELOW an elevated flag on a
    // dry tank burns each regen trickle the moment it clears the lockout
    // — 8E sputters that never mount the face (peaks: 120s lapping the
    // stand at en 2-17). Inside the ring and below the pole the floor
    // jumps to a real mount budget, so the tank refills to one
    // committed climb instead of spending forever on fizzle-burns.
    if (ctx.runner === true && dyAbove < -6 && odTap < T.moves.destHighNear * 1.5) {
      tapFloor = Math.max(tapFloor, T.moves.breathHold);
    }
    // REVERTED: pressured carriers banking shieldReserve — same-seed
    // soak caps flat (13) but med hold fell 8.1->5.0s: slowing under
    // pursuit lets the chaser close sooner; speed IS the carrier's
    // defense, the banked shield rarely got to fire.
    const tanked = ctx.energy === undefined || ctx.energy > tapFloor;
    const mount = this.stepMount(ctx, { rise, speed, airborne, dyAbove, odTap, tanked,
      mountCommit: (ctx.runner === true || ctx.running === true) && dyAbove < -6 && odTap < T.moves.destHighNear * 1.5 && (ctx.energy ?? -1) >= T.moves.breathHold });
    if (mount) {return mount;}
    this.glideLatch(dt, ctx);
    // Tribes energy play: ski DOWNHILL for free speed, JET UPHILL so the
    // face doesn't eat momentum. A modest rise ahead while moving gets a
    // short tap - the mission gates above only arm on real climbs, this
    // covers the constant small-hill hopping humans never stop doing.
    if (!airborne && !ctx.posted && !ctx.runner && rise > 1.5 && rise < 8 && speed > 12 && this.glideTapT <= 0 && this.glideT <= 0
        && (ctx.energy === undefined || ctx.energy > T.moves.climbTapMinE)) {
      this.glideTapT = 2.5;
      this.jetHold = Math.max(this.jetHold, 0.35);
      this.jetWhy = 'climb-tap';
    }
    // Re-arm while the reason holds (a long climb = one long burn),
    // plus a minimum pulse so a gate flicker can't chop the burn.
    // glideT banks the post-burn rest; prey/block/runIn still arm.
    if (this.wantJet(ctx, pos, dest, { rise, speed, gd, airborne }) && tanked && (this.glideT <= 0 || this.jetWhy === 'prey' || this.jetWhy === 'block' || this.jetWhy === 'runIn')) {
      this.jetHold = Math.max(this.jetHold, T.moves.jetHoldBase + botRand() * T.moves.jetHoldRand);
    }
    this.reconTick(dt, ctx, pos, { g0, rise, airborne, tanked, speed });
    // Cruise (skill.airLove): the Tribes hangtime buy - a free roamer
    // ascending or on a shallow descent (vy > -4) burns to stay up:
    // ascent extends the climb, the shallow-descend burn is the glide
    // over the bowl that keeps altitude banked as ha instead of trading
    // it back to the slope. Steep descents never burn - gravity is
    // already paying, the dive/pump logic owns that leg.
    const al = ctx.airLove ?? 0;
    if (al > 0 && airborne && !ctx.posted && ctx.runner !== true && ctx.wave !== true && ctx.running !== true
        && (ctx.vel?.y ?? 0) > -4 && speed > T.moves.reconMinSpeed * (ctx.speedScale ?? 1)
        // Reserve discipline: cruise only arms off a healthy tank - a
        // bot that re-burns each regen trickle lives dry, and dry +
        // airborne is a target, not a dodger (evo: airLove carriers
        // halved eFill and died MORE). Burn a window, glide, refill.
        && (ctx.energy === undefined || ctx.energy > T.moves.climbTapMinE)
        && pos.y - g0 < T.moves.reconAglMax * (1 + al * 2)) {
      this.jetHold = Math.max(this.jetHold, T.moves.reconBurn * al);
      this.cruiseHoldT = Math.max(this.cruiseHoldT, T.moves.reconBurn * al);
      this.jetWhy = 'cruise';
    }
    this.reconHoldT = Math.max(0, this.reconHoldT - dt); this.apexHoldT = Math.max(0, this.apexHoldT - dt);
    this.cruiseHoldT = Math.max(0, this.cruiseHoldT - dt);
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
    // A tasked wave member is on the same clock — the flood's transit
    // IS the approach, and flat-map median speed was pinned at ~14m/s
    // (katabatic: d~480m near0% every soak) because members hop-chained
    // but never burned flat like the runner.
    const flatRun = (ctx.runner === true || ctx.wave === true) && drop < T.moves.flatRunDrop;
    // Dive only pays when altitude converts to speed: a falling route
    // (terrain ahead drops) or real overhead clearance. Over a flat
    // apron it was vetoing every burn while the bot hop-crawled at
    // 10-20m/s — the stand being 20m below isn't a dive, it's just
    // headroom (surreal plateau walk).
    const agl = pos.y - g0;
    const canDive = rise < -T.moves.boostRise || agl > T.moves.diveAglMin;
    const diveRun = gd < runway && tgtY < pos.y + T.moves.diveArriveMargin && canDive && this.jetWhy !== 'prey' && this.jetWhy !== 'block' && !flatRun;
    // A recon burn survives the dive read: it IS altitude bought on
    // purpose, and the skim-down that follows is the ski leg. Vetoing
    // it here meant roamers (usually descending - that's why they ski)
    // cancelled every climb before it started.
    if (diveRun && this.reconHoldT <= 0 && this.apexHoldT <= 0 && this.cruiseHoldT <= 0) {this.jetHold = 0;}
    // Tail-of-hop tap — the timing the standalone sweep measured: jetting
    // only the DESCENDING arc of each hop holds ~43m/s at ~1/10 the energy
    // per meter of a held burn (66m/s): every thrust tick lands as forward
    // speed with no ground friction, and the up-jet stretches the hop so
    // the next descent arrives sooner. JP's timing trick — gated on
    // moveSkill so skilled bots ride the hop while low-skill ones pay the
    // flat burn. Deliberately bypasses jetHold: a 0.7s min-pulse would
    // hold the burn through the landing it was meant to stop at.
    const vy = ctx.vel?.y ?? 0;
    const skilledHop = ctx.moveSkill === undefined || ctx.moveSkill >= T.moves.tailTapSkill;
    const enTap = ctx.energy === undefined || ctx.energy > (strikeTap ? T.moves.strikeTapMin : T.moves.tapEnergyMin);
    // `!travelDescent`: a tail tap over a falling surface buys airtime
    // the slope would have pumped — same veto the momentum hop gets.
    const tail = (ctx.runner === true || ctx.wave === true) && skilledHop && airborne && vy < 0 &&
      odTap > T.moves.boostGdMin && (ctx.objective?.y ?? dest.y) - pos.y < T.moves.runInRise &&
      speed < T.moves.tailTapSpeed && rise <= T.moves.boostRise && agl <= T.moves.ceilingAgl && enTap &&
      !this.travelDescent(ctx, pos, speed);
    if (tail) {this.jetWhy = 'tail';}
    // The hold latch and the escape ladder both bleed past the wantJet
    // veto: a burn armed outside the glide window keeps thrusting through
    // the touch ring (~20-30m of carry at approach speed), and the orbit
    // trap's own escape jets balloon the runner right back up — the trap
    // feeds the altitude that keeps it armed (flagprobe: capper sustained
    // dy 8-20, orbits forever). Same window, same cut for both.
    const fod = ctx.flagPos ? Math.hypot(pos.x - ctx.flagPos.x, pos.z - ctx.flagPos.z) : od;
    const inGlide = ctx.runner && dyAbove > 6 && fod < Math.max(T.moves.grabOrbitGd * 1.5, dyAbove * T.lines.diveGlideK);
    // Carrier landing commit: the home-stand touch is a ±6m vertical
    // window, and a carrier arriving overhead-high has no mechanism that
    // sheds altitude — the orbit brake is carrier-exempt (it once parked
    // him on the doorstep) and inGlide arms too late (dy*4 ≈ 130m) for a
    // 40m/s approach. Soak: carrier climbed to y=272 off escape/hop
    // burns, then blew 30m OVER a y=60 flag for 100+s. Overhead +
    // closing = every jet tick is a flyby — cut the burn early and let
    // the fall land him on the deck.
    const landDive = ctx.running === true && ctx.objective !== null && ctx.objective !== undefined
      && dyAbove > 8 && od < Math.max(140, dyAbove * T.lines.diveGlideK * 1.5);
    if (inGlide || landDive) {this.jetHold = 0;}
    // Escape burns bypass jetHold and never set jetWhy - name them or
    // duty telemetry reads a third of all thrust as reasonless ('-').
    const escJet = this.host.escapeJetT() > 0 && !inGlide;
    if (escJet && this.jetHold <= 0) {this.jetWhy = 'escape';}
    const jet = (!diveRun || this.reconHoldT > 0 || this.apexHoldT > 0 || this.cruiseHoldT > 0) && !landDive && (((this.jetHold > 0 || escJet) && tanked) || (tail && !inGlide));
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
      ski: !ctx.posted && !(rise > T.moves.skiVetoRise && speed < T.moves.skiVetoSpeed && !airborne) && !(ctx.running && this.skiReleaseT > 0),
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
      // Gate on `od` (distance to the objective), not `gd` — gd is the
      // ~8m steer step, so a gd gate is dead code and the hop chain
      // never fires (the 10-18m/s walk-in every soak autopsy blames).
      // …but NOT on a real descent: a hop is airtime the slope can't
      // pump — skiing only converts gravity while grounded, so a hop
      // chain over a downhill literally leaves free speed on the table
      // (kata carry probe: descents averaged 23m/s vs 29 on flats —
      // the bot was hopping over every pump). Humans hold ski and stay
      // glued; the hop is for flats and climbs.
      // The descent read also travels: the 6m steer probe reads
      // micro-bumps on a downslope as flat, so hops kept firing over
      // pumpable terrain (grabV stuck ~14-21). Probe 12m along the
      // VELOCITY line — if that drops, the surface under the slide is
      // falling away and the hop veto stands.
      // And no hop when the CURRENT ballistic arc already threads the
      // flag's ±6m vertical window - the hop just raises the arc over
      // the pole (broadside: a 53m/s pass overflew at dy=33, ungrabbable).
      // Strike-window deck glue: inside the run-in on flat ground the
      // hop chain is the only thing keeping the bot airborne - and the
      // feet blast needs <6m of dirt to pop. Grounded ski is frictionless
      // too, so gluing the runner costs no speed and opens the 2.2s
      // heel-blast cadence (the flat-stand path to ~40m/s entry speed).
      jump: (uphill && speed < T.moves.jumpUphillSpeed && !airborne)
        // Jump-first launch: any burn that arms on the deck pops the
        // jump edge first - the hop's free vy is what the jets then
        // multiply (jet-from-standing burns the same tank for half the
        // apex). Humans never burn without the launch.
        || (jet && !airborne)
        || (!ctx.posted && !airborne && speed > T.moves.hopSpeed * (ctx.speedScale ?? 1) && rise > -T.moves.hopDescRise && !this.arcThreadsFlag(ctx, pos, speed, od) && !(ctx.runner === true && od < T.moves.strikeGd && Math.abs(rise) < T.moves.stepRise)
          // Cruise chain (airLove): the relaunch. Pumpable descents veto
          // the hop for a speed-maxing bot - but an air-loving roamer's
          // hop isn't bought speed, it's the next climb's launch ramp.
          // Landing = immediately going back up.
          && ((al > 0 && ctx.runner !== true && ctx.wave !== true && ctx.running !== true) || !this.travelDescent(ctx, pos, speed))
          // Runners below cruise speed stay glued on near-flat ground:
          // ski contact is frictionless so a flat hop buys nothing, and
          // it pops the bot airborne where no grounded cruise burn can
          // fire — the hop chain itself is what pinned transit ~25m/s.
          && !((ctx.runner === true || ctx.wave === true) && speed < T.moves.cruiseSpeed && Math.abs(rise) < T.moves.hopRiseLo)
          && (od > T.moves.hopGdFar ? rise <= T.moves.hopRiseFar : od > hopRing)),
    };
  }

  /** Step mount: a face below climbRise (dais skirt 2.2m, deck lip
   *  0.85m, any collider top - the probe reads structures through
   *  ctx.groundY) still walls the walk key, and no climb ever arms
   *  for it. A stalled shove pays the free jump; the tap covers only
   *  what jump apex can't. Fires on stall, not on rise alone, so a
   *  moving walker keeps running through gentle grades.
   *  Posted anchors aren't exempt: a defender stalled against the stand
   *  lip has no other way back onto its post - the stall gates above
   *  already keep a freely-moving post planted (soak: four pinned
   *  anchors ringed around the henge dais, all posted, all rise~3.6m).
   *  Mount-commit: a runner/carrier below an elevated flag whose tank
   *  holds a real burn stops orbiting at speed (the stall-gate hop only
   *  arms near-stationary - a moving orbiter never mounts, peaks carry
   *  leg: 150s circling 15-25m under the stand) and burns the face now.
   *  Returns null when the gate doesn't fire so hints() continues. */
  private stepMount(ctx: BrainCtx, s: { rise: number; speed: number; airborne: boolean; dyAbove: number; odTap: number; tanked: boolean; mountCommit: boolean }): BrainOut['move'] | null {
    if (s.airborne || s.rise <= T.moves.stepRise) {return null;}
    if (s.speed >= T.moves.jumpUphillSpeed && !s.mountCommit) {return null;}
    this.jetWhy = 'hop';
    // A lip above jump apex but below breathRise has no perch - with a
    // dry tank the hop kept firing anyway and the bot rim-orbited the
    // dais forever (soak: HALO/MARA pinned at the henge stand). Hold
    // the shove while the tank refills to the hop's floor, then mount.
    if (s.rise > T.moves.stepJetRise && (ctx.energy ?? Infinity) < (s.dyAbove < -20 && ctx.running ? T.moves.breathHold : T.moves.mountE)) {
      this.mountWait = true;
      return { ski: false, jet: false, jump: false, park: true };
    }
    return { ski: false, jet: s.rise > T.moves.stepJetRise && s.tanked, jump: true };
  }

  /** Burn-glide bookkeeping: decay the holds, and when a free roamer's
   *  committed burn ends, bank the glide before any economy reason can
   *  re-arm on the same tick. Combat/mission burns never trigger it. */
  private glideLatch(dt: number, ctx: BrainCtx): void {
    const freeRoam = !ctx.posted && ctx.runner !== true && ctx.wave !== true && ctx.running !== true;
    const hadHold = this.jetHold > 0;
    this.jetHold = Math.max(0, this.jetHold - dt); this.glideTapT = Math.max(0, this.glideTapT - dt);
    this.glideT = Math.max(0, this.glideT - dt);
    if (hadHold && this.jetHold <= 0 && freeRoam
        && this.jetWhy !== 'prey' && this.jetWhy !== 'block' && this.jetWhy !== 'runIn' && this.jetWhy !== 'tail') {
      this.glideT = T.moves.glideTime;
    }
  }

  /** Recon climb: a free-roaming bot with a healthy tank periodically
   *  buys altitude - the human "pop up and look" that doubles as the
   *  AGL the HA column measures. Posted anchors and route-committed
   *  bodies (runner/wave/carrier) keep their own burn policy; hunting
   *  bots still climb - humans jet mid-fight constantly. diveRun/
   *  inGlide/landDive still veto the burn below.
   *  MPC phase rule (botMpcSearch solves on rimrock): the altitude buy
   *  belongs at the descent bottom, not mid-slope. Jetting while the
   *  ground drops spends the tank on height gravity was about to give
   *  free, and starts the climb slow instead of fast. rise < -boostRise
   *  is the same "terrain ahead drops" read canDive uses. */
  private reconTick(dt: number, ctx: BrainCtx, pos: BotVec, s: { g0: number; rise: number; airborne: boolean; tanked: boolean; speed: number }): void {
    this.reconT = Math.max(0, this.reconT - dt);
    // Burn-while-fast: past jetMaxFwdAccel the jet's forward share drops
    // out and the burn is pure lift - a recon lit at walking pace pays
    // the same 15E/s for a hover that converts to nothing (chaos _chaos3).
    if (this.reconT <= 0 && this.jetHold <= 0 && this.glideT <= 0 && !ctx.posted && ctx.runner !== true && ctx.wave !== true
        && ctx.running !== true && !s.airborne && !this.perched && s.tanked && s.rise > -T.moves.boostRise
        && s.speed > T.moves.reconMinSpeed
        && (ctx.energy === undefined || ctx.energy > T.moves.reconMinE)
        && pos.y - s.g0 < T.moves.reconAglMax * (1 + (ctx.airLove ?? 0))) {
      // airLove: climb sooner (shorter cooldown), burn longer, allow a
      // taller self-ceiling — the 50%HA chill style as one appetite dial.
      this.reconT = (T.moves.reconPeriod * (0.6 + botRand() * 0.8)) / (1 + (ctx.airLove ?? 0) * 2);
      this.jetHold = Math.max(this.jetHold, T.moves.reconBurn * (1 + (ctx.airLove ?? 0)));
      this.reconHoldT = T.moves.reconBurn * (1 + (ctx.airLove ?? 0));
      this.jetWhy = 'recon';
    }
  }

  /** True when the ground ~12m along the direction of travel falls away
   *  — the hop chain would leave descent-pump speed on the table. Uses
   *  velocity, not steer yaw: the surface under the slide is what pumps
   *  it, not where the bot wants to point. */
  private travelDescent(ctx: BrainCtx, pos: BotVec, speed: number): boolean {
    const v = ctx.vel;
    // Under ~15 m/s there is no pump to protect — a hop down the slope
    // is free airtime for a slow bot, and gluing him costs the carry.
    if (!v || speed < 15) {return false;}
    if (ctx.running) {return false;} // carrier: the lip hop at the
    // descent bottom IS the escape speed — gluing him rides the slope
    // into bad lines (sweep: carry 66→114s under a universal glue).
    const drop = ctx.groundY(pos.x, pos.z)
      - ctx.groundY(pos.x + (v.x / speed) * 12, pos.z + (v.z / speed) * 12);
    return drop > T.moves.hopDescRise * 2;
  }

  /** Apex jet: at the top of a jump, if the no-thrust arc won't reach the
   *  next peak (shallow angle, barely reachable), jet to extend the
   *  trajectory. Tribes: "jet just enough to reach the next hill" — a
   *  brief burn at the apex extends range so you land on the downslope
   *  and keep the descent pump. Also handles steering (lateral aim) by
   *  extending the arc when the destination is off-axis. */
  private apexNeedsJet(ctx: BrainCtx, pos: BotVec): boolean {
    const v = ctx.vel;
    if (!v || ctx.running) {return false;}
    // Don't jet at the apex when close to the objective — near the flag
    // you want to DESCEND into it, not jet up and sail over.
    if (ctx.objective) {
      const od = Math.hypot(ctx.objective.x - pos.x, ctx.objective.z - pos.z);
      if (od < 40) {return false;}
    }
    const vy = v.y ?? 0;
    // Apex = vertical velocity near zero (top of arc).
    if (vy > 2 || vy < -8) {return false;} // not at apex (rising or falling fast)
    const hSpeed = Math.hypot(v.x, v.z);
    if (hSpeed < 5) {return false;} // too slow to matter
    // Dead-reckon the no-thrust arc forward. If it hits ground before
    // reaching a downslope, we need jet to extend.
    const nx = v.x / hSpeed, nz = v.z / hSpeed;
    const dtS = 0.12, G = GRAVITY;
    let {x} = pos, {y} = pos, {z} = pos, vy_ = vy;
    let needsJet = false;
    for (let s = 0; s < 30; s += 1) {
      x += v.x * dtS; z += v.z * dtS;
      y += vy_ * dtS; vy_ += G * dtS;
      const g = ctx.groundY(x, z);
      const clearance = y - g;
      if (clearance <= 1.5) {
        // Touchdown. Check if the ground ahead is a descent (we can ski)
        // or a rise (we'd lose speed on impact).
        const ahead = ctx.groundY(x + nx * 6, z + nz * 6);
        if (ahead > g + 0.5) {
          // Rising ahead — slamming into a face. Need jet to extend arc
          // over the rise and land on the downslope.
          needsJet = true;
        }
        return needsJet;
      }
    }
    // Still airborne at 3.6s — arc is fine, no jet needed.
    return false;
  }

  /** True when the no-thrust arc reaches the objective's planar ring at
   *  a grabbable height (±6m matches the pickup's vertical cap) — a hop
   *  here is altitude the grab can't spend, so hold the arc. Runner
   *  approaches only; only while the arc can plausibly reach (od < 60m
   *  of ring time left). */
  private arcThreadsFlag(ctx: BrainCtx, pos: BotVec, speed: number, od: number): boolean {
    const v = ctx.vel;
    if (!ctx.runner || !ctx.objective || !v || od > 60 || speed < 1) {return false;}
    const tHit = od / speed;
    if (tHit > 3) {return false;}
    const yAt = pos.y + (v.y ?? 0) * tHit + 0.5 * GRAVITY * tHit * tHit;
    // Veto whenever the un-hopped arc already reaches the flag window
    // from below OR sails over it — a hop only adds altitude, which is
    // exactly what killed the dunes fast passes (40m/s arrival, hop
    // added vy≈13, sailed 15m over the pole into a slow orbit). Only
    // an arc landing clearly under the flag might hop up into it.
    return yAt > ctx.objective.y - 6;
  }

  /** Dead-reckon the no-thrust ballistic arc: march vel + gravity and
   *  watch clearance over the terrain. True when the arc reaches a
   *  downslope entry (skims ground where the surface falls away along
   *  travel) or stays airborne past the local crest — the free arc
   *  delivers the route, no burn required. False when the arc would
   *  smack a rising face first. ~30 groundY probes, called only while
   *  an altitude deficit is in play. */
  private arcClearsCrest(ctx: BrainCtx, pos: BotVec): boolean {
    const v = ctx.vel;
    if (!v) {return false;}
    const vx = v.x, vy = v.y ?? 0, vz = v.z;
    const hSpeed = Math.hypot(vx, vz);
    if (hSpeed < 4) {return false;} // no arc worth predicting — the climb sense owns this
    const nx = vx / hSpeed, nz = vz / hSpeed;
    const dtS = 0.12, G = GRAVITY; // same fall the sim sells — a dead-reckoned arc must pay world gravity
    let {x} = pos, {y} = pos, {z} = pos, vy_ = vy;
    for (let s = 0; s < 24; s += 1) {
      x += vx * dtS; z += vz * dtS;
      y += vy_ * dtS; vy_ += G * dtS;
      const g = ctx.groundY(x, z);
      const clearance = y - g;
      if (clearance <= 1.2) {
        // Touchdown on a rising face = the burn is needed, no matter
        // how high the arc hung earlier; a falling entry means the
        // descent skis free.
        const ahead = ctx.groundY(x + nx * 6, z + nz * 6);
        return ahead < g - 0.5;
      }
    }
    // Still airborne at ~3s: only counts as cleared if the far ground
    // sits at-or-below the start point — an arc still rising toward a
    // high face (e.g. mid-burn ascent) must not veto its own thrust.
    return ctx.groundY(x, z) < pos.y + 4;
  }

  /** Marginal-utility jet: march the no-thrust arc and the burn arc
   *  ~2s forward, compare terminal mechanical energy (½v²+g·h). A burn
   *  pays iff thrust leaves the bot richer than gliding — micro-taps,
   *  graze-landings, ascend-burns and band-holding all EMERGE from the
   *  inequality instead of being scripted behaviors. Only evaluated
   *  while airborne (deck climbs are terrain duty, priced elsewhere). */
  private burnPays(ctx: BrainCtx, pos: BotVec): boolean {
    const v = ctx.vel;
    if (!v) {return false;}
    const dtS = 0.12, G = -GRAVITY;
    // mass 1 = light/medium (heavies climb slower; ctx carries no mass —
    // a shared mass keeps the gate comparative, not absolute).
    const UP = MOVEMENT_CONFIG.jetForceUp, FWD = MOVEMENT_CONFIG.jetForceDir, CAP = MOVEMENT_CONFIG.jetMaxFwdAccel;
    const vx1 = v.x, vz1 = v.z;
    let x1 = pos.x, y1 = pos.y, z1 = pos.z, vy1 = v.y ?? 0;
    let x2 = x1, y2 = y1, z2 = z1, vx2 = vx1, vy2 = vy1, vz2 = vz1;
    let done1 = false, done2 = false, steps = 0;
    for (let s = 0; s < 18 && (!done1 || !done2); s += 1) {
      steps += 1;
      if (!done1) {
        x1 += vx1 * dtS; z1 += vz1 * dtS; y1 += vy1 * dtS; vy1 -= G * dtS;
        done1 = y1 - ctx.groundY(x1, z1) <= 1.2;
      }
      if (!done2) {
        const hv = Math.hypot(vx2, vz2);
        vy2 += (UP - G) * dtS;
        if (hv < CAP && hv > 0.01) {
          const nx = vx2 / hv, nz = vz2 / hv;
          vx2 += nx * FWD * dtS; vz2 += nz * FWD * dtS;
        }
        x2 += vx2 * dtS; z2 += vz2 * dtS; y2 += vy2 * dtS;
        done2 = y2 - ctx.groundY(x2, z2) <= 1.2;
      }
    }
    const mech = (vx: number, vy: number, vz: number, y: number, gx: number, gz: number): number =>
      0.5 * (vx * vx + vy * vy + vz * vz) + G * Math.max(0, y - ctx.groundY(gx, gz));
    return mech(vx2, vy2, vz2, y2, x2, z2) > mech(vx1, vy1, vz1, y1, x1, z1) * 1.05;
  }

  /** Whether the situation calls for a burn: genuine climbs, airborne
   *  prey, a high destination — or discretionary speed plays when the
   *  tank is comfortable. */
  // oxlint-disable-next-line complexity -- priced burn decision table; the gates are tuned as one priority-ordered surface
  private wantJet(ctx: BrainCtx, pos: BotVec, dest: BotVec, s: { rise: number; speed: number; gd: number; airborne: boolean }): boolean {
    const { rise, speed, gd, airborne } = s;
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
          if (!e.alive || !e.vel) {continue;}
          const ox = e.pos.x - obj.x, oz = e.pos.z - obj.z;
          const od = Math.hypot(ox, oz);
          if (od > T.moves.blockOd) {continue;}
          const closing = -(e.vel.x * ox + e.vel.z * oz) / (od || 1);
          if (closing < T.moves.blockClosing || od / closing > T.moves.blockEta) {continue;}
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
    // Strike-dive zones for a route-committed runner: the bank leg just
    // outside the defended band refills the tank for the dive, the
    // strike leg itself burns everything — arrival speed is the armor.
    const strike = ctx.runner === true && od < T.moves.strikeGd;
    const bank = ctx.runner === true && !strike && od < T.moves.strikeBankGd;
    // A runner already overhead inside the grab ring burns to go UP —
    // every hop/tap balloons it another 10-35m past the grab window
    // (broadside 9002: 4 minutes of orbits at dy -5..-36). Cutting
    // thrust lets gravity deliver the touch; below the objective the
    // mount still needs the burn, so the veto is signed, not absolute.
    // The ring is the whole glide window, not just the pole: at 25m/s
    // a bot 15m up needs ~20m of planar travel to land, so runIn/tap
    // fired out to 45m kept feeding speed into every overshoot
    // (flagprobe: capper orbited dy 8-21, planar 10-46, never touched).
    {
      // Measure the flag, not the aim point: `od` tracks the objective,
      // which a committed pass offsets up to ~35m past the pole — an
      // overhead bot read "far from objective" and kept burning
      // (broadside: runIn jets at od 8-27, dy 8-16, over the pole).
      const flagY = ctx.flagPos?.y ?? ctx.objective?.y ?? -Infinity;
      const fdx = ctx.flagPos ? pos.x - ctx.flagPos.x : 0;
      const fdz = ctx.flagPos ? pos.z - ctx.flagPos.z : 0;
      const fod = ctx.flagPos ? Math.hypot(fdx, fdz) : od;
      const dy = pos.y - flagY;
      if (ctx.runner && dy > 6 && fod < Math.max(T.moves.grabOrbitGd * 1.5, dy * T.lines.diveGlideK)) {
        this.jetWhy = '-';
        return false;
      }
    }
    const climbY = od < T.moves.destHighNear ? Math.max(dest.y, ctx.objective!.y) : dest.y;
    const destDeficit = climbY - pos.y;
    // Crest discipline: jets buy the lip, gravity skis the descent.
    // A dead-reckoned free arc that reaches a downslope entry needs
    // no altitude burn — only an arc smacking a rising face earns one.
    const destHigh = destDeficit > T.moves.destHighRise + Math.min(30, gd * 0.08)
      && !this.arcClearsCrest(ctx, pos);
    // Carve suppressor (hoisted for the ceiling check below): thrusting
    // into a turn brakes — jet facing runs at the steerer yaw, and
    // mid-turn that yaw opposes momentum.
    const vx = ctx.vel?.x ?? 0, vz = ctx.vel?.z ?? 0;
    const vSpd = Math.hypot(vx, vz);
    const tx = dest.x - pos.x, tz = dest.z - pos.z;
    const tl = Math.hypot(tx, tz) || 1;
    const turning = vSpd > 20 && (vx * tx + vz * tz) / (vSpd * tl) < -0.5;
    // Sky-bank: the TAS-found trick — past jetMaxFwdAccel a held jet adds
    // ZERO forward thrust but full +35 up, so a fast airborne runner
    // burning while it glides spends nothing horizontal and banks the
    // altitude as potential — the next descent converts it all back.
    // Needs real runway to convert (od), real speed to bank (vSpd), and
    // air under the arc (airborne). Jets up at low speed is ballooning.
    const skyBank = (ctx.runner === true || ctx.wave === true) && s.airborne &&
      !turning && vSpd >= T.moves.bankSpeed && od > T.moves.bankOdMin;
    // Hard ceiling: past ~30m AGL a held burn is ballooning, not skiing —
    // featherjets turned a shallow hop chain into a 250m balloon ride.
    // High prey still earns altitude; everything else glides back down.
    // A sky-banking runner is exempt by construction — the altitude IS
    // the purchase, not a byproduct of feathering.
    if (!targetHigh && !skyBank && pos.y - ctx.groundY(pos.x, pos.z) > T.moves.ceilingAgl) {return false;}
    // Discretionary spending asks for a healthier tank — boosting to
    // speed is nice-to-have, climbing out of a hole is not.
    const comfy = ctx.energy === undefined || ctx.energy > T.moves.comfyEnergy;
    // The Tribes hop: on gentle rises, ski through the approach and jet-
    // assist over the lip — the up-over-down rhythm that converts energy
    // into speed. A bot that only jets on cliffs never gets dynamic.
    const hop = rise > T.moves.hopRiseLo && rise <= T.moves.hopRiseHi;
    // Carve suppressor: thrusting into a turn brakes — jet facing runs
    // at the steerer yaw, and mid-turn that yaw opposes momentum. A
    // human carves (holds ski, turns, no thrust); the bot should too.
    // When fast with the destination behind, discretionary speed burns
    // stay off and the ski turn does the work.
    // The anti-sheep move: a bot at walking pace with ground to cover
    // jets to build momentum — but only flat-or-downhill from the
    // deck. Burn while facing uphill buys altitude, not speed (the
    // cap run showed a featherjets bot jetting 200m up on spawn);
    // burn already fast in the air just empties the tank.
    // `gd` here is the ~8m steer step — "ground to cover" has to read
    // the objective distance or the gate is dead code. No objective →
    // fall back to gd so wander steps still can't trip the burn.
    // Discretionary speed only spends the TOP of the tank — a boost
    // that drains to the reserve floor leaves the mid-route climbs
    // (which are not discretionary) with nothing.
    const boostTank = ctx.energy === undefined || ctx.energy > T.moves.boostEnergyMin;
    // Cruise burn (runners/wave, grounded only): the anti-sheep boost
    // stops at 12m/s, which left transit capped at hop-chain pace —
    // passV telemetry shows the capper never even passes the stand over
    // ~30m/s on any map. Ski contact is frictionless so the forward jet
    // converts straight into speed; airborne sustained jets were the
    // ballooning failure (grabV 50→13) — this only fires with dirt
    // under the skis, where thrust can't trade for altitude.
    const cruiseCap = (ctx.runner === true || ctx.wave === true) ? T.moves.cruiseSpeed : T.moves.boostSpeedMax;
    const boost = !turning && !bank && speed < cruiseCap && (ctx.objective ? od > T.moves.boostGdMin : gd > T.moves.boostGdMin) && boostTank && rise <= T.moves.boostRise && !airborne;
    // Transit burn REVERTED: airborne sustained jets balloon the hop
    // arcs (altitude, not speed — grabV 50→13, dunes 50→93s). Grounded-
    // only was dead code: the hop chain leaves no grounded flat ticks.
    // Flat-transit speed already comes from descent tail taps; the real
    // limiter mid-route is terrain supply, not jet policy.
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
    const runIn = !turning && (ctx.runner === true || ctx.wave === true) && od > T.moves.runInGdMin &&
      od < (strike ? T.moves.strikeGd : T.moves.runInGdMax) &&
      (ctx.objective?.y ?? dest.y) - pos.y < T.moves.runInRise && speed < T.moves.runInSpeed && (comfy || strike);
    // The featherjet: a route-committed runner or wave member on a
    // near-level transit whose tank sits below `comfy` still taps the
    // burn — AIRBORNE ONLY, so no ground friction eats the thrust and
    // every regen point lands as forward speed. This is the human
    // technique on a dead flat: without it the plateau walk is ~10-20m/s
    // of pure regen-bound walk (surreal autopsy: ~30s from the landing
    // to the grab ring). Wave members get the same wing — the flood's
    // whole point is arriving with the capper, and ~11m/s med transit
    // was the soak's near0% defect.
    // Arms on the descent only: the standalone sweep shows taps fired
    // on the rising arc spend the same tank for less speed (34 vs 43m/s
    // at delay 0 vs ~300ms) — the up-jet during a climb buys airtime
    // the flat route never converts. The hold latch still bleeds past
    // landing; this gate only picks when a burn can START.
    const tap = !turning && (ctx.runner === true || ctx.wave === true) && !bank && !comfy && airborne &&
      (ctx.vel?.y ?? 0) < 0 && od > T.moves.boostGdMin &&
      (ctx.objective?.y ?? dest.y) - pos.y < T.moves.runInRise && speed < T.moves.runInSpeed && rise <= T.moves.boostRise;
    // MPC transit finding (_tools/_mpctransit.ts, rimrock A/B): airborne
    // descent jets are load-bearing - banning them cost ~15-25% transit
    // speed and halved mean AGL. apexNeedsJet is the "reach the next
    // face" dead-reckon; runners get it below as a burn extender, but
    // roamers had NO airborne jet path at all. Give them the trigger -
    // carriers keep their own landing discipline, posted anchors never
    // reach this far.
    if (airborne && !turning && ctx.runner !== true && ctx.wave !== true && ctx.running !== true
        && ctx.energy !== undefined && ctx.energy > T.moves.mountE
        && this.apexNeedsJet(ctx, pos)) {
      this.jetWhy = 'apex';
      this.apexHoldT = T.moves.jetHoldBase + T.moves.jetHoldRand;
      return true;
    }
    // Sustained-climb deep-probe experiment REVERTED: jetting a slow
    // massif walk bought altitude that bled straight back — soak warns
    // rose both maps (katabatic 34→40, henge 17→24). The 6m lip probe
    // stays the climb sense.
    // Fuel-gauge pricing: a burn START is a purchase — below `mountE`
    // the tank holds less than one hop's worth, so a 2-8E climb or
    // destHigh burn is a sputter that buys no altitude. Banking (8/s
    // regen, ~2s to a full hop) is always the better move; mid-burn
    // latches ride the regen inflow past this floor.
    let why = '-';
    if (rise > T.moves.climbRise) {why = 'climb';}
    else if (targetHigh) {why = 'prey';}
    else if (destHigh) {why = 'destHigh';}
    else if (hop) {why = 'hop';}
    else if (skyBank) {why = 'skyBank';}
    else if (runIn) {why = 'runIn';}
    else if (tap) {why = 'tap';}
    else if (boost) {why = 'boost';}
    // Marginal-utility first principles: for non-committed bots the
    // arc math evaluates BEFORE the reason table — a burn arms whenever
    // thrust ends richer than gliding, regardless of which legacy gate
    // would've named it. Mission burns (climb/destHigh/prey) keep their
    // own pricing: a flag face is duty, not a trade. Reserve floor stays.
    if (why !== 'climb' && why !== 'destHigh' && why !== 'prey' && why !== 'block'
        && s.airborne && !ctx.runner && !ctx.wave && !ctx.running && !ctx.posted
        && (ctx.energy === undefined || ctx.energy > T.moves.climbTapMinE)
        && this.burnPays(ctx, pos)) { this.jetWhy = 'econ'; return true; }
    if (why === '-') {return false;}
    // Energy thrift (skill.thrift): the Tribes loop is jet-on-ascent,
    // never-on-descent — a burn while the slope is pumping buys energy
    // gravity gives free. Thrifty bots refuse discretionary burns
    // exactly on pumpable descents (the travelDescent probe): boost/
    // hop/runIn/tap all get refused; climbs, altitude purchases, and
    // combat/mission jets stay (skyBank is itself an altitude buy).
    // Deterministic draw per gate like the jetHold roll.
    if ((why === 'boost' || why === 'hop' || why === 'runIn' || why === 'tap')
        && botRand() < (ctx.thrift ?? 0) && this.travelDescent(ctx, pos, s.speed)) { this.jetWhy = '-'; return false; }
    // Bank leg owns the whole tank: outside the strike window only a real
    // climb (or a live prey chase) earns a burn. `boost`/`tap` were
    // vetoed here but the hop chain and `destHigh` kept spending the same
    // regen, so the strike leg opened at E≈2-13 and the run-in died on
    // the mountE floor 15m short (katabatic 9002: grabV 9.3). Refilling
    // costs ~2.4s of hops; it buys the entire run-in window.
    // skyBank exempt: at 45+ m/s the burn IS altitude banking — a fast
    // runner buys more arrival speed spending the tank on lift now than
    // arriving topped-up on a slow line.
    if (bank && !skyBank && why !== 'climb' && why !== 'prey') {return false;}
    // Strike-window discipline: inside the dive the tank exists for the
    // run-in forward burn. `tap`/`hop`/`destHigh` kept skimming the
    // regen mid-approach so the burn opened on ~10E (≈0.7s of thrust —
    // grabV stuck at 25-35). Only a real climb still spends — an
    // elevated flag face is the one thing forward thrust can't buy.
    if (strike && why !== 'runIn' && why !== 'climb' && why !== 'prey' && why !== 'skyBank') {return false;}
    // Apex jet (Tribes: "jet just enough to reach the next hill"): at the
    // top of a jump, if the no-thrust arc won't reach the next peak (shallow
    // angle, barely reachable), jet to extend the trajectory. Also handles
    // steering (lateral aim) by extending the arc when the destination is
    // off-axis. This is proactive jetting — looking ahead, not just
    // reacting to climbs.
    if (airborne && (ctx.vel?.y ?? 0) >= -2 && (ctx.vel?.y ?? 0) <= 2 &&
        ctx.energy !== undefined && ctx.energy > T.moves.tapEnergyMin &&
        this.apexNeedsJet(ctx, pos)) {
      this.jetWhy = 'apex';
      return true;
    }
    // The `mountE` start floor is load-bearing even inside the strike
    // window: letting the leg drain to `strikeTapMin` (2) was measured
    // WORSE on every axis (5 seeds × 3 maps: grabV 22.4→15.0, oasis
    // 22.4→8.7) — a capper who arrives with 2E cannot mount the dais and
    // crawls the last meters in. The deep tap floor only governs the
    // HOLD latch, which is what carries a burn across the floor.
    if (ctx.energy !== undefined && ctx.energy < T.moves.mountE) { this.jetWhy = '-'; return false; }
    this.jetWhy = why;
    return true;
  }
}
