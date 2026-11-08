/**
 * botGoals - idle-goal selection for BotBrain. Reflex overrides run
 * first (revenge, rally, the cloak-fuel errand), then the goal itself is
 * utility-scored: every candidate - objective, gem, heard fight, wander -
 * gets weight × distance-falloff × danger-discount, argmax wins with a
 * hysteresis margin so goals don't dither. Runs on the slow think
 * cadence; botBrain keeps the per-tick destination resolution. The
 * picker writes into the brain-owned GoalState bag, so the mutable
 * fields stay private to the brain while the ordering lives here.
 */
import { botRand } from './botRand.ts';
import { BOT_EYE } from './botHunt.ts';
import { BOT_TUNING as T } from './botTuning.ts';
import { distSq } from './botVec.ts';
import { ENERGY } from './movement.ts';
import type { BotVec, BrainCtx } from './botBrain.ts';

/** Mutable goal/wander/revenge state - the brain owns the bag, the
 *  picker mutates it in place. */
export interface GoalState {
  /** The committed destination think() reads when nothing presses. */
  goal: BotVec;
  /** Revenge timer - being shot by an unseen attacker outranks every
   *  idle drive until it decays. */
  revengeT: number;
  revengeFrom: BotVec;
  /** Wander pacing - personal clock so a squad doesn't caravan. */
  wanderT: number;
  wanderWp: BotVec;
  /** Thinks since the current goal was picked - the stale clock for
   *  the switching-cost model (a committed line expires, never locks). */
  goalAge: number;
  /** Score the incumbent won with - remembered so a goal whose offer
   *  vanishes next think still defends its commitment. */
  goalScore: number;
}

export class BotGoals {
  constructor(
    private s: () => GoalState,
    private wanderlust: () => number,
    private headingVec: () => { x: number; z: number },
    private nearDeath: (p: { x: number; z: number }) => boolean,
    private duty: () => number = (): number => 1,
    private social: () => number = (): number => 0.5,
    private greed: () => number = (): number => 0.5,
    /** Seeded per-bot angle — escort/vulture goals ring the carrier
     *  here instead of stacking his exact spot (see the offer below). */
    private escortA: () => number = (): number => 0,
    /** Hero resolve — a pressured bot's curiosity sharpens into
     *  predation: heardGoal's investigate roll climbs toward certain. */
    private resolve: () => number = (): number => 0,
  ) {}

  /** The bot's nerve - where on the solo↔social dial it sits right now.
   *  High social + low confidence (losing, dying) pushes toward company;
   *  a confident loner barely registers allies exist. */
  private nerve(ctx: BrainCtx): number {
    return this.social() * (1.1 - (ctx.confidence ?? 0.5));
  }

