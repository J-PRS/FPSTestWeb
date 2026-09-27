import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';

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
export const EYE = 1.6;
const BOT_RESPAWN_S = 4;
const BOT_THINK_S = 0.3;
const BOT_FIRE_RANGE = 45;

export class GameBot extends RemotePlayer {
  /** 'alpha'/'bravo' in team modes; the bot's own playerId in FFA. */
  team: string;
  botHp = BOT_HP;
  respawnAt = 0;
  // brain state
  private thinkT = Math.random() * BOT_THINK_S;
  private goal = new THREE.Vector3();
  private huntTarget: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } | null = null;
  /** CTF: carrying the enemy flag home — objective overrides roam. */
  carryingFlag = false;
  private lastSeen = new THREE.Vector3();
  private lastSeenVel = new THREE.Vector3();
  private lastSeenAt = 0;
  private fireT = 0;
  private burstLeft = 0;
  private flinchT = 0;
  private flinchFrom = new THREE.Vector3();
  private wanderWp = new THREE.Vector3();
  private wanderT = 0;
  private botVel = new THREE.Vector3();

  constructor(scene: THREE.Scene, name: string, team: TeamId | 'ffa', spawn: THREE.Vector3, terrain: Terrain) {
    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain);
    this.team = team;
    this.setGizmoColor(team === 'ffa' ? 0xcc66ff : TEAM_COLORS[team]);
    this.goal.copy(spawn);
    this.lastSeen.copy(spawn);
  }

  /** Local-authority damage — the same role the server's hit validation
   *  plays online. Returns true when the hit killed. */
  takeDamageLocal(dmg: number, fromPos: THREE.Vector3): boolean {
    if (this.isDead) return false;
    this.botHp -= dmg;
    // Flinch toward cover — bots sidestep after taking a hit like creatures do.
    this.flinchT = 0.4;
    this.flinchFrom.copy(fromPos);
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
  }): { targetId: string; aim: THREE.Vector3 } | null {
    const pos = this.position;
    const now = performance.now();

    // --- pick an objective ---
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = BOT_THINK_S;
      let best: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } | null = null;
      let bestD = BOT_FIRE_RANGE;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const d = pos.distanceTo(e.pos);
        if (d < bestD) { bestD = d; best = e; }
      }
      this.huntTarget = best;
      if (best) {
        this.lastSeen.copy(best.pos);
        this.lastSeenVel.copy(best.vel);
        this.lastSeenAt = now;
      } else if (ctx.objective) {
        this.goal.copy(ctx.objective); // CTF: flag or home base wins over gems
      } else if (ctx.nugget) {
        this.goal.copy(ctx.nugget.pos);
      } else if (this.wanderT <= 0 || pos.distanceToSquared(this.wanderWp) < 9) {
        this.wanderT = 3 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2;
        const r = 15 + Math.random() * 40;
        this.wanderWp.set(pos.x + Math.cos(a) * r, 0, pos.z + Math.sin(a) * r);
        this.wanderWp.y = ctx.terrain.getHeight(this.wanderWp.x, this.wanderWp.z) + EYE;
        this.goal.copy(this.wanderWp);
      }
    }
    this.wanderT -= dt;

    // --- locomotion ---
    let dest: THREE.Vector3;
    if (this.flinchT > 0) {
      this.flinchT -= dt;
      _flinch.subVectors(pos, this.flinchFrom).setY(0);
      const l = _flinch.length() || 1;
      dest = _flinch.multiplyScalar(8 / l).add(pos); // recoil point ~8m away
    } else if (this.huntTarget) {
      const t = this.huntTarget;
      const d = pos.distanceTo(t.pos);
      if (d > 22) dest = t.pos;
      else {
        // Orbit the target at ring distance — weave like creatures do.
        _orbit.subVectors(pos, t.pos).setY(0).normalize();
        _orbitPerp.set(-_orbit.z, 0, _orbit.x);
        dest = _dest.copy(pos).addScaledVector(_orbitPerp, 6);
        if (d < 12) dest.addScaledVector(_orbit, 4); // too close — back off
      }
    } else {
      dest = this.goal;
    }

    _move.subVectors(dest, pos).setY(0);
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

    // Drive the RemotePlayer visual: feed our own pos as the "server" target.
    this.update({ x: pos.x, y: pos.y, z: pos.z }, { yaw: this.yawTo(dest), pitch: 0 }, dt, 0,
      { x: this.botVel.x, y: this.botVel.y, z: this.botVel.z });

    // --- fire ---
    if (!this.huntTarget) return null;
    const stale = now - this.lastSeenAt > 1200;
    if (stale) return null; // lost them — don't fire blind
    this.fireT -= dt;
    if (this.fireT > 0) return null;
    if (this.burstLeft <= 0) {
      this.burstLeft = 3;
      this.fireT = 0; // first shot immediate
    }
    this.burstLeft--;
    this.fireT = this.burstLeft > 0 ? 0.85 : 1.6 + Math.random(); // burst then lull
    this.fire();
    const t = this.huntTarget;
    const d = pos.distanceTo(this.lastSeen);
    const err = 0.5 + this.lastSeenVel.length() * 0.1 + d * 0.02;
    const aim = _aim.copy(this.lastSeen)
      .addScaledVector(this.lastSeenVel, d / 60) // lead by ~airtime
      .add(_rand.set((Math.random() - 0.5) * err, (Math.random() - 0.5) * err * 0.5, (Math.random() - 0.5) * err));
    return { targetId: t.id, aim };
  }

  private yawTo(dest: THREE.Vector3): number {
    return Math.atan2(dest.x - this.position.x, dest.z - this.position.z);
  }
}

const _flinch = new THREE.Vector3();
const _orbit = new THREE.Vector3();
const _orbitPerp = new THREE.Vector3();
const _dest = new THREE.Vector3();
const _move = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _rand = new THREE.Vector3();
