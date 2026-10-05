import * as THREE from 'three';
import * as en from './botEnergy.js';

import { Projectile } from '../projectiles/Projectile.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
import { MovementController, type MovementState } from '../entities/movement.js';
import { ENERGY } from '../../../shared/movement.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { BotBrain, BOT_EYE, type BrainOut } from '../../../shared/botBrain.js';
import { CLASS_STATS, type ArmorClass } from '../../../shared/botClasses.js';
import { BOT_LOADOUTS, pickBotWeapon } from '../../../shared/botLoadouts.js';
import { aimSkillFor } from '../../../shared/botSkill.js';
import { getWeaponStats } from '../../../shared/weapons.js';
import { STATUS } from '../../../shared/status.js';
import type { BotLoadout } from '../../../shared/botLoadouts.js';
import { perkMods, effectiveResist, type PerkMods } from '../../../shared/perks.js';

/**
 * GameBot — an in-world fake player. A GameBot is a RemotePlayer registered
 * in world.remotePlayers under `bot:<name>`, so every existing funnel treats
 * it as a real player: creatures hunt it, projectiles collide with it,
 * explosions shove it. Damage resolution lives in TeamBots (local authority
 * in place of the server's hit validation).
 *
 * Brain is intentionally simple utility AI: collect nuggets > fight the
 * nearest enemy > roam. Aim uses last-seen position + lead + speed-scaled
 * scatter — the same Omicron delay as the pvptest harness bots.
 */

export const BOT_HP = 100;
export const BOT_DMG = 18;   // bolt claim damage, tuned to threaten but not melt
export const EYE = BOT_EYE;
const BOT_RESPAWN_S = 4;
// Terrain heights are static mid-match — one shared memo for every bot.
const sharedGroundYCache = new Map<number, number>();

export class GameBot extends RemotePlayer {
  /** 'alpha'/'bravo' in team modes; the bot's own playerId in FFA. */
  team: string;
  /** The LOCAL player's team — TeamBots refreshes it each frame so the
   *  friendly/enemy verdicts (cloak ghost vs vanish) follow re-seats. */
  localTeam?: string;
  botHp = BOT_HP;
  /** Armor tier — speedScale feeds the shared MoveSim so heavy/light
   *  ground speed changes land exactly as the server computes them. */
  armorClass: ArmorClass = 'medium';
  botMaxHp = BOT_HP;
  /** Loadout perk modifiers — the same table the server multiplies
   *  through CombatHandler/GameServer. 'none' until setLoadout runs. */
  mods = perkMods('none');
  get perkMods(): PerkMods { return this.mods; }
  private perkHealthBonus = 0;
  setLoadout(lo: BotLoadout): void {
    this.loadout = lo;
    this.mods = perkMods(lo.perk);
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
    if (gained > 0) this.botHp = Math.min(cap, this.botHp + gained);
  }
  respawnAt = 0;
  /** CTF: carrying the enemy flag home — objective overrides roam. */
  carryingFlag = false;
  /** Sheep meter 0-100: fills while the bot moves like a pedestrian
   *  (walking or parked), drains while it's skiing/airborne/jetting.
   *  Owned by TeamBots; rendered on the scoreboard + head badge. */
  /** Raw sheep factor + its smoothed display twin (badge/scoreboard read
   *  sheepShown so the % doesn't flicker frame to frame). */
  sheep = 100;    // llama until proven — high-E play drains it
  sheepShown = 100;
  /** Jets pinned by a propel blast — rides the shove like a disc-jump. */
  propelJetT = 0;
  /** Brain's belt intent from the last think — TeamBots resolves the arc. */
  wantBelt = false;
  /** Builder intent from the shared brain — TeamBots plants it. */
  wantDeploy: { kind: string; pos: { x: number; y: number; z: number } } | null = null;
  /** Weld intent — the deployable key the brain is working on. */
  wantRepair: string | null = null;
  /** Situation chatter edge from the shared brain — TeamBots routes it
   *  through the taunt pools + local chat sink. */
  wantSay: BrainOut['say'] | null = null;
  /** The destination the brain steered toward last think — propel gates
   *  on how far the bot still has to run. */
  readonly lastDest = new THREE.Vector3();
  /** Propel cooldown (performance.now deadline) — one jump per launch. */
  propelUntil = 0;

