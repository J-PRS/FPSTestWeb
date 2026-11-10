/**
 * BotBrain - the shared decision core for every fake player, offline
 * (client GameBot) and online (server_bun ServerBots). Pure logic on plain
 * vectors: no THREE, no sockets, no scene - both runtimes supply those at
 * the edges and consume the same "where to move / when to fire / where to
 * aim" answers, so bot personality is tuned once and ships to both.
 *
 * Contract: call think(dt, ctx) once per tick/frame with the bot's current
 * position and world snapshot; it returns a movement destination and, when
 * it wants to shoot, a fire command { targetId, aim }. The caller owns
 * locomotion, the visual, and resolving the hit.
 */

import { botRand } from './botRand.ts';
import { sharedEnv } from './env.ts';
import {type ChatterKind, dir8} from './botTaunts.ts';
import { BotSteer } from './botSteer.ts';
import { BotSlew } from './botSlew.ts';
import { BotLines } from './botLines.ts';
import { BotGoals, type GoalState } from './botGoals.ts';
import { BotMoves } from './botMoves.ts';
import { segSolidHit, type ColliderIndex } from './solidWorld.ts';

import type { StructureCollider } from './ballSim.ts';
import {
  newHuntState, pickHunt, pickFire, preyUnreachable, type HuntState,
  noteFoeHit, noteFoeDeath, dreadOf,
} from './botHunt.ts';
import { stuckBreak, dodge, wallTopOnPath, ownGate, breachAlongWall, type EscapeState } from './botEscape.ts';
import { driftForm, heroTick, HERO_ON, type BotSkill, type BotSkillSpec } from './botSkill.ts';
import { pickDest, pickDeploy, pickRepair, statusIntent } from './botDisposition.ts';
import { dist3, distSqXZ, dirXZ, type BotVec } from './botVec.ts';
import { WeaponType } from './weapons.ts';
import { BOT_TUNING as T } from './botTuning.ts';

const f = (v: BotVec): string => `${v.x.toFixed(0)},${v.z.toFixed(0)}`;

// Combat half lives in botHunt.ts - re-export so existing imports keep
// resolving (losClear/BOT_EYE/BOT_FIRE_RANGE are the public surface).
export { losClear, losMemoReset, BOT_EYE, BOT_FIRE_RANGE } from './botHunt.ts';
export type { BotVec } from './botVec.ts';

/** Brawl range - the "a live enemy is right here" evidence the sheep
 *  meter's ignore debit and every foeNear check measure by. One radius
 *  for wire humans, wire bots, offline bots, and the self readout. */
export const BRAWL_RANGE = 45;
/** View-cone gate for that evidence: the foe must be inside the ~113°
 *  frontal cone (dot(facing, toFoe) > -0.4) - charging a body for
 *  "ignoring" an enemy directly behind it is a false positive. */
export const FOE_CONE_MIN_DOT = -0.4;

export interface BotEnemy {
  id: string;
  pos: BotVec;
  vel: BotVec;
  alive: boolean;
  /** Vertical offset from `pos` (the eye point for players, ball center
   *  for creatures) to the natural aim point - the hit capsule's axis
   *  midpoint. Negative for players (the chest sits below the eyes),
   *  ~0 for creatures. Omitted → the brain aims a medium's center. */
  aimY?: number;
  /** Health as a 0..1 fraction - the finisher read: a wounded runner
   *  is worth an easy chip weapon instead of another heroic lob. */
  hpFrac?: number;
  /** Headhunt tokens this enemy carries - the bounty read: acquisition
   *  prices hoards closer than their raw distance. */
  held?: number;
}

