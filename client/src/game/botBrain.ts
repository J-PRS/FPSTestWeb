import * as THREE from 'three';

import { Projectile } from '../projectiles/Projectile.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
import { MovementController, type MovementState } from '../entities/movement.js';
import { ENERGY } from '../../../shared/movement.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { BotBrain, BOT_EYE } from '../../../shared/botBrain.js';
import { CLASS_STATS } from '../../../shared/botClasses.js';
import type { BotLoadout } from '../../../shared/botLoadouts.js';

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

export class GameBot extends RemotePlayer {
  /** 'alpha'/'bravo' in team modes; the bot's own playerId in FFA. */
  team: string;
  botHp = BOT_HP;
  /** Armor tier — speedScale feeds the shared MoveSim so heavy/light
   *  ground speed changes land exactly as the server computes them. */
  armorClass: 'light' | 'medium' | 'heavy' = 'medium';
  botMaxHp = BOT_HP;
  setBotClass(cls: 'light' | 'medium' | 'heavy'): void {
    this.armorClass = cls;
    const st = CLASS_STATS[cls];
    this.movement.setSpeedScale(st.speedScale);
    this.botMaxHp = BOT_HP + st.maxHealth;
    this.botHp = Math.min(this.botMaxHp, this.botHp + Math.max(0, this.botMaxHp - BOT_HP));
    this.setClass(cls); // silhouette
  }
  respawnAt = 0;
  /** CTF: carrying the enemy flag home — objective overrides roam. */
  carryingFlag = false;
  /** Sheep meter 0-100: fills while the bot moves like a pedestrian
   *  (walking or parked), drains while it's skiing/airborne/jetting.
   *  Owned by TeamBots; rendered on the scoreboard + head badge. */
  /** Raw sheep factor + its smoothed display twin (badge/scoreboard read
   *  sheepShown so the % doesn't flicker frame to frame). */
  sheep = 0;
  sheepShown = 0;
  /** Jets pinned by a sheep yeet — countdown in seconds. */
  yeetT = 0;

  /** The sheep-yeet: an impulse launch that forces a few seconds of
   *  airborne Tribes play — the penalty is the cure. */
  yeet(): void {
    const yaw = Math.random() * Math.PI * 2;
    this.velocity.x += Math.cos(yaw) * 12;
    this.velocity.y = 18;
    this.velocity.z += Math.sin(yaw) * 12;
    this.yeetT = 1.5;
    this.sheep = 40;
  }
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
  private moveState: MovementState;
  private appliedSpecList: readonly StructureSpec[] | undefined;
  /** Jet energy tank — a bot can only hold burn while fuel remains. */
  energy: number = ENERGY.max;

  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain,
              cls: 'light' | 'medium' | 'heavy' = 'medium') {
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
  }): { targetId: string; aim: THREE.Vector3 } | null {
    const pos = this.position;
    const out = this.brain.think(dt, {
      pos,
      enemies: ctx.enemies,
      objective: ctx.objective ?? undefined,
      pickup: ctx.nugget?.pos,
      groundY: (x, z) => ctx.terrain.getHeight(x, z),
      solids: Projectile.solidColliders,
      solidIndex: Projectile.solidIndex,
      others: ctx.others,
      now: performance.now(),
    });
    const dest = out.dest;
    if (this.yeetT > 0) this.yeetT -= dt;
    this.locomote(dt, ctx, dest, out.move);
    if (!out.fire) return null;
    this.fire();
    return { targetId: out.fire.targetId, aim: _aim.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z) };
  }

  /** Locomotion: point yaw at the destination, feed the brain's buttons
   *  into the shared MoveSim, keep an honest energy tank on the jets. */
  private locomote(dt: number, _ctx: { terrain: Terrain }, dest: { x: number; y: number; z: number }, move: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined): void {
    const pos = this.position;
    const md = Math.hypot(dest.x - pos.x, dest.z - pos.z);
    this.rotation.yaw = md > 0.01 ? Math.atan2(dest.x - pos.x, dest.z - pos.z) : this.rotation.yaw;
    this.rotation.pitch = 0;
    this.rotation.roll = 0; // corpse roll would otherwise stick forever

    if (this.appliedSpecList !== botStructureSpec) {
      this.appliedSpecList = botStructureSpec;
      this.movement.setStructures(botStructureSpec);
    }
    this.moveState.yaw = this.rotation.yaw;
    this.moveState.pitch = 0;
    // Yeet overrides fuel — the penalty jet ignores the tank on purpose.
    const jet = (!!move?.jet && this.energy > 0.5) || this.yeetT > 0;
    this.movement.setInput({
      forward: md > 0.5 ? 1 : 0,
      right: 0,
      jumpHeld: !!move?.jump,
      skiHeld: !!move?.ski,
      jetHeld: jet,
    });
    this.movement.update(dt);
    if (jet && this.yeetT <= 0) this.energy = Math.max(0, this.energy - ENERGY.jetDrain * dt);
    else if (this.moveState.onGround && this.energy < ENERGY.max) {
      this.energy = Math.min(ENERGY.max, this.energy + ENERGY.jetCharge * dt);
    }

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
    const s = pull ? -1 : 1;
    this.velocity.x += (dx / dist) * impulseMag * s;
    this.velocity.y += (pull ? 0.3 : 0.5) * impulseMag;
    this.velocity.z += (dz / dist) * impulseMag * s;
  }

  override respawn(position: { x: number; y: number; z: number }): void {
    super.respawn(position);
    this.energy = ENERGY.max;
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

const _aim = new THREE.Vector3();