  /** Idle-goal selection, in priority order: revenge > rally > objective >
   *  pickup > heard fight > wander. */
  pick(ctx: BrainCtx, pos: BotVec): void {
    const s = this.s();
    if (s.revengeT > 0) {
      // Hit from somewhere unseen: push toward the shooter rather than
      // continue a patrol - the flinch already spent the recoil. A
      // posted anchor doesn't take the bait: the revenge push is what
      // shelled HoFs off their stand - he answers with fire, not feet.
      if (!(ctx.posted && ctx.objective && Math.sqrt(distSq(s.revengeFrom, ctx.objective)) > ctx.posted)) {
        s.goal = Object.assign({}, s.revengeFrom);
        return;
      }
    }
    // Rally threshold breathes with nerve: a rattled gregarious bot folds
    // at ~30% HP, a confident loner only at the brink (a 0-social nerve
    // barely moves the base 15%).
    const rallyAt = 0.15 * (0.4 + this.nerve(ctx) * 1.6)
      // A hoarder's spill belongs to the team: rich carriers fold
      // toward friendlies much earlier (the corpse drops the pile on
      // a re-grab lane) - but only mostly; a predictable turtle just
      // gets pinched between hunters, so the extension rolls 70%.
      + (ctx.held === undefined ? 0 : Math.min(0.4, ctx.held * 0.004));
    const foldOk = ctx.held === undefined
      || (ctx.healthFrac ?? 1) < 0.15 * (0.4 + this.nerve(ctx) * 1.6)
      || botRand() < 0.7;
    if ((ctx.healthFrac ?? 1) < rallyAt && foldOk && ctx.allies && ctx.allies.length > 0 && !ctx.posted) {
      const rally = this.rallyGoal(ctx, pos, rallyAt);
      if (rally) {s.goal = rally;}
      return;
    }
    // A dry infiltrator can't hold the veil - the nugget loop IS its
    // stealth economy, so feeding the tank outranks pressing the stand.
    if (ctx.infiltrating && ctx.energy !== undefined && ctx.energy < ENERGY.cloakCost + 30 && ctx.pickup) {
      s.goal = Object.assign({}, ctx.pickup); return;
    }
    // Utility pick - nothing is first-past-the-post anymore: a gem 30m
    // out can outscore a flag 400m off, a distant objective beats a
    // death-scented fight. duty tempers the danger discount (dutiful
    // bots press through scent, sightseers route around it); weight is
    // each drive's pull; distance folds to a falloff curve.
    const wander = this.wanderCandidate(ctx, pos);
    const heard = this.heardGoal(ctx, pos);
    const cands: Array<{ goal: BotVec; score: number }> = [];
    // Crowding discount: a goal that already has allies on it loses
    // pull fast - Tribes players spread, they don't stack in a bowl.
    // The FIRST ally at the candidate is often the anchor itself (a
    // rally/escort offer lives ON a teammate) - penalty counts extra
    // stacking beyond them, not their existence.
    const crowd = (g: BotVec): number => {
      let n = 0;
      for (const a of ctx.allies ?? []) {if (distSq(g, a) < 18 * 18) {n += 1;}}
      return Math.max(0, n - 1);
    };
    const offer = (goal: BotVec | null | undefined, weight: number, ignoreScent = false): void => {
      if (!goal) {return;}
      const d = Math.sqrt(distSq(pos, goal));
      // Quadratic crowding: the linear 1/(1+crowd) let a dominant offer
      // (objective w=3.5) still argmax at 1/3 pull - five bots stacking
      // the same bowl was each brain's correct pick. At n extra allies
      // the offer falls off quadratically, so the third head in a bowl
      // finds a different stand unless nothing else exists at all.
      const reach = 1 / (1 + d / 140) / (1 + crowd(goal) * crowd(goal));
      // Experience memory on top of the shared scent: a spot where THIS
      // bot already died reads extra dangerous to it personally - the
      // map's graveyard is everyone else's history, this one is mine.
      const personal = this.nearDeath(goal) ? 0.2 : 0;
      const scent = ignoreScent ? 0
        : Math.min(0.85, (ctx.imapDanger?.(goal) ?? 0) * 0.22 * (1.5 - Math.min(1, this.duty())) + personal);
      cands.push({ goal, score: weight * reach * (1 - scent) });
    };
    // A runner's objective is a commitment, not a candidate: the cap
    // route is the job, so midfield noise has to beat a heavy weight to
    // pull the legs. Fights en route get answered by the fire layer
    // while the feet keep the line - humans run and shoot.
    // A posted anchor's objective is the same kind of commitment the
    // cap route is - nothing midfield outbids the pole.
    // The committed objective (cap route / posted pole / wave flood) is
    // exempt from the scent discount: a hot lane is the ROUTE's problem -
    // the entry scorer already prices detours - not a license to wander
    // midfield. A named wave member's task slot is the same commitment:
    // soak showed ~86% of wave ticks holding a goal 60m+ off the flood -
    // every heard fight outbid the 1.0-weight objective, so the called
    // push walked in alone.
    const committed = ctx.runner || ctx.posted || ctx.wave;
    // Broke hunters chase the hoard like a commitment - a 0-token pocket
    // has nothing to spill, so the vault hunt outbids corridor loot and
    // heard fights up to ~3x (par at 40+ held, where the carrier is the
    // one worth guarding, not chasing). ctx.held is undefined outside
    // headhunt - other modes keep the flat 1 weight.
    const huntW = (ctx.held === undefined ? 1 : 1 + 2 * Math.max(0, 1 - ctx.held / 40))
      // Losing late? The vault IS the win button - desperation stacks
      // on top of poverty instead of replacing it.
      + (ctx.desperate ?? 0);
    offer(ctx.objective, committed ? 3.5 : huntW, Boolean(committed));
    // Escort the piñata: a 20+ friendly hoard draws its team like the
    // carrier is a walking objective - committed roles already hold
    // their task, everyone else drifts to guard the vault. The pull is
    // a RING point around the carrier, not his position: every escort
    // converging on one spot stacked the team into a mortar-shaped
    // clump circling the bowl he hid in (reported on prod rimrock).
    // orbitA is the seeded per-bot angle; it also drifts slowly in
    // patrol, so the screen point wanders instead of statue-sitting.
    const escort = (p: BotVec | null | undefined, r: number): BotVec | null => {
      if (!p) {return null;}
      const rr = r * (0.7 + 0.6 * this.greed());
      const x = p.x + Math.cos(this.escortA()) * rr;
      const z = p.z + Math.sin(this.escortA()) * rr;
      return { x, y: ctx.groundY(x, z), z };
    };
    offer(escort(ctx.convoy, 25), 1.5);
    // Corpse-watch beats the pickup offer it's about to become -
    // camping the dying carrier wins the spill; arriving late reads
    // as the enemy team's tokens. Greed still decides who circles -
    // but vultures spread the ring the same way (12m is close enough
    // to pounce on the drop).
    offer(escort(ctx.spillSoon, 12), 1.8 * (0.5 + this.greed()));
    if (!(ctx.posted && ctx.objective && ctx.pickup && distSq(ctx.pickup, ctx.objective) > ctx.posted * ctx.posted)) {
      // Corridor loot: a nugget on the way to the objective is nearly
      // free and worth a bump; one off the line drops to a passing whim.
      // detour = self→pickup→objective minus self→objective.
      // Committed-only: an uncommitted bot's objective is a weight-1
      // candidate like everything else - pricing its pickup detours
      // against the route starves it of every off-line gem.
      let w = 0.8;
      if (committed && ctx.objective && ctx.pickup) {
        const detour = Math.sqrt(distSq(pos, ctx.pickup)) + Math.sqrt(distSq(ctx.pickup, ctx.objective)) - Math.sqrt(distSq(pos, ctx.objective));
        w = detour < 12 ? 1.1 : detour > 30 ? 0.3 : w;
      }
      // Pile size x personality x appetite: a 27-coin spill pulls ~2x
      // a lone coin's ~0.55x; a lobby hoover (greed 1) multiplies by
      // ~1.7 where a deathmatch-brained bot (greed 0) cares 0.3x -
      // same field, different people. Held-hoarders stay hungry on top.
      const pileW = 0.5 + Math.min(ctx.pickupVal ?? 1, 40) / 40 * 1.5;
      // Vulture pull: broke hunters dive free loot (nothing on their
      // own corpse to lose) on top of the hoarder's appetite.
      const hunger = ctx.held === undefined ? 1
        : 1 + Math.min(1, ctx.held * 0.02) + Math.max(0, 1 - ctx.held / 15) * 0.6;
      offer(ctx.pickup, w * pileW * (0.3 + this.greed() * 1.4) * hunger);
    }
    // A posted defender hears the same gunfire - he just doesn't go
    // look. Beyond the leash it's someone else's job; wandering is
    // off the table entirely, feet stay on the post.
    // Appetite grows with eating: a rich hoarder is emboldened by the
    // regen/plating his pile buys - he hunts the action like an
    // ultrahunter instead of hiding (the drip still argues for the
    // bail-then-drip rhythm the fear floor gives him).
    const greedy = ctx.held === undefined ? 1 : 1 + Math.min(1.5, ctx.held * 0.02);
    if (heard && !(ctx.posted && ctx.objective && distSq(heard, ctx.objective) > ctx.posted * ctx.posted)) {
      offer(heard, (0.2 + this.duty() * 0.5) * greedy);
    }
    // Opportunity heat as a destination, not just a steering nudge: gem
    // drops, hits and corpses all splat it, so a bot that sees no gem
    // and hears no fight still drifts toward where the money/action is
    // - the pull a spawn-clustered team needs before first contact.
    // Committed roles (posted/wave) hold their post, same as heard.
    const hot = ctx.posted || ctx.wave ? null : ctx.imapHottest?.(pos);
    if (hot && hot.v > 0.3) {offer({ x: hot.x, y: ctx.groundY(hot.x, hot.z) + BOT_EYE, z: hot.z }, 0.6 * greedy);}
    // Ally drift: no objective pulling (flag modes have their own squad
    // machinery - this is the TDM/nuggets hint of cohesion), nobody
    // already in company range, and a teammate in real reach. Weight is
    // nerve-shaped so confident/loner bots keep their solo roam while a
    // rattled social one finds a buddy - pairs form and dissolve as the
    // drifted-to ally's own goals move it on, never a formed unit.
    const buddy = this.buddyAnchor(ctx, pos);
    if (buddy) {offer(buddy, this.nerve(ctx) * 0.55);}
    // A same-team VGS callout left a pin: commited roles hold their post -
    // everyone else weighs the call like a heard fight, duty-scaled so a
    // loner bot can still shrug off "cover me".
    if (ctx.radio && !committed) {offer(ctx.radio, 0.35 + this.duty() * 0.45);}
    if (wander && !ctx.posted) {offer(wander, 0.35);}
    if (cands.length > 0) {
      let best = cands[0]!;
      for (const c of cands) {if (c.score > best.score) {best = c;}}
      // Hysteresis: the incumbent needs beating by a margin - flipping
      // goals on a 1% re-score reads as bot dithering, not judgment.
      const incumbent = cands.find((c): boolean => distSq(c.goal, s.goal) < 25 * 25);
      // Switching cost, not a lock - humans hold a line but still change
      // their mind for a good reason. The cost grows with the committed
      // distance still ahead (sunk transit = momentum), drops under
      // threat (danger is always a good reason), and expires stale: a
      // goal older than ~20s earns no loyalty at all, so a wedged line
      // can always be dropped. Idle IS traveling - a bot's default is
      // sustained motion, not a parked orbit.
      s.goalAge += 1;
      const underFire = (ctx.threats?.length ?? 0) > 0;
      const stale = s.goalAge > 60;
      const cost = (g: BotVec): number => stale ? 0
        : (0.2 + Math.min(1.8, Math.sqrt(distSq(pos, g)) / 120)) * (underFire ? 0.4 : 1);
      // The incumbent is EITHER a re-offered candidate or the live goal
      // itself defending on its remembered score - a line whose offer
      // source vanished (wander re-roll, spent pickup) doesn't die
      // instantly to the next best thing.
      const incScore = incumbent ? incumbent.score : s.goalScore;
      const incGoal = incumbent ? incumbent.goal : s.goal;
      // shared/ runs in the browser too - bare process.env throws there
      // (and killed the whole bot tick mid-loop, freezing corpses).
      if (typeof process !== 'undefined' && process.env?.BOTGOALS_DEBUG) {console.log('PICK', JSON.stringify({cands: cands.map((c): { g: BotVec; s: number } => ({g: c.goal, s: +c.score.toFixed(2)})), inc: incumbent?.goal, incScore, cost: +cost(incGoal).toFixed(2), best: best.goal, bestScore: +best.score.toFixed(2)}));}
      if (incScore * (1 + cost(incGoal)) > best.score) {
        s.goal = incGoal;
        s.goalScore = incScore;
      } else {
        s.goal = ((((((Object.assign({}, best.goal)))))));
        s.goalScore = best.score;
        s.goalAge = 0;
      }
      return;
    }
    // Wander always offers a candidate, so an empty board only happens
    // when even the roll produced nothing - hold the line.
  }