export interface BrainCtx {
  /** The bot's own id - also the FPS_TRACE selector for soak debugging. */
  id?: string;
  /** The bot's own position. */
  pos: BotVec;
  /** The bot's own velocity - ski policy keys off speed, jet off climbs. */
  vel?: BotVec;
  /** skill.movement - times the hop-descent tap: skilled bots jet only the
   *  falling arc; undefined reads as skilled (hosts without a skill matrix). */
  moveSkill?: number;
  /** skill.thrift 0..1 — vetoes wasteful grounded burns in botMoves;
   *  undefined reads as 0 (hosts without a skill matrix stay thirsty). */
  thrift?: number;
  enemies: BotEnemy[];
  /** Objective anchor (CTF flag/base) - outranks pickup and wander. */
  objective?: BotVec | null;
  /** The real flag position when `objective` is an offset AIM point
   *  (committed capper passes aim past/beside the pole) - altitude
   *  vetoes that mean "over the flag" must measure this, not the aim. */
  flagPos?: BotVec | null;
  /** This bot is carrying the objective (flag carrier running home):
   *  the route rules the feet - hunt press/orbit yields to the line,
   *  while fire stays live for opportunistic shots on the way. */
  running?: boolean;
  /** Route-first movement (carrier or capper): the line planner may
   *  swing wider and weight downhill harder - momentum preservation
   *  beats directness, which is how real cap routes arc roundabout. */
  runner?: boolean;
  /** Named wave member (push/escort): feet committed to the flood like
   *  a runner's, without the capper's staging/propel rules. */
  wave?: boolean;
  /** Push-task member: mass-orbits ~110m out until the flood converges
   *  (escorts share wave but never hold off a moving carrier). */
  marshal?: boolean;
  /** The capper's push call is live - he's committed and inside the ETA
   *  window. Marshal members release on this so the flood lands WITH
   *  him instead of trickling in on their own patience clocks. */
  pushLive?: boolean;
  /** The objective is an enemy-held position this bot is pressing -
   *  CTF offense heading for the enemy stand. Lets the status sense
   *  read the approach as an infiltration (cloak) rather than a roam. */
  infiltrating?: boolean;
  /** Posted-anchor leash (meters) - home defenders fire on anything
   *  they can see but only leave the objective for a fight inside this
   *  radius. 0/omitted → not posted, hunts move feet freely. */
  posted?: number;
  /** The enemy carrying OUR flag, when the host tracks flags and this
   *  bot's role chases the thief. Carrier position+velocity are beacon
   *  info (the flag broadcasts the carrier - Tribes' command circuit),
   *  so engaging the thief is legal without LOS. */
  thief?: BotEnemy | null;
  /** CTF quiet phase - both flags on their stands. Route roles read
   *  it as "enemy offense is ignorable": mid-field passerby get
   *  discounted in acquisition (spot, don't figit) while stand press
   *  and brawl-range reflexes stay untouched. Flag state is broadcast
   *  wire info, so the read is legal everywhere. */
  flagsHome?: boolean;
  /** The tryhard scalar - brain-owned, injected into ctx at think
   *  time (hosts never set it). 0 for most bots; ~12% roll a sweaty
   *  comp-pub personality that extends figit discipline to posted
   *  roles and announces its cap timing. */
  sweat?: number;
  /** Squad spot-report: enemies a teammate had eyes on recently -
   *  stale-decayed snapshots, same legality as the thief beacon. Lets
   *  a bot commit to a contact it never personally saw, the way a
   *  squad's callouts work. */
  spots?: BotEnemy[];
  /** Ground pickup to chase (nugget) - outranks wander. */
  pickup?: BotVec | null;
  /** A second capper's route lands within ~15s of mine - paired-run
   *  window. The staging orbit holds a beat longer while the pair's
   *  ETAs line up so the runners hit the ring together. */
  capSync?: boolean;
  /** Score-deficit x time-pressure, ~0..2 - endgame desperation. Rises
   *  only when the team is behind AND the clock is nearly done; the
   *  goal picker turns it into vault-hunt weight, so a losing squad
   *  throws everything at the hoard instead of playing out the string. */
  desperate?: number;
  /** Denomination of the chased pickup (headhunt tokens 1/3/9/27) -
   *  the goal picker scales the offer by pile size: a purple spill is
   *  worth a walk, a lone 1-coin is opportunism. */
  pickupVal?: number;
  /** Terrain height at x,z - wander waypoints clamp to ground. */
  groundY: (x: number, z: number) => number;
  /** Leg-scale route probe (flow field): the next waypoint toward a
   *  far goal, ~`ahead` meters along the cheapest-cost terrain route.
   *  Hosts without a coarse grid omit it and lines fall back to the
   *  local fan. */
  route?: (fx: number, fz: number, tx: number, tz: number, ahead: number) => BotVec | null;
  /** Nearby bodies (allies, the local player, self ok - skipped by
   *  distance) for the separation sense. Optional; steering works
   *  without it. */
  others?: BotVec[];
  /** Teammates only - the rally/fold sense. In team modes a hurt bot
   *  folding onto an ENEMY is worse than going it alone, so the rally
   *  reads this channel instead of `others`. FFA hosts leave it absent
   *  (there's no one to rally to). */
  allies?: BotVec[];
  /** Richest friendly headhunt hoard worth guarding - a 20+ token
   *  carrier is a map-visible piñata, so teammates drift to its escort.
   *  Absent outside headhunt and when no teammate is rich enough. */
  convoy?: BotVec | null;
  /** A rich teammate visibly dying nearby - the spill hasn't landed
   *  yet but vultures circle the body. Lets the goal picker camp the
   *  corpse before it drops instead of chasing the pickup after. */
  spillSoon?: BotVec | null;
  /** How far out this bot's armament can productively engage - a mortar
   *  heavy suppresses at ~95m where a chaingun medium would just waste
   *  ammo. Hosts compute it from the loadout's long-range weapon; absent
   *  → the default duel range. */
  engageRange?: number;
  /** How this bot's match is going, 0..1 - the host folds team score
   *  margin and personal K/D into one "nerve" the goal picker reads:
   *  rattled bots seek company, confident ones spread out and hunt.
   *  Omit where there's no scoreboard; 0.5 (neutral) is assumed. */
  confidence?: number;
  /** Hero-mode pressure (host-computed): deficit = how badly the bot's
   *  side loses, ownPerf = this bot's K/D vs the lobby, menace = the
   *  dominant-enemy pull, menacePos = where that player is. heroTick in
   *  shared/botSkill turns it into resolve. */
  hero?: { deficit: number; ownPerf: number; menace: number; menacePos?: BotVec };
  /** Wall/sim time in ms - brain cooldowns key off this, not frames. */
  now: number;
  /** Modeled energy tank (server shadow truth) - skills/jet gate on it.
   *  Omitted on hosts without an energy model; hints assume a full tank. */
  energy?: number;
  /** The bot's equipped Q-skill id ('dash'|'blink'|'slam'|'warp'|
   *  'bounce'|'cloak'|'shield'|'medkit') - the host shadows its
   *  cooldown, so a press is legal whenever the brain picks it. */
  skill?: string;
  /** The belt slot's equipped weapon (WeaponType.Hook only matters here -
   *  the grapple-transit intent is legal to aim only with the rope). */
  beltItem?: WeaponType;
  /** Own health as a 0..1 fraction - mend decision input. */
  healthFrac?: number;
  /** Own held tokens (headhunt) - the hoard-protection read: carriers
   *  break contact earlier so the regen drip can top them back up. */
  held?: number;
  /** Positions of projectiles closing on the bot (host pre-filters to
   *  inbound shells) - the dodge sense. Omit where no projectile sim
   *  exists (offline bots, legacy path). */
  threats?: BotVec[];
  /** Recent loud events within earshot (host pre-filters radius + age) -
   *  the hearing sense. No LOS required: a fight over the ridge pulls
   *  an idle bot toward it, which is how scouting emerges. */
  sounds?: BotVec[];
  /** A room event the bot noticed this think (host already mapped it to
   *  this bot's side - cheer/groan/alert/reply). `actor` is whoever
   *  caused it, so lines can name them ({t}). Each bot sees it on its
   *  own think phase - reactions dribble out; brains only emit edges. */
  notice?: { kind: ChatterKind; actor?: string; goal?: BotVec } | null;
  /** A live radio callout's implied position (host resolved the chord
   *  to a spot - defend-the-stand, chase-the-carrier, cover-the-caller).
   *  Brain-owned: set each think, consumed by the goal picker. */
  radio?: BotVec | null;
  /** Nuggets-style economy rooms: when no player threatens, prefer
   *  creature targets (id prefix `b:`) - farming is the objective, and a
   *  human would do the same. Enemies still outrank food when close. */
  huntCreatures?: boolean;
  /** A friendly deployable that needs a weld - the host's nearest
   *  damaged item (key is host-opaque: server id, client candId).
   *  Only builders act on it; everyone else ignores the channel. */
  repair?: { key: string; pos: BotVec; frac: number } | null;
  /** Map-structure colliders for wall occlusion in LOS - hosts that model
   *  solid structures pass them so bots don't stare into walls; hosts
   *  without one fall back to terrain-only LOS like before. */
  solids?: readonly StructureCollider[];
  solidIndex?: ColliderIndex | null;
  /** The bot's team - team-filtered solids (shield gates) don't block
   *  its own LOS/aim probes. */
  team?: string;
  /** Host hook: muzzle speed of the weapon the bot would pick at `dist`
   *  - aim lead divides range by real flight speed instead of a fixed
   *  60 m/s guess (a mortar under-leads and a disc over-leads at 60).
   *  0 means hitscan - zero flight time, no lead. */
  weaponSpeed?(dist: number): number;
  /** Host hook: effective reach of the weapon the bot would pick at
   *  `dist` - the brain holds fire beyond it (a beam stops at its ray
   *  length; hosing air past reach is a whiff the stats count). Omit
   *  → no limit (projectiles reach past any sane engagement). */
  weaponRange?(dist: number): number | undefined;
  /** Host hook: fuse seconds of the weapon the bot would pick at `dist`
   *  when it's a fuseOnly carrier (MRV - the airburst IS the attack).
   *  Intercept time caps at the fuse: the aim solves "carrier at fuse =
   *  target at fuse", not a body crossing it phases through. Omit → no
   *  fuse, plain intercept timing. */
  weaponFuse?(dist: number): number | undefined;
  /** Host hook: preferred duel distance for the weapon the bot would
   *  draw at `dist`, against a target at `targetHpFrac` health - a Flak
   *  brawler hugs a full-hp foe but won't chase a straggler it can chip
   *  from mid. Omit → the generic orbit midpoint. */
  preferredRange?(dist: number, targetHpFrac?: number): number | undefined;
  /** Host hook: legal refire (s between shots) of the weapon the bot
   *  would pick at `dist` - the volley cadence scales with it so a
   *  chaingun streams while a mortar deliberates. Omit → 0.45s. */
  fireInterval?(dist: number): number;
  /** Host hook: whether the weapon the bot would pick at `dist` is
   *  gravity-bent - the aim point gets the drop added back so lobbed
   *  shells don't land short. Omit → flat trajectories. */
  weaponGravity?(dist: number): boolean;
  /** Blast of the weapon the pick would take at `dist` - feeds the
   *  self-splash read (r=0 for hitscan/melee). */
  weaponAoe?(dist: number): { r: number; dmg: number };
  /** Host hook: the bot's skill multiplier for the weapon it would pick
   *  at `dist`, against a target moving at `targetSpeed` - feeds the
   *  skill matrix (snap/track/arc axes, moving vs still split, form).
   *  Omit → every bot shoots at 1×. */
  aimSkill?(dist: number, targetSpeed: number): number;
  /** Spatial-memory hooks - the host's influence map. QuietDir points
   *  at the least-danger-scented ring cell ~160m out (where MY team is
   *  NOT getting hurt); hottest returns the strongest opportunity cell
   *  within ~190m (fights, gems, flag events). Absent without a map. */
  imapQuietDir?(pos: BotVec): { x: number; z: number };
  imapHottest?(pos: BotVec): { x: number; z: number; v: number } | null;
  /** Raw danger scent at a spot on the caller's team layer - utility
   *  scoring reads it to discount goals in graveyards. */
  imapDanger?(pos: BotVec): number;
}

