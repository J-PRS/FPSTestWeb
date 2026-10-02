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

import { botRand } from './botRand.ts';
import type { ChatterKind } from './botTaunts.ts';
import { BotSteer } from './botSteer.ts';
import { BotLines } from './botLines.ts';
import { BotGoals } from './botGoals.ts';
import { BotMoves } from './botMoves.ts';
import type { ColliderIndex } from './solidWorld.ts';
import type { StructureCollider } from './ballSim.ts';
import {
  newHuntState, pickHunt, pickFire,
  STALE_MS, type HuntState,
} from './botHunt.ts';
import { stuckBreak, dodge, type EscapeState } from './botEscape.ts';
import { driftForm, type BotSkill } from './botSkill.ts';

// Combat half lives in botHunt.ts — re-export so existing imports keep
// resolving (losClear/BOT_EYE/BOT_FIRE_RANGE are the public surface).
export { losClear, losMemoReset, BOT_EYE, BOT_FIRE_RANGE } from './botHunt.ts';
import { pickDest, pickDeploy, pickRepair, statusIntent } from './botDisposition.ts';

export type { BotVec } from './botVec.ts';
import { dist3, type BotVec } from './botVec.ts';

export interface BotEnemy {
  id: string;
  pos: BotVec;
  vel: BotVec;
  alive: boolean;
  /** Vertical offset from `pos` (the eye point for players, ball center
   *  for creatures) to the natural aim point — the hit capsule's axis
   *  midpoint. Negative for players (the chest sits below the eyes),
   *  ~0 for creatures. Omitted → the brain aims a medium's center. */
  aimY?: number;
}

export interface BrainCtx {
  /** The bot's own id — also the FPS_TRACE selector for soak debugging. */
  id?: string;
  /** The bot's own position. */
  pos: BotVec;
  /** The bot's own velocity — ski policy keys off speed, jet off climbs. */
  vel?: BotVec;
  enemies: BotEnemy[];
  /** Objective anchor (CTF flag/base) — outranks pickup and wander. */
  objective?: BotVec | null;
  /** This bot is carrying the objective (flag carrier running home):
   *  the route rules the feet — hunt press/orbit yields to the line,
   *  while fire stays live for opportunistic shots on the way. */
  running?: boolean;
  /** Route-first movement (carrier or capper): the line planner may
   *  swing wider and weight downhill harder — momentum preservation
   *  beats directness, which is how real cap routes arc roundabout. */
  runner?: boolean;
  /** The objective is an enemy-held position this bot is pressing —
   *  CTF offense heading for the enemy stand. Lets the status sense
   *  read the approach as an infiltration (cloak) rather than a roam. */
  infiltrating?: boolean;
  /** The enemy carrying OUR flag, when the host tracks flags and this
   *  bot's role chases the thief. Carrier position+velocity are beacon
   *  info (the flag broadcasts the carrier — Tribes' command circuit),
   *  so engaging the thief is legal without LOS. */
  thief?: BotEnemy | null;
  /** Squad spot-report: enemies a teammate had eyes on recently —
   *  stale-decayed snapshots, same legality as the thief beacon. Lets
   *  a bot commit to a contact it never personally saw, the way a
   *  squad's callouts work. */
  spots?: BotEnemy[];
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
  /** A room event the bot noticed this think (host already mapped it to
   *  this bot's side — cheer/groan/alert/reply). `actor` is whoever
   *  caused it, so lines can name them ({t}). Each bot sees it on its
   *  own think phase — reactions dribble out; brains only emit edges. */
  notice?: { kind: ChatterKind; actor?: string } | null;
  /** Nuggets-style economy rooms: when no player threatens, prefer
   *  creature targets (id prefix `b:`) — farming is the objective, and a
   *  human would do the same. Enemies still outrank food when close. */
  huntCreatures?: boolean;
  /** A friendly deployable that needs a weld — the host's nearest
   *  damaged item (key is host-opaque: server id, client candId).
   *  Only builders act on it; everyone else ignores the channel. */
  repair?: { key: string; pos: BotVec; frac: number } | null;
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
  /** Blast of the weapon the pick would take at `dist` — feeds the
   *  self-splash read (r=0 for hitscan/melee). */
  weaponAoe?(dist: number): { r: number; dmg: number };
  /** Host hook: the bot's skill multiplier for the weapon it would pick
   *  at `dist`, against a target moving at `targetSpeed` — feeds the
   *  skill matrix (snap/track/arc axes, moving vs still split, form).
   *  Omit → every bot shoots at 1×. */
  aimSkill?(dist: number, targetSpeed: number): number;
  /** Spatial-memory hooks — the host's influence map. QuietDir points
   *  at the least-danger-scented ring cell ~160m out (where MY team is
   *  NOT getting hurt); hottest returns the strongest opportunity cell
   *  within ~190m (fights, gems, flag events). Absent without a map. */
  imapQuietDir?(pos: BotVec): { x: number; z: number };
  imapHottest?(pos: BotVec): { x: number; z: number; v: number } | null;
  /** Raw danger scent at a spot on the caller's team layer — utility
   *  scoring reads it to discount goals in graveyards. */
  imapDanger?(pos: BotVec): number;
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
  /** Repair-beam tick on the ctx.repair target — the host resolves the
   *  key and runs the same heal path a human's repair claim does. */
  repair?: string;
  /** Situation chatter edge — the senses noticed something worth a line.
   *  The host resolves kind→text through botTaunts.chatter (chance +
   *  cooldown live there), so brains never speak directly. */
  say?: { kind: ChatterKind; target?: string };
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