  /** The wander slot as a utility candidate - a fresh roll when the
   *  pacing clock says so, else the leg already underway. */
  private wanderCandidate(ctx: BrainCtx, pos: BotVec): BotVec | null {
    const s = this.s();
    if (s.wanderT <= 0 || distSq(pos, s.wanderWp) < 9) {
      s.wanderT = (3 + botRand() * 4) / this.wanderlust();
      const best = this.rollWander(ctx, pos);
      if (best) {s.wanderWp = best;}
    }
    return s.wanderWp;
  }

  /** Roll a few candidate waypoints; the leg style (downhill ski run,
   *  climb, or max-change traverse) is picked once per roll so a leg
   *  commits to its character instead of flip-flopping per candidate.
   *  Death spots are skipped outright. */
  private rollWander(ctx: BrainCtx, pos: BotVec): BotVec | null {
    const g0 = ctx.groundY(pos.x, pos.z);
    // A cold field's best pull is the crowd - every live body's position
    // is already a legal sense (retreat folds read it), and a lobby
    // drifts toward where everyone is. The cone blends toward the crowd
    // centroid with distance - no hard gate, so a team rim-camped ~300m
    // out still drifts inward instead of lapping the perimeter forever.
    const h0 = this.headingVec();
    let hv = h0, pull = 0;
    let cx = 0, cz = 0, n = 0;
    for (const o of ctx.others ?? []) { cx += o.x; cz += o.z; n += 1; }
    if (n > 1) {
      cx /= n; cz /= n;
      const dcx = cx - pos.x, dcz = cz - pos.z;
      // Bowl-lock fix: the centroid pull fades INSIDE ~60m - drifting
      // toward a crowd is a compass, not a parking spot. Arriving bots
      // stop being pulled into the pile they already joined.
      pull = Math.min(1, Math.hypot(dcx, dcz) / 180)
        * Math.min(1, Math.hypot(dcx, dcz) / 60);
      hv = { x: h0.x * (1 - pull) + dcx * pull, z: h0.z * (1 - pull) + dcz * pull };
    }
    // Leg style per roll: pure-downhill picking ratcheted every bot into
    // terrain minima - ski down into the hollow, next roll picks the next
    // hollow, herd'd together by the crowd pull (the bowl-lock). A third
    // of rolls now commits to climbing and a third takes the biggest
    // elevation change either way; only the ski share stays downhill.
    const leg = botRand();
    let mode = 0;
    if (leg < T.brain.wanderDownP) {mode = 1;}
    else if (leg < T.brain.wanderDownP + T.brain.wanderClimbP) {mode = -1;}
    let best: BotVec | null = null;
    let bestScore = -Infinity;
    for (let tries = 0; tries < 3; tries += 1) {
      // Committed lines: a skier picks a direction and holds it - the
      // roll is a forward cone off the current heading with real run
      // length, not a fresh random bearing that reverses mid-carve.
      // The cone narrows as the crowd pull grows - a far wanderer
      // beelines for the lobby, it doesn't slalom to it.
      const a = Math.atan2(hv.z, hv.x) + (botRand() - 0.5) * 2.4 * (1 - pull);
      const r = (T.brain.wanderLegMin + botRand() * T.brain.wanderLegSpan) * this.wanderlust();
      const wp = { x: pos.x + Math.cos(a) * r, z: pos.z + Math.sin(a) * r };
      if (this.nearDeath(wp)) {continue;}
      const drop = g0 - ctx.groundY(wp.x, wp.z);
      const score = mode === 0 ? Math.abs(drop) : mode * drop;
      if (score > bestScore) {
        bestScore = score;
        best = { x: wp.x, y: ctx.groundY(wp.x, wp.z) + BOT_EYE, z: wp.z };
      }
    }
    return best;
  }

