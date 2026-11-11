import * as THREE from 'three';

import * as en from './botEnergy.js';



import { Projectile } from '../../projectiles/Projectile.js';

import { RemotePlayer } from '../../entities/RemotePlayer.js';

import type { Terrain } from '../../world/terrain.js';

import type { Nugget } from '../../entities/Nugget.js';

import { MovementController, type MovementState } from '../../entities/movement.js';

import { ENERGY } from '../../../../shared/movement.js';

import type { StructureSpec } from '../../../../shared/mapSpec.js';

import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';

import { BotBrain, BOT_EYE, type BrainOut } from '../../../../shared/botBrain.js';

import { CLASS_STATS, type ArmorClass } from '../../../../shared/botClasses.js';

import { BOT_LOADOUTS, pickBotWeapon, adaptLoadout, botClassForLoadout, type LoadoutSlot,type BotLoadout } from '../../../../shared/botLoadouts.js';

import { aimSkillFor } from '../../../../shared/botSkill.js';

import { botRand } from '../../../../shared/botRand.js';

import { botWeaponHooks } from '../../../../shared/botWeaponHooks.js';

import { type WeaponType, type AmmoPool } from '../../../../shared/weapons.js';

import { STATUS } from '../../../../shared/status.js';

import type { ChatterKind } from '../../../../shared/botTaunts.js';

import { perkMods, effectiveResist, type PerkMods } from '../../../../shared/perks.js';

import { inv } from '../../../../shared/invariants.js';

// the same map.structures the player's controller gets (net/world.ts).

const _aim = new THREE.Vector3();



/**

 * GameBot - an in-world fake player. A GameBot is a RemotePlayer registered

 * in world.remotePlayers under `bot:<name>`, so every existing funnel treats

 * it as a real player: creatures hunt it, projectiles collide with it,

 * explosions shove it. Damage resolution lives in TeamBots (local authority

 * in place of the server's hit validation).

 *

 * Brain is intentionally simple utility AI: collect nuggets > fight the

 * nearest enemy > roam. Aim uses last-seen position + lead + speed-scaled

 * scatter - the same Omicron delay as the pvptest harness bots.

 */



export const BOT_HP = 100;

export const BOT_DMG = 18;   // bolt claim damage, tuned to threaten but not melt

export const EYE = BOT_EYE;

const BOT_RESPAWN_S = 4;

// Terrain heights are static mid-match - one shared memo for every bot.

const sharedGroundYCache = new Map<number, number>();






interface BotThinkCtx {

  terrain: Terrain;

  skill?: string;

  beltItem?: WeaponType;

