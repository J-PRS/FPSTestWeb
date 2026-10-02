import { botRand } from './botRand.ts';
import { STATUS } from './status.ts';
import { ENERGY } from './movement.ts';
import { REPAIR_RANGE } from './weapons.ts';
import { retreatDest } from './botHunt.ts';
import type { BotVec, BrainCtx, BrainOut, BotBrain } from './botBrain.ts';
import { dist3 } from './botVec.ts';

const CLOSE_PRESS_M = 6; // inside this the orbit breaks — press to fist range
const FLINCH_DIST = 8;

// Disposition family — step destination (flinch knock > hunt
// press/retreat/orbit > goal), the fortification pick, and the
// toggle-skill intent. BotBrain is the host; these take it flat.

  /** Step destination: flinch knock > hunt press/retreat/orbit > goal. */
export function pickDest(b: BotBrain, dt: number, ctx: BrainCtx, pos: BotVec, fearing: boolean, hero: boolean): BotVec {
    b.holding = false;
    if (b.flinchT > 0) {
      b.flinchT -= dt;
      const fx = pos.x - b.flinchFrom.x, fz = pos.z - b.flinchFrom.z;
      const l = Math.hypot(fx, fz) || 1;
      return { x: pos.x + (fx / l) * FLINCH_DIST, y: pos.y, z: pos.z + (fz / l) * FLINCH_DIST };
    }
    // Carrying the objective: the run is the job — engaging whoever the
    // hunt found converts the carrier into a duelist mid-route (orbit
    // fights won fights but lost flags). fire stays live elsewhere in
    // the pipeline; only the feet commit to the line.
    if (ctx.running && ctx.objective) return { ...ctx.objective };
    // Last-leg commitment beats self-preservation: inside ~40m of the
    // objective a wounded bot still crashes the point — dying with the
    // flag in hand beats surviving the approach. Only the feet commit;
    // fire stays live elsewhere.
    if (ctx.objective && dist3(pos, ctx.objective) < 40) return { ...ctx.objective };
    if (!b.h.hunt) {
      // A builder with hands free welds the stand's wounded gear before
      // wandering on — same "nobody close enough to interrupt" gate the
      // emplacement pick uses (a weld under fire is a feeding run).
      if (b.builder && !fearing && ctx.repair) return ctx.repair.pos;
      // Quiet-map drift: with no hunt, no objective and no gem, pull the
      // wander toward wherever the action last scented — fleets that
      // only walk nav lines never meet. A pull, not a commit: the roam
      // goal still leads, the scent just bends it.
      const hot = ctx.imapHottest?.(pos);
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
    if (fearing) return retreatDest(ctx, pos, t);
    // A gem chase is a route, not a duel pause: while a pickup sits on
    // the goal line the feet keep walking it — fire and aim stay live
    // elsewhere, so the bot hunts THROUGH the pickup like a player
    // strafing past a gem mid-fight. Only an enemy planted on the
    // route itself earns the orbit (same blocker test the objective
    // commit uses).
    if (ctx.pickup && dist3(b.goalS.goal, ctx.pickup) < 30) {
      const pd = dist3(pos, ctx.pickup);
      const pgx = (ctx.pickup.x - pos.x) / (pd || 1), pgz = (ctx.pickup.z - pos.z) / (pd || 1);
      const ptx = t.pos.x - pos.x, ptz = t.pos.z - pos.z;
      const ptd = Math.hypot(ptx, ptz) || 1;
      const onRoute = d <= b.h.orbitFar && (ptx * pgx + ptz * pgz) / ptd > 0.4;
      if (!onRoute || pd < 12) return { ...ctx.pickup };
    }
    // Mission commitment — capper-role only: the feet stay on the line
    // unless an enemy actually sits on the route, at ANY distance —
    // inside the stand ring a visible defender still only earns feet
    // when he's on the flag line itself (pressing that blocker runs
    // through the flag anyway). The old >120m gate let close-in duels
    // steal the last 10m: soaks showed cappers orbiting ~9m off the
    // flag with zero grabs (fleet-wide muting is still wrong —
    // blocking-or-bypass is the rule, not silence).
    if (ctx.objective) {
      const gd = dist3(pos, ctx.objective);
      // Who earns committed feet: cappers anywhere on the route; any bot
      // whose objective IS the stand once inside ~40m — an opportunistic
      // grab beats an opportunistic duel at that range (the capper role
      // existing doesn't mean it's alive, so the last leg can't be
      // role-gated).
      const committed = ctx.runner || gd < 40;
      if (committed) {
        // Inside the last leg the blocker test flips against you: a
        // defender planted ON the flag is "blocking" by definition, so
        // orbiting him concedes the grab. Crash the point — the touch
        // is instant; surviving the approach is what speed is for.
        if (gd < 40) return { ...ctx.objective };
        const gx = (ctx.objective.x - pos.x) / gd, gz = (ctx.objective.z - pos.z) / gd;
        const tx = t.pos.x - pos.x, tz = t.pos.z - pos.z;
        const td = Math.hypot(tx, tz) || 1;
        const blocking = d <= b.h.orbitFar && (tx * gx + tz * gz) / td > 0.4;
        if (!blocking) return { ...ctx.objective };
      }
    }
    if (d < CLOSE_PRESS_M || d > b.h.orbitFar * (hero ? 0.7 : 1)) {
      // Point-blank or outranged: press straight in either way — inside
      // fist reach the press converts to the punch, outside it to the
      // approach. Holding the orbit at 2m would stare down a barrel.
      return { ...t.pos };
    }
    // fightPos comes from the last replan tick — "hold" used to mean
    // stand still and shoot, which reads (and meters) as sheeping.
    // A held position now strafes: orbit the target inside the
    // preferred range band, cycling angle so the bot keeps moving
    // between volleys like a real duelist.
    b.holding = b.h.fightPos === null;
    if (b.h.fightPos) return b.h.fightPos;
    b.orbitA += dt * (b.orbitDir * 0.55);
    b.orbitFlipT -= dt;
    if (b.orbitFlipT <= 0) {
      b.orbitFlipT = 1.2 + botRand() * 1.4;
      b.orbitDir = -b.orbitDir;
      b.orbitMul = 0.75 + botRand() * 0.4; // jink in/out too — not just direction
    }
    const mid = (b.h.orbitFar + b.h.orbitClose) * 0.5 * b.orbitMul;
    const ox = t.pos.x + Math.cos(b.orbitA) * mid;
    const oz = t.pos.z + Math.sin(b.orbitA) * mid;
    return { x: ox, y: ctx.groundY(ox, oz), z: oz };
  }

  /** Fortification pick: planting while a fight rages on the stand is
   *  suicide, but a defender watching a duel across the field still has
   *  hands free — the gate is "nobody close enough to interrupt", not
   *  "nobody visible at all" (a busy room never goes fully quiet, which
   *  starved the sense). */
export function pickDeploy(b: BotBrain, dt: number, ctx: BrainCtx, pos: BotVec, fearing: boolean): BrainOut['deploy'] {
    b.deployT -= dt;
    const handsFree = !b.h.hunt || dist3(pos, b.h.hunt.pos) > 25;
    if (!b.builder || b.deployT > 0 || !handsFree || fearing || !ctx.objective) return undefined;
    if (dist3(pos, ctx.objective) >= 15) return undefined;
    b.deployT = 28 + botRand() * 20;
    // A hurting builder drops a station first (it heals the squad);
    // otherwise the stand gets guns, a minefield, or a patrol drone
    // by temperament — drones roam the stand's perimeter so they're
    // the pick when the anchor is already watched.
    const roll = botRand();
    const kind: string = (ctx.healthFrac ?? 1) < 0.4 ? 'station'
      : roll < 0.55 ? 'turret' : roll < 0.85 ? 'mine' : 'drone';
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
    if (!b.builder || fearing || !ctx.repair) return undefined;
    if (b.h.hunt && dist3(pos, b.h.hunt.pos) <= 25) return undefined;
    if (dist3(pos, ctx.repair.pos) > REPAIR_RANGE * 0.9) return undefined;
    return ctx.repair.key;
  }

  /** Toggle-skill intent — the STATUS bits a legal client claims. Mend
   *  wins when hurt and unpressured — and while FLEEING: a retreat is
   *  exactly when a Tribes player channels, so fearing counts as the
   *  unpressured window even though the hunt is technically still live.
   *  Otherwise shield up in a real fight while the tank can carry the
   *  drain. Returns undefined when the host has no energy model. */
export function statusIntent(b: BotBrain, ctx: BrainCtx, fearing: boolean): number | undefined {
    if (ctx.energy === undefined) return undefined;
    const fighting = b.h.hunt !== null;
    const hurt = (ctx.healthFrac ?? 1) < 0.6;
    let status = 0;
    if (hurt && (!fighting || fearing) && ctx.energy >= ENERGY.mendCost + 10) status |= STATUS.MEND;
    else if (fighting && ctx.energy >= ENERGY.shieldCost + 15) status |= STATUS.SHIELD;
    // Infiltration cloak: pressing an enemy stand unseen beats shielding
    // through it. A WOUNDED infiltrator slips the veil back on while
    // retreating — the pest survives by breaking contact, not trading.
    if (ctx.infiltrating && (!fighting || fearing) && ctx.energy >= ENERGY.cloakCost + 15) status |= STATUS.CLOAK;
    return status;
  }


