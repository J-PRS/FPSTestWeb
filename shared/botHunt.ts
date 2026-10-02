/**
 * BotHunt — the combat half of BotBrain, pulled out so the brain file
 * stays readable: line-of-sight (terrain march + structure solids with a
 * cell-keyed memo), target acquisition (scanVisible/pickHunt), the
 * killzone position pick (pickFightPos/scorePos), volley cadence + the
 * ballistic-lead aim (pickFire), and the retreat destination.
 *
 * All of it runs on a HuntState bag the brain owns — free functions
 * rather than a second class because there's exactly one state per bot.
 */

import { botRand } from './botRand.ts';
import { GRAVITY } from './movement.ts';
import { rollSkill, type BotSkill } from './botSkill.ts';
import { losClear, BOT_EYE } from './botLos.ts';
import type { BotVec, BotEnemy, BrainCtx, BrainOut } from './botBrain.ts';

// LOS lives in botLos.ts — re-export so botBrain's public surface stays put.
export { losClear, losMemoReset, BOT_EYE } from './botLos.ts';
export const BOT_FIRE_RANGE = 45;
// Default aim offset from the eye position to a medium's capsule center —
// hosts that don't report per-target aimY still land center-mass.
const CENTER_AIM_Y = -0.9;
// Creatures are big, slow, and fly — a human plinks them past the normal
// duel range, so the farming reach runs longer (3D distance still applies:
// a beast parked 80m overhead is out of reach until it swoops).
const CREATURE_FIRE_RANGE = 65;
// Non-economy rooms don't farm, but a swarm gnawing the bot's legs is a
// threat in every mode — creatures inside this radius are always huntable.
const CREATURE_DEFENSE_M = 30;
const THREAT_M = 55; // a player inside this radius always outranks farming
// A creature literally on top of the bot beats even a close player —
// answer what's biting before what's shooting.
const CREATURE_URGENT_M = 14;
const ORBIT_FAR = 22;    // orbit the target inside this ring distance
const ORBIT_TOO_CLOSE = 12;
export const STALE_MS = 1200;   // last-seen older than this = stop firing blind
// Pursuit: breaking LOS shouldn't instantly reset to the goal ladder —
// a human chases a leaker's last heading for a few seconds. Capped by
// both window and reach so a stale ghost never forms a cross-map hunt.
const PURSUE_MS = 3500;
/** How far the eye line honestly reaches on open terrain — the
 *  acquisition bound, not a firing range. */
const SIGHT_M = 160;
const PURSUE_M = 150;

const dist3 = (a: BotVec, b: BotVec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distSq = (a: BotVec, b: BotVec) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// ---- Hunt state: everything the fire/position decisions mutate ----

export interface HuntState {
  /** Current target — the one last-seen the senses keep fresh. */
  hunt: BotEnemy | null;
  lastSeen: BotVec;
  lastSeenVel: BotVec;
  lastSeenAt: number;
  /** Aim offset of the target at last sighting — class geometry moves
   *  the capsule center, so the lead point remembers where it was. */
  lastAimY: number;
  /** Volley pacing: fireT is the cooldown, burstLeft counts the burst. */
  fireT: number;
  burstLeft: number;
  /** Combat spot from the last replan — null means "hold and shoot". */
  fightPos: BotVec | null;
  /** Aim humanization state — reaction delay stamps per target id in
   *  think-ticks (the brain's own cadence, so sim-time harnesses see
   *  the same delay as wall-clock play — 1-2 pickHunt cycles ≈ human
   *  reaction time; flickered re-acquires keep their original stamp).
   *  lastHitAt feeds the flinch error spike. */
  acquiredAt: Map<string, number>;
  huntTick: number;
  lastHitAt: number;
  readonly reactTicks: number; // acquisition → first shot, per-bot nerves
  readonly leadSkew: number; // under/over-leads the intercept, per-bot
  readonly jitter: number;   // steady-hand scale on aim error, per-bot
  readonly temper: number;   // per-bot fire-cadence scale
  readonly orbitFar: number;
  readonly orbitClose: number;
  /** The skill matrix — rolled once, drifts via form. Weapon pick and
   *  aim error both read it, so a chaingun phenom draws the chaingun
   *  and lands it. */
  readonly skill: BotSkill;
}

export function newHuntState(spawn: BotVec): HuntState {
  return {
    hunt: null,
    lastSeen: { ...spawn },
    lastSeenVel: { x: 0, y: 0, z: 0 },
    lastSeenAt: 0,
    lastAimY: CENTER_AIM_Y,
    skill: rollSkill(spawn),
    fireT: 0,
    burstLeft: 0,
    fightPos: null,
    acquiredAt: new Map(),
    huntTick: 0,
    lastHitAt: -1e9,
    reactTicks: 1 + Math.round(botRand()),
    leadSkew: 0.9 + botRand() * 0.2,
    jitter: 0.7 + botRand() * 0.6,
    temper: 0.7 + botRand() * 0.6,
    orbitFar: ORBIT_FAR * (0.85 + botRand() * 0.3),
    orbitClose: ORBIT_TOO_CLOSE * (0.85 + botRand() * 0.3),
  };
}

/** Nearest visible enemy of each class — no wallhack: only acquire
 *  what the eye line can actually see; an occluded enemy clears the
 *  hunt entirely so breaking LOS shakes pursuit like a human's. */
export function scanVisible(ctx: BrainCtx, pos: BotVec, range: number, beastRange: number): { player: BotEnemy | null; beast: BotEnemy | null; playerD: number; beastD: number } {
  let player: BotEnemy | null = null, beast: BotEnemy | null = null;
  let playerD = range, beastD = beastRange;
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const d = dist3(pos, e.pos);
    if (!losClear(ctx, pos, e.pos)) continue;
    if (e.id.startsWith('b:')) {
      if (d < beastD) { beastD = d; beast = e; }
    } else if (d < playerD) { playerD = d; player = e; }
  }
  return { player, beast, playerD, beastD };
}