  enemies: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];

  nugget: Nugget | null;

  /** CTF: overrides nugget/roam - the flag or the home base. */

  objective?: THREE.Vector3 | null;

  /** Nearby bodies for the steering separation sense. */

  others?: THREE.Vector3[];

  /** Teammates only - the rally/fold sense (retreat never folds

   *  onto an enemy). */

  allies?: THREE.Vector3[];

  /** Long-arm reach for mortar heavies - extends acquisition past

   *  the duel band. */

  engageRange?: number;

  /** Fresh blasts in earshot - the hearing sense. */

  sounds?: { x: number; y: number; z: number }[];

  /** Inbound shells - the dodge sense. */

  threats?: { x: number; y: number; z: number }[];

  /** Carrying the objective - the route rules the feet. */

  running?: boolean;

  /** Flag-seeker commitment (rabbit hunters, CTF recoverers) - the

   *  objective outranks the hunt/dodge senses, same as server-side. */

  runner?: boolean;

  /** Named wave member - feet committed to a push/escort flood. */

  wave?: boolean;

  /** Escort-officer wave - holds position ahead of a moving carrier. */

  marshal?: boolean;

  /** Posted radius around the objective - 0/omitted hunts freely. */

  posted?: number;

  /** Rushing the enemy stand - cloak candidates cloak up. */

  infiltrating?: boolean;

  /** Enemy carrying OUR flag - beacon-marked, engages without LOS. */

  thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } | null;

  /** Both CTF flags on stands - route roles discount mid-field duels. */

  flagsHome?: boolean;

  /** Sweatlord reset: the objective layer wants this bot to press K -
   *  the manager executes it, the brain never sees it. */

  kout?: boolean;

  /** Economy modes prefer creature targets (nuggets farming). */

  huntCreatures?: boolean;

  /** Damaged friendly deployable a builder could weld (host-opaque

   *  key - mirrors the server senses' dep id). */

  repair?: { key: string; pos: THREE.Vector3; frac: number } | null;

  /** Room event this bot noticed - the server senses' notice ping. */

  notice?: { kind: ChatterKind; actor?: string } | null;

  /** The bot's nerve input (score margin + K/D) - mirrors

   *  ServerBotSenses.confidenceOf. Team modes only. */

  confidence?: number;
  /** Hero-mode pressure - mirrors ServerBotSenses.heroOf. */
  hero?: { deficit: number; ownPerf: number; menace: number; menacePos?: { x: number; y: number; z: number } };

  /** The objective flag's real position - altitude vetoes measure
   *  this, not the offset aim point (shared brain contract). */
  flagPos?: { x: number; y: number; z: number } | null;
  /** skill.movement - times the hop-descent jet. */
  moveSkill?: number;
  /** skill.thrift - vetoes wasteful grounded burns (shared/botMoves). */
  thrift?: number;
  /** skill.airLove - scales recon-climb appetite (shared/botMoves). */
  airLove?: number;
  /** Armor-class speedScale - speed floors in shared/botMoves scale by
   *  it so heavies are limited by physics, not a tuned floor. */
  speedScale?: number;
  /** Chased pickup's denomination (headhunt 1/3/9/27). */
  pickupVal?: number;
  /** Score deficit x endgame pressure, ~0..2 - team modes only. */
  desperate?: number;
  /** Richest friendly headhunt hoard worth escorting. */
  convoy?: { x: number; y: number; z: number } | null;
  /** Rich ally visibly dying - camp the spill before it lands. */
  spillSoon?: { x: number; y: number; z: number } | null;
}

export class GameBot extends RemotePlayer {

  /** 'alpha'/'bravo' in team modes; the bot's own playerId in FFA. */

  team: string;

  /** The LOCAL player's team - TeamBots refreshes it each frame so the

   *  friendly/enemy verdicts (cloak ghost vs vanish) follow re-seats. */

  localTeam?: string;

  botHp = BOT_HP;
  /** Last damage timestamp (perf.now) - mutes the headhunt hoard drip
   *  for HELD_BUFF.graceMs. */
  lastHitAt = 0;
  /** Headhunt held tokens - the offline mirror of PlayerState.heldTokens;
   *  death scatters it in denomination coins. */
  heldTokens = 0;

  /** Armor tier - speedScale feeds the shared MoveSim so heavy/light

   *  ground speed changes land exactly as the server computes them. */

  armorClass: ArmorClass = 'medium';

  botMaxHp = BOT_HP;

  /** Per-weapon pool rounds (ammoCap rows) - the offline mirror of
   *  PlayerState.ammoPool; botFire spends it, respawn() refills it. */
  ammoPool: AmmoPool = new Map();

  /** Loadout perk modifiers - the same table the server multiplies

   *  through CombatHandler/GameServer. 'none' until setLoadout runs. */

  mods = perkMods('none');

  get perkMods(): PerkMods { return this.mods; }

  private perkHealthBonus = 0;

  setLoadout(lo: BotLoadout): void {

    this.loadout = lo;

    this.mods = perkMods(lo.perk);
    this.movement?.setJumpstart?.(this.mods.jumpstart);

    this.perkHealthBonus = this.mods.maxHealth;

    this.recalcMaxHp();

  }