  /** The ally-drift anchor: nearest teammate outside company range but
   *  inside real transit reach. Null when the bot already HAS company
   *  (the pull can't stack pairs into a blob) or nobody's reachable. */
  private buddyAnchor(ctx: BrainCtx, pos: BotVec): BotVec | null {
    if (ctx.objective || !ctx.allies || ctx.allies.length === 0 || ctx.posted) {return null;}
    let ally: BotVec | null = null;
    let ad = Infinity;
    for (const o of ctx.allies) {
      const d = distSq(pos, o);
      if (d < 60 * 60) {return null;} // already has company - a pull here would herd
      if (d < ad && d < 260 * 260) { ad = d; ally = o; }
    }
    return ally ? ((((((Object.assign({}, ally))))))) : null;
  }

  /** Hurt with nobody shooting back at: fold toward the nearest ALLY -
   *  folding onto an enemy while at 15% hp was worse than running solo. */
  private rallyGoal(ctx: BrainCtx, pos: BotVec, rallyAt = 0.15): BotVec | null {
    if ((ctx.healthFrac ?? 1) >= rallyAt || !ctx.allies || ctx.allies.length === 0) {return null;}
    let ally: BotVec | null = null;
    let ad = Infinity;
    for (const o of ctx.allies) {
      const d = distSq(pos, o);
      if (d < ad && d > 4) { ad = d; ally = o; }
    }
    return ally ? ((((((Object.assign({}, ally))))))) : null;
  }

  /** Heard a fight: investigate the nearest noise. Curiosity is a
   *  personality roll so a squad doesn't stampede as one. */
  private heardGoal(ctx: BrainCtx, pos: BotVec): BotVec | null {
    if (!ctx.sounds || ctx.sounds.length === 0) {return null;}
    let loudest: BotVec | null = null;
    let ld = Infinity;
    for (const s of ctx.sounds) {
      const d = distSq(pos, s);
      if (d < ld) { ld = d; loudest = s; }
    }
    // Duty tempers wanderlust: the professional hears the fight, the
    // tourist hears the call of the mountain.
    return loudest && botRand() < (0.15 + this.duty() * 0.5 + this.resolve() * 0.4) ? ((((((Object.assign({}, loudest))))))) : null;
  }
}
