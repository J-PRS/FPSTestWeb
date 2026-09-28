/**
 * BotBrain — the shared decision core for every fake player, offline
 * (client GameBot) and online (server_bun ServerBots). Pure logic on plain
 * vectors: no THREE, no sockets, no scene — both runtimes supply those at
 * the edges and consume the same "where to move / when to fire / where to
 * aim" answers, so bot personality is tuned once and ships to both.
 *
 * Contract: call think(dt, ctx) once per tick/frame with the bot's current
 * position and world snapshot; it returns a movement destination and, when
 * it wants to shoot, a fire command { targetId, aim }. The caller owns
 * locomotion, the visual, and resolving the hit.
 */

import { STATUS } from './status.ts';
import { ENERGY } from './movement.ts';

export interface BotVec { x: number; y: number; z: number }

export interface BotEnemy {
  id: string;
  pos: BotVec;
  vel: BotVec;
  alive: boolean;
}

export interface BrainCtx {
  /** The bot's own position. */
  pos: BotVec;
  /** The bot's own velocity — ski policy keys off speed, jet off climbs. */
  vel?: BotVec;
  enemies: BotEnemy[];
  /** Objective anchor (CTF flag/base) — outranks pickup and wander. */
  objective?: BotVec | null;
  /** Ground pickup to chase (nugget) — outranks wander. */
  pickup?: BotVec | null;
  /** Terrain height at x,z — wander waypoints clamp to ground. */
  groundY: (x: number, z: number) => number;
  /** Nearby bodies (allies, the local player, self ok — skipped by
   *  distance) for the separation sense. Optional; steering works
   *  without it. */
  others?: BotVec[];
  /** Wall/sim time in ms — brain cooldowns key off this, not frames. */
  now: number;
  /** Modeled energy tank (server shadow truth) — skills/jet gate on it.
   *  Omitted on hosts without an energy model; hints assume a full tank. */
  energy?: number;
  /** Own health as a 0..1 fraction — mend decision input. */
  healthFrac?: number;
  /** Positions of projectiles closing on the bot (host pre-filters to
   *  inbound shells) — the dodge sense. Omit where no projectile sim
   *  exists (offline bots, legacy path). */
  threats?: BotVec[];
  /** Recent loud events within earshot (host pre-filters radius + age) —
   *  the hearing sense. No LOS required: a fight over the ridge pulls
   *  an idle bot toward it, which is how scouting emerges. */
  sounds?: BotVec[];
}

export interface BrainOut {
  /** Where the caller should move the bot this step. */
  dest: BotVec;
  /** Legal-input hints for the host sim — same keys a human holds.
   *  Omitted fields mean "not held". */
  move?: { ski?: boolean; jet?: boolean; jump?: boolean };
  /** Fire command when the bot wants to shoot this step. */
  fire?: { targetId: string; aim: BotVec };
  /** Claimed toggle bits — same STATUS mask a human's inputMove carries.
   *  The host applies rising-edge antes + drains, so the brain only
   *  picks bits it can afford; omit → keep current status. */
  status?: number;
  /** Belt throw this step (grenade arc at the hunt target). */
  belt?: boolean;
}

export const BOT_EYE = 1.6;
export const BOT_FIRE_RANGE = 45;
const THINK_S = 0.3;
const ORBIT_FAR = 22;    // orbit the target inside this ring distance
const ORBIT_TOO_CLOSE = 12;
const STALE_MS = 1200;   // last-seen older than this = stop firing blind
const FLINCH_S = 0.4;
const FLINCH_DIST = 8;
const DODGE_RANGE = 12;  // m — only react to shells already inbound
const DODGE_STEP = 9;    // m — lateral hop, ~one body-length burst

// --- context steering senses ---
const SLOTS = 16;        // directions sampled around the circle
const PROBE_A = 4;       // m — near slope probe
const PROBE_B = 9;       // m — far probe catches ridgelines early
const STEP = 8;          // m — steering lookahead distance
const SEP_RANGE = 7;     // m — personal space vs other bodies
const MEM_MS = 4000;     // recently-visited ground repels for this long
const MEM_RANGE = 12;    // m — memory trail influence radius
const DEATH_MS = 30000;  // a death spot stays scary this long
const DEATH_RANGE = 15;  // m — repel radius around each remembered death

