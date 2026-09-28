import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import { BotBrain, BOT_EYE } from '../../../shared/botBrain.js';

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
  respawnAt = 0;
  /** CTF: carrying the enemy flag home — objective overrides roam. */
  carryingFlag = false;
  /** Shared decision core — same brain server bots run. */
  private brain: BotBrain;
  private botVel = new THREE.Vector3();

  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain) {
    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain);
    this.team = team;
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
      others: ctx.others,
      now: performance.now(),
    });
    const dest = out.dest;

    _move.set(dest.x - pos.x, 0, dest.z - pos.z);
    const md = _move.length();
    if (md > 0.5) {
      _move.multiplyScalar(BOT_SPEED / md);
      this.botVel.x += (_move.x - this.botVel.x) * Math.min(1, dt * 6);
      this.botVel.z += (_move.z - this.botVel.z) * Math.min(1, dt * 6);
    } else {
      this.botVel.x *= Math.max(0, 1 - dt * 8);
      this.botVel.z *= Math.max(0, 1 - dt * 8);
    }
    this.botVel.y += GRAVITY * dt;
    pos.addScaledVector(this.botVel, dt);
    const gy = ctx.terrain.getHeight(pos.x, pos.z) + EYE;
    if (pos.y < gy) { pos.y = gy; this.botVel.y = 0; }
    else if (pos.y > gy + 0.05 && this.botVel.y < -2) { /* falling */ }

    // Drive the RemotePlayer visual directly — localDriven means tick()
    // skips snapshot interp, so we own position/rotation/velocity.
    this.rotation.yaw = Math.atan2(dest.x - pos.x, dest.z - pos.z);
    this.rotation.pitch = 0;
    this.velocity.copy(this.botVel);
    this.serverVelocity.copy(this.botVel); // vel getter prefers this

    if (!out.fire) return null;
    this.fire();
    return { targetId: out.fire.targetId, aim: _aim.set(out.fire.aim.x, out.fire.aim.y, out.fire.aim.z) };
  }
}

const _move = new THREE.Vector3();
const _aim = new THREE.Vector3();
