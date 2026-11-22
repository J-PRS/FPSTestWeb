/*
 * BotEntry - the approach-election half of BotRouting: descent-head
 * scanning, committed presses, and the candidate scoring/election that
 * picks a ring entry, flow saddle, or ski-run head. Owns nothing -
 * reads the routing state (holds, graveyard, pass commits, the shared
 * TerrainFlow) through the BotRouting it was minted with.
 */
import { hmHeight } from '../../shared/heightfield.ts';
import { dist3, type BotVec } from '../../shared/botVec.ts';
import { simNow } from './simClock.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { TeamId } from '../../shared/teams.ts';
import type { Vec3 } from './types.ts';
import type { BotRouting } from './botRouting.ts';

/** Meters past the flag a capper aims on the committed run - the
 *  pass-through aim that makes the approach wrap to the home-side
 *  exit instead of beeline-and-stop. */
const PASS_M = 40;

/** Shared context for the entry-routing helpers extracted out of
 *  flagGoal - one bag so the per-think fields ride together. */
export interface EntryCtx {
  p: { id: string; team?: string; position: Vec3 };
  enemyStand: Vec3;
  enemyFlagY: number;
  dStand: number;
  capper: boolean;
  waveTask: boolean;
  laneBlocked: boolean;
  foes: { x: number; z: number }[];
  me: TeamId;
}

export class BotEntry {
  constructor(private readonly rt: BotRouting) {}

  /** Walk a ray outward from `stand` while the ground keeps rising -
   *  the endpoint is the head of a contiguous descent into the stand,
   *  i.e. a ski run a capper can convert to grab speed. Small flats are
   *  forgiven (bumps on a real descent); two consecutive non-rising
   *  steps end the run. Returns null for run-ins under 60m - too short
   *  to build speed on. */
  runInHead(stand: BotVec, ang: number): BotVec | null {
    if (!this.rt.field) {return null;}
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let lx = stand.x, lz = stand.z, lh = stand.y;
    let flats = 0;
    for (let s = 0; s < 20; s += 1) {
      const nx = lx + ca * 15, nz = lz + sa * 15;
      const nh = hmHeight(this.rt.field, nx, nz);
      if (nh > lh + 0.5) { flats = 0; lh = nh; }
      else { flats += 1; if (flats >= 2) { break; } }
      lx = nx; lz = nz;
    }
    return Math.hypot(lx - stand.x, lz - stand.z) >= 60 ? { x: lx, y: lh, z: lz } : null;
  }

