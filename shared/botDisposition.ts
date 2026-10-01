import { botRand } from './botRand.ts';
import { STATUS } from './status.ts';
import { ENERGY } from './movement.ts';
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
    if (!b.h.hunt) return b.goalS.goal;
    const t = b.h.hunt;
    const d = dist3(pos, t.pos);
    if (fearing) return retreatDest(ctx, pos, t);
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
    // through it — cloak only while the approach is still covert (no
    // hunt target), so contact drops the veil the tick fighting starts.
    else if (ctx.infiltrating && !fighting && ctx.energy >= ENERGY.cloakCost + 15) status |= STATUS.CLOAK;
    return status;
  }


