import { botRand } from './botRand.ts';
import { STATUS } from './status.ts';
import { ENERGY } from './movement.ts';
import { REPAIR_RANGE } from './weapons.ts';
import { retreatDest } from './botHunt.ts';
import type { BotVec, BrainCtx, BrainOut, BotBrain } from './botBrain.ts';
import { dist3, dirXZ } from './botVec.ts';

const CLOSE_PRESS_M = 6; // inside this the orbit breaks — press to fist range
const FLINCH_DIST = 8;
// Shield only while effectively planted: ground caps are 8/11/14 m/s
// (heavy/medium/light), so 10 lets heavies shield at their run pace but
// sheds the bubble the moment a medium or light commits to a ski line.
const SHIELD_PLANTED_SPEED = 10;
/** Effectively stationary read for the shield gate - missing vel reads
 *  as planted (old ctx shapes predating velocity). */
const isPlanted = (vel: { x: number; z: number } | undefined): boolean =>
  !vel || Math.hypot(vel.x, vel.z) < SHIELD_PLANTED_SPEED;

// Disposition family — step destination (flinch knock > hunt
// press/retreat/orbit > goal), the fortification pick, and the
// toggle-skill intent. BotBrain is the host; these take it flat.

  /** Step destination: flinch knock > hunt press/retreat/orbit > goal. */