  /** Descent-head sense: scan ±4 bearings off the direct line for the
   *  tallest crest within 250m and elect the run-in head whose
   *  integrated arrival speed beats going straight. */
  headScan(p: { id: string; position: Vec3 }, enemyStand: Vec3, dStand: number, foes: { x: number; z: number }[], me: TeamId): BotVec | null {
    // One drive, one currency: projected arrival speed at the stand.
    // Each candidate is a two-seg route pos→via→stand integrated as
    // a point mass on the terrain profile - descents convert 2g·dh
    // to speed, climbs bleed it, the tank buys back a transit floor
    // where the leg starves (jets cap out near 50 anyway), seconds
    // of extra leg cost a flat tax. Affordability, basin traps and
    // apron climb-backs are not separate gates: a crest you reach
    // at v≈4 doesn't buy its dive back fast enough to beat going
    // straight - it just scores low.
    const vel0 = this.rt.room.players.getPlayer(p.id)?.velocity;
    const v0 = vel0 ? Math.max(6, Math.hypot(vel0.x, vel0.z)) : 6;
    const tank0 = this.rt.room.moveSim.energyOf(p.id) ?? 30;
    const cols = this.rt.room.ballSim.colliders;
    const cIdx = this.rt.room.ballSim.colliderIndex ?? undefined;
    const scoreLeg = (vx2: number, vz2: number): number => {
      let v = v0, e = tank0, time = 0, hPrev = p.position.y;
      const pts: [number, number][] = [[p.position.x, p.position.z], [vx2, vz2], [enemyStand.x, enemyStand.z]];
      for (let l = 1; l < pts.length; l += 1) {
        const a2 = pts[l - 1]!, b2 = pts[l]!;
        const len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        const steps = Math.max(2, Math.ceil(len / 20));
        const ds = len / steps;
        for (let s = 1; s <= steps; s += 1) {
          const h = hmHeight(this.rt.field!, a2[0] + (b2[0] - a2[0]) * (s / steps), a2[1] + (b2[1] - a2[1]) * (s / steps));
          v = Math.sqrt(Math.max(16, v * v + 56 * (hPrev - h)));
          v = Math.max(4, v - ds * 0.06);      // ski drag per meter, tuned to hold ~40 transit
          time += ds / Math.max(v, 8);
          if (e > 4 && v < 50) {const dv = Math.min(10 * ds / Math.max(v, 8), 50 - v); v += dv; e -= dv * 1.5;}
          hPrev = h;
        }
      }
      return v - time * 0.15;
    };
    const direct = scoreLeg(enemyStand.x, enemyStand.z);
    const baseA = Math.atan2(p.position.z - enemyStand.z, p.position.x - enemyStand.x);
    const body = { x: p.position.x, y: p.position.y + 1, z: p.position.z };
    let bestScore = direct + 3;
    let headGoal: BotVec | null = null;
    for (let o = -4; o <= 4; o += 1) {
      const a = baseA + o * 0.22;
      const bx = Math.cos(a), bz = Math.sin(a);
      const crest = this.crestOf(enemyStand, bx, bz);
      if (crest === null) {continue;}
      const {d: crestD, h: crestH} = crest;
      // A near-aligned crest BEYOND the bot is the run it is
      // already inside - electing it routes him back uphill.
      if (Math.abs(o) <= 1 && crestD > dStand) {continue;}
      const hx = enemyStand.x + bx * crestD, hz = enemyStand.z + bz * crestD;
      // Terrain probes are blind to walls - a head behind a
      // compound face is no run-in.
      if (cols.length > 0 && segSolidHit(body, { x: hx, y: crestH + 1, z: hz }, cols, cIdx, me)) {continue;}
      // Foe tax: the crest is also the stage zone - a head inside
      // the enemy blob is a run through the kill zone (matchSim:
      // every lone transit died mid-field). Live foe positions
      // are on the wire; a human reads the same board.
      let foesNear = 0;
      for (const fp of foes) {if (Math.hypot(fp.x - hx, fp.z - hz) < 90) {foesNear += 1;}}
      const score = scoreLeg(hx, hz) - foesNear * 8;
      if (score > bestScore) { bestScore = score; headGoal = { x: hx, y: crestH + 1, z: hz }; this.rt.headHold.set(p.id, { pos: headGoal, standD: crestD, at: simNow() }); }
    }
    return headGoal;
  }

  /** The crest is the TALLEST ground within 250m on a bearing - a
   *  stand-side apron dip doesn't end the search. Null when nothing
   *  tall enough/close enough rises. */
  crestOf(enemyStand: Vec3, bx: number, bz: number): { d: number; h: number } | null {
    let crestD = 0, crestH = -Infinity;
    for (let t = 10; t <= 250; t += 10) {
      const lh = hmHeight(this.rt.field!, enemyStand.x + bx * t, enemyStand.z + bz * t);
      if (lh > crestH) { crestH = lh; crestD = t; }
    }
    return crestD < 40 || crestH - enemyStand.y < 8 ? null : { d: crestD, h: crestH };
  }