  setBotClass(cls: ArmorClass): void {

    this.armorClass = cls;

    const st = CLASS_STATS[cls];

    this.movement.setSpeedScale(st.speedScale);

    this.movement.setBody(st.mass, st.eyeHeight, st.radius);

    this.recalcMaxHp();

    this.setClass(cls); // silhouette

  }

  private recalcMaxHp(): void {

    const cap = BOT_HP + CLASS_STATS[this.armorClass].maxHealth + this.perkHealthBonus;

    const gained = cap - this.botMaxHp;

    this.botMaxHp = cap;

    if (gained > 0) {this.botHp = Math.min(cap, this.botHp + gained);}

  }

  respawnAt = 0;

  /** CTF: carrying the enemy flag home - objective overrides roam. */

  carryingFlag = false;

  /** Sheep meter 0-100: fills while the bot moves like a pedestrian

   *  (walking or parked), drains while it's skiing/airborne/jetting.

   *  Owned by TeamBots; rendered on the scoreboard + head badge. */

  /** Raw sheep factor + its smoothed display twin (badge/scoreboard read

   *  sheepShown so the % doesn't flicker frame to frame). */

  sheep = 100;    // llama until proven - high-E play drains it

  sheepShown = 100;

  /** Jets pinned by a propel blast - rides the shove like a disc-jump. */

  propelJetT = 0;

  /** Brain's belt intent from the last think - TeamBots resolves the arc. */

  wantBelt = false;

  /** Equipped Q-skill id + the brain's press intent from the last think. */
  skillId: string | undefined;
  wantSkill: string | null = null;

  /** Grapple-transit intent - the anchor point to rope toward. */
  wantHook: { x: number; y: number; z: number } | null = null;

  /** Builder intent from the shared brain - TeamBots plants it. */

  wantDeploy: { kind: string; pos: { x: number; y: number; z: number } } | null = null;

  /** Weld intent - the deployable key the brain is working on. */

  wantRepair: string | null = null;

  /** Flag-pass intent - the receiver's position; the bridge aims the

   *  toss at it through the same arc a human G-press resolves. */

  wantPass: { x: number; y: number; z: number } | null = null;

  /** Situation chatter edge from the shared brain - TeamBots routes it

   *  through the taunt pools + local chat sink. */

  wantSay: BrainOut['say'] | null = null;

  /** The destination the brain steered toward last think - propel gates

   *  on how far the bot still has to run. */

  readonly lastDest = new THREE.Vector3();

  /** Debug snapshot for the Alt+Shift+Q dump - what the brain is doing
   *  right now: steered dest, hunt target, equipped skill, pending
   *  intents. Compact enough to paste in a bug report. */
  get aiDump(): string {
    const {hunt} = this.brain.h;
    const intents = [this.wantSkill, this.wantBelt ? 'belt' : '', this.wantDeploy ? 'deploy' : '', this.wantHook ? 'hook' : ''].filter(Boolean).join(',') || '-';
    return `ai[dest=${this.lastDest.x.toFixed(0)},${this.lastDest.z.toFixed(0)} hunt=${hunt ? hunt.id.slice(0, 8) : '-'} skill=${this.skillId ?? '-'} intents=${intents}]`;
  }

  /** Propel cooldown (performance.now deadline) - one jump per launch. */

  propelUntil = 0;



  /** Shared decision core - same brain server bots run. */

  private brain: BotBrain;

  /** Kit from the shared roster - TeamBots assigns it so range-band

   *  weapon picks mirror the dedicated server's bots. */

  loadout?: BotLoadout;

  /** Per-slot reroll candidates this bot spawned with - alternates for

   *  authored kits, the full pools for wildcards (same rule as

   *  BotRoster.alts server-side). */

  loadoutAlts?: Partial<Record<LoadoutSlot, WeaponType[]>>;

  /** Respawn kit drift: keep whichever candidate the skill matrix

   *  favors - same adaptation BotRoster.adaptOnRespawn runs online. */

