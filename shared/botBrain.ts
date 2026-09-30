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

import { BotSteer } from './botSteer.ts';
import { BotGoals } from './botGoals.ts';
import { BotMoves } from './botMoves.ts';
import type { ColliderIndex } from './solidWorld.ts';
import type { StructureCollider } from './ballSim.ts';
import {
  newHuntState, pickHunt, pickFire,
  STALE_MS, type HuntState,
} from './botHunt.ts';
import { stuckBreak, dodge, type EscapeState } from './botEscape.ts';

// Combat half lives in botHunt.ts — re-export so existing imports keep
// resolving (losClear/BOT_EYE/BOT_FIRE_RANGE are the public surface).
export { losClear, BOT_EYE, BOT_FIRE_RANGE } from './botHunt.ts';
import { pickDest, pickDeploy, statusIntent } from './botDisposition.ts';

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
  /** The objective is an enemy-held position this bot is pressing —
   *  CTF offense heading for the enemy stand. Lets the status sense
   *  read the approach as an infiltration (cloak) rather than a roam. */
  infiltrating?: boolean;
  /** The enemy carrying OUR flag, when the host tracks flags and this
   *  bot's role chases the thief. Carrier position+velocity are beacon
   *  info (the flag broadcasts the carrier — Tribes' command circuit),
   *  so engaging the thief is legal without LOS. */
  thief?: BotEnemy | null;
  /** Ground pickup to chase (nugget) — outranks wander. */
  pickup?: BotVec | null;
  /** Terrain height at x,z — wander waypoints clamp to ground. */
  groundY: (x: number, z: number) => number;
  /** Nearby bodies (allies, the local player, self ok — skipped by
   *  distance) for the separation sense. Optional; steering works
   *  without it. */
  others?: BotVec[];
  /** Teammates only — the rally/fold sense. In team modes a hurt bot
   *  folding onto an ENEMY is worse than going it alone, so the rally
   *  reads this channel instead of `others`. FFA hosts leave it absent
   *  (there's no one to rally to). */
  allies?: BotVec[];
  /** How far out this bot's armament can productively engage — a mortar
   *  heavy suppresses at ~95m where a chaingun medium would just waste
   *  ammo. Hosts compute it from the loadout's long-range weapon; absent
   *  → the default duel range. */
  engageRange?: number;
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
  /** Nuggets-style economy rooms: when no player threatens, prefer
   *  creature targets (id prefix `b:`) — farming is the objective, and a
   *  human would do the same. Enemies still outrank food when close. */
  huntCreatures?: boolean;
  /** Map-structure colliders for wall occlusion in LOS — hosts that model
   *  solid structures pass them so bots don't stare into walls; hosts
   *  without one fall back to terrain-only LOS like before. */
  solids?: readonly StructureCollider[];
  solidIndex?: ColliderIndex | null;
  /** Host hook: muzzle speed of the weapon the bot would pick at `dist`
   *  — aim lead divides range by real flight speed instead of a fixed
   *  60 m/s guess (a mortar under-leads and a disc over-leads at 60).
   *  Return 0 for hitscan speed rows; the brain falls back to 60. */
  weaponSpeed?(dist: number): number;
  /** Host hook: whether the weapon the bot would pick at `dist` is
   *  gravity-bent — the aim point gets the drop added back so lobbed
   *  shells don't land short. Omit → flat trajectories. */
  weaponGravity?(dist: number): boolean;
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
  /** Deployable claim this step (turret/mine/station) — the same shape a
   *  human's deploy message carries; the host validates + caps it. */
  deploy?: { kind: string; pos: BotVec };
}

const THINK_S = 0.3;
const FLINCH_S = 0.4;