export interface BrainOut {
  /** Where the caller should move the bot this step. */
  dest: BotVec;
  /** Legal-input hints for the host sim - same keys a human holds.
   *  Omitted fields mean "not held". */
  move?: { ski?: boolean; jet?: boolean; jump?: boolean; park?: boolean };
  /** Fire command when the bot wants to shoot this step. */
  fire?: { targetId: string; aim: BotVec };
  /** Claimed toggle bits - same STATUS mask a human's inputMove carries.
   *  The host applies rising-edge antes + drains, so the brain only
   *  picks bits it can afford; omit → keep current status. */
  status?: number;
  /** Belt throw this step (grenade arc at the hunt target). */
  belt?: boolean;
  /** Instant Q-skill press this step - the host validates energy +
   *  cooldown via onSkillUse, then applies the effect locally. */
  skill?: string;
  /** Grapple-transit intent: an anchor point ahead of the destination
   *  to fire the rope-dart belt item at - hit terrain, reel to it,
   *  keep skiing. Only valid when the loadout's belt slot IS Hook. */
  hook?: BotVec;
  /** Flag pass to a teammate (standoff pass or pre-death handoff) -
   *  the host resolves the toss through the same throwFor a human's
   *  throwFlag intent reaches. Carries the receiver's position so the
   *  host can face the carrier at it for the arc. */
  passFlag?: BotVec;
  /** Deployable claim this step (turret/mine/station) - the same shape a
   *  human's deploy message carries; the host validates + caps it. */
  deploy?: { kind: string; pos: BotVec };
  /** Repair-beam tick on the ctx.repair target - the host resolves the
   *  key and runs the same heal path a human's repair claim does. */
  repair?: string;
  /** Situation chatter edge - the senses noticed something worth a line.
   *  The host resolves kind→text through botTaunts.chatter (chance +
   *  cooldown live there), so brains never speak directly. */
  say?: { kind: ChatterKind; target?: string; d?: string; h?: string };
}

const FLINCH_S = 0.4;

// Fear / hero - both are sense tuning, never new moves or info. Below
// FEAR_HP the bot breaks contact (retreat, sloppy suppression on purpose);
// a rare hero roll on entering that state instead sharpens every sense a
// human could sharpen: cadence, aim, dodge horizon, acquisition range.
// Tribes players don't scatter at the first scratch - FEAR_HP sits near
// death, and the hero roll is a real coin flip toward a last stand.

 // per hurt episode, rolled on the rising edge
        // seconds of hero before it cools off

const DEATH_MS = 15_000;  // a death spot stays scary this long
const DEATH_RANGE = 10;  // m - repel radius around each remembered death


export class BotBrain {
  /** Set the spawn point as the initial goal. `spec` picks the
   *  difficulty band (or per-axis mix) the skill matrix and hunt
   *  draws are rolled from. */
  constructor(spawn: BotVec, spec: BotSkillSpec = 'medium') {
    this.goalS.goal = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.h = newHuntState(spawn, spec);
    // Phase-stagger + personality by spawn hash, not RNG: constructor-time
    // draws run before a harness can install a seeded stream, so botRand
    // here made same-seed rooms diverge on which tick each brain first
    // thought. Three independent hashes so the traits don't correlate.
    const h01 = ((Math.sin(spawn.x * 12.9898 + spawn.z * 78.233 + spawn.y * 37.719) * 43_758.5453) % 1 + 1) % 1;
    const h02 = ((Math.sin(spawn.x * 39.3468 + spawn.z * 11.1357 + spawn.y * 83.1554) * 24_634.6345) % 1 + 1) % 1;
    const h03 = ((Math.sin(spawn.x * 73.1562 + spawn.z * 52.2354 + spawn.y * 9.1512) * 58_342.2154) % 1 + 1) % 1;
    const h04 = ((Math.sin(spawn.x * 27.6197 + spawn.z * 57.5831 + spawn.y * 19.9176) * 31_415.9265) % 1 + 1) % 1;
    const h05 = ((Math.sin(spawn.x * 51.4237 + spawn.z * 93.1157 + spawn.y * 11.1313) * 58_342.2154) % 1 + 1) % 1;
    const h06 = ((Math.sin(spawn.x * 91.3317 + spawn.z * 41.7213 + spawn.y * 63.2741) * 47_231.8113) % 1 + 1) % 1;
    this.thinkT = h01 * T.brain.thinkS;
    this.beltT = 4 + h02 * 4;
    this.deployT = 8 + h02 * 25;
    this.builder = h03 < 0.45;
    this.wanderlust = T.brain.wanderBase + h01 * T.brain.wanderRand;
    this.duty = T.brain.dutyBase + h03 * T.brain.dutyRand;
    this.social = h04;
    this.sweat = h05 >= 0.88 ? h05 : 0;
    // Coin-greed trait: hoovers every spill vs plays deathmatch and
    // barely registers the floor. The goal picker scales pile weight
    // by it, so the same drop pulls some bots cross-map and leaves
    // others fighting through it.
    this.greed = h06;
    this.orbitA = h02 * Math.PI * 2;
    this.orbitDir = h01 < 0.5 ? 1 : -1;
    this.orbitFlipT = 1 + h03 * 1.5;
  }

  private thinkT = T.brain.thinkS;
  // Hunt-stall window - see the comment at the probe site below. Tracks
  // whether a chase is actually closing; the escape counters can't see
  // the treadmill shape (wobble resets them every window).
  private huntWin = { id: '', t: 0, ax: 0, az: 0, d0: 0, fails: 0 };
  private goalClimbs = 0;
  private goalWin = { t: 0, d: Infinity, ax: 0, az: 0 };
  /** Wall-walk waypoint - armed when the goal line hits an unclimbable
   *  face; pickDest steers feet to the gap/low section the probe found. */
  breachGoal: BotVec = { x: 0, y: 0, z: 0 };
  breachUntil = 0;
  readonly h: HuntState;
  flinchT = 0;
  flinchFrom: BotVec = { x: 0, y: 0, z: 0 };
  private beltT = 8; // staggered in the constructor along with thinkT
  private skillT = 5; // same stagger cadence - presses, not channels
  private hookT = 3; // staggered with the others
  /** Belt trigger window/cooldown - tunable for A/B trigger soaks. */
  beltMin = 5;
  beltMax = 45;
  beltCd = 6;
  // Stuck/dodge senses live in botEscape.ts - escapeS is their state bag.
  private readonly escapeS: EscapeState = {
    stuckStreak: 0,
    orbitStreak: 0,
    escapeJetT: 0,
    detour: null,
    detourT: 0,
    progressPos: { x: 0, y: 0, z: 0 },
    progressGoalD: Infinity,
    goalWinT: 0,
    progressT: 0,
    pinX: 0,
    pinZ: 0,
    pinT: 0,
    pinStreak: 0,
    goal: { x: 0, y: 0, z: 0 }, // kept in sync with goalS.goal each think
  };
  readonly steerer = new BotSteer(); // public for A/B soak flags (skiCharge)
  /** Human-shaped aiming turns (see botSlew.ts) — hosts drive this with
   *  their own yaw/pitch each frame; the spring+volatility+noise model
   *  replaces the old constant-rate slew so crosshair motion reads as a
   *  person, not a servo. Lives on the brain so both hosts share it. */
  readonly slew = new BotSlew();
  // Meso-scale terrain routing lives in botLines.ts - turns a raw goal
  // into a committed landing spot so the steerer walks ski lines.
  private readonly lines = new BotLines();
  // Idle-goal ladder lives in botGoals.ts - goalS is the state bag it
  // reads/writes so the brain's goal/wander/revenge fields stay private.
  readonly goalS: GoalState = {
    goal: { x: 0, y: 0, z: 0 },
    revengeT: 0,
    revengeFrom: { x: 0, y: 0, z: 0 },
    wanderT: 0,
    wanderWp: { x: 0, y: 0, z: 0 },
    goalAge: 0, goalScore: 0,
  };
  private readonly goals = new BotGoals(
    (): GoalState => this.goalS,
    (): number => this.wanderlust,
    (): { x: number; z: number; } => this.steerer.headingVec(),
    (p): boolean => this.nearDeath(p),
    (): number => this.duty,
    (): number => this.social,
    (): number => this.greed,
    (): number => this.orbitA,
    (): number => this.h.skill?.resolve ?? 0,
  );
  // Ski/jet/jump hint intents live in botMoves.ts - host closures read
  // the escape burst latch and the live hunt target.
  private readonly moves = new BotMoves({
    escapeJetT: (): number => this.escapeS.escapeJetT,
    huntPos: (): BotVec | null => this.h.hunt?.pos ?? null,
  });
  // Death memory - where the host reported this body dying. Souring
  // goals near a death spot is how map denial emerges: nobody scripts
  // "that corner is dangerous", the squad just stops wandering back.
  private deaths: { x: number; z: number; t: number }[] = [];
  private heroT = 0;      // hero-mode seconds remaining
  private hurtLatch = false; // rising-edge detector for the hero roll
  // Chatter edge latches - the say field is edge-triggered (fires once
  // per situation), never a steady-state flag.
  private threatLatch = false;
  private boredLatch = false;
  /** takeHit arms a 'getting shot' line for the next think - flinchT
   *  decays silently, but the flinch event is worth one remark. */
  private hitSay = false;
  // Deploy intent - only some bots are builders, so a stand gets a couple
  // of sentries rather than a turret farm. Arriving at a defensive anchor
  // (objective in reach, nobody shooting) is the whole trigger: the
  // emplacement emerges from "a defender with time on their hands",
  // not a scripted base layout.
  // Field-init draws can't use botRand - they run at construction, before a
  // harness installs a seeded stream, so they made same-seed rooms diverge.
  // Both get re-seeded from the spawn hash inside the constructor instead.
  deployT = 8;
  builder = false;
  /** Deploy trigger gates - tunable for A/B trigger soaks. */
  deployCdLo = 8;
  deployCdSpan = 10;
  deployObjR = 60;
  /** Force a deployable kind for item A/B soaks - undefined = the roll. */
  deployForce: string | undefined;
  /** Skills blind for A/B soaks - statusIntent returns undefined. */
  skillsOff = false;