  private thinkT = botRand() * THINK_S;
  readonly h: HuntState;
  flinchT = 0;
  flinchFrom: BotVec = { x: 0, y: 0, z: 0 };
  private beltT = 4 + botRand() * 4; // stagger first throws across the squad
  // Stuck/dodge senses live in botEscape.ts — escapeS is their state bag.
  private readonly escapeS: EscapeState = {
    stuckStreak: 0,
    escapeJetT: 0,
    detour: null,
    detourT: 0,
    progressPos: { x: 0, y: 0, z: 0 },
    progressGoalD: Infinity,
    goalWinT: 0,
    progressT: 0,
    goal: { x: 0, y: 0, z: 0 }, // kept in sync with goalS.goal each think
  };
  private readonly steerer = new BotSteer();
  // Meso-scale terrain routing lives in botLines.ts — turns a raw goal
  // into a committed landing spot so the steerer walks ski lines.
  private readonly lines = new BotLines();
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
    () => this.duty,
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
  // Chatter edge latches — the say field is edge-triggered (fires once
  // per situation), never a steady-state flag.
  private threatLatch = false;
  private boredLatch = false;
  /** takeHit arms a 'getting shot' line for the next think — flinchT
   *  decays silently, but the flinch event is worth one remark. */
  private hitSay = false;
  // Deploy intent — only some bots are builders, so a stand gets a couple
  // of sentries rather than a turret farm. Arriving at a defensive anchor
  // (objective in reach, nobody shooting) is the whole trigger: the
  // emplacement emerges from "a defender with time on their hands",
  // not a scripted base layout.
  deployT = 8 + botRand() * 25;
  builder = botRand() < 0.45;

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
  private readonly wanderlust = 0.7 + botRand() * 0.6;
  /** How much this bot minds the objective vs the scenery — high duty
   *  chases heard fights and holds roles, low duty goes sightseeing.
   *  Independent of wanderlust: a hyper tourist and a lazy pro both
   *  exist in a real lobby. */
  private readonly duty = 0.5 + botRand() * 0.9;
  /** Held-position strafe orbit — angle advances each pickDest step.
   *  Direction reverses on a jitter (a real duelist breaks the readable
   *  circle) and the radius breathes per flip, so the hold never reads
   *  as a carousel. */
  orbitA = botRand() * Math.PI * 2;
  orbitDir = botRand() < 0.5 ? 1 : -1;
  orbitFlipT = 1 + botRand() * 1.5;
  orbitMul = 1;
  /** Last think resolved to stand-and-shoot — a legal hold, not a stall.
   *  Hosts read this to keep stall/mobility watchdogs honest. */
  holding = false;

  /** Current hunt target — the belt intent carries no aim of its own,
   *  so hosts resolve the throw's arc off this. */
  get currentHuntId(): string | null {
    return this.h.hunt?.id ?? null;
  }

  /** Where the hunt was last actually seen — the only legal aim point
   *  for a lobbed throw (live position would be a wallhack on a
   *  cloaked or occluded target). */
  get currentHuntSeen(): BotVec | null {
    return this.h.hunt ? { ...this.h.lastSeen } : null;
  }