// Fear / hero — both are sense tuning, never new moves or info. Below
// FEAR_HP the bot breaks contact (retreat, sloppy suppression on purpose);
// a rare hero roll on entering that state instead sharpens every sense a
// human could sharpen: cadence, aim, dodge horizon, acquisition range.
// Tribes players don't scatter at the first scratch — FEAR_HP sits near
// death, and the hero roll is a real coin flip toward a last stand.
const FEAR_HP = 0.15;
const HERO_CHANCE = 0.3; // per hurt episode, rolled on the rising edge
const HERO_S = 6;        // seconds of hero before it cools off

const DEATH_MS = 15000;  // a death spot stays scary this long
const DEATH_RANGE = 10;  // m — repel radius around each remembered death


export class BotBrain {
  /** Set the spawn point as the initial goal. */
  constructor(spawn: BotVec) {
    this.goalS.goal = { ...spawn };
    this.h = newHuntState(spawn);
  }

  private thinkT = Math.random() * THINK_S;
  readonly h: HuntState;
  flinchT = 0;
  flinchFrom: BotVec = { x: 0, y: 0, z: 0 };
  private beltT = 4 + Math.random() * 4; // stagger first throws across the squad
  // Stuck/dodge senses live in botEscape.ts — escapeS is their state bag.
  private readonly escapeS: EscapeState = {
    stuckStreak: 0,
    escapeJetT: 0,
    detour: null,
    detourT: 0,
    progressPos: { x: 0, y: 0, z: 0 },
    progressT: 0,
    goal: { x: 0, y: 0, z: 0 }, // kept in sync with goalS.goal each think
  };
  private readonly steerer = new BotSteer();
  // Idle-goal ladder lives in botGoals.ts — goalS is the state bag it
  // reads/writes so the brain's goal/wander/revenge fields stay private.
  readonly goalS: import('./botGoals.ts').GoalState = {
    goal: { x: 0, y: 0, z: 0 },
    revengeT: 0,
    revengeFrom: { x: 0, y: 0, z: 0 },
    wanderT: 0,
    wanderWp: { x: 0, y: 0, z: 0 },
  };
  private readonly goals = new BotGoals(
    () => this.goalS,
    () => this.wanderlust,
    () => this.steerer.headingVec(),
    (p) => this.nearDeath(p),
  );
  // Ski/jet/jump hint intents live in botMoves.ts — host closures read
  // the escape burst latch and the live hunt target.
  private readonly moves = new BotMoves({
    escapeJetT: () => this.escapeS.escapeJetT,
    huntPos: () => this.h.hunt?.pos ?? null,
  });
  // Death memory — where the host reported this body dying. Souring
  // goals near a death spot is how map denial emerges: nobody scripts
  // "that corner is dangerous", the squad just stops wandering back.
  private deaths: { x: number; z: number; t: number }[] = [];
  private heroT = 0;      // hero-mode seconds remaining
  private hurtLatch = false; // rising-edge detector for the hero roll
  // Deploy intent — only some bots are builders, so a stand gets a couple
  // of sentries rather than a turret farm. Arriving at a defensive anchor
  // (objective in reach, nobody shooting) is the whole trigger: the
  // emplacement emerges from "a defender with time on their hands",
  // not a scripted base layout.
  deployT = 8 + Math.random() * 25;
  builder = Math.random() < 0.45;

  /** Hosts can pin the builder trait — a technician role shouldn't be
   *  a dice roll away from never touching the deploy kit. */
  setBuilder(v: boolean): void { this.builder = v; }

  /** Host reports the bot's corpse spot on death, stamped with the
   *  same clock ctx.now rides — shared sim code never reads wall-clock
   *  itself (test harnesses step sim-time, not real time). */
  private now = 0;
  markDeath(pos: BotVec, now: number): void {
    this.deaths.push({ x: pos.x, z: pos.z, t: now });
    if (this.deaths.length > 8) this.deaths.shift();
  }

