import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { Projectile } from '../projectiles/Projectile.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
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

const BOT_SPEED = 16;
export const BOT_HP = 100;
export const BOT_DMG = 18;   // bolt claim damage, tuned to threaten but not melt
export const EYE = BOT_EYE;
const BOT_RESPAWN_S = 4;

export class GameBot extends RemotePlayer {
  /** 'alpha'/'bravo' in team modes; the bot's own playerId in FFA. */
  team: string;
  botHp = BOT_HP;
  /** Armor tier — offline bots don't run the shared sim, so class lands
   *  as a flat speed multiplier + HP cap + silhouette scale. */
  armorClass: 'light' | 'medium' | 'heavy' = 'medium';
  private classSpeed = 1;
  botMaxHp = BOT_HP;
  setBotClass(cls: 'light' | 'medium' | 'heavy'): void {
    this.armorClass = cls;
    const st = CLASS_STATS[cls];
    this.classSpeed = st.speedScale;
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
    this.botVel.x += Math.cos(yaw) * 12;
    this.botVel.y = 18;
    this.botVel.z += Math.sin(yaw) * 12;
    this.yeetT = 1.5;
    this.sheep = 40;
  }
  /** Shared decision core — same brain server bots run. */
  private brain: BotBrain;
  /** Kit from the shared roster — TeamBots assigns it so range-band
   *  weapon picks mirror the dedicated server's bots. */
  loadout?: BotLoadout;
  private botVel = new THREE.Vector3();

  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain,
              cls: 'light' | 'medium' | 'heavy' = 'medium') {
    // Class must ride super() — the model variant (knight for heavy) is
    // picked inside the RemotePlayer ctor before setBotClass could speak.
    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain, cls);
    this.team = team;
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

  /** Locomotion: steering + the brain's ski/jet/jump buttons. Ski holds
   *  momentum past run speed (steering only, downhill feeds it); jet is
   *  real thrust, forward included. */
  private locomote(dt: number, ctx: { terrain: Terrain }, dest: { x: number; y: number; z: number }, move: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined): void {
    const pos = this.position;
    _move.set(dest.x - pos.x, 0, dest.z - pos.z);
    const md = _move.length();
    const groundY = ctx.terrain.getHeight(pos.x, pos.z) + EYE;
    const grounded = pos.y <= groundY + 0.1;
    const speedXZ = Math.hypot(this.botVel.x, this.botVel.z);
    const k = { dt, terrain: ctx.terrain, md, speedXZ, grounded };
    this.steer(dt, move?.ski, md, speedXZ, grounded);
    this.propel(pos, move, k);
    pos.addScaledVector(this.botVel, dt);
    const gy = ctx.terrain.getHeight(pos.x, pos.z) + EYE;
    if (pos.y < gy) { pos.y = gy; this.botVel.y = 0; }
    else if (pos.y > gy + 0.05 && this.botVel.y < -2) { /* falling */ }

    // Drive the RemotePlayer visual directly — localDriven means tick()
    // skips snapshot interp, so we own position/rotation/velocity.
    // wireSki feeds the anim pick the bot's real ski button — without it
    // the speed heuristic tucks every fast bot, sliding or not.
    this.wireSki = !!move?.ski;
    // Real jet button for the trail — the vel.y heuristic can't tell a
    // burn from a knockback launch; the brain knows.
    this.wireJet = !!move?.jet || this.yeetT > 0;
    this.rotation.yaw = Math.atan2(dest.x - pos.x, dest.z - pos.z);
    this.rotation.pitch = 0;
    this.rotation.roll = 0; // corpse roll would otherwise stick forever
    this.velocity.copy(this.botVel);
    this.serverVelocity.copy(this.botVel); // vel getter prefers this
  }

  /** Thrust + slope physics: gravity always, jet adds real thrust
   *  (forward too, not just up), downhill ski converts slope into speed
   *  past the run cap, flat-ski bleeds momentum gently. */
  private propel(pos: THREE.Vector3, move: { ski?: boolean; jet?: boolean; jump?: boolean } | undefined, k: { dt: number; terrain: Terrain; md: number; speedXZ: number; grounded: boolean }): void {
    const { dt, terrain, md, speedXZ, grounded } = k;
    this.botVel.y += GRAVITY * dt;
    if (move?.jet || this.yeetT > 0) {
      this.botVel.y += 55 * dt;
      if (this.botVel.y > 14) this.botVel.y = 14;
      if (md > 0.5) { this.botVel.x += _move.x / BOT_SPEED * 6 * dt; this.botVel.z += _move.z / BOT_SPEED * 6 * dt; }
    }
    if (move?.jump && grounded) this.botVel.y = 12;
    if (!move?.ski || !grounded || speedXZ <= 1) return;
    const nx = this.botVel.x / speedXZ, nz = this.botVel.z / speedXZ;
    const drop = terrain.getHeight(pos.x, pos.z) - terrain.getHeight(pos.x + nx * 6, pos.z + nz * 6);
    if (drop > 0) {
      const push = Math.min(drop * 18, 30) * dt;
      this.botVel.x += nx * push; this.botVel.z += nz * push;
    } else if (speedXZ > BOT_SPEED * this.classSpeed) {
      const bleed = Math.max(0, 1 - dt * 0.35);
      this.botVel.x *= bleed; this.botVel.z *= bleed;
    }
  }

  /** XZ steering: walk-lerp toward BOT_SPEED under run speed; past it a
   *  skiing bot keeps magnitude and the lerp only steers heading. */
  private steer(dt: number, ski: boolean | undefined, md: number, speedXZ: number, _grounded: boolean): void {
    if (md > 0.5) {
      _move.multiplyScalar(BOT_SPEED * this.classSpeed / md);
      if (ski && speedXZ > BOT_SPEED * this.classSpeed) {
        const m = Math.hypot(_move.x, _move.z) || 1;
        this.botVel.x += (_move.x / m * speedXZ - this.botVel.x) * Math.min(1, dt * 3);
        this.botVel.z += (_move.z / m * speedXZ - this.botVel.z) * Math.min(1, dt * 3);
      } else {
        this.botVel.x += (_move.x - this.botVel.x) * Math.min(1, dt * 6);
        this.botVel.z += (_move.z - this.botVel.z) * Math.min(1, dt * 6);
      }
    } else {
      this.botVel.x *= Math.max(0, 1 - dt * 8);
      this.botVel.z *= Math.max(0, 1 - dt * 8);
    }
  }
}

const _move = new THREE.Vector3();
const _aim = new THREE.Vector3();