  /** Jet-gate telemetry for the cap-run harness — which gate armed the
   *  last burn plus the latches that could outlive it. */
  get jetDebug(): { why: string; escapeT: number; out: boolean; hold: number } {
    return { why: this.moves.jetWhy, escapeT: this.escapeS.escapeJetT, out: this.moves.jetOut, hold: this.moves.holdFor() };
  }

  /** The bot's skill matrix — hosts read it to bias weapon selection
   *  (a phenom draws its good gun) and to build the aimSkill ctx hook. */
  get skill(): BotSkill {
    return this.h.skill;
  }

  /** Role-adherence scalar for role-policy callers (HoF lean, route
   *  discipline): high duty holds the assigned shape, low duty loosens
   *  it. Guidelines not laws — nobody sits at exactly 1.0. */
  get dutyLevel(): number {
    return this.duty;
  }

  /** Getting shot makes the bot recoil — call from the damage funnel. */
  takeHit(from: BotVec): void {
    this.flinchT = FLINCH_S;
    this.hitSay = true;
    this.flinchFrom = { ...from };
    this.h.lastHitAt = this.now;
    this.h.skill.form = Math.max(0.85, this.h.skill.form - 0.03); // tilt
    this.goalS.revengeT = 2.5;
    this.goalS.revengeFrom = { ...from };
  }

  /** Situation chatter — rising edges only; the host resolves kind→line
   *  through botTaunts.chatter, which rate-limits anyway, but firing a
   *  steady flag would still waste the cooldown on repeats. Priority is
   *  first-come: wounds outrank contacts outrank ambience. */
  private pickSay(ctx: BrainCtx, hurtEdge: boolean, hero: boolean, wasHunt: string | null): BrainOut['say'] {
    // Threat/bored latches update every think — skipping them when a
    // higher-priority line fires would leak a stale 'underfire' next tick.
    const underfire = this.sayThreats(ctx);
    const bored = this.sayBored(ctx);
    if (hurtEdge) return { kind: hero ? 'hero' : 'fear' };
    return this.sayHunt(ctx, wasHunt) ?? underfire ?? bored;
  }

  /** Hunt edge: acquired a player (or committed to the thief) / lost them. */
  private sayHunt(ctx: BrainCtx, wasHunt: string | null): BrainOut['say'] {
    const huntNow = this.h.hunt?.id ?? null;
    if (huntNow && !wasHunt) {
      return huntNow === ctx.thief?.id ? { kind: 'thief', target: huntNow }
        : huntNow.startsWith('b:') ? undefined
        : { kind: 'contact', target: huntNow };
    }
    if (wasHunt && !huntNow) return { kind: 'lost', target: wasHunt };
    return undefined;
  }

  /** Inbound shells OR a fresh hit — either is "I'm being shot at". */
  private sayThreats(ctx: BrainCtx): BrainOut['say'] {
    const threats = (ctx.threats?.length ?? 0) > 0 || this.hitSay;
    this.hitSay = false;
    const say = threats && !this.threatLatch ? { kind: 'underfire' } as const : undefined;
    this.threatLatch = threats;
    return say;
  }

  /** Long silence with nobody acquired — the ambient line. STALE_MS is
   *  too twitchy; a human only remarks on a genuinely empty field. */
  private sayBored(ctx: BrainCtx): BrainOut['say'] {
    const quiet = !this.h.hunt && ctx.now - this.h.lastSeenAt > 40_000;
    if (!quiet) { this.boredLatch = false; return undefined; }
    if (this.boredLatch) return undefined;
    this.boredLatch = true;
    return { kind: 'bored' };
  }

  /** Belt lob: a live target in mid range on a 9s cooldown — grenades
   *  into a brawl, not at ghosts (stale seen-times don't qualify).
   *  The infiltrator plays it as an ambush: the belt flies at knife
   *  range in the same tick the cloak drops — belt+primary combo is
   *  the whole point of sneaking up. */
  private pickBelt(dt: number, pos: BotVec, now: number, ctx: BrainCtx): boolean {
    this.beltT -= dt;
    if (!this.h.hunt || this.beltT > 0 || now - this.h.lastSeenAt > STALE_MS) return false;
    const d = dist3(pos, this.h.lastSeen);
    if (ctx.infiltrating) {
      // Guideline, not doctrine — only commit to the knife-range combo
      // when the setup is favorable: healthy enough to eat the trade,
      // tank carrying the fight, and not walking into a crowd.
      const crowded = (ctx.enemies?.length ?? 0) > 2;
      if (d > 22 || crowded || (ctx.healthFrac ?? 1) < 0.45 || (ctx.energy ?? 99) < 25) return false;
      this.beltT = 9;
      return true;
    }
    if (d <= 10 || d >= 35) return false;
    this.beltT = 9;
    return true;
  }