  /** Entry routing for an approach with no live incumbent: press the
   *  straight line when it's actually open (or the run is committed),
   *  otherwise score the ring/flow/run-in candidates and elect one. */
  routeEntry(cx: EntryCtx): BotVec {
    const { p, enemyStand, dStand, capper, waveTask, laneBlocked } = cx;
    // …unless the straight line to the stand is already open. Ring
    // entries only earn their detour when terrain actually rises
    // into the approach; without this check a bot on the anchor
    // ring hops entry-to-entry ~60m out forever, never taking the
    // last hop that was clean all along.
    let wall = 0;
    for (let s = 1; s < 8; s += 1) {
      const t = s / 8;
      wall = Math.max(wall, hmHeight(this.rt.field!, p.position.x + (enemyStand.x - p.position.x) * t,
        p.position.z + (enemyStand.z - p.position.z) * t)
        - (p.position.y + (enemyStand.y - p.position.y) * t));
    }
    // Inside the DMZ a capper must keep pressing in: far ring entries
    // are exits there, and a lip it can jet over is no wall. Without
    // this the probe kept re-picking entries behind the bot - cappers
    // entered the 80m ring, rerouted outward, and left ungrazed.
    // Inside the DMZ a tasked wave member presses in too - untasked
    // pressers re-route to ring entries, but a named flood member
    // orbiting the ring is exactly the "wave at d183m" the soak
    // probe caught: tasked, committed, never inside.
    const committed = (capper || waveTask) && dStand < 80 && wall < 12;
    // A tasked member still presses the straight line over rolling
    // ground - the flood's job is arriving, and entry detours for
    // every 8m swell read worse than the beeline they replace
    // (peaks soak: routing dropped near% 3->1). Only a real wall
    // face earns the detour.
    // Inside the grab ring a capper commits to the pole - the wall
    // probe still reads the dais/apron face there and routing it
    // back out to ring probes throws away a stand it already owns
    // (broadside 9002: 90s of probe-churn 8-25m out).
    // `wall` measures terrain only - on a structure map it reads 0
    // through a genhouse, so "clear lane" must include solids or the
    // commit press becomes a grind on an interior wall (bastion:
    // cappers pinned 25m from the flag with a flat-terrain "open"
    // lane). Committed pressers still press into the wall - that
    // stall is what feeds the breach machinery.
    if ((wall < 6 && !laneBlocked) || committed || (waveTask && wall < 20) || (capper && dStand < 25)) {
      return this.pressGoal(cx);
    }
    return this.electEntry(cx);
  }

  /** Committed straight press on the stand - the altitude pull, miss-
   *  vector lead, and home-side pass-through aim shaping. */
  pressGoal(cx: EntryCtx): BotVec {
    const { p, enemyStand, enemyFlagY, dStand, capper } = cx;
    // Any straight press is ownership of the stand: stamp the
    // press record so a bounce back out past the lane window
    // sees `pressing` instead of re-running the ring probe -
    // laneClear approaches used to leave no trace, so every
    // overshoot re-entered routing and picked a hilltop entry.
    this.rt.routeHold.set(p.id, { stand: enemyStand, pos: Object.assign({}, enemyStand), at: simNow() });
    // Two human corrections on the final run:
    // - Altitude pull: a ballistic runner can't dive, so aim the
    //   landing short of the flag and skim through it at grab height.
    // - Track lead: momentum lags yaw, so the velocity ray misses
    //   the pole by meters. Shift the aim point by the measured
    //   miss vector so the converged path crosses the flag.
    const dy = p.position.y - enemyFlagY;
    const pull = Math.max(0, Math.min(24, (dy - 5) * 1.6));
    const ux = (enemyStand.x - p.position.x) / dStand;
    const uz = (enemyStand.z - p.position.z) / dStand;
    const vel = this.rt.room.players.getPlayer(p.id)?.velocity;
    const spd = vel ? Math.hypot(vel.x, vel.z) : 0;
    const {mx, mz} = this.missVec(cx, vel ?? null, spd);
    const {px: px2, pz: pz2} = this.passThrough(cx, spd);
    // The pass shape is for a runner arriving with speed - a
    // stalled or point-blank presser aiming PAST the flag slides
    // around the dais hull chasing the offset (broadside: ~19s of
    // ring orbits at 4-15m/s). Threshold lives above crawl pace:
    // a braked bot hovering 5-9m/s flapped between the pole and
    // a point 40m past the flag and paced 10-17m out forever
    // (katabatic 9002). Slow/close presses aim the pole.
    // Direct-aim threshold raised 6→20m: at 36 m/s the steerer
    // needs ~0.5s to align with the flag; 6m gives 0.17s -
    // not enough to unwrap from the pass-through heading.
    // Commitment latch: the 14/20 gates are entrance criteria, not
    // a per-think switch - a capper crossing them flips his aim
    // 10-40m sideways every think, which is the limit cycle above.
    // Once opened, hold the pass until the run actually dies
    // (speed gone), so the last 40m is one committed line.
    if (capper) {
      if (spd > 14 && dStand > 20) { this.rt.passCommit.set(p.id, simNow()); }
      else if (spd < 9) { this.rt.passCommit.delete(p.id); }
    }
    const passOn = capper && spd > 6 && this.rt.passCommit.has(p.id);
    // Non-cappers keep the original lead+pull aim whenever the
    // gates open - only the capper's aim needs the latch.
    const aimLead = passOn || (!capper && spd > 14 && dStand > 20);
    // The altitude pull is a landing-short brake for a ballistic
    // arrival; on a committed pass it fights the very line that
    // carries speed through the ring, so it only trims.
    const pullUse = passOn ? pull * 0.35 : pull;
    return aimLead
      ? { x: enemyStand.x + mx + px2 - ux * pullUse,
          y: enemyFlagY,
          z: enemyStand.z + mz + pz2 - uz * pullUse }
      : Object.assign({}, enemyStand);
  }