  /** Is p within the repel radius of a recent death? */
  private nearDeath(p: { x: number; z: number }): boolean {
    const now = this.now;
    for (const d of this.deaths) {
      if (now - d.t > DEATH_MS) continue;
      const dx = p.x - d.x, dz = p.z - d.z;
      if (dx * dx + dz * dz < DEATH_RANGE * DEATH_RANGE) return true;
    }
    return false;
  }
  // Personality scalars — ±20-30% per bot so a squad doesn't read as one
  // centipede: different preferred ranges, wander appetites, tempers.
  private readonly wanderlust = 0.7 + Math.random() * 0.6;
  /** Held-position strafe orbit — angle advances each pickDest step.
   *  Direction reverses on a jitter (a real duelist breaks the readable
   *  circle) and the radius breathes per flip, so the hold never reads
   *  as a carousel. */
  orbitA = Math.random() * Math.PI * 2;
  orbitDir = Math.random() < 0.5 ? 1 : -1;
  orbitFlipT = 1 + Math.random() * 1.5;
  orbitMul = 1;
  /** Last think resolved to stand-and-shoot — a legal hold, not a stall.
   *  Hosts read this to keep stall/mobility watchdogs honest. */
  holding = false;

  /** Current hunt target — the belt intent carries no aim of its own,
   *  so hosts resolve the throw's arc off this. */
  get currentHuntId(): string | null {
    return this.h.hunt?.id ?? null;
  }

  /** Getting shot makes the bot recoil — call from the damage funnel. */
  takeHit(from: BotVec): void {
    this.flinchT = FLINCH_S;
    this.flinchFrom = { ...from };
    this.goalS.revengeT = 2.5;
    this.goalS.revengeFrom = { ...from };
  }

  think(dt: number, ctx: BrainCtx): BrainOut {
    const pos = ctx.pos;
    const now = ctx.now;
    this.now = now;

    // Fear/hero state rides the health fraction — a rare hero roll on the
    // rising edge of getting hurt decides whether low HP means retreat or
    // a desperate last stand. Latch resets once healed so the next wound
    // gets a fresh roll.
    const hurt = (ctx.healthFrac ?? 1) < FEAR_HP;
    if (hurt && !this.hurtLatch && Math.random() < HERO_CHANCE) this.heroT = HERO_S;
    this.hurtLatch = hurt;
    this.heroT = Math.max(0, this.heroT - dt);
    const hero = this.heroT > 0;
    const fearing = hurt && !hero;

    // --- pick a hunt target / refresh the goal (slow cadence) ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = hero ? THINK_S * 0.45 : THINK_S;
      pickHunt(this.h, ctx, pos, now, { hero, fearing }, (c, p) => this.goals.pick(c, p));
    }
    this.goalS.wanderT -= dt;
    // detourT decays here, with the other timers — decrementing it inside
    // the dest block below would let the setting call's dt eat the window.
    this.escapeS.detourT -= dt;
    this.escapeS.escapeJetT -= dt;
    this.escapeS.goal = this.goalS.goal;
    this.goalS.revengeT -= dt;

    // --- choose the step destination ---
    let dest = pickDest(this, dt, ctx, pos, fearing, hero);

    // --- context steering: senses score every direction ---
    dest = this.steerer.steer(dt, ctx, pos, dest);

    dest = stuckBreak(this.escapeS, dt, ctx, pos, dest);

    // --- dodge: sidestep the nearest closing shell ---
    dest = dodge(ctx, pos, dest, hero);

    // --- fire ---
    const fire = pickFire(this.h, dt, ctx, pos, now, { hero, fearing });

    // --- belt: lob a grenade into a mid-range fight on a slow cooldown ---
    this.beltT -= dt;
    let belt = false;
    if (this.h.hunt && this.beltT <= 0 && now - this.h.lastSeenAt <= STALE_MS) {
      const d = dist3(pos, this.h.lastSeen);
      if (d > 10 && d < 35) { belt = true; this.beltT = 9; }
    }

    // --- deploy: a quiet defender with hands free fortifies the stand ---
    const deploy = pickDeploy(this, dt, ctx, pos, fearing);

    return { dest, move: this.moves.hints(dt, ctx, pos, dest), fire, status: statusIntent(this, ctx, fearing), belt, deploy };
  }

  
  
}

function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