  /** Hosts can pin the builder trait - a technician role shouldn't be
   *  a dice roll away from never touching the deploy kit. */
  setBuilder(v: boolean): void { this.builder = v; }

  /** Host reports the bot's corpse spot on death, stamped with the
   *  same clock ctx.now rides - shared sim code never reads wall-clock
   *  itself (test harnesses step sim-time, not real time). */
  private now = 0;
  markDeath(pos: BotVec, now: number): void {
    this.deaths.push({ x: pos.x, z: pos.z, t: now });
    if (this.deaths.length > 8) {this.deaths.shift();}
    noteFoeDeath(this.h, now); // the kill goes on whoever hit last
  }

  /** Is p within the repel radius of a recent death? */
  private nearDeath(p: { x: number; z: number }): boolean {
    const { now } = this;
    for (const d of this.deaths) {
      if (now - d.t > DEATH_MS) {continue;}
      const dx = p.x - d.x, dz = p.z - d.z;
      if (dx * dx + dz * dz < DEATH_RANGE * DEATH_RANGE) {return true;}
    }
    return false;
  }
  // Personality scalars - ±20-30% per bot so a squad doesn't read as one
  // centipede: different preferred ranges, wander appetites, tempers.
  // Spawn-hash seeded (see constructor) - a field-init botRand here would
  // diverge same-seed rooms before any seeded stream is installed.
  private readonly wanderlust = T.brain.wanderBase;
  /** How much this bot minds the objective vs the scenery - high duty
   *  chases heard fights and holds roles, low duty goes sightseeing.
   *  Independent of wanderlust: a hyper tourist and a lazy pro both
   *  exist in a real lobby. */
  private readonly duty = T.brain.dutyBase;
  /** Gregariousness 0..1 - how much company this bot seeks when the
   *  match isn't going its way. A 0-social bot is a career lone wolf:
   *  it rallies at the same near-death HP a human soloer would, while
   *  a 1-social bot rattled by a losing match drifts toward teammates
   *  long before it's cornered. */
  private readonly social: number = 0.5;
  /** Tryhard scalar - 0 for ~88% of bots; the rare sweatlord plays
   *  comp-pub: posted roles still don't figit, and a runner announces
   *  its cap timing instead of just going. Charm is the rarity - a
   *  uniform squad of callers would read as scripted, not sweaty. */
  private readonly sweat: number = 0;
  /** Coin-greed trait 0..1 - how hard token piles pull the goal pick.
   *  Near-0 bots play the mode as deathmatch (the pile has to be at
   *  their feet to outbid a fight); near-1 bots are lobby hoovers who
   *  cross midfield for a purple spill. Hashed per spawn like the
   *  rest of the personality. */
  readonly greed: number = 0.5;
  /** Held-position strafe orbit - angle advances each pickDest step.
   *  Direction reverses on a jitter (a real duelist breaks the readable
   *  circle) and the radius breathes per flip, so the hold never reads
   *  as a carousel. */
  // Field-init draws stay literal - the constructor re-seeds them from the
  // spawn hash (botRand here would diverge same-seed rooms pre-stream).
  orbitA = 0;
  orbitDir = 1;
  orbitFlipT = 1;
  orbitMul = 1;
  /** Combat-dance beat: duels alternate a settled "burst" phase (orbit
   *  crawls - feet quiet, aim steady) with a "relocate" swing (orbit
   *  races to a new angle). The rhythm is what reads human; a constant
   *  carousel doesn't. beatMove=true means the swing is live. */
  beatT = 1;
  /** A teammate's VGS command stuck a pin: where the call points and
   *  until when. Heard fresh → offered to pick() as long as it's warm. */
  private radioGoal: (BotVec & { until: number }) | null = null;
  /** Rising-edge latch for the sweatlord's cap call. */
  private pushLatch = false;
  beatMove = false;
  /** Last think resolved to stand-and-shoot - a legal hold, not a stall.
   *  Hosts read this to keep stall/mobility watchdogs honest. */
  holding = false;
  /** Last think's destination - watchdog forensics only: a stuck bot
   *  grinding toward X needs X logged, not just where it is. */
  lastDest: BotVec = { x: 0, y: 0, z: 0 };
  /** Capper staging patience - seconds spent orbiting outside the
   *  defended ring waiting for the push wave to catch up. */
  stageT = 0;
  /** Contested-transit loiter clock - seconds the capper has held at the
   *  edge of a live kill zone waiting for the fight to thin or his wave
   *  to join (pickDest arm/reset). */
  loiterT = 0;
  /** Hold-off repeller the steerer applies this think - pickDest sets
   *  it while a defended objective is being staged onto. */
  standoff: { x: number; z: number; radius: number; strength: number } | null = null;
  /** Lateral weave drive armed by pickDest - the runner's serpentine,
   *  applied inside the steering field rather than as a fake waypoint. */
  weave = 0;
  /** Flag-pass cooldown - a tossed flag changes hands on its own, so
   *  this only throttles the wounded-carrier roll between passes. */
  private passT = 0;

  /** Current hunt target - the belt intent carries no aim of its own,
   *  so hosts resolve the throw's arc off this. */
  get currentHuntId(): string | null {
    return this.h.hunt?.id ?? null;
  }

  /** Where the hunt was last actually seen - the only legal aim point
   *  for a lobbed throw (live position would be a wallhack on a
   *  cloaked or occluded target). `vel` rides along so the throw can
   *  lead by the same velocity the eye measured - a dart at a memory
   *  point is a guaranteed miss on a runner. */
  get currentHuntSeen(): (BotVec & { vel: BotVec }) | null {
    return this.h.hunt ? { x: this.h.lastSeen.x, y: this.h.lastSeen.y, z: this.h.lastSeen.z, vel: this.h.lastSeenVel } : null;
  }

  /** Jet-gate telemetry for the cap-run harness - which gate armed the
   *  last burn plus the latches that could outlive it. */
  get jetDebug(): { why: string; escapeT: number; out: boolean; hold: number } {
    return { why: this.moves.jetWhy, escapeT: this.escapeS.escapeJetT, out: this.moves.jetOut, hold: this.moves.holdFor() };
  }

  /** True while the mount-perch holds a lip for tank refill - the
   *  disposition reads it to shed drain skills until the mount fires. */
  get mountWait(): boolean { return this.moves.mountWait; }

  /** Perched-by-design (breath/mount staging) for the mobility watchdog. */
  get perched(): boolean { return this.moves.perched; }