/** Heightfield LOS — march the eye→target line, fail where ground rises
 *  above it. pos.y is eye-height on the client and near-feet on the
 *  server, so the eye point is whichever is higher of pos.y and
 *  ground+eye. Structures aren't modeled — callers don't hand them in —
 *  so this is "can I see over the terrain", not full occlusion. */
function losClear(ctx: BrainCtx, from: BotVec, to: BotVec): boolean {
  const dx = to.x - from.x, dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 4) return true; // point-blank: probes are coarser than the gap
  const steps = Math.ceil(dist / 3);
  const y0 = Math.max(from.y + 0.4, ctx.groundY(from.x, from.z) + BOT_EYE);
  const y1 = Math.max(to.y + 0.4, ctx.groundY(to.x, to.z) + BOT_EYE);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t, z = from.z + dz * t;
    if (ctx.groundY(x, z) > y0 + (y1 - y0) * t + 0.5) return false;
  }
  return true;
}

export class BotBrain {
  /** Set the spawn point as the initial goal. */
  constructor(spawn: BotVec) {
    this.goal = { ...spawn };
    this.lastSeen = { ...spawn };
  }

  private thinkT = Math.random() * THINK_S;
  private goal: BotVec;
  private hunt: BotEnemy | null = null;
  private lastSeen: BotVec;
  private lastSeenVel: BotVec = { x: 0, y: 0, z: 0 };
  private lastSeenAt = 0;
  private fireT = 0;
  private burstLeft = 0;
  private flinchT = 0;
  private flinchFrom: BotVec = { x: 0, y: 0, z: 0 };
  // Revenge — after the recoil ends the bot pushes toward the attacker's
  // position: ambushes get answered, not just absorbed.
  private revengeT = 0;
  private revengeFrom: BotVec = { x: 0, y: 0, z: 0 };
  private wanderWp: BotVec = { x: 0, y: 0, z: 0 };
  private wanderT = 0;
  private beltT = 4 + Math.random() * 4; // stagger first throws across the squad
  private progressPos: BotVec = { x: 0, y: 0, z: 0 };
  private progressT = 0;
  private detour: BotVec | null = null;
  private detourT = 0;
  private heading = { x: 1, z: 0 };
  private memory: { x: number; z: number; t: number }[] = [];
  private memT = 0;
  // Death memory — where the host reported this body dying. Souring
  // goals near a death spot is how map denial emerges: nobody scripts
  // "that corner is dangerous", the squad just stops wandering back.
  private deaths: { x: number; z: number; t: number }[] = [];

  /** Host reports the bot's corpse spot on death. */
  markDeath(pos: BotVec): void {
    this.deaths.push({ x: pos.x, z: pos.z, t: Date.now() });
    if (this.deaths.length > 8) this.deaths.shift();
  }

  /** Is p within the repel radius of a recent death? */
  private nearDeath(p: { x: number; z: number }): boolean {
    const now = Date.now();
    for (const d of this.deaths) {
      if (now - d.t > DEATH_MS) continue;
      const dx = p.x - d.x, dz = p.z - d.z;
      if (dx * dx + dz * dz < DEATH_RANGE * DEATH_RANGE) return true;
    }
    return false;
  }
  // Personality scalars — ±20-30% per bot so a squad doesn't read as one
  // centipede: different preferred ranges, wander appetites, tempers.
  private readonly orbitFar = ORBIT_FAR * (0.85 + Math.random() * 0.3);
  private readonly orbitClose = ORBIT_TOO_CLOSE * (0.85 + Math.random() * 0.3);
  private readonly wanderlust = 0.7 + Math.random() * 0.6;
  private readonly temper = 0.7 + Math.random() * 0.6; // fire-cadence scale
  private fightPos: BotVec | null = null; // combat spot from the last replan

  /** Current hunt target — the belt intent carries no aim of its own,
   *  so hosts resolve the throw's arc off this. */
  get currentHuntId(): string | null {
    return this.hunt?.id ?? null;
  }

  /** Getting shot makes the bot recoil — call from the damage funnel. */
  takeHit(from: BotVec): void {
    this.flinchT = FLINCH_S;
    this.flinchFrom = { ...from };
    this.revengeT = 2.5;
    this.revengeFrom = { ...from };
  }