  adaptLoadout(): void {

    if (!this.loadout || !this.loadoutAlts) {return;}

    const next = adaptLoadout(this.loadout, this.loadoutAlts, (w): number => aimSkillFor(this.brain.skill, w, 0), botRand);

    if (next === this.loadout) {return;}

    this.setLoadout(next);

    const cls = botClassForLoadout(next);

    if (cls !== this.armorClass) {this.setBotClass(cls);}

  }

  /** Shared MoveSim - the same physics the server shadow runs, so a bot

   *  skis/jets/lands exactly like a legal player (no invented velocities). */

  readonly movement: MovementController;

  /** Live MoveState aliasing position/velocity - the sim mutates the

   *  RemotePlayer's own vectors in place (same trick as Player). */

  moveState: MovementState;

  private appliedSpecList: readonly StructureSpec[] | undefined;

  /** Jet energy tank - a bot can only hold burn while fuel remains. */

  energy: number = ENERGY.max;

  /** Toggle-skill bits the bot holds (MEND/SHIELD/CLOAK) - the same

   *  STATUS mask a legal client's inputMove carries. */

  status = 0;

  /** Shared brain's current hunt target - belt throws arc at its spot. */

  get huntTargetId(): string | null { return this.brain.currentHuntId; }

  /** The brain's skill matrix - the fire resolver biases the draw with it. */

  get skill() { return this.brain.skill; }

  /** Kill-zone memory - the death site feeds the brain so the next
   *  life routes around it (delegates to the shared brain). */
  markDeath(pos: THREE.Vector3, now: number): void { this.brain.markDeath(pos, now); }

  /** Role-adherence scalar - role policy (HoF lean) scales by it. */

  get dutyLevel(): number { return this.brain.dutyLevel; }

  /** Tryhard scalar - the flag role table reads it for comp-pub behavior. */
  get sweatLevel(): number { return this.brain.sweatLevel; }

  /** MoveSim grounded flag - propel only launches from a stand. */

  get grounded(): boolean { return this.moveState.onGround; }



  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain,