export function pickDest(b: BotBrain, dt: number, ctx: BrainCtx, pos: BotVec, fearing: boolean, hero: boolean): BotVec {
    b.holding = false;
    b.standoff = null; // staging re-arms it below when the wave isn't ready
    b.weave = 0;       // the run-weave rearms inside the committed-route block
    if (b.flinchT > 0) {
      b.flinchT -= dt;
      const fx = pos.x - b.flinchFrom.x, fz = pos.z - b.flinchFrom.z;
      const f = dirXZ(fx, fz);
      // The flinch dest says where it WANTS to knock the bot — the
      // steering field decides how far feet may actually travel (a
      // posted leash already masks outward slots).
      const dx = pos.x + f.x * FLINCH_DIST, dz = pos.z + f.z * FLINCH_DIST;
      return { x: dx, y: pos.y, z: dz };
    }
    // Wall-walk override: a breach waypoint armed by the stall path
    // outranks even the objective commit — inside 40m of the flag the
    // committed route IS what pinned the bot on the tower face. Feet
    // walk to the gap/low section; fire and aim stay live elsewhere.
    if (b.breachUntil > ctx.now) {
      if (Math.hypot(pos.x - b.breachGoal.x, pos.z - b.breachGoal.z) < 6) {b.breachUntil = 0;}
      else {return Object.assign({}, b.breachGoal);}
    }
    // Carrying the objective: the run is the job — engaging whoever the
    // hunt found converts the carrier into a duelist mid-route (orbit
    // fights won fights but lost flags). fire stays live elsewhere in
    // the pipeline; only the feet commit to the line.
    // Same for the outbound capper (runner): a capper that stops to
    // fight every midfield contact dies ~130m short of the stand —
    // soak autopsy showed the hunt pull eating every approach leg.
    // He shoots on the move; the route owns the feet.
    // Wave members get the same mass-orbit: a flood that trickles in
    // one bot at a time dies piecemeal at the stand (soak: sup@0 —
    // members arrived but never together). The first to land holds a
    // few seconds for the rest; late or alone, he goes anyway.
    if (((ctx.runner && !ctx.running) || ctx.marshal) && ctx.objective) {
      // "Cap in 10" staging: a runner entering a defended ring alone
      // dies to focused interceptors ~40m out (ring autopsy: pushes
      // die at mdD@41m). He holds a ~110m orbit until the wave his
      // push call summoned is actually converging, then goes in with
      // it. Patience wears out — alone past ~7s he goes anyway, a
      // low-percentage run beats a permanently parked capper.
      const gd = dist3(pos, ctx.objective);
      if (gd > 40 && gd < 160) {
        // Mutual-hold bug: the capper waits for an ally inside 70m while
        // marshalled members hold the same 110m ring — both sides wait
        // on each other until stageT expires and he goes alone. A member
        // staging at ~110m IS converging — count the ring as gathered.
        // Converge radius follows the members' own ~110m stage orbit,
        // plus slack for a member about to land on it — wider releases
        // the capper while the "wave" is still a minute out (katabatic:
        // wave hovers ~170m and the capper's 25s expired alone).
        // A 2-member requirement regressed hard (4g/1c vs 6g/2c on the
        // same seed): the flood trickles in one at a time, so waiting
        // for mass just burns the patience window — a single arrival
        // is the best convergence signal this wave produces.
        const wave = (ctx.allies ?? []).some((a): boolean => dist3(a, ctx.objective!) < 130);
        const wingman = (ctx.allies ?? []).some((a): boolean => dist3(a, pos) < 45);
        // 35s patience for the capper, 45s for wave members: the call
        // posts at route start (~75s ETA), big-map waves transit 40s+ —
        // 25s still released the capper before his flood landed, and a
        // member whose clock expires mid-flood presses the ring alone,
        // feeding instead of flooding. The member window tracks the
        // push task's own 45s dead-slot lifetime: while the call still
        // lives, so does the hold. The orbit is outside the posted
        // defense leash, so holding is cheap.
        // Members also release the moment the capper's push call goes
        // live — he's committed inside the ETA window, and a member
        // covering ~110m of stage orbit lands just behind him. Waiting
        // out the patience clock instead is what made the flood trickle.
        // Longer lone patience for the capper (55s) tried and reverted:
        // waits aged the call and the soak still showed lone entries —
        // a flood that hasn't formed by 35s isn't forming by 55
        // (seed 7 14g/8c->6g/5c, seed 11 9g/2c->5g/2c).
        if (!wave && !wingman && !(ctx.marshal && ctx.pushLive)) {
          // Paired runs: a second capper ~15s from the same ring earns
          // extra patience - two runners landing together is the
          // unguardable push; the solo clock keeps running otherwise.
          const limit = (ctx.marshal && !ctx.runner ? 45 : 35) + (ctx.capSync ? 15 : 0);
          if (b.stageT < limit) {
            b.stageT += dt;
            // Hold-off repeller around the defended ring: the dest stays
            // the objective and the steering field owns the geometry —
            // where the bot circles emerges from goal-pull vs repel, not
            // a scripted orbit. Strength fades with patience so the
            // approach resumes as a drift inward, not a hard release.
            b.standoff = {
              x: ctx.objective.x, z: ctx.objective.z, radius: 160,
              strength: 1 - b.stageT / limit,
            };
          }
        }
      } else if (gd >= 160) {
        b.stageT = 0;
        // Contested-transit loiter: a lone runner crossing a LIVE kill
        // zone dies in it (matchSim: ~260 kills/5min on lagoon, every
        // approach leg ended mid-field, 0 grabs on all four maps). He
        // holds just outside the brawl until the fight thins or his
        // wave joins — the same "go with the flood" rule as the 160m
        // staging orbit, but the staging ring is INSIDE the kill zone.
        // Gate is a live enemy inside ~180m of HIM (the lane is hot):
        // frozen-harness lanes are foe-free, so capStat's route metric
        // is untouched. Loiter expires — some run beats never — but at
        // 60s, not the staging orbit's 35.
        if (ctx.runner && !ctx.running) {
          // Speed is the capper's armor: a runner already carrying
          // >20m/s IS the fast mover who slips a hot lane - parking
          // him mid-route for a lull that never comes just makes him
          // the stationary target the loiter exists to avoid. Only a
          // slow/stalled capper waits out the kill zone.
          const slow = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) < 20 : true;
          const hot = slow && ctx.enemies.some((e): boolean => e.alive && dist3(e.pos, pos) < 180);
          const waveNear = (ctx.allies ?? []).some((a): boolean => dist3(a, ctx.objective!) < 130);
          if (!hot || waveNear) {
            // Decay, don't zero — `hot` flickers every few seconds on a
            // live map (probe: enemies in/out of 180m constantly), and
            // resetting on each lull yanked the capper into the next
            // cluster. A real lull drains the clock in ~20s.
            b.loiterT = Math.max(0, b.loiterT - dt * 2.5);
          }
          if (b.loiterT > 3 && b.loiterT < 60) {
            // Repeller pinned at ~92% of his current stand distance —
            // he orbits his current safe range instead of drifting in.
            b.standoff = {
              x: ctx.objective.x, z: ctx.objective.z,
              radius: gd * 0.92,
              strength: Math.max(0.25, 0.6 - b.loiterT / 120),
            };
          }
          if (hot && !waveNear) { b.loiterT += dt; }
        }
      }
    }
    if ((ctx.running || ctx.runner || ctx.wave) && ctx.objective) {
      // Jink on the run: a committed runner crossing open ground on a
      // laser line is the easiest disc read in the game — humans weave.
      // The weave is a steering-field term: a lateral pull oscillating
      // around the goal line, so the carve is emergent (turn-limited,
      // terrain-aware) rather than a fake perpendicular waypoint.
      // The last leg stays pure — jinking inside the grab ring is a
      // missed flag.
      if (dist3(pos, ctx.objective) > 60) {b.weave = 0.35;}
      // Drop lead: an airborne runner steering at the flag overshoots
      // the 2.2m touch ring every pass — the arc keeps flying while the
      // aim point says "here". Aim short by the arc's own overshoot so
      // the descent lands ON the stand (flagprobe: 120s orbits at planar
      // 4.7-50, dy 8-21, never touched). Pure ballistics, no tuning.
      const dy = pos.y - ctx.objective.y;
      if (dy > 4 && ctx.vel) {
        const spd = Math.hypot(ctx.vel.x, ctx.vel.z);
        if (spd > 1) {
          const fall = Math.sqrt(2 * dy / 28);
          const odx = ctx.objective.x - pos.x, odz = ctx.objective.z - pos.z;
          const od = Math.hypot(odx, odz) || 1;
          const pull = spd * fall - od;
          if (pull > 0) {
            const u = dirXZ(odx, odz);
            return { x: ctx.objective.x - u.x * pull, y: ctx.objective.y, z: ctx.objective.z - u.z * pull };
          }
        }
      }
      return Object.assign({}, ctx.objective);
    }
    // Last-leg commitment beats self-preservation: inside ~40m of the
    // objective a wounded bot still crashes the point — dying with the
    // flag in hand beats surviving the approach. Only the feet commit;
    // fire stays live elsewhere.
    if (ctx.objective && dist3(pos, ctx.objective) < 40) {return Object.assign({}, ctx.objective);}
    if (!b.h.hunt) {
      // A builder with hands free welds the stand's wounded gear before
      // wandering on — same "nobody close enough to interrupt" gate the
      // emplacement pick uses (a weld under fire is a feeding run).
      // Builders weld what's in reach — but each hop makes the next
      // damaged emplacement "nearest", so an ungated weld daisy-chains
      // an anchor 100m+ off post (the hof excursion probe caught
      // exactly this: 123m median dest while the flag sat home).
      if (b.builder && !fearing && ctx.repair
        && !(ctx.posted && ctx.objective && dist3(ctx.repair.pos, ctx.objective) > ctx.posted)) {
        return ctx.repair.pos;
      }
      // Quiet-map drift: with no hunt, no objective and no gem, pull the
      // wander toward wherever the action last scented — fleets that
      // only walk nav lines never meet. A pull, not a commit: the roam
      // goal still leads, the scent just bends it.
      // Posted anchors don't drift toward fight scent — the idle
      // blend is what pulled a HoF 35% toward every rumor of a fight
      // three hills over, reading as wander on the heatmap.
      // Posted idle isn't a statue: a defender sweeps the stand in a
      // slow patrol arc inside his leash — planted, never frozen. The
      // HoF keeps the tightest ring; his post is the flag itself.
      if (ctx.posted && ctx.objective && dist3(pos, ctx.objective) < ctx.posted * 0.5) {
        // Every anchored defender on this objective used to ride the
        // SAME ring — same center, same angular rate, radius capped 8m:
        // a fixed-separation carousel one mortar deletes whole. Spread
        // the annulus per bot: seeded direction and a greed-keyed
        // radius/speed factor keep the patrol but break the ring.
        b.orbitA += dt * 0.3 * b.orbitDir * (0.5 + b.greed);
        const r = (ctx.posted <= 6 ? 2.2 : Math.min(8, ctx.posted * 0.15)) * (0.55 + 0.9 * b.greed);
        return {
          x: ctx.objective.x + Math.cos(b.orbitA) * r,
          y: ctx.objective.y,
          z: ctx.objective.z + Math.sin(b.orbitA) * r,
        };
      }
      const hot = ctx.posted ? null : ctx.imapHottest?.(pos);
      if (hot && hot.v > 0.3) {
        return {
          x: b.goalS.goal.x * 0.65 + hot.x * 0.35,
          y: b.goalS.goal.y,
          z: b.goalS.goal.z * 0.65 + hot.z * 0.35,
        };
      }
      return b.goalS.goal;
    }
    const t = b.h.hunt;
    const d = dist3(pos, t.pos);
    // Posted anchors — a HoF or home defender fires on everything it
    // can see but only leaves the post for a fight inside its leash.
    // The leash is a steering-field rule now (out-of-leash slots read as
    // danger), so dests can say what they mean — a retreat aims away,
    // the feet still hold the zone.
    // A posted defender under fire still dodges — but the stand is the
    // most-shelled ground on the map, and an unclamped fear retreat is
    // exactly how the HoF kept wandering: shell → flee 30m → walk back
    // → shell. He sidesteps inside his leash, not across the field.
    if (fearing) {return retreatDest(ctx, pos, t);}
    // Hurt-runner health-pack divert tried and reverted: eHp rose
    // 33->37 but grabs collapsed 14->6 — the mid-run detour cost more
    // momentum/timing than the HP bought. eHp is a combat-power
    // problem, not a routing one.
    // A gem chase is a route, not a duel pause: while a pickup sits on
    // the goal line the feet keep walking it — fire and aim stay live
    // elsewhere, so the bot hunts THROUGH the pickup like a player
    // strafing past a gem mid-fight. Only an enemy planted on the
    // route itself earns the orbit (same blocker test the objective
    // commit uses).
    if (ctx.pickup && dist3(b.goalS.goal, ctx.pickup) < 30) {
      const pd = dist3(pos, ctx.pickup);
      const pg = dirXZ(ctx.pickup.x - pos.x, ctx.pickup.z - pos.z);
      const ptx = t.pos.x - pos.x, ptz = t.pos.z - pos.z;
      const ptd = Math.hypot(ptx, ptz) || 1;
      const onRoute = d <= b.h.orbitFar && (ptx * pg.x + ptz * pg.z) / ptd > 0.4;
      if (!onRoute || pd < 12) {return Object.assign({}, ctx.pickup);}
    }
    // The committed-route and crash-the-point rules live above the hunt
    // section (runner/wave always objective; anyone <40m crashes the
    // point), so a hunt that survives to here is by definition a duel
    // the objective hasn't claimed — no second gate needed.
    if (ctx.posted && ctx.objective && dist3(t.pos, ctx.objective) > ctx.posted) {
      return Object.assign({}, ctx.objective);
    }
    if (d < CLOSE_PRESS_M || d > b.h.orbitFar * (hero ? 0.7 : 1)) {
      // Point-blank or outranged: press straight in either way — inside
      // fist reach the press converts to the punch, outside it to the
      // approach. Holding the orbit at 2m would stare down a barrel.
      return Object.assign({}, t.pos);
    }
    // fightPos comes from the last replan tick — "hold" used to mean
    // stand still and shoot, which reads (and meters) as sheeping.
    // A held position now strafes: orbit the target inside the
    // preferred range band, cycling angle so the bot keeps moving
    // between volleys like a real duelist.
    b.holding = b.h.fightPos === null;
    if (b.h.fightPos) {return b.h.fightPos;}
    // The beat: settle and shoot, then swing wide. Direction flips and
    // radius jinks already break up the carousel; the cadence is what
    // makes it read like a duelist choosing a moment instead of a fan
    // blade orbiting on rails.
    b.beatT -= dt;
    if (b.beatT <= 0) {
      b.beatMove = !b.beatMove;
      b.beatT = b.beatMove ? 0.5 + botRand() * 0.5 : 0.9 + botRand() * 0.9;
    }
    b.orbitA += dt * (b.orbitDir * 0.55) * (b.beatMove ? 1.8 : 0.3);
    b.orbitFlipT -= dt;
    if (b.orbitFlipT <= 0) {
      b.orbitFlipT = 1.2 + botRand() * 1.4;
      b.orbitDir = -b.orbitDir;
      b.orbitMul = 0.75 + botRand() * 0.4; // jink in/out too — not just direction
    }
    const mid = (b.h.orbitFar + b.h.orbitClose) * 0.5 * b.orbitMul;
    // Open-flank rule: five bots on one target all carousel the same ring
    // at synced phases - a disc's AoE eats the whole stack. An orbit
    // sector an ally already owns gets skipped forward until it opens:
    // deterministic from ally positions, no registry, spreads the squad
    // around the target like a real flanking habit.
    for (let tries = 0; tries < 3; tries += 1) {
      const ox = t.pos.x + Math.cos(b.orbitA) * mid;
      const oz = t.pos.z + Math.sin(b.orbitA) * mid;
      let taken = false;
      for (const a of ctx.allies ?? []) {
        if ((a.x - ox) * (a.x - ox) + (a.z - oz) * (a.z - oz) < 12 * 12) {taken = true; break;}
      }
      if (!taken) {return { x: ox, y: ctx.groundY(ox, oz), z: oz };}
      b.orbitA += Math.PI / 3; // ~60° - hop to the next free sector
    }
    const ox = t.pos.x + Math.cos(b.orbitA) * mid;
    const oz = t.pos.z + Math.sin(b.orbitA) * mid;
    return { x: ox, y: ctx.groundY(ox, oz), z: oz };
  }

  /** Fortification pick: planting while a fight rages on the stand is
   *  suicide, but a defender watching a duel across the field still has
   *  hands free — the gate is "nobody close enough to interrupt", not
   *  "nobody visible at all" (a busy room never goes fully quiet, which
   *  starved the sense). */