  /** Track lead: momentum lags yaw, so the velocity ray misses the pole
   *  by meters. Shift the aim point by the measured miss vector so the
   *  converged path crosses the flag. */
  missVec(cx: EntryCtx, vel: Vec3 | null, spd: number): { mx: number; mz: number } {
    const { p, enemyStand } = cx;
    let mx = 0, mz = 0;
    if (vel && spd > 6) {
      const t = Math.max(0, ((enemyStand.x - p.position.x) * vel.x +
        (enemyStand.z - p.position.z) * vel.z) / spd);
      mx = enemyStand.x - (p.position.x + (vel.x / spd) * t);
      mz = enemyStand.z - (p.position.z + (vel.z / spd) * t);
      // Miss-vector cap scales with speed: a hard 15m ceiling
      // left fast passes uncorrectable - a 30m/s run-in that
      // drifted >15m off the pole line aimed a fixed 15m aside
      // and sailed past the ring entirely (surreal s2: od 30→76
      // at v=31, lap-brake fumble, re-approach grab at 18).
      const mLen = Math.hypot(mx, mz), cap = Math.max(15, spd * 0.8);
      if (mLen > cap) { mx *= cap / mLen; mz *= cap / mLen; }
    }
    return { mx, mz };
  }

  /** The grab is a pass-through, not an arrival: a human capper
   *  flanks so his momentum exits toward home, and that whole
   *  shape falls out of aiming at a point PAST the flag on the
   *  home side - the approach wraps to the far side for free. */
  passThrough(cx: EntryCtx, spd: number): { px: number; pz: number } {
    const { enemyStand, dStand, capper } = cx;
    let px = 0, pz = 0;
    if (capper && this.rt.field) {
      const own = this.rt.room.flags!.flags.get(cx.me)!;
      const hx = own.home.x - enemyStand.x, hz = own.home.z - enemyStand.z;
      const hd = Math.hypot(hx, hz) || 1;
      // Scale pass-through by distance: at 20m out, aim 10m past;
      // at 6m, aim direct. A fixed 40m offset at 36 m/s approach
      // misses the 6m grab radius by 34m - the capper sails past
      // and orbits for 55+s.
      // …and fade the pass-through OUT with speed: steering a
      // 30m/s line onto a point 15m past the flag bends the whole
      // trajectory off the pole - the converged path misses the
      // 6m ring laterally (surreal s2: od 30→76 @31m/s whiff).
      // A fast capper aims the corrected pole line and lets his
      // momentum carry the exit; the wrap shape is a slow-bot
      // tool for landing ON the stand, not through it.
      const passM = Math.min(PASS_M, dStand * 0.5)
        * Math.max(0, 1 - spd / 35);
      const cx2 = enemyStand.x + (hx / hd) * passM;
      const cz = enemyStand.z + (hz / hd) * passM;
      if (hmHeight(this.rt.field, cx2, cz) - enemyStand.y < 15) {
        px = cx2 - enemyStand.x; pz = cz - enemyStand.z;
      }
    }
    return { px, pz };
  }