  /** Fear/hero state rides the health fraction — a rare hero roll on the
   *  rising edge of getting hurt decides whether low HP means retreat or
   *  a desperate last stand. Latch resets once healed so the next wound
   *  gets a fresh roll. */
  private mood(ctx: BrainCtx, dt: number): { hurtEdge: boolean; hero: boolean; fearing: boolean } {
    const hurt = (ctx.healthFrac ?? 1) < FEAR_HP;
    const hurtEdge = hurt && !this.hurtLatch;
    if (hurtEdge && botRand() < HERO_CHANCE) this.heroT = HERO_S;
    this.hurtLatch = hurt;
    this.heroT = Math.max(0, this.heroT - dt);
    const hero = this.heroT > 0;
    return { hurtEdge, hero, fearing: hurt && !hero };
  }

  think(dt: number, ctx: BrainCtx): BrainOut {
    const pos = ctx.pos;
    const now = ctx.now;
    this.now = now;
    driftForm(this.h.skill, dt);

    const { hurtEdge, hero, fearing } = this.mood(ctx, dt);

    const wasHunt = this.h.hunt?.id ?? null;

    // --- pick a hunt target / refresh the goal (slow cadence) ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = hero ? THINK_S * 0.45 : THINK_S;
      pickHunt(this.h, ctx, pos, now, { hero, fearing }, (c, p) => this.goals.pick(c, p));
    }
    let say = this.pickSay(ctx, hurtEdge, hero, wasHunt);
    this.goalS.wanderT -= dt;
    // detourT decays here, with the other timers — decrementing it inside
    // the dest block below would let the setting call's dt eat the window.
    this.escapeS.detourT -= dt;
    this.escapeS.escapeJetT -= dt;
    this.escapeS.goal = this.goalS.goal;
    this.goalS.revengeT -= dt;

    // --- choose the step destination ---
    const d0 = pickDest(this, dt, ctx, pos, fearing, hero);
    let dest = d0;

    // --- line planning: commit to a terrain-sampled landing spot ---
    const d1 = this.lines.plan(dt, ctx, pos, dest);
    dest = d1;

    // --- context steering: senses score every direction ---
    const d2 = this.steerer.steer(dt, ctx, pos, dest);
    dest = d2;
    // Env-gated decision-chain trace: which stage rewrites the step.
    // FPS_TRACE=<playerId> — soaks print stage deltas for one bot.
    if (ctx.id && process.env.FPS_TRACE && ctx.id.includes(process.env.FPS_TRACE)) {
      const f = (v: BotVec) => `${v.x.toFixed(0)},${v.z.toFixed(0)}`;
      console.log(`trace t=${(now / 1000).toFixed(1)} pos=${f(pos)} goal=${f(ctx.objective ?? pos)} d0=${f(d0)} d1=${f(d1)} d2=${f(d2)}`);
    }

    dest = stuckBreak(this.escapeS, dt, ctx, pos, dest);

    // --- dodge: sidestep the nearest closing shell ---
    dest = dodge(ctx, pos, dest, hero);

    // --- fire ---
    const fire = pickFire(this.h, dt, ctx, pos, now, { hero, fearing });

    // --- belt: lob a grenade into a mid-range fight on a slow cooldown ---
    const belt = this.pickBelt(dt, pos, now, ctx);

    // --- deploy: a quiet defender with hands free fortifies the stand ---
    const deploy = pickDeploy(this, dt, ctx, pos, fearing);

    // --- repair: a builder in weld range works on the damaged gear ---
    const repair = pickRepair(this, ctx, pos, fearing);

    if (!say && belt) say = { kind: 'belt' };
    if (!say && deploy) say = { kind: 'deploy' };
    // Room-event notice — last priority: a wound or a fresh contact is
    // worth more words than scoreboard commentary.
    if (!say && ctx.notice) say = { kind: ctx.notice.kind, target: ctx.notice.actor };

    return { dest, move: this.moves.hints(dt, ctx, pos, dest), fire, status: statusIntent(this, ctx, fearing), belt, deploy, repair, say };
  }

  
  
}

// dist3/distSq live in botVec.ts — shared by the brain family.