// Station first when hurting; otherwise weighted by temperament roll.
function deployKind(roll: number, healthFrac: number): string {
  if (healthFrac < 0.4) {return 'station';}
  if (roll < 0.42) {return 'turret';}
  if (roll < 0.56) {return 'mortar';} // stand artillery - shells the approach lanes
  if (roll < 0.72) {return 'cgturret';} // suppression spray on the open ground
  if (roll < 0.78) {return 'loiter';} // the circling dart - hunts the lane, not just the stand
  if (roll < 0.83) {return 'spider';} // the ground scuttler - cheap chase, air is the counter
  if (roll < 0.87) {return 'jammer';} // bubble hides its side from the pulse mast
  if (roll < 0.92) {return 'motion';} // ring sensor - reads movement through cloak
  if (roll < 0.92) {return 'mine';}
  if (roll < 0.94) {return 'beacon';}
  if (roll < 0.96) {return 'tether';}
  if (roll < 0.97) {return 'pad';}
  if (roll < 0.98) {return 'watersphere';}
  if (roll < 0.99) {return 'shield';}
  return 'drone';
}

export function pickDeploy(b: BotBrain, dt: number, ctx: BrainCtx, pos: BotVec, fearing: boolean): BrainOut['deploy'] {
    b.deployT -= dt;
    const handsFree = !b.h.hunt || dist3(pos, b.h.hunt.pos) > 25;
    if (!b.builder || b.deployT > 0 || !handsFree || fearing || !ctx.objective) {return undefined;}
    if (dist3(pos, ctx.objective) >= b.deployObjR) {return undefined;}
    b.deployT = b.deployCdLo + botRand() * b.deployCdSpan;
    // A hurting builder drops a station first (it heals the squad);
    // otherwise the stand gets guns, a minefield, or a patrol drone
    // by temperament — drones roam the stand's perimeter so they're
    // the pick when the anchor is already watched.
    const kind = b.deployForce ?? deployKind(botRand(), ctx.healthFrac ?? 1);
    const a = botRand() * Math.PI * 2;
    const r = 4 + botRand() * 6;
    const px = pos.x + Math.cos(a) * r, pz = pos.z + Math.sin(a) * r;
    return { kind, pos: { x: px, y: ctx.groundY(px, pz), z: pz } };
  }

  /** Weld intent: a builder inside beam reach of the damaged item works
   *  on it — same cadence a human holds the trigger, and the host-side
   *  heal path re-validates range/LOS/team like any claim. The hunt and
   *  fear gates mirror pickDeploy: nobody welds through a firefight. */