/** Target acquisition + fight-position replan, on the slow think
 *  cadence — the ring eval is the expensive part (LOS per candidate
 *  per enemy) and 3Hz is plenty for position keeping. */
export function pickHunt(st: HuntState, ctx: BrainCtx, pos: BotVec, now: number, mood: { hero: boolean; fearing: boolean }, pickGoal: (ctx: BrainCtx, pos: BotVec) => void): void {
  const { hero, fearing } = mood;
  // Armament reach widens acquisition for siege weapons — a mortar heavy
  // engages at ~95m where a chaingun medium still holds the duel band.
  // A Tribes eye line reaches across a midfield: bots acquire contacts
  // far past their duel band and close to it, like a human spotting a
  // skier two hills out. Commitment stays in pickDest — seeing isn't
  // chasing.
  const base = Math.max(BOT_FIRE_RANGE, ctx.engageRange ?? 0);
  const range = Math.max(hero ? base * 1.4 : base, SIGHT_M);
  const beastRange = ctx.huntCreatures ? CREATURE_FIRE_RANGE : CREATURE_DEFENSE_M;
  const { player, beast: bestBeast, playerD: bestD, beastD: bestBeastD } = scanVisible(ctx, pos, range, beastRange);
  // In economy rooms, only an actual nearby player threat outranks
  // the harvest — otherwise the bot keeps farming past a firefight
  // across the map like a human focused on the score. In any mode a
  // creature on top of the bot is urgent: deal with what's biting.
  const best = bestBeast && (!player || bestD > THREAT_M || bestBeastD < CREATURE_URGENT_M) ? bestBeast : player;
  // The flag thief is the fallback hunt: a beacon-marked carrier is
  // legally trackable without LOS, but a bot only commits when it's
  // close enough to matter — farther out the objective goal still
  // walks it toward the carrier without it firing blind.
  const thief = best ? null : thiefBeacon(ctx, pos);
  // Squad spot-report: a teammate's callout — commit to the nearest
  // fresh spot in reach, the same "beacon without LOS" the thief
  // already gets. Eye-line contacts outrank it either way.
  const spotted = best || thief ? null : nearestSpot(ctx, pos);
  const next = best ?? thief ?? spotted;
  // Nothing in the eye line but the last contact is still fresh: chase
  // its last-seen spot for a few seconds — the ghost carries lastSeen,
  // not the live pos, so it stays as legal as a human's memory. Dead
  // targets never ghost (their corpse stops moving but the chase
  // shouldn't follow it to the respawn).
  const ghost = !next && st.hunt?.alive
    && now - st.lastSeenAt < PURSUE_MS && dist3(pos, st.lastSeen) < PURSUE_M
    ? { ...st.hunt, pos: { ...st.lastSeen }, vel: { ...st.lastSeenVel } }
    : null;
  st.hunt = next ?? ghost;
  st.huntTick++;
  // New contact starts the reaction clock — a human doesn't shoot the
  // instant a target enters the eye line. Stamped per id so losing the
  // eye line for a tick doesn't reset the nerves.
  if (next && !st.acquiredAt.has(next.id)) {
    st.acquiredAt.set(next.id, st.huntTick);
    if (st.acquiredAt.size > 6) st.acquiredAt.delete(st.acquiredAt.keys().next().value!);
  }
  const seen = best ?? thief ?? spotted;
  if (seen) {
    st.lastSeen = { ...seen.pos };
    st.lastSeenVel = { ...seen.vel };
    st.lastSeenAt = now;
    st.lastAimY = seen.aimY ?? CENTER_AIM_Y;
  }
  planFight(st, ctx, pos, best, fearing, pickGoal);
}