  /** Entry candidate scoring: height, detour, ridge/climb/lip taxes,
   *  capper run-in credit, foe proximity, graveyard memory, and the
   *  structure cost terrain probes are blind to. */
  scoreEntry(cx: EntryCtx, ex: number, ey: number, ez: number): number {
    const { p, enemyStand, dStand, capper } = cx;
    const high = ey - enemyStand.y;
    const detour = Math.hypot(ex - p.position.x, ez - p.position.z) - dStand;
    let score = high * (capper ? 1.2 : 0.3) - Math.max(0, ey - p.position.y) * 2 - Math.max(0, detour) * 0.8;
    let ridge = 0;
    let prevH = p.position.y;
    let climb = 0;
    for (let s = 1; s < 8; s += 1) {
      const t = s / 8;
      const lx = p.position.x + (ex - p.position.x) * t;
      const lz = p.position.z + (ez - p.position.z) * t;
      const lh = hmHeight(this.rt.field!, lx, lz);
      ridge = Math.max(ridge, lh - (p.position.y + (ey - p.position.y) * t));
      if (lh > prevH) {climb += lh - prevH;}
      prevH = lh;
    }
    score -= ridge * 2.5;
    // Climb budget: ridge prices the tallest hump, but a wall of
    // rolling +10m ascents drains the tank just the same - the
    // massif face reads ~50m cumulative, more than a light kit's
    // full burn, so the capper Sisyphus-orbits it for the match.
    // Tax total ascent: a saddle route that spreads the same
    // climb over dips beats the sheer face.
    score -= climb * 2;
    let lip = 0;
    for (let s = 1; s < 8; s += 1) {
      const t = s / 8;
      const lx = ex + (enemyStand.x - ex) * t;
      const lz = ez + (enemyStand.z - ez) * t;
      lip = Math.max(lip, hmHeight(this.rt.field!, lx, lz) - (ey + (enemyStand.y - ey) * t));
    }
    score -= lip * 3;
    // A run-in that drops pays speed on the table: the leg that
    // ends the push is where m/s actually buys survival - pushes
    // were arriving at ~16m/s and dying to interceptors at the
    // ring edge, so elevated entries earn their climb back here.
    if (capper) {score += this.runInCredit(cx, ex, ey, ez);}
    score -= this.foeTax(cx, ex, ez);
    // Graveyard penalty: an entry the bot already failed to reach
    // loses by a landslide - without memory the probe re-elects
    // the same unreachable point every re-score (raindance orbit).
    const fr = this.rt.routeFailed.get(p.id);
    if (fr && simNow() - fr.at < 90_000
      && Math.hypot(fr.pos.x - ex, fr.pos.z - ez) < 80) {score -= 400;}
    score -= this.wallTax(cx, ex, ey, ez);
    return score;
  }

