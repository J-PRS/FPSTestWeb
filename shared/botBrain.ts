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
  enemies: BotEnemy[];
  /** Objective anchor (CTF flag/base) — outranks pickup and wander. */
  objective?: BotVec | null;
  /** Ground pickup to chase (nugget) — outranks wander. */
  pickup?: BotVec | null;
  /** Terrain height at x,z — wander waypoints clamp to ground. */
  groundY: (x: number, z: number) => number;
  /** Wall/sim time in ms — brain cooldowns key off this, not frames. */
  now: number;
}

export interface BrainOut {
  /** Where the caller should move the bot this step. */
  dest: BotVec;
  /** Fire command when the bot wants to shoot this step. */
  fire?: { targetId: string; aim: BotVec };
}

export const BOT_EYE = 1.6;
export const BOT_FIRE_RANGE = 45;
const THINK_S = 0.3;
const ORBIT_FAR = 22;    // orbit the target inside this ring distance
const ORBIT_TOO_CLOSE = 12;
const STALE_MS = 1200;   // last-seen older than this = stop firing blind
const FLINCH_S = 0.4;
const FLINCH_DIST = 8;

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
  private wanderWp: BotVec = { x: 0, y: 0, z: 0 };
  private wanderT = 0;

  /** Getting shot makes the bot recoil — call from the damage funnel. */
  takeHit(from: BotVec): void {
    this.flinchT = FLINCH_S;
    this.flinchFrom = { ...from };
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
        if (d < bestD) { bestD = d; best = e; }
      }
      this.hunt = best;
      if (best) {
        this.lastSeen = { ...best.pos };
        this.lastSeenVel = { ...best.vel };
        this.lastSeenAt = now;
      } else if (ctx.objective) {
        this.goal = { ...ctx.objective };
      } else if (ctx.pickup) {
        this.goal = { ...ctx.pickup };
      } else if (this.wanderT <= 0 || distSq(pos, this.wanderWp) < 9) {
        this.wanderT = 3 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2;
        const r = 15 + Math.random() * 40;
        this.wanderWp = {
          x: pos.x + Math.cos(a) * r,
          y: ctx.groundY(pos.x + Math.cos(a) * r, pos.z + Math.sin(a) * r) + BOT_EYE,
          z: pos.z + Math.sin(a) * r,
        };
        this.goal = { ...this.wanderWp };
      }
    }
    this.wanderT -= dt;

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
      if (d > ORBIT_FAR) {
        dest = { ...t.pos };
      } else {
        // Orbit at ring distance; back off when hugged.
        const ox = pos.x - t.pos.x, oz = pos.z - t.pos.z;
        const ol = Math.hypot(ox, oz) || 1;
        const px = -oz / ol, pz = ox / ol; // perpendicular
        dest = { x: pos.x + px * 6, y: pos.y, z: pos.z + pz * 6 };
        if (d < ORBIT_TOO_CLOSE) { dest.x += (ox / ol) * 4; dest.z += (oz / ol) * 4; }
      }
    } else {
      dest = this.goal;
    }

    // --- fire ---
    let fire: BrainOut['fire'];
    if (this.hunt && now - this.lastSeenAt <= STALE_MS) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        if (this.burstLeft <= 0) this.burstLeft = 3;
        this.burstLeft--;
        this.fireT = this.burstLeft > 0 ? 0.85 : 1.6 + Math.random();
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

    return { dest, fire };
  }
}

function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