/** Fight-position replan or goal fallback. A fearing bot skips
 *  position-keeping: the dest pick breaks contact instead of
 *  holding an orbit. */
function planFight(st: HuntState, ctx: BrainCtx, pos: BotVec, best: BotEnemy | null, fearing: boolean, pickGoal: (ctx: BrainCtx, pos: BotVec) => void): void {
  st.fightPos = null;
  if (best && !fearing && dist3(pos, best.pos) <= st.orbitFar) {
    st.fightPos = pickFightPos(st, ctx, pos, best);
  }
  if (!best) pickGoal(ctx, pos);
}

/** The beacon-marked flag carrier, when it's in committing range —
 *  beacon range (80m) or any clear eye line. */
function thiefBeacon(ctx: BrainCtx, pos: BotVec): BotEnemy | null {
  const t = ctx.thief;
  if (!t || !t.alive) return null;
  if (dist3(pos, t.pos) >= 80 && !losClear(ctx, pos, t.pos)) return null;
  return t;
}

/** Nearest squad-spotted enemy inside committing reach — callouts
 *  don't summon cross-map hunts, just the leaker two hills over. */
function nearestSpot(ctx: BrainCtx, pos: BotVec): BotEnemy | null {
  let best: BotEnemy | null = null, bd = PURSUE_M;
  for (const e of ctx.spots ?? []) {
    if (!e.alive) continue;
    const d = dist3(pos, e.pos);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Volley pick: burst cadence + sloppy ballistic lead at lastSeen. */
export function pickFire(st: HuntState, dt: number, ctx: BrainCtx, pos: BotVec, now: number, mood: { hero: boolean; fearing: boolean }): BrainOut['fire'] {
  const { hero, fearing } = mood;
  if (!st.hunt || now - st.lastSeenAt > STALE_MS) return undefined;
  const acq = st.acquiredAt.get(st.hunt.id);
  if (acq !== undefined && st.huntTick - acq < st.reactTicks) return undefined;
  st.fireT -= dt;
  if (st.fireT > 0) return undefined;
  if (st.burstLeft <= 0) st.burstLeft = 5;
  st.burstLeft--;
  st.fireT = (st.burstLeft > 0 ? 0.45 : 0.8 + botRand() * 0.5) / st.temper
    * (hero ? 0.65 : fearing ? 0.9 : 1);
  const d = dist3(pos, st.lastSeen);
  // Suppressive fire is deliberately sloppy — noise, not hits. Hero
  // aim just stops being sloppy.
  const ws = ctx.weaponSpeed?.(d);
  const flight = d / (ws && ws > 0 ? ws : 60);
  // Scatter grows with how far ahead the bot must predict: target
  // speed (a jinking enemy is hard to lead), raw distance, and the
  // shell's time in flight — a 1.3s mortar lob is a much bigger
  // prediction than a 0.6s disc at the same range.
  let err = 0.5 + Math.hypot(st.lastSeenVel.x, st.lastSeenVel.y, st.lastSeenVel.z) * 0.1 + d * 0.02 + flight * 1.2;
  err *= hero ? 0.3 : fearing ? 1.8 : 1;
  err *= st.jitter;
  // The skill matrix: hosts that know which weapon will actually fire
  // report it via aimSkill — a snap phenom threads rails, a mortar
  // artist plants the stand, a potato sprays and prays.
  if (ctx.aimSkill) err /= ctx.aimSkill(d, Math.hypot(st.lastSeenVel.x, st.lastSeenVel.y, st.lastSeenVel.z));
  // The shooter's own motion: projectile velocity inheritance makes
  // shots ACROSS your line of travel the hardest (the impact point
  // drags sideways with you), while firing along your velocity is
  // actually easier — the shell inherits the speed and the lead
  // shrinks. Movement-phenom bots handle their own speed better.
  if (ctx.vel) {
    const ax = st.lastSeen.x - pos.x, az = st.lastSeen.z - pos.z;
    const ad = Math.hypot(ax, az) || 1;
    const perp = Math.abs(ctx.vel.x * (az / ad) - ctx.vel.z * (ax / ad));
    const along = (ctx.vel.x * ax + ctx.vel.z * az) / ad;
    err *= 1 + (perp * 0.05) / Math.max(0.6, st.skill.movement) - Math.max(0, along) * 0.01;
  }
  // Getting shot throws the aim off — decaying spike, not a toggle.
  const hitAgo = now - st.lastHitAt;
  if (hitAgo < 800) err *= 1 + (1 - hitAgo / 800) * 0.9;
  // Humans under- and over-lead differently — per-bot skew on the
  // intercept so tracers don't all converge on the same math.
  const leadFlight = flight * st.leadSkew;
  // Ballistic intercept: the target keeps falling while the shell
  // travels — a skier mid-air arcs down, and a flat lead overshoots
  // high. Clamp at terrain so a grounded runner isn't predicted
  // under the map.
  const px = st.lastSeen.x + st.lastSeenVel.x * leadFlight;
  const pz = st.lastSeen.z + st.lastSeenVel.z * leadFlight;
  // `pos` is the eye point — the capsule's axis midpoint sits `aimY`
  // below it, so center-mass aim means the bolt crosses the fattest
  // legal radius even before its wake proxy grows.
  const py = Math.max(
    ctx.groundY(px, pz),
    st.lastSeen.y + st.lastAimY + st.lastSeenVel.y * leadFlight + 0.5 * GRAVITY * leadFlight * leadFlight,
  );
  // Gravity-bent shells drop by the same amount — aim the arc's
  // drop back so mortars don't land short.
  const drop = ctx.weaponGravity?.(d) ? -0.5 * GRAVITY * flight * flight : 0;
  return {
    targetId: st.hunt.id,
    aim: {
      x: px + (botRand() - 0.5) * err,
      y: py + drop + (botRand() - 0.5) * err * 0.5,
      z: pz + (botRand() - 0.5) * err,
    },
  };
}

/** Killzone-style position pick: score a ring of candidate spots by
 *  LOS to the target, preferred range band, exposure to the rest of
 *  the enemy roster, and climbable ground. Standing still is candidate
 *  0 with an inertia bonus, so a good spot is kept instead of orbiting
 *  for orbit's sake. Returns null to hold position. */
export function pickFightPos(st: HuntState, ctx: BrainCtx, pos: BotVec, t: BotEnemy): BotVec | null {
  const mid = (st.orbitFar + st.orbitClose) * 0.5;
  const g0 = ctx.groundY(pos.x, pos.z);
  let bx = pos.x, bz = pos.z;
  let bs = scorePos(ctx, pos, pos, t, mid, g0) + 0.4;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const cx = pos.x + Math.cos(a) * 10, cz = pos.z + Math.sin(a) * 10;
    const cy = ctx.groundY(cx, cz);
    if (cy - g0 > 4) continue; // can't stand there
    const s = scorePos(ctx, pos, { x: cx, y: cy + BOT_EYE, z: cz }, t, mid, cy);
    if (s > bs) { bs = s; bx = cx; bz = cz; }
  }
  if (Math.hypot(bx - pos.x, bz - pos.z) < 3) return null;
  return { x: bx, y: pos.y, z: bz };
}

/** Score one candidate position for the combat picker: LOS to the hunt
 *  target (a spot that can't see it is cover — mildly bad on offense),
 *  closeness to the preferred range band, exposure to every OTHER enemy
 *  that could see the spot, and how much vertical scrambling it needs. */
function scorePos(ctx: BrainCtx, self: BotVec, cand: BotVec, t: BotEnemy, mid: number, candGround: number): number {
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

/** Retreat: straight away from the shooter, folding toward the nearest
 *  body when one is near — suppression keeps them honest. */
export function retreatDest(ctx: BrainCtx, pos: BotVec, t: BotEnemy): BotVec {
  const ax = pos.x - t.pos.x, az = pos.z - t.pos.z;
  const al = Math.hypot(ax, az) || 1;
  let rx = pos.x + (ax / al) * 24, rz = pos.z + (az / al) * 24;
  let ally: BotVec | null = null;
  let ad = Infinity;
  for (const o of ctx.others ?? []) {
    const od = distSq(pos, o);
    if (od < ad && od > 4) { ad = od; ally = o; }
  }
  if (ally && ad < 2500) { rx = (rx + ally.x) * 0.5; rz = (rz + ally.z) * 0.5; }
  return { x: rx, y: pos.y, z: rz };
}