export function pickRepair(b: BotBrain, ctx: BrainCtx, pos: BotVec, fearing: boolean): string | undefined {
    if (!b.builder || fearing || !ctx.repair) {return undefined;}
    if (b.h.hunt && dist3(pos, b.h.hunt.pos) <= 25) {return undefined;}
    if (dist3(pos, ctx.repair.pos) > REPAIR_RANGE * 0.9) {return undefined;}
    return ctx.repair.key;
  }

  /** Toggle-skill intent — the STATUS bits a legal client claims. Mend
   *  wins when hurt and unpressured — and while FLEEING: a retreat is
   *  exactly when a Tribes player channels, so fearing counts as the
   *  unpressured window even though the hunt is technically still live.
   *  Otherwise shield up in a real fight while the tank can carry the
   *  drain. Returns undefined when the host has no energy model. */
export function statusIntent(b: BotBrain, ctx: BrainCtx, fearing: boolean): number | undefined {
    if (ctx.energy === undefined || b.skillsOff) {return undefined;}
    // A pinned wall-mount needs the tank for jets — a held drain skill
    // keeps the tank sputter-locked at zero and the lip never mounts
    // (soak: shielded hunters pinned at the stand dais 5s+ cycles).
    if (b.mountWait) {return 0;}
    const fighting = b.h.hunt !== null;
    const hurt = (ctx.healthFrac ?? 1) < 0.6;
    // Shield is the hold-the-fight bubble - it eats the same tank jets
    // burn AND zeroes the recharge while held. A bot above jog speed is
    // moving with intent (ski line, chase, escape); shedding the bubble
    // there is what a player does before a jet. Below it, the bot is
    // planted in the exchange and the DR is worth the tank.
    const planted = isPlanted(ctx.vel);
    // Channel honesty: a bot channels only the skill it actually has
    // equipped - a dash-equipped fighter has no shield bubble to hold.
    // Hosts that never declare ctx.skill keep the legacy all-channels
    // read so nothing regresses on un-declared seats.
    const has = (s: string): boolean => ctx.skill === undefined || ctx.skill === s;
    let status = 0;
    if (hurt && (!fighting || fearing) && ctx.energy >= ENERGY.mendCost + 10 && has('medkit')) {status |= STATUS.MEND;}
    // REVERTED: SHIELD for committed runners inside 200m of the objective —
    // same-seed soak identical (5g/2c, eHp 44->42). The ring kill window is
    // crossfire volume, not a tank problem; shields already fire once the
    // hunt flags 'fighting' inside the ring anyway.
    else if (fighting && planted && ctx.energy >= ENERGY.shieldCost + 15 && has('shield')) {status |= STATUS.SHIELD;}
    // Infiltration cloak: pressing an enemy stand unseen beats shielding
    // through it. A WOUNDED infiltrator slips the veil back on while
    // retreating — the pest survives by breaking contact, not trading.
    if (ctx.infiltrating && (!fighting || fearing) && ctx.energy >= ENERGY.cloakCost + 15 && has('cloak')) {status |= STATUS.CLOAK;}
    return status;
  }