  /** Shared decision core — same brain server bots run. */
  private brain: BotBrain;
  /** Kit from the shared roster — TeamBots assigns it so range-band
   *  weapon picks mirror the dedicated server's bots. */
  loadout?: BotLoadout;
  /** Shared MoveSim — the same physics the server shadow runs, so a bot
   *  skis/jets/lands exactly like a legal player (no invented velocities). */
  readonly movement: MovementController;
  /** Live MoveState aliasing position/velocity — the sim mutates the
   *  RemotePlayer's own vectors in place (same trick as Player). */
  moveState: MovementState;
  private appliedSpecList: readonly StructureSpec[] | undefined;
  /** Jet energy tank — a bot can only hold burn while fuel remains. */
  energy: number = ENERGY.max;
  /** Toggle-skill bits the bot holds (MEND/SHIELD/CLOAK) — the same
   *  STATUS mask a legal client's inputMove carries. */
  status = 0;
  /** Shared brain's current hunt target — belt throws arc at its spot. */
  get huntTargetId(): string | null { return this.brain.currentHuntId; }
  /** The brain's skill matrix — the fire resolver biases the draw with it. */
  get skill() { return this.brain.skill; }
  /** Role-adherence scalar — role policy (HoF lean) scales by it. */
  get dutyLevel() { return this.brain.dutyLevel; }
  /** MoveSim grounded flag — propel only launches from a stand. */
  get grounded(): boolean { return this.moveState.onGround; }

  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain,
              cls: ArmorClass = 'medium') {
    // Class must ride super() — the model variant (knight for heavy) is
    // picked inside the RemotePlayer ctor before setBotClass could speak.
    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain, cls);
    this.team = team;
    this.moveState = { pos: this.position, vel: this.velocity, yaw: 0, pitch: 0, onGround: true };
    this.movement = new MovementController(terrain, this.moveState);
    this.setBotClass(cls);
    this.brain = new BotBrain({ x: spawn.x, y: spawn.y, z: spawn.z });
    // Local authority: think() writes position/rotation directly — routing
    // them through update()→snapshot interp made tick() stomp pos with a
    // ~200ms-delayed sample every frame (the frozen/crawling bot bug).
    this.localDriven = true;
    this.setGizmoColor(team === 'ffa' ? 0xcc66ff : TEAM_COLORS[team]);
  }

  /** Local-authority damage — the same role the server's hit validation
   *  plays online. Returns true when the hit killed. */
  takeDamageLocal(dmg: number, fromPos: THREE.Vector3): boolean {
    if (this.isDead) return false;
    // Plated et al — the server's applyDamage applies the same resist.
    dmg *= 1 - effectiveResist(this.mods, this.botHp, this.botMaxHp);
    // Held shield burns tank instead of flesh — same exchange rate the
    // server shadow models (10 hp per energy point).
    if ((this.status & STATUS.SHIELD) && this.energy > 0) {
      const absorbed = Math.min(dmg, this.energy * ENERGY.shieldDmgPerEnergy);
      this.energy -= absorbed / ENERGY.shieldDmgPerEnergy;
      dmg -= absorbed;
      if (this.energy <= 0.5) this.dropSkill(STATUS.SHIELD);
    }
    this.botHp -= dmg;
    this.brain.takeHit(fromPos); // recoil decision lives in the shared brain
    this.flinch(); // RemotePlayer 'hit' oneshot — the model reacts, not just the brain
    if (this.botHp <= 0) {
      this.playDeath(fromPos, dmg * 0.4);
      this.respawnAt = BOT_RESPAWN_S;
      return true;
    }
    return false;
  }

  /** Brain + locomotion. Returns the fire command when the bot wants to
   *  shoot this frame — the manager resolves the hit. */
  think(dt: number, ctx: {
    terrain: Terrain;
    enemies: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
    nugget: Nugget | null;
    /** CTF: overrides nugget/roam — the flag or the home base. */
    objective?: THREE.Vector3 | null;
    /** Nearby bodies for the steering separation sense. */
    others?: THREE.Vector3[];
    /** Teammates only — the rally/fold sense (retreat never folds
     *  onto an enemy). */
    allies?: THREE.Vector3[];
    /** Long-arm reach for mortar heavies — extends acquisition past
     *  the duel band. */
    engageRange?: number;
    /** Fresh blasts in earshot — the hearing sense. */
    sounds?: { x: number; y: number; z: number }[];
    /** Inbound shells — the dodge sense. */
    threats?: { x: number; y: number; z: number }[];
    /** Carrying the objective — the route rules the feet. */
    running?: boolean;
    /** Rushing the enemy stand — cloak candidates cloak up. */
    infiltrating?: boolean;
    /** Enemy carrying OUR flag — beacon-marked, engages without LOS. */
    thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean } | null;
    /** Economy modes prefer creature targets (nuggets farming). */
    huntCreatures?: boolean;
    /** Damaged friendly deployable a builder could weld (host-opaque
     *  key — mirrors the server senses' dep id). */
    repair?: { key: string; pos: THREE.Vector3; frac: number } | null;
  }): { targetId: string; aim: THREE.Vector3 } | null {
    const pos = this.position;
    // Heights are static for a match's lifetime — every bot probes the
    // same terrain, so ONE shared memo beats a per-bot copy of the same
    // cells: teammates re-query each other's cached LOS marches and steer
    // probes instead of recomputing them.
    const gyc = sharedGroundYCache;
    const out = this.brain.think(dt, {
      pos,
      vel: this.velocity,
      enemies: ctx.enemies,
      objective: ctx.objective ?? undefined,
      pickup: ctx.nugget?.pos,
      groundY: (x, z) => {
        // ~2m cells, not 4cm: getHeight is a smooth bilinear heightmap
        // read, so meter snapping is invisible to the senses — and wider
        // cells give the shared memo a much higher hit rate.
        const k = ((x * 0.5) | 0) * 131072 + ((z * 0.5) | 0);
        let v = gyc.get(k);
        if (v === undefined) {
          // Cap the memo — roaming bots would otherwise grow it a cell at
          // a time for the whole match. Clear-and-refill beats LRU here:
          // a Map reset is one alloc, per-entry LRU bookkeeping is worse.
          if (gyc.size > 2048) gyc.clear();
          v = ctx.terrain.getHeight(x, z);
          gyc.set(k, v);
        }
        return v;
      },
      solids: Projectile.solidColliders,
      solidIndex: Projectile.solidIndex,
      others: ctx.others,
      allies: ctx.allies,
      engageRange: ctx.engageRange,
      sounds: ctx.sounds,
      threats: ctx.threats,
      infiltrating: ctx.infiltrating,
      running: ctx.running,
      thief: ctx.thief ?? null,
      huntCreatures: ctx.huntCreatures,
      repair: ctx.repair ?? null,
      now: performance.now(),
      // The real tank + hp — fear, mend, shield, and retreat gates all
      // read these; without them every status decision saw a full sheet.
      energy: this.energy,
      healthFrac: this.botHp / this.botMaxHp,
      // Aim lead uses the muzzle speed of the weapon this bot would
      // pick at that range — mirrors the server's senses hook. The
      // draw is skill-biased: phenoms reach for their gun, and the
      // aim error scores the same matrix so pick and aim agree.
      weaponSpeed: (d) => {
        const wt = pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t) => aimSkillFor(this.brain.skill, t, 0));
        return getWeaponStats(wt).speed || 60;
      },
      // Fuse-carrier picks detonate at their clock, not the body — aim
      // intercept caps at the fuse the same way the server's hook does.
      weaponFuse: (d) => {
        const ws = getWeaponStats(pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t) => aimSkillFor(this.brain.skill, t, 0)));
        return ws.fuseOnly ? ws.maxLifetime : undefined;
      },
      weaponGravity: (d) =>
        getWeaponStats(pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t) => aimSkillFor(this.brain.skill, t, 0))).gravity,
      aimSkill: (d, targetSpeed) =>
        aimSkillFor(this.brain.skill, pickBotWeapon(this.loadout ?? BOT_LOADOUTS[0]!, d, d, (t) => aimSkillFor(this.brain.skill, t, 0)), targetSpeed),
    });
    const dest = out.dest;
    this.lastDest.set(dest.x, dest.y, dest.z);
    this.lastMove = out.move;
    this.wantBelt = !!out.belt;
    this.wantDeploy = out.deploy ?? null;
    this.wantRepair = out.repair ?? null;
    this.wantSay = out.say ?? null;
    if (out.status !== undefined) this.applyStatus(out.status, dt);
    if (!out.fire) return null;
    this.fire();
    return { targetId: out.fire.targetId, aim: _aim.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z) };
  }

  /** Toggle-skill intent from the brain — ante on the rising edge,
   *  per-second drains while held, auto-drop on an empty tank. Mirrors
   *  what the server shadow applies to out.status. */
  /** Owner callbacks for bot-deployed pads — a station heals its planter. */
  heal(n: number): void { this.botHp = Math.min(this.botMaxHp, this.botHp + n); }
  get energyCap(): number { return ENERGY.max * this.mods.energyMax; }
  addEnergy(n: number): void { this.energy = Math.min(this.energyCap, this.energy + n); }

  /** Per-frame locomotion — the brain decides at ~10Hz, but position
   *  must integrate every render frame or bots warp in 100ms hops.
   *  Uses the last think's dest/move; a stale plan for 2 frames is
   *  fine, a stale position is not. */
  stepFrame(dt: number, ctx: { terrain: Terrain }): void {
    if (this.propelJetT > 0) this.propelJetT -= dt;
    this.locomote(dt, ctx, this.lastDest, this.lastMove);
  }

  private lastMove: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined;

  private applyStatus(claim: number, dt: number): void { en.applyStatus(this, claim, dt); }
  private dropSkill(bit: number): void { en.dropSkill(this, bit); }
  private fuelTick(dt: number, jet: boolean): void { en.fuelTick(this, dt, jet); }

  /** Locomotion: point yaw at the destination, feed the brain's buttons
   *  into the shared MoveSim, keep an honest energy tank on the jets. */
  private locomote(dt: number, _ctx: { terrain: Terrain }, dest: { x: number; y: number; z: number }, move: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined): void {
    const pos = this.position;
    const md = Math.hypot(dest.x - pos.x, dest.z - pos.z);
    // Wrist-speed turn — same slew the server host applies, so an
    // offline bot carves its view around instead of fly-flicking.
    if (md > 0.01) this.rotation.yaw = slewYaw(this.rotation.yaw, Math.atan2(dest.x - pos.x, dest.z - pos.z), 5 * dt);
    this.rotation.pitch = 0;
    this.rotation.roll = 0; // corpse roll would otherwise stick forever

    if (this.appliedSpecList !== botStructureSpec) {
      this.appliedSpecList = botStructureSpec;
      this.movement.setStructures(botStructureSpec);
    }
    this.moveState.yaw = this.rotation.yaw;
    this.moveState.pitch = 0;
    const jet = (!!move?.jet || this.propelJetT > 0) && this.energy > 0.5;
    this.movement.setInput({
      forward: md > 0.5 ? 1 : 0,
      right: 0,
      jumpHeld: !!move?.jump,
      skiHeld: !!move?.ski,
      jetHeld: jet,
    });
    this.movement.update(dt);
    en.fuelTick(this, dt, jet);

    this.wireSki = !!move?.ski;
    // Real jet button for the trail — the vel.y heuristic can't tell a
    // burn from a knockback launch; the brain knows.
    this.wireJet = jet;
    this.serverVelocity.copy(this.velocity); // vel getter prefers this
  }

  override applyPredictedKnockback(fromPos: THREE.Vector3, impulseMag: number, pull = false): void {
    // Local authority: the shove lands directly on the sim velocity —
    // no dead-reckoning guess like wire remotes get.
    const dx = this.position.x - fromPos.x;
    const dy = this.position.y - fromPos.y;
    const dz = this.position.z - fromPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    const mag = impulseMag * this.mods.knockbackTaken;
    const s = pull ? -1 : 1;
    this.velocity.x += (dx / dist) * mag * s;
    this.velocity.y += (pull ? 0.3 : 0.5) * mag;
    this.velocity.z += (dz / dist) * mag * s;
  }

  override respawn(position: { x: number; y: number; z: number }): void {
    super.respawn(position);
    this.energy = this.energyCap;
    this.moveState.onGround = true;
    this.movement.setState(this.moveState);
  }
}

// Map structures every bot's movement surface resolves against — set from
// the same map.structures the player's controller gets (net/world.ts).
let botStructureSpec: readonly StructureSpec[] | undefined;
export function setBotStructureSpecs(list: readonly StructureSpec[] | undefined): void {
  botStructureSpec = list;
}

/** Rotate `cur` toward `want` by at most `maxDelta` radians — view
 *  turns have wrist speed, so a snapped 180° reads as a fly-flick. */
function slewYaw(cur: number, want: number, maxDelta: number): number {
  let d = want - cur;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + Math.max(-maxDelta, Math.min(maxDelta, d));
}

const _aim = new THREE.Vector3();