  /** Snapshot of the escape/mount internals at warn time - the line that
   *  says WHY the bot couldn't close (dry tank, perching, detouring). */
  get stuckDiag(): Record<string, number | boolean> {
    return {
      mw: this.moves.mountWait,
      perched: this.moves.perched,
      holding: this.holding,
      ss: this.escapeS.stuckStreak,
      os: this.escapeS.orbitStreak,
      ps: this.escapeS.pinStreak,
      det: Number(this.escapeS.detourT.toFixed(2)),
      ej: Number(this.escapeS.escapeJetT.toFixed(2)),
      park: this.lastPark,
      posted: this.lastPosted,
    };
  }

  private lastPark = false;
  private lastPosted = 0;

  /** The bot's skill matrix - hosts read it to bias weapon selection
   *  (a phenom draws its good gun) and to build the aimSkill ctx hook. */
  get skill(): BotSkill {
    return this.h.skill;
  }

  /** Role-adherence scalar for role-policy callers (HoF lean, route
   *  discipline): high duty holds the assigned shape, low duty loosens
   *  it. Guidelines not laws - nobody sits at exactly 1.0. */
  get dutyLevel(): number {
    return this.duty;
  }

  /** The tryhard read - hosts feed it into FlagSituation so the goal
   *  table can give sweaty bots comp-pub behaviors (route-leading the
   *  thief, posting a leash a loose defender wouldn't hold). */
  get sweatLevel(): number {
    return this.sweat;
  }

  /** Getting shot makes the bot recoil - call from the damage funnel. */
  takeHit(from: BotVec, attackerId?: string): void {
    this.flinchT = FLINCH_S;
    this.hitSay = true;
    this.flinchFrom = { x: from.x, y: from.y, z: from.z };
    if (attackerId) {noteFoeHit(this.h, attackerId, this.now);}
    this.h.lastHitAt = this.now;
    this.h.skill.form = Math.max(0.85, this.h.skill.form - 0.03); // tilt
    this.goalS.revengeT = 2.5;
    this.goalS.revengeFrom = { x: from.x, y: from.y, z: from.z };
  }

  /** Situation chatter - rising edges only; the host resolves kind→line
   *  through botTaunts.chatter, which rate-limits anyway, but firing a
   *  steady flag would still waste the cooldown on repeats. Priority is
   *  first-come: wounds outrank contacts outrank ambience. */
  private pickSay(ctx: BrainCtx, hurtEdge: boolean, hero: boolean, wasHunt: string | null): BrainOut['say'] {
    // Threat/bored latches update every think - skipping them when a
    // higher-priority line fires would leak a stale 'underfire' next tick.
    const underfire = this.sayThreats(ctx);
    const bored = this.sayBored(ctx);
    if (hurtEdge) {return { kind: hero ? 'hero' : 'fear', h: this.hpTag(ctx) };}
    return this.sayHelp(ctx) ?? this.sayHunt(ctx, wasHunt) ?? underfire ?? bored;
  }

  /** Carrier under pressure calls for an escort - when the line comes
   *  out as VDM/VNE the radio layer turns the chord into a real pin on
   *  this bot's position, so the shout is a call for help, not flavor. */
  private helpUntil = 0;
  private sayHelp(ctx: BrainCtx): BrainOut['say'] {
    if (!ctx.running || ctx.now < this.helpUntil) {return undefined;}
    const close = ctx.enemies.some((e): boolean => e.alive && distSqXZ(e.pos, ctx.pos) < 90 * 90);
    if (!close) {return undefined;}
    this.helpUntil = ctx.now + 30_000;
    return { kind: 'callfor' };
  }

  /** {h} fill for wound lines - "im at 23hp" reads human, "im hurt" is a bot line. */
  private hpTag(ctx: BrainCtx): string | undefined {
    return ctx.healthFrac == null ? undefined : `${Math.round(ctx.healthFrac * 100)}hp`;
  }

  /** {d} fill for spotting lines - compass bearing from self to the
   *  last-seen ground, so "contact sw" names where, not just who. */
  private dirTag(ctx: BrainCtx, at?: BotVec | null): string | undefined {
    const t = at ?? this.h.lastSeen;
    if (!t) {return undefined;}
    return dir8(t.x - ctx.pos.x, t.z - ctx.pos.z);
  }

  /** Hunt edge: acquired a player (or committed to the thief) / lost them. */
  private sayHunt(ctx: BrainCtx, wasHunt: string | null): BrainOut['say'] {
    const huntNow = this.h.hunt?.id ?? null;
    if (huntNow && !wasHunt) {
      if (huntNow === ctx.thief?.id) {return { kind: 'thief', target: huntNow, d: this.dirTag(ctx, ctx.thief.pos) };}
      if (huntNow.startsWith('b:')) {return undefined;}
      return { kind: 'contact', target: huntNow, d: this.dirTag(ctx) };
    }
    if (wasHunt && !huntNow) {return { kind: 'lost', target: wasHunt, d: this.dirTag(ctx) };}
    return undefined;
  }

  /** Inbound shells OR a fresh hit - either is "I'm being shot at". */
  private sayThreats(ctx: BrainCtx): BrainOut['say'] {
    const threats = (ctx.threats?.length ?? 0) > 0 || this.hitSay;
    this.hitSay = false;
    const say = threats && !this.threatLatch ? { kind: 'underfire' as const, h: this.hpTag(ctx) } : undefined;
    this.threatLatch = threats;
    return say;
  }

  /** Long silence with nobody acquired - the ambient line. STALE_MS is
   *  too twitchy; a human only remarks on a genuinely empty field. */
  private sayBored(ctx: BrainCtx): BrainOut['say'] {
    const quiet = !this.h.hunt && ctx.now - this.h.lastSeenAt > 40_000;
    if (!quiet) { this.boredLatch = false; return undefined; }
    if (this.boredLatch) {return undefined;}
    this.boredLatch = true;
    return { kind: 'bored' };
  }

  /** Belt lob: a live target in mid range on a 9s cooldown - grenades
   *  into a brawl, not at ghosts (stale seen-times don't qualify).
   *  The infiltrator plays it as an ambush: the belt flies at knife
   *  range in the same tick the cloak drops - belt+primary combo is
   *  the whole point of sneaking up. */
  private pickBelt(dt: number, pos: BotVec, now: number, ctx: BrainCtx): boolean {
    this.beltT -= dt;
    if (!this.h.hunt || this.beltT > 0) {return false;}
    // A live sight is the normal window; a ghost that went dark inside
    // ~4s still earns the AoE - the human "he went cloak, spam the
    // corner" lob. Beyond that the target is genuinely elsewhere and
    // the belt stays home.
    if (now - this.h.lastSeenAt > 4000) {return false;}
    const d = dist3(pos, this.h.lastSeen);
    if (ctx.infiltrating) {
      // Guideline, not doctrine - only commit to the knife-range combo
      // when the setup is favorable: healthy enough to eat the trade,
      // tank carrying the fight, and not walking into a crowd.
      const crowded = (ctx.enemies?.length ?? 0) > 2;
      if (d > 22 || crowded || (ctx.healthFrac ?? 1) < 0.45 || (ctx.energy ?? 99) < 25) {return false;}
      this.beltT = this.beltCd;
      return true;
    }
    if (d <= this.beltMin || d >= this.beltMax) {return false;}
    this.beltT = this.beltCd;
    return true;
  }

  /** Instant Q-skill pick: the brain presses its own equipped skill on
   *  its own terms, never a scripted moment - the host validates the
   *  energy ante + cooldown so the press is only ever legal. Each
   *  skill's trigger is a human-shaped reason, not doctrine: dash is a
   *  gap-closer on a chase, slam is a dive on a fight you're landing
   *  on, blink/warp are the get-there/escape teleports, bounce is a
   *  hop. Channel skills (cloak/shield/medkit) live in statusIntent. */
  private pickSkill(dt: number, pos: BotVec, ctx: BrainCtx, fearing: boolean): string | undefined {
    this.skillT -= dt;
    const id = ctx.skill;
    if (!id || this.skillT > 0 || (ctx.energy ?? 99) < 40) {return undefined;}
    if (id === 'cloak' || id === 'shield' || id === 'medkit') {return undefined;} // channel skills ride statusIntent
    const hunting = this.h.hunt !== null;
    const d = hunting ? dist3(pos, this.h.lastSeen) : Infinity;
    const hurt = (ctx.healthFrac ?? 1) < 0.4;
    const press = (): string => { this.skillT = 4; return id; };
    switch (id) {
      case 'dash': {
        // Gap-closer: a committed chase at reach, or a scared bot
        // breaking contact - both are the human "Q to move faster".
        if ((hunting && d > 10 && d < 70) || (fearing && hurt)) {return press();}
        break;
      }
      case 'slam': {
        // Dive on the fight you're landing on: a close hunt with the
        // drop to make the dive pay.
        if (hunting && d < 18) {return press();}
        break;
      }
      case 'blink':
      case 'warp': {
        // Get-there or get-out: infiltrating toward the objective from
        // reach, or a hurt bot escaping - the beacon answers both.
        if ((ctx.infiltrating && ctx.objective && dist3(pos, ctx.objective) > 50) || (fearing && hurt)) {return press();}
        break;
      }
      case 'bounce': {
        // Hop: the mobility habit on any approach or scramble.
        if (hunting || fearing) {return press();}
        break;
      }
    }
    return undefined;
  }