  /** Score the NET drop - descent minus the climb it has to undo: a
   *  moat-rim entry drops 50m into the trench then walls back up, and
   *  scoring the drop alone made that trap outrank the saddle (capRun
   *  katabatic bisect: green→red at cfe341d). Plus the CONTIGUOUS
   *  run-in descent ending at the stand. */
  runInCredit(cx: EntryCtx, ex: number, ey: number, ez: number): number {
    const { enemyStand } = cx;
    let credit = 0;
    let drop = 0, rise = 0;
    let prevH = ey;
    for (let s = 1; s < 8; s += 1) {
      const t = s / 8;
      const lx = ex + (enemyStand.x - ex) * t;
      const lz = ez + (enemyStand.z - ez) * t;
      const lh = hmHeight(this.rt.field!, lx, lz);
      if (lh < prevH) {drop += prevH - lh;} else {rise += lh - prevH;}
      prevH = lh;
    }
    // Run-in descent weight 1.5→3: the descent-glue fix made
    // drop convertible to grab speed (sweep grabV 14→19), so
    // entries whose run-in keeps falling are worth more - a
    // 10m net drop now outranks a 30m detour.
    credit += (drop - rise) * 3;
    // Sustained run-in credit: the drop that converts to grab
    // speed is the CONTIGUOUS descent ending at the stand - a
    // leg that dips early then flats in delivers nothing. Walk
    // backward from the stand and sum the unbroken fall: ~50m
    // of ski run is what a 40m/s entry is made of (sweep:
    // net-drop alone left flat-run entries tied with ski runs).
    // Sample the last ≤90m densely - on a 150m leg the old
    // whole-leg 8-sample walk spaced ~19m and couldn't tell a
    // real run-in from a long shallow grade.
    const legLen = Math.hypot(enemyStand.x - ex, enemyStand.z - ez) || 1;
    const runWin = Math.min(90, legLen * 0.875);
    let runIn = 0;
    prevH = enemyStand.y;
    for (let s = 1; s <= 8; s += 1) {
      const t = (s / 8) * runWin;
      const lx = enemyStand.x + (ex - enemyStand.x) * (t / legLen);
      const lz = enemyStand.z + (ez - enemyStand.z) * (t / legLen);
      const lh = hmHeight(this.rt.field!, lx, lz);
      if (lh <= prevH + 0.5) {break;}  // flat-ish step ends the run
      runIn += lh - prevH;
      prevH = lh;
    }
    credit += Math.min(runIn, 40) * 2;
    return credit;
  }

  /** Foe proximity tax along the pos→entry leg, nearest contact wins. */
  foeTax(cx: EntryCtx, ex: number, ez: number): number {
    const { p, foes } = cx;
    let tax = 0;
    for (const e of foes) {
      for (let s = 1; s < 8; s += 1) {
        const t = s / 8;
        const lx = p.position.x + (ex - p.position.x) * t - e.x;
        const lz = p.position.z + (ez - p.position.z) * t - e.z;
        const ed = Math.hypot(lx, lz);
        if (ed < 80) { tax += (80 - ed) * 0.05; break; }
      }
    }
    return tax;
  }

  /** Structure cost - the terrain probes are blind to walls, so a
   *  ring point inside a walled compound scored like open ground
   *  and the bot chased it through a curtain it can't walk
   *  through (bastion: every close-ring entry is courtyard
   *  interior). Each leg of pos→entry→stand pays per wall on the
   *  line; entries that only cross the breach face once still
   *  compete, entries walled on both legs lose. */
  wallTax(cx: EntryCtx, ex: number, ey: number, ez: number): number {
    const { p, enemyStand, me } = cx;
    const cols = this.rt.room.ballSim.colliders;
    if (cols.length === 0) {return 0;}
    const idx = this.rt.room.ballSim.colliderIndex ?? undefined;
    const body = { x: p.position.x, y: p.position.y + 1, z: p.position.z };
    const ent = { x: ex, y: ey + 1, z: ez };
    const std = { x: enemyStand.x, y: enemyStand.y + 1, z: enemyStand.z };
    let tax = 0;
    if (segSolidHit(body, ent, cols, idx, me)) {tax += 150;}
    if (segSolidHit(ent, std, cols, idx, me)) {tax += 180;}
    return tax;
  }