  think(dt: number, ctx: BrainCtx): BrainOut {
    const pos = ctx.pos;
    const now = ctx.now;

    // --- pick a hunt target / refresh the goal (slow cadence) ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = THINK_S;
      let best: BotEnemy | null = null;
      let bestD = BOT_FIRE_RANGE;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const d = dist3(pos, e.pos);
        // No wallhack: only acquire what the eye line can actually see.
        // An occluded enemy clears the hunt entirely — breaking LOS behind
        // a ridge shakes pursuit like it would a human.
        if (d < bestD && losClear(ctx, pos, e.pos)) { bestD = d; best = e; }
      }
      this.hunt = best;
      if (best) {
        this.lastSeen = { ...best.pos };
        this.lastSeenVel = { ...best.vel };
        this.lastSeenAt = now;
      }
      // Combat replan rides the slow cadence — the ring eval is the
      // expensive part (LOS per candidate per enemy) and 3Hz is plenty
      // for position keeping.
      this.fightPos = null;
      if (best && dist3(pos, best.pos) <= this.orbitFar) {
        this.fightPos = this.pickFightPos(ctx, pos, best);
      }
      if (!best) this.pickGoal(ctx, pos);
    }
    this.wanderT -= dt;
    // detourT decays here, with the other timers — decrementing it inside
    // the dest block below would let the setting call's dt eat the window.
    this.detourT -= dt;
    this.revengeT -= dt;

    // --- choose the step destination ---
    let dest: BotVec;
    if (this.flinchT > 0) {
      this.flinchT -= dt;
      const fx = pos.x - this.flinchFrom.x, fz = pos.z - this.flinchFrom.z;
      const l = Math.hypot(fx, fz) || 1;
      dest = { x: pos.x + (fx / l) * FLINCH_DIST, y: pos.y, z: pos.z + (fz / l) * FLINCH_DIST };
    } else if (this.hunt) {
      const t = this.hunt;
      const d = dist3(pos, t.pos);
      if (d > this.orbitFar) {
        dest = { ...t.pos };
      } else {
        // fightPos comes from the last replan tick — no pick yet (or the
        // pick was "hold") means stand and shoot.
        dest = this.fightPos ?? { ...pos };
      }
    } else {
      dest = this.goal;
    }

    // --- context steering: senses score every direction ---
    dest = this.steer(dt, ctx, pos, dest);

    // Stuck break — no progress for 1.5s means the straight line is
    // blocked (structure, cliff, another bot). Sidestep perpendicular to
    // the goal for a beat; random side per incident keeps herds from
    // detouring in lockstep.
    this.progressT += dt;
    if (this.progressT >= 1.5) {
      this.progressT = 0;
      if (distSq(pos, this.progressPos) < 2.25 && this.detourT <= 0) {
        const gx = this.goal.x - pos.x, gz = this.goal.z - pos.z;
        const gl = Math.hypot(gx, gz) || 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const dx = (-gz / gl) * side * 14, dz = (gx / gl) * side * 14;
        this.detour = { x: pos.x + dx, y: ctx.groundY(pos.x + dx, pos.z + dz) + BOT_EYE, z: pos.z + dz };
        this.detourT = 1.2;
      }
      this.progressPos = { ...pos };
    }
    if (this.detourT > 0 && this.detour) {
      dest = this.detour;
    }

    // --- dodge: sidestep the nearest closing shell ---
    // A perpendicular step dodges a ballistic arc without abandoning the
    // fight; the side that keeps current momentum wins (dodging backward
    // through your own velocity reads as a stumble, not a juke).
    let nearest: BotVec | null = null;
    let nearestD = DODGE_RANGE;
    for (const t of ctx.threats ?? []) {
      const d = dist3(pos, t);
      if (d < nearestD) { nearestD = d; nearest = t; }
    }
    if (nearest) {
      const tx = pos.x - nearest.x, tz = pos.z - nearest.z;
      const tl = Math.hypot(tx, tz) || 1;
      const vx = ctx.vel?.x ?? 0, vz = ctx.vel?.z ?? 0;
      const side = (vx * -tz + vz * tx) * tl >= 0 ? 1 : -1; // keep momentum
      dest = {
        x: pos.x + (-tz / tl) * side * DODGE_STEP,
        y: pos.y,
        z: pos.z + (tx / tl) * side * DODGE_STEP,
      };
    }

    // --- fire ---
    let fire: BrainOut['fire'];
    if (this.hunt && now - this.lastSeenAt <= STALE_MS) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        if (this.burstLeft <= 0) this.burstLeft = 3;
        this.burstLeft--;
        this.fireT = (this.burstLeft > 0 ? 0.85 : 1.6 + Math.random()) / this.temper;
        const d = dist3(pos, this.lastSeen);
        const err = 0.5 + Math.hypot(this.lastSeenVel.x, this.lastSeenVel.y, this.lastSeenVel.z) * 0.1 + d * 0.02;
        fire = {
          targetId: this.hunt.id,
          aim: {
            x: this.lastSeen.x + this.lastSeenVel.x * (d / 60) + (Math.random() - 0.5) * err,
            y: this.lastSeen.y + this.lastSeenVel.y * (d / 60) + (Math.random() - 0.5) * err * 0.5,
            z: this.lastSeen.z + this.lastSeenVel.z * (d / 60) + (Math.random() - 0.5) * err,
          },
        };
      }
    }

    // --- belt: lob a grenade into a mid-range fight on a slow cooldown ---
    this.beltT -= dt;
    let belt = false;
    if (this.hunt && this.beltT <= 0 && now - this.lastSeenAt <= STALE_MS) {
      const d = dist3(pos, this.lastSeen);
      if (d > 10 && d < 35) { belt = true; this.beltT = 9; }
    }

    return { dest, move: this.moveHints(ctx, pos, dest), fire, status: this.statusIntent(ctx), belt };
  }

  /** Idle-goal selection, in priority order: objective > pickup >
   *  heard fight > wander. Runs on the slow think cadence. */
  private pickGoal(ctx: BrainCtx, pos: BotVec): void {
    if (this.revengeT > 0) {
      // Hit from somewhere unseen: push toward the shooter rather than
      // continue a patrol — the flinch already spent the recoil.
      this.goal = { ...this.revengeFrom };
    } else if ((ctx.healthFrac ?? 1) < 0.4 && ctx.others && ctx.others.length > 0) {
      // Hurt with nobody shooting back at: fold toward the nearest body.
      // Safety-in-numbers emerges — nobody scripts a retreat.
      let ally: BotVec | null = null;
      let ad = Infinity;
      for (const o of ctx.others) {
        const d = distSq(pos, o);
        if (d < ad && d > 4) { ad = d; ally = o; }
      }
      if (ally) this.goal = { ...ally };
    } else if (ctx.objective) {
      this.goal = { ...ctx.objective };
    } else if (ctx.pickup) {
      this.goal = { ...ctx.pickup };
    } else if (ctx.sounds && ctx.sounds.length > 0) {
      // Heard a fight: investigate the nearest noise. Curiosity is a
      // personality roll so a squad doesn't stampede as one.
      let loudest: BotVec | null = null;
      let ld = Infinity;
      for (const s of ctx.sounds) {
        const d = distSq(pos, s);
        if (d < ld) { ld = d; loudest = s; }
      }
      if (loudest && Math.random() < this.wanderlust * 0.5) this.goal = { ...loudest };
    } else if (this.wanderT <= 0 || distSq(pos, this.wanderWp) < 9) {
      this.wanderT = (3 + Math.random() * 4) / this.wanderlust;
      // Roll a few candidate waypoints; the first one away from a death
      // spot wins. Falling through keeps the last goal — a bot that died
      // wandering simply keeps moving somewhere else.
      for (let tries = 0; tries < 3; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = (15 + Math.random() * 40) * this.wanderlust;
        const wp = { x: pos.x + Math.cos(a) * r, z: pos.z + Math.sin(a) * r };
        if (this.nearDeath(wp)) continue;
        this.wanderWp = {
          x: wp.x,
          y: ctx.groundY(wp.x, wp.z) + BOT_EYE,
          z: wp.z,
        };
        this.goal = { ...this.wanderWp };
        break;
      }
    }
  }

  /** Toggle-skill intent — the STATUS bits a legal client claims. Mend
   *  wins: hurt + unpressured + can afford the ante. Otherwise shield up
   *  in a real fight while the tank can carry the drain. Returns
   *  undefined when the host has no energy model (offline bots). */
  private statusIntent(ctx: BrainCtx): number | undefined {
    if (ctx.energy === undefined) return undefined;
    const fighting = this.hunt !== null;
    const hurt = (ctx.healthFrac ?? 1) < 0.6;
    let status = 0;
    if (!fighting && hurt && ctx.energy >= ENERGY.mendCost + 10) status |= STATUS.MEND;
    else if (fighting && ctx.energy >= ENERGY.shieldCost + 15) status |= STATUS.SHIELD;
    return status;
  }

  /** Ski/jet/jump as the same buttons a human presses: ski downhill or
   *  when already fast, jet when the goal sits above a climbable wall,
   *  jump when an uphill stall is the blocker (pairs with detour). */
  private moveHints(ctx: BrainCtx, pos: BotVec, dest: BotVec): BrainOut['move'] {
    const dx = dest.x - pos.x, dz = dest.z - pos.z;
    const gd = Math.hypot(dx, dz);
    if (gd < 0.5) return { ski: false, jet: false, jump: false };
    const nx = dx / gd, nz = dz / gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    const ahead = ctx.groundY(pos.x + nx * 6, pos.z + nz * 6);
    const rise = ahead - g0;
    const speed = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    const airborne = pos.y - g0 > 2;
    // Jet when the way ahead climbs faster than running covers — or the
    // hunt target is clearly airborne and pursuit needs altitude.
    const uphill = rise > 3;
    const targetHigh = this.hunt ? this.hunt.pos.y - pos.y > 6 : false;
    // Jet respects the tank — below the reserve the bot saves energy for
    // skills rather than hovering dry at the wall.
    const tanked = ctx.energy === undefined || ctx.energy > 15;
    return {
      ski: rise < -0.5 || speed > 8 || airborne,
      jet: (uphill || targetHigh) && speed > 0.5 && tanked,
      // Uphill + near-stationary = hop it; autohop chains the rest.
      jump: uphill && speed < 3 && !airborne,
    };
  }

  /** Killzone-style position pick: score a ring of candidate spots by
   *  LOS to the target, preferred range band, exposure to the rest of
   *  the enemy roster, and climbable ground. Standing still is candidate
   *  0 with an inertia bonus, so a good spot is kept instead of orbiting
   *  for orbit's sake. Returns null to hold position. */
  private pickFightPos(ctx: BrainCtx, pos: BotVec, t: BotEnemy): BotVec | null {
    const mid = (this.orbitFar + this.orbitClose) * 0.5;
    const g0 = ctx.groundY(pos.x, pos.z);
    let bx = pos.x, bz = pos.z;
    let bs = this.scorePos(ctx, pos, pos, t, mid, g0) + 0.4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const cx = pos.x + Math.cos(a) * 10, cz = pos.z + Math.sin(a) * 10;
      const cy = ctx.groundY(cx, cz);
      if (cy - g0 > 4) continue; // can't stand there
      const s = this.scorePos(ctx, pos, { x: cx, y: cy + BOT_EYE, z: cz }, t, mid, cy);
      if (s > bs) { bs = s; bx = cx; bz = cz; }
    }
    if (Math.hypot(bx - pos.x, bz - pos.z) < 3) return null;
    return { x: bx, y: pos.y, z: bz };
  }

  /** Score one candidate position for the combat picker: LOS to the hunt
   *  target (a spot that can't see it is cover — mildly bad on offense),
   *  closeness to the preferred range band, exposure to every OTHER enemy
   *  that could see the spot, and how much vertical scrambling it needs. */
  private scorePos(ctx: BrainCtx, self: BotVec, cand: BotVec, t: BotEnemy, mid: number, candGround: number): number {
    const dt = dist3(cand, t.pos);
    let s = losClear(ctx, cand, t.pos) ? 2 : -1.5;
    s -= Math.abs(dt - mid) * 0.08;
    for (const e of ctx.enemies) {
      if (!e.alive || e === t) continue;
      if (losClear(ctx, cand, e.pos)) s -= 0.6; // a second gun covers this spot
    }
    s -= Math.abs(candGround - ctx.groundY(self.x, self.z)) * 0.05;
    return s;
  }

  /** Context steering — every direction is scored instead of testing
   *  just the goal line. Interest comes from goal alignment and current
   *  heading (momentum); danger comes from slope probes, bodies in the
   *  way, and recently-visited ground (the memory trail, which is what
   *  lets a bot escape a local minimum instead of orbitting it).
   *  Danger masks interest; the best surviving slot wins, and the result
   *  is blended with the last heading so 22.5° slot granularity never
   *  shows as jitter. */
  private steer(dt: number, ctx: BrainCtx, pos: BotVec, dest: BotVec): BotVec {
    let gx = dest.x - pos.x, gz = dest.z - pos.z;
    const gd = Math.hypot(gx, gz);
    if (gd < 0.5) return dest;
    gx /= gd; gz /= gd;
    const g0 = ctx.groundY(pos.x, pos.z);
    const now = ctx.now;

    // Lay the trail, then drop crumbs that are stale or out of range.
    this.memT -= dt;
    if (this.memT <= 0) {
      this.memT = 0.4;
      this.memory.push({ x: pos.x, z: pos.z, t: now });
      if (this.memory.length > 24) this.memory.shift();
    }
    this.memory = this.memory.filter(
      (m) => now - m.t < MEM_MS && (m.x - pos.x) ** 2 + (m.z - pos.z) ** 2 < MEM_RANGE * MEM_RANGE,
    );

    let bestX = gx, bestZ = gz, bestScore = -1;
    let safeX = gx, safeZ = gz, safeDanger = 2;
    for (let i = 0; i < SLOTS; i++) {
      const a = (i / SLOTS) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);

      const align = dx * gx + dz * gz;
      let interest = Math.max(0, align);
      interest *= interest; // sharpen: prefer near-goal arcs over drift
      interest += 0.25 * Math.max(0, dx * this.heading.x + dz * this.heading.z);

      let danger = 0;
      const riseA = ctx.groundY(pos.x + dx * PROBE_A, pos.z + dz * PROBE_A) - g0;
      const riseB = ctx.groundY(pos.x + dx * PROBE_B, pos.z + dz * PROBE_B) - g0;
      const slope = Math.max(riseA / PROBE_A, riseB / PROBE_B);
      if (slope > 0.45) danger = Math.min(1, danger + (slope - 0.45) * 2);
      if (riseA < -12) danger = Math.min(1, danger + 0.5); // sheer drop

      if (ctx.others) {
        for (const o of ctx.others) {
          const ox = o.x - pos.x, oz = o.z - pos.z;
          const od = Math.hypot(ox, oz);
          if (od > SEP_RANGE || od < 0.01) continue;
          const toward = dx * (ox / od) + dz * (oz / od);
          if (toward > 0.5) danger = Math.min(1, danger + toward * (1 - od / SEP_RANGE));
        }
      }
      for (const m of this.memory) {
        const mx = m.x - pos.x, mz = m.z - pos.z;
        const md = Math.hypot(mx, mz);
        if (md > MEM_RANGE || md < 0.5) continue;
        const toward = dx * (mx / md) + dz * (mz / md);
        if (toward > 0.5) {
          danger = Math.min(1, danger + toward * 0.2 * (1 - md / MEM_RANGE) * (1 - (now - m.t) / MEM_MS));
        }
      }

      const score = interest * (1 - danger);
      if (score > bestScore) { bestScore = score; bestX = dx; bestZ = dz; }
      if (danger < safeDanger) { safeDanger = danger; safeX = dx; safeZ = dz; }
    }

    // Every slot masked → take the least-dangerous one; a standstill is
    // worse than a sideways shuffle.
    if (bestScore <= 0.001) { bestX = safeX; bestZ = safeZ; }

    // Blend with the previous heading — smooths slot-to-slot jitter while
    // the momentum term above keeps real turns responsive.
    const mx = bestX * 0.7 + this.heading.x * 0.3;
    const mz = bestZ * 0.7 + this.heading.z * 0.3;
    const ml = Math.hypot(mx, mz) || 1;
    this.heading.x = mx / ml; this.heading.z = mz / ml;
    const step = Math.min(gd, STEP);
    return { x: pos.x + this.heading.x * step, y: pos.y, z: pos.z + this.heading.z * step };
  }
}

function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
