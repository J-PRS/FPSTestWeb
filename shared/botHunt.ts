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
import { sharedEnv } from './env.ts';
import { GRAVITY } from './movement.ts';
import { rollSkill, type BotSkill, type BotSkillSpec } from './botSkill.ts';
import { losClear, BOT_EYE } from './botLos.ts';
import { segSolidHit } from './solidWorld.ts';
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
 *  acquisition bound, not a firing range. Tribes sightlines are long
 *  (a skier two hills out is a visible contact); 160m left the fleet
 *  blind at the ~260m median foe spacing big maps actually produce. */
const SIGHT_M = 300;
const PURSUE_M = 200;

const dist3 = (a: BotVec, b: BotVec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distSq = (a: BotVec, b: BotVec) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// ---- Hunt state: everything the fire/position decisions mutate ----

export interface HuntState {
  /** Current target — the one last-seen the senses keep fresh. */
  hunt: BotEnemy | null;
  /** Every enemy the last scanVisible actually verified — the squad
   *  spot board's report. Reusing the scan's own LOS work keeps the
   *  board from paying a second march per enemy per think. */
  seenEnemies: BotEnemy[];
  lastSeen: BotVec;
  lastSeenVel: BotVec;
  /** The opponent model: a low-pass of the target's observed velocity.
   *  Instantaneous vel would track a jink perfectly — a human predictor
   *  lags it, so leads miss where the strafe turns. Blended on each
   *  sighting; the ghost and the lead point both fly this. */
  leadVel: BotVec;
  /** Which enemy the model is tracking — a new face snaps the estimate
   *  (first read is the model), an old one only drifts it. */
  leadId: string;
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

export function newHuntState(spawn: BotVec, spec: BotSkillSpec = 'medium'): HuntState {
  const skill = rollSkill(spawn, spec);
  const m = skill.mods;
  return {
    hunt: null,
    seenEnemies: [],
    lastSeen: { ...spawn },
    lastSeenVel: { x: 0, y: 0, z: 0 },
    leadVel: { x: 0, y: 0, z: 0 },
    leadId: '',
    lastSeenAt: 0,
    lastAimY: CENTER_AIM_Y,
    skill,
    fireT: 0,
    burstLeft: 0,
    fightPos: null,
    acquiredAt: new Map(),
    huntTick: 0,
    lastHitAt: -1e9,
    // Personality rolls ride the skill's spawn-seeded private stream, not
    // botRand — construction-time botRand draws run before a harness can
    // install a seeded stream, which made same-seed rooms diverge.
    reactTicks: Math.max(1, Math.round((1 + Math.round(skill.rng())) * m.react)),
    leadSkew: 0.9 + skill.rng() * 0.2,
    jitter: (0.7 + skill.rng() * 0.6) * m.jitter,
    temper: (0.7 + skill.rng() * 0.6) * m.temper,
    orbitFar: ORBIT_FAR * (0.85 + skill.rng() * 0.3),
    orbitClose: ORBIT_TOO_CLOSE * (0.85 + skill.rng() * 0.3),
  };
}

/** Nearest visible enemy of each class — no wallhack: only acquire
 *  what the eye line can actually see; an occluded enemy clears the
 *  hunt entirely so breaking LOS shakes pursuit like a human's. */
export function scanVisible(ctx: BrainCtx, pos: BotVec, range: number, beastRange: number, seenAll?: BotEnemy[]): { player: BotEnemy | null; beast: BotEnemy | null; playerD: number; beastD: number } {
  let player: BotEnemy | null = null, beast: BotEnemy | null = null;
  let playerD = range, beastD = beastRange;
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const d = dist3(pos, e.pos);
    // Cheapest gate first: an out-of-range enemy never earns the LOS
    // march — it was paying a ~dist/6-probe walk for a guaranteed discard.
    if (d >= (e.id.startsWith('b:') ? beastRange : range)) continue;
    if (!losClear(ctx, pos, e.pos)) continue;
    seenAll?.push(e);
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
  const seenAll: BotEnemy[] = [];
  const { player, beast: bestBeast, playerD: bestD, beastD: bestBeastD } = scanVisible(ctx, pos, range, beastRange, seenAll);
  st.seenEnemies = seenAll;
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
    ? {
        ...st.hunt,
        // The ghost keeps the model's momentum — humans chase where
        // the runner was HEADING, not the spot they vanished from.
        pos: {
          x: st.lastSeen.x + st.leadVel.x * Math.min(1.2, (now - st.lastSeenAt) / 1000),
          y: st.lastSeen.y,
          z: st.lastSeen.z + st.leadVel.z * Math.min(1.2, (now - st.lastSeenAt) / 1000),
        },
        vel: { ...st.leadVel },
      }
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
    // Opponent-model update — the tracker's running estimate drifts
    // toward the newest read, never snaps to it.
    const blend = st.leadId !== seen.id ? 0.55 : 0.2;
    st.leadId = seen.id;
    st.leadVel.x += (seen.vel.x - st.leadVel.x) * blend;
    st.leadVel.y += (seen.vel.y - st.leadVel.y) * blend;
    st.leadVel.z += (seen.vel.z - st.leadVel.z) * blend;
  }
  planFight(st, ctx, pos, best, fearing, pickGoal);
}

/** Fight-position replan or goal fallback. A fearing bot skips
 *  position-keeping: the dest pick breaks contact instead of
 *  holding an orbit. */
function planFight(st: HuntState, ctx: BrainCtx, pos: BotVec, best: BotEnemy | null, fearing: boolean, pickGoal: (ctx: BrainCtx, pos: BotVec) => void): void {
  st.fightPos = null;
  // A runner's route owns his feet: a capper that orbits every midfield
  // contact dies at ~130m out without ever arriving (soak: hunt pulls
  // ate every approach leg). He still FIRES off st.hunt — only the
  // position commitment shrinks to point-blank threats he can't
  // out-ski, and the objective goal keeps refreshing so the run
  // resumes the tick the fight ends.
  // Wave members get the same committed feet — a tasked push/escort
  // dueling every midfield contact is the soak's "wave never arrives"
  // defect (d530m, near0%): suppression travels WITH the flood, not
  // instead of it.
  const orbit = (ctx.runner || ctx.wave) ? Math.min(st.orbitFar, 45) : st.orbitFar;
  if (best && !fearing && dist3(pos, best.pos) <= orbit) {
    st.fightPos = pickFightPos(st, ctx, pos, best);
  }
  if (!best || ctx.runner || ctx.wave) pickGoal(ctx, pos);
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
  // LOS memory: past STALE_MS the shot isn't blind amnesia — a human
  // keeps suppressing where the runner was heading. Fire stays legal on
  // the extrapolated ghost until the pursuit window itself expires,
  // with aim decaying by how long the eye line has been broken.
  const staleMs = now - st.lastSeenAt;
  const memS = Math.max(0, (staleMs - STALE_MS) / 1000);
  if (!st.hunt || staleMs > PURSUE_MS) return undefined;
  const acq = st.acquiredAt.get(st.hunt.id);
  if (acq !== undefined && st.huntTick - acq < st.reactTicks) return undefined;
  const d = dist3(pos, memS > 0 ? st.hunt.pos : st.lastSeen);
  st.fireT -= dt;
  if (st.fireT > 0) return undefined;
  // The trigger finger follows the gun: a chaingun streams long bursts,
  // a mortar picks its moments — same cadence rules the client enforces.
  const interval = ctx.fireInterval?.(d) ?? 0.45;
  if (st.burstLeft <= 0) st.burstLeft = Math.max(2, Math.min(12, Math.round(3.0 / interval)));
  st.burstLeft--;
  st.fireT = (st.burstLeft > 0
    ? Math.max(interval, 0.25) + botRand() * 0.15
    : 0.8 + botRand() * 0.5) / st.temper
    * (hero ? 0.65 : fearing ? 0.9 : 1);
  // Suppressive fire is deliberately sloppy — noise, not hits. Hero
  // aim just stops being sloppy.
  const ws = ctx.weaponSpeed?.(d);
  const flight = d / (ws && ws > 0 ? ws : 60);
  // Scatter grows with how far ahead the bot must predict — the lead
  // distance itself (target speed × shell flight), not speed alone:
  // a 30m/s skier crosses 54m during a disc's 1.8s flight, and human
  // lead error scales as a fraction of that (soak: disc splash grazes
  // counted 48% "accurate" at 120-200m — every transit lane was a
  // kill envelope because AoE covered the whole miss budget).
  const leadDist = Math.hypot(st.lastSeenVel.x, st.lastSeenVel.y, st.lastSeenVel.z) * flight;
  let err = 0.5 + leadDist * 0.28 + d * 0.015 + flight * 0.4;
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
  // Memory shots aim at the drifting ghost (pickHunt keeps it walking
  // the lead model), not the frozen sighting point — and the error
  // budget grows with every second the target stays unseen.
  const aimPos = memS > 0 ? st.hunt.pos : st.lastSeen;
  err *= 1 + memS;
  // Ballistic intercept: the target keeps falling while the shell
  // travels — a skier mid-air arcs down, and a flat lead overshoots
  // high. Clamp at terrain so a grounded runner isn't predicted
  // under the map.
  // Lead off the opponent model, not the live velocity — a jinking
  // target's instant vel is already gone by the time the shell flies;
  // the lagged estimate is what a human's prediction actually tracks.
  const px = aimPos.x + st.leadVel.x * leadFlight;
  const pz = aimPos.z + st.leadVel.z * leadFlight;
  // Self-splash read: when the predicted blast lands closer to the
  // shooter than the target, the shot costs more than it earns — a
  // human holds that disc. Courage draws the exception: heroic bots
  // sometimes take the mutual-splash shot anyway.
  const aoe = ctx.weaponAoe?.(d);
  if (aoe && aoe.r > 0) {
    const selfD = Math.hypot(px - pos.x, pz - pos.z);
    const foeD = Math.hypot(px - aimPos.x, pz - aimPos.z);
    // A blast landing nearer me than him costs more than it earns —
    // humans hold that disc. Courage draws the exception: heroic bots
    // sometimes take the mutual-splash shot anyway.
    if (selfD < aoe.r * 0.9 && selfD < foeD * 0.9 && botRand() > st.skill.courage) {
      st.fireT = 0.3;
      return undefined;
    }
    // The lethal read: a shot that would kill ME only earns when the
    // enemy is nearer its center — dying to take him down is a play,
    // dying while he grazes is a waste. Self-damage follows the same
    // falloff the server applies (full in the core, fading to the rim).
    const selfDmg = selfD < 3 ? aoe.dmg : aoe.dmg * Math.max(0, 1 - (selfD - 3) / Math.max(1, aoe.r - 3));
    const lethal = selfDmg >= (ctx.healthFrac ?? 1) * 120 * 0.8;
    if (lethal && selfD < aoe.r && foeD > selfD * 0.8 && botRand() > st.skill.courage) {
      st.fireT = 0.3;
      return undefined;
    }
  }
  // `pos` is the eye point — the capsule's axis midpoint sits `aimY`
  // below it, so center-mass aim means the bolt crosses the fattest
  // legal radius even before its wake proxy grows.
  const py = Math.max(
    ctx.groundY(px, pz),
    aimPos.y + st.lastAimY + st.leadVel.y * leadFlight + 0.5 * GRAVITY * leadFlight * leadFlight,
  );
  // Gravity-bent shells drop by the same amount — aim the arc's
  // drop back so mortars don't land short.
  const drop = ctx.weaponGravity?.(d) ? -0.5 * GRAVITY * flight * flight : 0;
  const aim = {
    x: px + (botRand() - 0.5) * err,
    y: py + drop + (botRand() - 0.5) * err * 0.5,
    z: pz + (botRand() - 0.5) * err,
  };
  // Muzzle clearance: LOS proves the EYE line is open, but the shell
  // leaves from +1.4m and launches lower than the sightline — a lip
  // right in front eats it ~3-5m out, which is exactly the self-splash
  // the soak ledger showed (foe@120m, impact@4m). Only the first
  // meters decide that: a bump farther downrange just costs a miss —
  // and ballistic arcs clear lips a straight full-length ray would
  // flag, so probing the whole ray strangled fire volume for nothing.
  if (ctx.weaponSpeed?.(d) && !sharedEnv.noMuzzle) {
    const muzzle = { x: pos.x, y: pos.y + 1.4, z: pos.z };
    // Reach = splash radius + a stride's margin, not a constant: a lip
    // that pops the shell outside its own blast can't self-frag, and a
    // mortar-class splash reaches ~18m back (surviving pops read @17m).
    const aoeR = ctx.weaponAoe?.(d)?.r ?? 10;
    const reach = Math.min(d, aoeR + 6);
    const nearAim = {
      x: pos.x + ((aim.x - pos.x) / d) * reach,
      y: pos.y + ((aim.y - pos.y) / d) * reach,
      z: pos.z + ((aim.z - pos.z) / d) * reach,
    };
    // Raw march of the shell's own segment — the shared LOS sense lifts
    // its endpoints to eye height and declines to look inside 4m, which
    // is exactly the band the lip pops live in (impact@6m, foe@98m: a
    // sub-eye-height lip the lifted ray sailed over and the shell ate).
    // The shell flies the unlifted segment, so probe the unlifted
    // segment at ~1m steps, solids included — a wall eats it too.
    let blocked = false;
    const steps = Math.max(2, Math.ceil(reach));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // A lip is terrain ABOVE the ray: descending toward a foe's feet
      // skims the deck near the aim point and that is the shell doing
      // its job, not a block (flat-ground feet shots read "blocked" at
      // any graze tolerance and refused every volley).
      if (ctx.groundY(muzzle.x + (nearAim.x - muzzle.x) * t,
                      muzzle.z + (nearAim.z - muzzle.z) * t)
          >= muzzle.y + (nearAim.y - muzzle.y) * t + 0.3) { blocked = true; break; }
    }
    if (!blocked && ctx.solids?.length &&
        segSolidHit(muzzle, nearAim, ctx.solids, ctx.solidIndex ?? undefined)) blocked = true;
    if (blocked) {
      st.fireT = 0.3;
      return undefined;
    }
  }
  return { targetId: st.hunt.id, aim };
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
    // A shooter past engagement range can't hold this spot down — skip
    // the march; the whole roster times a ring of candidates made this
    // the hunt stage's hot loop.
    if (dist3(cand, e.pos) >= BOT_FIRE_RANGE) continue;
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
  // Spatial memory votes too: fold the escape toward the direction the
  // map says is quiet — running away blind lands in yesterday's graveyard.
  const q = ctx.imapQuietDir?.(pos);
  if (q) { rx += q.x * 12; rz += q.z * 12; }
  return { x: rx, y: pos.y, z: rz };
}