              cls: ArmorClass = 'medium') {

    // Class must ride super() - the model variant (knight for heavy) is

    // picked inside the RemotePlayer ctor before setBotClass could speak.

    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain, cls);

    this.team = team;

    this.moveState = { pos: this.position, vel: this.velocity, yaw: 0, pitch: 0, onGround: true, team };

    this.movement = new MovementController(terrain, this.moveState);

    this.setBotClass(cls);

    this.brain = new BotBrain({ x: spawn.x, y: spawn.y, z: spawn.z });

    // Local authority: think() writes position/rotation directly - routing

    // them through update()→snapshot interp made tick() stomp pos with a

    // ~200ms-delayed sample every frame (the frozen/crawling bot bug).

    this.localDriven = true;

    this.setGizmoColor(team === 'ffa' ? 0xCC_66_FF : TEAM_COLORS[team]);

  }



  /** Local-authority damage - the same role the server's hit validation

   *  plays online. Returns true when the hit killed. */

  takeDamageLocal(dmg: number, fromPos: THREE.Vector3, attackerId?: string): boolean {

    if (this.isDead) {return false;}

    // NaN dmg fails `botHp <= 0` forever - an unkillable bot.

    if (!Number.isFinite(dmg)) { inv('bot-damage-finite', false, { dmg }); return false; }

    // Plated et al - the server's applyDamage applies the same resist.

    let d = dmg * (1 - effectiveResist(this.mods, this.botHp, this.botMaxHp));

    // Held shield burns tank instead of flesh - same exchange rate the

    // server shadow models (10 hp per energy point).

    if ((this.status & STATUS.SHIELD) && this.energy > 0) {

      const absorbed = Math.min(d, this.energy * ENERGY.shieldDmgPerEnergy);

      this.energy -= absorbed / ENERGY.shieldDmgPerEnergy;

      d -= absorbed;

      if (this.energy <= 0.5) {this.dropSkill(STATUS.SHIELD);}

    }

    // Soaked to nothing - no hp moved, no flinch. A zero-damage splash
    // that still white-pops the model lies about contact to the player.
    if (d <= 0) {return false;}

    this.botHp -= d;
    this.lastHitAt = performance.now(); // HELD_BUFF grace - no hoard drip while under fire

    this.brain.takeHit(fromPos, attackerId); // recoil + foe score live in the shared brain

    this.flinch(); // RemotePlayer 'hit' oneshot - the model reacts, not just the brain

    if (this.botHp <= 0) {

      this.playDeath(fromPos, dmg * 0.4);

      this.respawnAt = BOT_RESPAWN_S;

      return true;

    }

    return false;

  }



  /** Brain + locomotion. Returns the fire command when the bot wants to

   *  shoot this frame - the manager resolves the hit. */


  // The shared-brain ctx literal - one memoized groundY probe serves
  // every sense; NaN floors memoize as flat-zero so a bad cell can't
  // poison later trajectories crossing it.
  private thinkCtx(ctx: BotThinkCtx, gyc: Map<number, number>) {
    const pos = this.position;
    return {pos,team: this.team === 'ffa' ? undefined : this.team,vel: this.velocity,enemies: ctx.enemies,objective: ctx.objective ?? undefined,pickup: ctx.nugget?.pos,groundY: (x: number, z: number): number => {

        // ~2m cells, not 4cm: getHeight is a smooth bilinear heightmap

        // read, so meter snapping is invisible to the senses - and wider

        // cells give the shared memo a much higher hit rate.

        const k = (Math.trunc((x * 0.5))) * 131_072 + (Math.trunc((z * 0.5)));

        let v = gyc.get(k);

        if (v === undefined) {

          // Cap the memo - roaming bots would otherwise grow it a cell at

          // a time for the whole match. Clear-and-refill beats LRU here:

          // a Map reset is one alloc, per-entry LRU bookkeeping is worse.

          if (gyc.size > 2048) {gyc.clear();}

          v = ctx.terrain.getHeight(x, z);

          // A NaN floor sample memoized here would poison every later

          // trajectory that crosses the cell - flat-zero instead.

          if (!Number.isFinite(v)) {v = 0;}

          gyc.set(k, v);

        }

        return v;

      },solids: Projectile.solidColliders,solidIndex: Projectile.solidIndex,others: ctx.others,allies: ctx.allies,engageRange: ctx.engageRange,sounds: ctx.sounds,threats: ctx.threats,infiltrating: ctx.infiltrating,running: ctx.running,runner: ctx.runner,wave: ctx.wave,marshal: ctx.marshal,posted: ctx.posted,thief: ctx.thief ?? null,flagsHome: ctx.flagsHome,huntCreatures: ctx.huntCreatures,repair: ctx.repair ?? null,notice: ctx.notice ?? null,confidence: ctx.confidence,hero: ctx.hero,flagPos: ctx.flagPos ?? null,moveSkill: ctx.moveSkill,pickupVal: ctx.pickupVal,desperate: ctx.desperate,convoy: ctx.convoy ?? null,spillSoon: ctx.spillSoon ?? null,now: performance.now(),energy: this.energy,healthFrac: this.botHp / this.botMaxHp,held: this.heldTokens};
  }

  think(dt: number, ctx: BotThinkCtx): { targetId: string; aim: THREE.Vector3 } | null {

    // Heights are static for a match's lifetime - every bot probes the

    // same terrain, so ONE shared memo beats a per-bot copy of the same

    // cells: teammates re-query each other's cached LOS marches and steer

    // probes instead of recomputing them.

    const gyc = sharedGroundYCache;

    const out = this.brain.think(dt, Object.assign({}, this.thinkCtx(ctx, gyc), botWeaponHooks(

        (d): WeaponType => pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t): number => aimSkillFor(this.brain.skill, t, 0), this.brain.skill.courage) as WeaponType,

        this.loadout ?? BOT_LOADOUTS[0]!,

      ), {aimSkill: (d: number, targetSpeed: number): number =>

        aimSkillFor(this.brain.skill, pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t): number => aimSkillFor(this.brain.skill, t, 0), this.brain.skill.courage), targetSpeed)}));

    const {dest} = out;

    this.lastDest.set(dest.x, dest.y, dest.z);

    this.lastMove = out.move;

    if (out.fire) {

      this.lastAim.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z);

      this.lastAimAt = performance.now();

    }

    this.wantBelt = Boolean(out.belt);
    this.wantSkill = out.skill ?? null;
    this.wantHook = out.hook ?? null;

    this.wantDeploy = out.deploy ?? null;

    this.wantRepair = out.repair ?? null;

    this.wantPass = out.passFlag ?? null;

    this.wantSay = out.say ?? null;

    if (out.status !== undefined) {this.applyStatus(out.status, dt);}

    if (!out.fire) {return null;}

    this.fire();

    return { targetId: out.fire.targetId, aim: _aim.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z) };

  }



  /** Toggle-skill intent from the brain - ante on the rising edge,

   *  per-second drains while held, auto-drop on an empty tank. Mirrors

   *  what the server shadow applies to out.status. */

  /** Owner callbacks for bot-deployed pads - a station heals its planter. */

  heal(n: number): void { this.botHp = Math.min(this.botMaxHp, this.botHp + n); }

  get energyCap(): number { return ENERGY.max * this.mods.energyMax; }

  addEnergy(n: number): void { this.energy = Math.min(this.energyCap, this.energy + n); }



  /** Per-frame locomotion - the brain decides at ~10Hz, but position

   *  must integrate every render frame or bots warp in 100ms hops.

   *  Uses the last think's dest/move; a stale plan for 2 frames is

   *  fine, a stale position is not. */

  stepFrame(dt: number, ctx: { terrain: Terrain }): void {

    if (this.propelJetT > 0) {this.propelJetT -= dt;}

    this.locomote(dt, ctx, this.lastDest, this.lastMove);

  }



  private lastMove: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined;

  // Held-fire aim point - the head keeps tracking between 10Hz thinks

  // and for a beat after the trigger releases.

  private readonly lastAim = new THREE.Vector3();

  private lastAimAt = -Infinity;



  private applyStatus(claim: number, dt: number): void { en.applyStatus(this, claim, dt); }

  private dropSkill(bit: number): void { en.dropSkill(this, bit); }

  private fuelTick(dt: number, jet: boolean): void { en.fuelTick(this, dt, jet); }



  /** Locomotion: point yaw at the destination, feed the brain's buttons

   *  into the shared MoveSim, keep an honest energy tank on the jets. */

  private locomote(dt: number, _ctx: { terrain: Terrain }, dest: { x: number; y: number; z: number }, move: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined): void {

    const pos = this.position;

    const md = Math.hypot(dest.x - pos.x, dest.z - pos.z);

    // Wrist-speed turn - same slew the server host applies, so an

    // offline bot carves its view around instead of fly-flicking.

    // A bot's yaw is its crosshair (like a human's): while a shot is
    // live it faces the TARGET, not the destination - a body strafing
    // sideways while its shots land on you reads as a silent aimbot.
    // Same rule the server driveMove applies off arsenal.aimPoint.
    const aimFresh = performance.now() - this.lastAimAt < 1500;
    // Between volleys the trigger is dead but the hunt is live - a
    // duelist keeps their crosshair on the enemy between pulls, so the
    // look falls back to the last-seen hunt spot (same rule as the
    // server's aimPoint fallback; without it volley weapons re-paid the
    // full spring acquisition before the settle gate opened).
    const look = aimFresh ? this.lastAim : (this.brain.h.hunt?.pos ?? null);
    const wantYaw = look
      ? Math.atan2(look.x - pos.x, look.z - pos.z)
      : Math.atan2(dest.x - pos.x, dest.z - pos.z);

    // Head tracks the last aim point like the server drive does - wire

    // pitch is negated (positive looks down), and a disengaged bot eases

    // back to level at the same 5 rad/s slew as the wrist turn.

    // Pitched at the MUZZLE (+1.4 over eye) like the server drive -

    // shots launch along this dir, so an eye-height solve lofts every

    // shell over the capsule top.

    const wantPitch = look

      ? -Math.atan2(look.y - (pos.y + 1.4), Math.hypot(look.x - pos.x, look.z - pos.z))

      : 0;

    // Human-shaped turn: spring flick + overshoot + settling noise,

    // skill-scaled - shared/botSlew.ts, same drive the server uses.

    if (look || md > 0.01) {
      const f = this.brain.slew.face(dt, this.rotation.yaw, wantYaw, this.rotation.pitch, wantPitch, this.brain.skill);
      this.rotation.yaw = f.yaw;
      this.rotation.pitch = f.pitch;
    }

    this.rotation.roll = 0; // corpse roll would otherwise stick forever



    if (this.appliedSpecList !== botStructureSpec) {

      this.appliedSpecList = botStructureSpec;

      this.movement.setStructures(botStructureSpec);

    }

    this.moveState.yaw = this.rotation.yaw;

    this.moveState.pitch = this.rotation.pitch;

    const jet = (Boolean(move?.jet) || this.propelJetT > 0) && this.energy > 0.5;

    // Travel intent in world space → yaw-relative keys (same strafe

    // decomposition the server driveMove does): the bot can face its

    // target and still walk to its dest instead of onto the crosshair.

    let fwdIn = 0, rgtIn = 0;

    if (md > 0.5) {

      const fx = Math.sin(this.rotation.yaw), fz = Math.cos(this.rotation.yaw);

      const nx = (dest.x - pos.x) / md, nz = (dest.z - pos.z) / md;

      fwdIn = Math.round(nx * fx + nz * fz);

      rgtIn = Math.round(nx * -fz + nz * fx);

    }

    this.movement.setInput({

      forward: fwdIn,

      right: rgtIn,

      jumpHeld: Boolean(move?.jump),

      skiHeld: Boolean(move?.ski),

      jetHeld: jet,

    });

    this.movement.update(dt);

    en.fuelTick(this, dt, jet);



    this.wireSki = Boolean(move?.ski);

    // Real jet button for the trail - the vel.y heuristic can't tell a

    // burn from a knockback launch; the brain knows.

    this.wireJet = jet;

    this.serverVelocity.copy(this.velocity); // vel getter prefers this

  }



  override applyPredictedKnockback(fromPos: THREE.Vector3, impulseMag: number, pull = false): void {

    // Local authority: the shove lands directly on the sim velocity -

    // no dead-reckoning guess like wire remotes get.

    const dx = this.position.x - fromPos.x;

    const dy = this.position.y - fromPos.y;

    const dz = this.position.z - fromPos.z;

    const dist = Math.hypot(dx, dy, dz) || 0.001;

    const mag = impulseMag * this.mods.knockbackTaken;

    const s = pull ? -1 : 1;

    this.velocity.x += (dx / dist) * mag * s;

    this.velocity.y += (pull ? 0.3 : 0.5) * mag;

    this.velocity.z += (dz / dist) * mag * s;

  }



  override respawn(position: { x: number; y: number; z: number }): void {

    super.respawn(position);

    this.energy = this.energyCap;

    this.ammoPool.clear(); // absent cell = full pool - the respawn refill

    this.moveState.onGround = true;

    this.movement.setState(this.moveState);

  }

}



// Map structures every bot's movement surface resolves against - set from

let botStructureSpec: readonly StructureSpec[] | undefined = undefined;

export function setBotStructureSpecs(list: readonly StructureSpec[] | undefined): void {

  botStructureSpec = list;

}