  /** Grapple transit: fire the rope at an anchor ahead of the line the
   *  bot is already walking - the human "hook the ridge, reel, keep
   *  skiing" move. Only fires when the belt slot actually carries the
   *  rope, the leg is long, nobody's worth a duel right now, and the
   *  reel isn't wasted on a body already at ski speed. */
  private pickHook(dt: number, pos: BotVec, ctx: BrainCtx, dest: BotVec): BotVec | undefined {
    this.hookT -= dt;
    if (ctx.beltItem !== WeaponType.Hook || this.hookT > 0 || (ctx.energy ?? 99) < 30) {return undefined;}
    if (this.h.hunt !== null) {return undefined;} // fighting > transiting
    const d = dist3(pos, dest);
    if (d < 60) {return undefined;} // short hops don't buy a reel
    const speed = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.z) : 0;
    if (speed > 22) {return undefined;} // already skiing - a reel adds nothing
    const dir = dirXZ(dest.x - pos.x, dest.z - pos.z);
    const reach = Math.min(45, d * 0.5);
    const ax = pos.x + dir.x * reach, az = pos.z + dir.z * reach;
    this.hookT = 6;
    return { x: ax, y: ctx.groundY(ax, az) + 2, z: az };
  }

  /** Fear/hero state rides the health fraction - a rare hero roll on the
   *  rising edge of getting hurt decides whether low HP means retreat or
   *  a desperate last stand. Latch resets once healed so the next wound
   *  gets a fresh roll. */
  private mood(ctx: BrainCtx, dt: number): { hurtEdge: boolean; hero: boolean; fearing: boolean } {
    // A hoarder breaks contact earlier - every held token is value the
    // corpse spills, and the headhunt regen drip refills a disengaged
    // carrier anyway. +0.005/held, capped at +0.50: empty pockets still
    // fight to 15% but a 100-token vault bails below ~65%.
    // Broke hunters press DEEPER than the base floor (-0.06 fading to
    // par at 20 tokens): nothing on the corpse means nothing to lose,
    // so the empty-pocket bot is the one who dives the guarded vault.
    // ctx.held is undefined outside headhunt - other modes keep par.
    const {held} = ctx;
    const fearAt = T.brain.fearHp + Math.min(held ?? 0, 100) * 0.005
      - (held === undefined ? 0 : 0.06 * Math.max(0, 1 - held / 20));
    const hurt = (ctx.healthFrac ?? 1) < fearAt;
    const hurtEdge = hurt && !this.hurtLatch;
    // A nemesis rattles the hero roll - the man who's already killed
    // this bot twice doesn't inspire a last stand, he ends it.
    const shaken = this.h.lastHitBy && dreadOf(this.h, this.h.lastHitBy.id) >= 2;
    if (hurtEdge && botRand() < T.brain.heroChance * (shaken ? 0.4 : 1)) {this.heroT = T.brain.heroS;}
    this.hurtLatch = hurt;
    this.heroT = Math.max(0, this.heroT - dt);
    const hero = this.heroT > 0;
    return { hurtEdge, hero, fearing: hurt && !hero };
  }

  // oxlint-disable-next-line complexity, max-lines-per-function -- the brain's per-think decision pipeline; staged gates read as one flow
  think(dt: number, ctx: BrainCtx): BrainOut {
    const {pos} = ctx;
    const {now} = ctx;
    this.now = now;
    driftForm(this.h.skill, dt);

    const { hurtEdge, hero, fearing } = this.mood(ctx, dt);

    const wasHunt = this.h.hunt?.id ?? null;

    // Opt-in stage profiler - FPS_THINK_PROF seeds thinkProf + wallPerf;
    // absent, the wrapper costs one undefined check per stage.
    const prof = sharedEnv.thinkProf;
    const pf = prof ? sharedEnv.wallPerf! : (): number => 0;
    const pm = (stage: string, t0: number): void => { if (prof) {prof.set(stage, (prof.get(stage) ?? 0) + pf() - t0);} };
    let tp = pf();

    // Radio commands carry an implied position - a same-team "Defend our
    // flag!" or "Cover me!" sticks for a stretch instead of dying with the
    // notice tick, so a dutiful bot actually rotates toward the call.
    if (ctx.notice?.goal) {this.radioGoal = Object.assign({}, ctx.notice.goal, {until: now + 25_000});}
    if (this.radioGoal && (now > this.radioGoal.until || distSqXZ(this.radioGoal, pos) < 25 * 25)) {this.radioGoal = null;}
    ctx.radio = this.radioGoal;
    // Brain-owned trait injected into ctx - pickHunt's ectx clone then
    // carries it to scanVisible without another parameter thread.
    // Resolve acts like sweat: a pressured bot plays like the rolled
    // tryhard - fight-seeking climbs with escalation, same legal dial.
    ctx.sweat = Math.max(this.sweat, this.h.skill?.resolve ?? 0);

    // Hero mode: pressure -> resolve -> the skill dials lerp toward
    // impossible. menacePos rides the hearing sense at high resolve -
    // the bot investigates the dominant player, no lock-on.
    if (HERO_ON && ctx.hero && this.h.skill) {
      heroTick(this.h.skill, ctx.hero, dt);
      // Predator earshot: the investigation radius scales WITH resolve -
      // a mild bot hears a brawl 50m out, a full hero hears the lobby's
      // problem across the map. Still the hearing sense, not a wallhack:
      // he walks there and fights fair.
      const earshot = 50 + this.h.skill.resolve * 250;
      if (this.h.skill.resolve > 0.5 && ctx.hero.menacePos
          && distSqXZ(ctx.hero.menacePos, pos) < earshot * earshot) {
        (ctx.sounds ??= []).push(ctx.hero.menacePos);
      }
    }

    // --- pick a hunt target / refresh the goal (slow cadence) ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = hero ? T.brain.thinkS * T.brain.heroThinkK : T.brain.thinkS;
      pickHunt(this.h, ctx, pos, now, { hero, fearing }, (c, p): void => this.goals.pick(c, p));
    }
    pm('hunt', tp);
    // The sweatlord's callout - a committed runner whose push just went
    // live announces the run ("going in") instead of silently flooding.
    // Rising edge only, and it doesn't outrank wound/fear lines.
    const capCall = this.sweat > 0 && ctx.runner && ctx.pushLive && !this.pushLatch;
    this.pushLatch = Boolean(ctx.pushLive);
    let say = this.pickSay(ctx, hurtEdge, hero, wasHunt) ?? (capCall ? { kind: 'capcall' } as const : undefined);
    this.goalS.wanderT -= dt;
    // detourT decays here, with the other timers - decrementing it inside
    // the dest block below would let the setting call's dt eat the window.
    this.escapeS.detourT -= dt;
    this.escapeS.escapeJetT -= dt;
    this.escapeS.goal = this.goalS.goal;
    this.goalS.revengeT -= dt;

    tp = pf();
    // --- choose the step destination ---
    const d0 = pickDest(this, dt, ctx, pos, fearing, hero);
    let dest = d0;
    pm('dest', tp);

    // --- line planning: commit to a terrain-sampled landing spot ---
    // Posted bots skip it - ski lines arc around the objective on
    // purpose (downhill bias, side-valley energy plays), which pulls a
    // defender off the stand he's meant to be planted on. Straight
    // home is the right route when the route is 50m.
    // An armed breach skips it too - the waypoint IS the door/gap the
    // wall machinery found; re-planning it against the objective pulls
    // the feet straight back into the face it exists to walk around
    // (bastion trace: bg=-326,328 → d1=-323,368 → d2=-301,339, bot
    // pinned at the wall 160s+).
    // An armed breach skips it too - but only the LOCAL wall-walk. A
    // far flow-hop breach is still a route leg, and blanket-skipping
    // both planning layers for the whole 25s window disarmed every
    // fight on the way (bastion soak: kills ~90 → ~30).
    const breaching = this.breachUntil > now
      && Math.hypot(pos.x - this.breachGoal.x, pos.z - this.breachGoal.z) < 45;
    tp = pf();
    const d1 = ctx.posted || breaching ? dest : this.lines.plan(dt, ctx, pos, dest);
    dest = d1;
    pm('lines', tp);

    // --- context steering: senses score every direction ---
    tp = pf();
    this.steerer.setStandoff(this.standoff);
    this.steerer.setWeave(this.weave);
    const d2 = breaching ? dest : this.steerer.steer(dt, ctx, pos, dest);
    dest = d2;
    pm('steer', tp);
    // Env-gated decision-chain trace: which stage rewrites the step.
    // FPS_TRACE=<playerId> - soaks print stage deltas for one bot.
    const {traceId} = sharedEnv;

    if (ctx.id && traceId && ctx.id.includes(traceId)
      && ctx.objective && Math.hypot(pos.x - ctx.objective.x, pos.z - ctx.objective.z) > 30) {
      const spd = ctx.vel ? Math.hypot(ctx.vel.x, ctx.vel.y, ctx.vel.z) : 0;
      const bg = this.breachUntil > now ? ` bg=${f(this.breachGoal)}` : '';
      // oxlint-disable-next-line no-console
      console.log(`trace t=${(now / 1000).toFixed(1)} pos=${f(pos)} v=${spd.toFixed(1)} ej=${this.escapeS.escapeJetT.toFixed(1)} goal=${f(ctx.objective ?? pos)} d0=${f(d0)} d1=${f(d1)} d2=${f(d2)}${bg}`);
    }

    // A deliberate stand-still must not arm the treadmill window inside
    // stuckBreak - a held combat spot or a mount/breath perch is parked
    // by choice, so re-anchor instead of letting it read as a pin.
    if (this.holding || this.moves.perched) {
      this.escapeS.pinT = 0;
      this.escapeS.pinX = pos.x;
      this.escapeS.pinZ = pos.z;
    }
    tp = pf();
    dest = stuckBreak(this.escapeS, dt, ctx, pos, dest);
    // Hunting is exempt from the waypoint forfeit - but a prey the bot
    // demonstrably can't reach is a wall-grind, not a chase. Windowed
    // streaks can't catch it (the detour/jet escapes wobble a walled
    // bot ≥2m a window, resetting every counter), so measure the hunt
    // itself: a 5s window where the bot neither moved 4m nor closed 4m
    // on the prey is a stall; if the straight line is blocked (roof
    // perch above the climb envelope, wall or enemy shield gate) the
    // target goes on a 30s blacklist. Blacklisting, not clearing:
    // pickHunt's LOS scan would re-acquire the same visible target on
    // the very next think, and the 'lost' edge fires through the
    // normal transition once the filter drops it.
    if (this.h.hunt) {
      const hp = this.h.hunt.pos;
      // The window survives target flips - a defended pocket holds
      // several visible enemies and pickHunt rotates between them, so
      // anchoring per-id resets the clock before it can ever mature.
      // The stall is the POCKET: only real movement or a target swap
      // that actually got closer re-arms it.
      this.huntWin.t += dt;
      // Target swap mid-window: keep the clock, re-anchor the distance
      // (closed-vs-d0 would otherwise measure the previous prey).
      if (this.huntWin.id !== this.h.hunt.id) {
        this.huntWin.id = this.h.hunt.id;
        this.huntWin.d0 = Math.hypot(hp.x - pos.x, hp.z - pos.z);
      }
      if (this.huntWin.t >= 5) {
        const moved = Math.hypot(pos.x - this.huntWin.ax, pos.z - this.huntWin.az);
        const closed = this.huntWin.d0 - Math.hypot(hp.x - pos.x, hp.z - pos.z);
        const stalled = moved < 4 && closed < 4;
        if (stalled && preyUnreachable(ctx, pos, hp) && this.huntWin.fails === 0) {
          // First verdict on a walled pocket isn't a blacklist - it's the
          // designed breach: spend the TANK scaling the face (3s ≈ 27m,
          // clears bastion's 21m gate where the 1.1s escape sips can't).
          // The dest still drives INTO the wall, so the burn climbs it.
          // Only a second consecutive stall earns the blacklist below.
          this.escapeS.escapeJetT = Math.max(this.escapeS.escapeJetT, 3);
          this.huntWin.fails = 1;
        } else if (stalled && (preyUnreachable(ctx, pos, hp) || (this.huntWin.fails += 1) >= 3)) {
          // The pocket is unreachable, not just this prey - a defended
          // gate holds several enemies, and blacklisting one at a time
          // re-arms the stall on each next-nearest. Everything huddled
          // near the unreachable target goes on the list together.
          // (Probe-false three-strikes: the geometry says a route exists
          // but the escape kit can't find it - same grind, same fix.)
          for (const e of ctx.enemies) {
            // oxlint-disable-next-line max-depth -- nesting tracks the hunt-failure branches above
            if (e.alive && distSqXZ(e.pos, hp) < 35 * 35) {this.h.unreachUntil.set(e.id, now + 30_000);}
          }
          this.h.unreachUntil.set(this.h.hunt.id, now + 30_000);
          this.huntWin.fails = 0;
        } else if (!stalled) {
          this.huntWin.fails = 0;
        }
        this.huntWin.t = 0; this.huntWin.ax = pos.x; this.huntWin.az = pos.z;
        this.huntWin.d0 = Math.hypot(hp.x - pos.x, hp.z - pos.z);
      }
    } else {
      this.huntWin.t = 0; this.huntWin.fails = 0;
    }
    // A goal the escape senses can't reach after ~4 failures is a bad
    // roll, not a challenge - forfeit the wander waypoint so the next
    // roll picks a new line instead of grinding the same wall forever.
    // Either streak counts: pinned grind or the orbit treadmill that
    // displaces without closing. But first, one designed-breach check:
    // if a structure wall sits on the straight path and its top is
    // inside the full-tank climb envelope (curtains ~17m, not 85m gate
    // towers), spend the tank scaling it before giving up the waypoint.
    // While a breach owns the feet, the stall counters must not grow -
    // the bot is deliberately walking a waypoint that ISN'T the goal,
    // so "not closing on goal" measures the escape itself, not a new
    // pin. Left counted, each breach re-arms the next: armed bg drives
    // feet off-goal, orbitStreak hits 4, wallResponse rolls another
    // 25s breach - the flag-carrier midfield orbit (capRun autopsy).
    if (this.breachUntil > now) {
      this.escapeS.stuckStreak = 0;
      this.escapeS.orbitStreak = 0;
    }
    const streak = Math.max(this.escapeS.stuckStreak, this.escapeS.orbitStreak);
    // Committed tasks outrank the hunt exemption: a besieger/runner
    // stalled on a vault wall with a live foe in sight still needs the
    // breach machinery - inside an enemy base there is ALWAYS a hunt
    // target, so `!this.h.hunt` would silence wallResponse exactly where
    // it's needed (siege probe: besieger parked at the door face 100s+).
    const committed = Boolean(ctx.wave || ctx.runner || ctx.running);
    if (streak >= 4 && (!this.h.hunt || committed)) {
      this.wallResponse(ctx, pos, now);
      this.escapeS.stuckStreak = 0;
      this.escapeS.orbitStreak = 0;
    } else if (streak === 0) {
      this.goalClimbs = 0;
    }
    // Proactive egress: a wall right in front of the bot on a long-range
    // goal line means it's pressing its own compound's interior - the
    // authored passTeam gate is air to it. Don't wait for a stall to
    // mature before finding the door; spawning inside a fortress burns
    // ~6s a life otherwise. ownGate only matches MY team's panes, so it
    // can never route an attacker through a defender's door.
    if ((!this.h.hunt || committed) && this.goalS.goal && this.breachUntil <= now && ctx.solids?.length) {
      const gd = Math.hypot(this.goalS.goal.x - pos.x, this.goalS.goal.z - pos.z);
      if (gd > 60) {
        const hit = segSolidHit(
          { x: pos.x, y: pos.y + 1, z: pos.z },
          { x: this.goalS.goal.x, y: pos.y + 1, z: this.goalS.goal.z },
          ctx.solids, ctx.solidIndex ?? undefined, ctx.team);
        if (hit && Math.hypot(hit.x - pos.x, hit.z - pos.z) < 45) {
          const gate = ownGate(ctx, pos, this.goalS.goal);
          if (gate) {
            this.breachGoal = gate;
            this.breachUntil = now + 20_000;
          }
        }
      }
    }
    // Macro progress check - the detector the motion counters can't
    // fake: a bot lapping a compound interior at 15m/s moves plenty but
    // never closes on the goal. Six seconds older and no nearer, with a
    // wall still on the goal line, gets the same climb-or-breach as a
    // hard pin. d anchored per window; a fresh goal just means the
    // first window re-anchors.
    if ((!this.h.hunt || committed) && this.goalS.goal) {
      this.goalWin.t += dt;
      if (this.goalWin.t >= 6) {
        const d = Math.hypot(this.goalS.goal.x - pos.x, this.goalS.goal.z - pos.z);
        const moved = Math.hypot(pos.x - this.goalWin.ax, pos.z - this.goalWin.az);
        if (d > 12 && this.goalWin.d - d < 8) {
          if (moved < 1.5) {
            // v≈0 with jets armed isn't a stall, it's a wedge - the bot
            // is folded into a structure pocket and every tangent probe
            // still reads wall. Back straight out of the pocket, then
            // let the next window route again.
            const g = dirXZ(this.goalS.goal.x - pos.x, this.goalS.goal.z - pos.z);
            this.breachGoal = { x: pos.x - g.x * 14, y: pos.y, z: pos.z - g.z * 14 };
            this.breachUntil = now + 4000;
            this.goalClimbs = 0;
          } else {
            this.wallResponse(ctx, pos, now);
          }
        }
        this.goalWin.t = 0;
        this.goalWin.d = d;
        this.goalWin.ax = pos.x;
        this.goalWin.az = pos.z;
      }
    } else {
      this.goalWin.t = 0;
      this.goalWin.d = Infinity;
      this.goalWin.ax = pos.x;
      this.goalWin.az = pos.z;
    }

    // --- dodge: sidestep the nearest closing shell ---
    dest = dodge(ctx, pos, dest, hero, this.h.skill?.movement ?? 1);
    pm('escape', tp);

    tp = pf();
    // --- fire ---
    const fire = pickFire(this.h, dt, ctx, pos, now, { hero, fearing });

    // --- belt: lob a grenade into a mid-range fight on a slow cooldown ---
    const belt = this.pickBelt(dt, pos, now, ctx);

    // --- Q-skill: press the equipped instant skill on its own terms ---
    const skillPress = this.pickSkill(dt, pos, ctx, fearing);

    // --- grapple: hook an anchor ahead on long quiet transits ---
    const hook = this.pickHook(dt, pos, ctx, dest);

    // --- deploy: a quiet defender with hands free fortifies the stand ---
    const deploy = pickDeploy(this, dt, ctx, pos, fearing);

    // --- repair: a builder in weld range works on the damaged gear ---
    const repair = pickRepair(this, ctx, pos, fearing);

    if (!say && belt) {say = { kind: 'belt' };}
    if (!say && deploy) {say = { kind: 'deploy' };}
    // Room-event notice - last priority: a wound or a fresh contact is
    // worth more words than scoreboard commentary.
    if (!say && ctx.notice) {say = { kind: ctx.notice.kind, target: ctx.notice.actor };}

    pm('fire+', tp);
    this.lastDest = dest;
    tp = pf();
    const move = this.moves.hints(dt, ctx, pos, dest);
    pm('moves', tp);
    this.lastPark = Boolean(move?.park);
    this.lastPosted = ctx.posted ?? 0;
    // Flag pass: a carrier about to eat the spill hands the flag
    // forward - a live teammate's grip beats the corpse drop, which is
    // also how the standoff pass game keeps the flag alive. A healthy
    // carrier runs the same play as a RELAY (30% roll): the receiver is
    // already nearer home and keeps the flag moving - free ground and
    // an unpredictable flag state for defenders reading the line.
    let passFlag: BotVec | undefined;
    this.passT = Math.max(0, this.passT - dt);
    if (ctx.running && this.passT <= 0) {
      const hp = ctx.healthFrac ?? 1;
      let mate: BotVec | null = null, mateD = 35;
      for (const a of ctx.allies ?? []) {
        const d = dist3(pos, a);
        if (d < mateD) { mate = a; mateD = d; }
      }
      // A pass that goes BACKWARD is a fumble, not a handoff - the toss
      // inherits carrier speed, so a mate parked at the stand the carrier
      // is leaving gets a flag that lands inside his own reach but still
      // on the enemy side, and the route pays the reset either way. Only
      // deliver forward: the receiver has to be meaningfully closer to
      // the carrier's objective (his own stand) than the carrier is.
      if (mate && ctx.objective
        && dist3(mate, ctx.objective) < dist3(pos, ctx.objective) - 10
        && botRand() < (hp < 0.4 ? 0.7 : 0.3)) { passFlag = { x: mate.x, y: mate.y, z: mate.z }; this.passT = 4; }
    }
    return { dest, move, fire, status: statusIntent(this, ctx, fearing), belt, skill: skillPress, hook, deploy, repair, say, passFlag };
  }

  /** Stall verdict for a goal the bot can't walk to: climbable face →
   *  spend the tank scaling it; unclimbable → waypoint the gap/low
   *  section the wall probe found; no structure at all → plain waypoint
   *  forfeit (terrain stall, not a wall problem). */
  private wallResponse(ctx: BrainCtx, pos: BotVec, now: number): void {
    // The authored exit first: a passTeam pane is our team's door - it
    // reads as air to us and solid to enemies, so walking THROUGH it is
    // always cheaper than climbing curtains. Only relevant when the
    // goal is on the far side of the walls; the pane must lie roughly
    // between the bot and its goal to be the exit, not a scenic detour.
    const gate = ownGate(ctx, pos, this.goalS.goal);
    if (gate) {
      this.breachGoal = gate;
      this.breachUntil = now + 20_000;
      this.goalClimbs = 0;
      return;
    }
    const wallTop = wallTopOnPath(ctx, pos, this.goalS.goal);
    if (wallTop !== null && wallTop - pos.y < 26 && this.goalClimbs < 2) {
      this.escapeS.escapeJetT = Math.max(this.escapeS.escapeJetT, 3);
this.goalClimbs += 1;
    } else {
      let breach = wallTop === null ? null : breachAlongWall(ctx, pos, this.goalS.goal);
      if (!breach && ctx.route && this.goalS.goal) {
        // The face probe only scans ±60m - a fortress wall's real
        // opening can sit farther along. The structure-aware flood
        // already threads it; take the next hop as the waypoint rather
        // than forfeiting to a re-approach loop - but only a hop the
        // bot can actually walk to: a cell center sitting behind wall
        // geometry re-arms the same pin it was meant to break.
        const hop = ctx.route(pos.x, pos.z, this.goalS.goal.x, this.goalS.goal.z, 90);
        if (hop && !segSolidHit(
          { x: pos.x, y: pos.y + 1, z: pos.z },
          { x: hop.x, y: pos.y + 1, z: hop.z },
          ctx.solids ?? [], ctx.solidIndex ?? undefined, ctx.team)) {breach = hop;}
      }
      if (breach) {
        this.breachGoal = breach;
        this.breachUntil = now + 25_000;
      } else {
        this.goalS.wanderT = 0;
      }
      this.goalClimbs = 0;
    }
  }
}

// dist3/distSq live in botVec.ts - shared by the brain family.