  /** Candidate election: flow-field saddle + ski-run heads + the three
   *  fixed ring radii, each through scoreEntry plus the per-bot
   *  temperament offset. Two dead entries on the stand short-circuit
   *  to a press. */
  electEntry(cx: EntryCtx): BotVec {
    const { p, enemyStand, dStand } = cx;
    const inside = dStand < 80;
    // Route temperament: two runners reading the same terrain pick
    // the same entry - mirrored runs joust head-on mid-field (the
    // capper autopsy: enemy cappers are each other's top killer).
    // A stable per-bot bearing OFFSET fans them out around their
    // own approach side - a fixed world bearing sent runners
    // around the massif to a far-side entry they could never reach
    // (the bravo capper's 750m contour orbit).
    // Two dead entries on this stand = the ring is lying: every
    // probe-elected detour dies on the same wall. Stop spending
    // 30s bail windows proving it a third time - press the stand
    // and let the jet-escape stack force the face. The failure
    // memory decays (90s graveyard window), so the detour sense
    // comes back once the terrain's verdict has room to change.
    const frStale = this.rt.routeFailed.get(p.id);
    if (frStale && (frStale.n ?? 0) >= 2 && frStale.stand !== undefined
      && simNow() - frStale.at < 90_000 && dist3(frStale.stand, enemyStand) < 1) {
      this.rt.routeHold.set(p.id, { stand: enemyStand, pos: Object.assign({}, enemyStand), at: simNow() });
      return Object.assign({}, enemyStand);
    }
    // The flood's own near-stand route point joins the ring as a
    // scored candidate - the saddle the cheapest path funnels
    // through. It goes through the same reachability/foe/graveyard
    // scoring as the ring points, so it wins only where the ring's
    // fixed radii are blind to it; on maps where the ring already
    // sees the saddle, nothing changes.
    const flowEntry = this.rt.flow
      ? this.rt.flow.routeNearGoal(p.position.x, p.position.z, enemyStand.x, enemyStand.z, 90, p.team)
      : null;
    const pref = Math.atan2(p.position.z - enemyStand.z, p.position.x - enemyStand.x)
      + this.rt.routePref(p.id);
    const prefW = process.env.FPS_NOPREF ? 0 : 18;
    const best = this.bestCandidate(cx, flowEntry, pref, prefW, inside);
    // No incumbent here - incumbents are chased to arrival, so this
    // branch only runs on a fresh pick or after a stale record died.
    this.rt.routeHold.set(p.id, { stand: enemyStand, pos: best, at: simNow() });
    return best;
  }

  /** Candidate scan: flow saddle, ski-run heads, then the three fixed
   *  ring radii - each through scoreEntry plus the temperament cosine. */
  bestCandidate(cx: EntryCtx, flowEntry: BotVec | null, pref: number, prefW: number, inside: boolean): BotVec {
    const { enemyStand, dStand, capper } = cx;
    let best: BotVec = enemyStand, bestScore = -Infinity;
    if (flowEntry) {
      const score = this.scoreEntry(cx, flowEntry.x, flowEntry.y, flowEntry.z)
        + Math.cos(Math.atan2(flowEntry.z - enemyStand.z, flowEntry.x - enemyStand.x) - pref) * prefW;
      if (score > bestScore) { bestScore = score; best = flowEntry; }
    }
    // Ski-run candidates: ring points miss run-in heads because
    // descents end where terrain says, not on fixed circles. Each
    // traced run-in head is a line a human cap route is built on.
    if (capper && this.rt.field) {
      for (let a = 0; a < 12; a += 1) {
        const ang = (a / 12) * Math.PI * 2;
        const head = this.runInHead(enemyStand, ang);
        if (!head) {continue;}
        const score = this.scoreEntry(cx, head.x, head.y, head.z) + Math.cos(ang - pref) * prefW;
        if (score > bestScore) { bestScore = score; best = head; }
      }
    }
    for (let a = 0; a < 24; a += 1) {
      // Three radii: close entries are cheap, a closed rim wall
      // only breaks further out - a plateau stand needs the far
      // rings to find the saddle where its massif opens.
      let ring = 300, phase = Math.PI / 4;
      if (a < 8) { ring = 85; phase = 0; }
      else if (a < 16) { ring = 170; phase = Math.PI / 8; }
      if (inside && ring > dStand + 20) {continue;}
      const ang = ((a % 8) / 8) * Math.PI * 2 + phase;
      const ex = enemyStand.x + Math.cos(ang) * ring;
      const ez = enemyStand.z + Math.sin(ang) * ring;
      const ey = hmHeight(this.rt.field!, ex, ez);
      const score = this.scoreEntry(cx, ex, ey, ez) + Math.cos(ang - pref) * prefW;
      if (score > bestScore) { bestScore = score; best = { x: ex, y: ey, z: ez }; }
    }
    return best;
  }
}
