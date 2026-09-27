import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Terrain } from '../world/terrain.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { TEAM_COLORS, TEAM_LABEL, bank, makeScores, winner, type TeamId, type TeamScores } from '../../../shared/teams.js';
import * as sfx from '../core/sfx.js';

/**
 * Nugget Wars bots — in-world fake players. A GameBot is a RemotePlayer
 * registered in world.remotePlayers under `bot:<name>`, so every existing
 * funnel treats it as a real player: creatures hunt it (candidates()),
 * projectiles collide with it (remotePlayerPositions), explosions shove
 * it. The ONLY difference is damage resolution: there is no server, so
 * combat routes bot damage through this manager's local authority instead
 * of a hit claim (see deps.botHit in combat.ts).
 *
 * Brain is intentionally simple utility AI: collect nuggets > fight the
 * nearest enemy > roam. Aim uses last-seen position + lead + speed-scaled
 * scatter — the same Omicron delay as the pvptest harness bots.
 */

const BOT_SPEED = 16;
const BOT_HP = 100;
const BOT_RESPAWN_S = 4;
const BOT_THINK_S = 0.3;
const BOT_FIRE_RANGE = 45;
const BOT_DMG = 18;          // bolt claim damage, tuned to threaten but not melt
const EYE = 1.6;

const BOT_NAMES = ['VEKTOR', 'SLATE', 'MARA', 'DUNE', 'PICO', 'RANCHO', 'OZONE', 'TALUS', 'BRICK', 'SABLE'];

export interface BotsDeps extends GameContext {
  lazyScene(): THREE.Scene;
  lazyHealthBarSystem(): { spawn(id: string, dmg: number, hp: number): void };
  /** Live creature list — bots fight these too. */
  targets: Targetable[];
}

interface BotHooks {
  /** Drop nuggets where a bot died (entities owns the nugget factory). */
  dropNuggets(pos: THREE.Vector3, n: number, inheritVel: THREE.Vector3): void;
  /** Local player died to a bot — mirrors netHandlers' kill path. */
  localPlayerKilled(killerName: string): void;
  /** A bot collected a nugget — heal/visual for parity with the player path. */
  remoteKillFeed(text: string): void;
  /** Find nearest nugget to a position. */
  nearestNugget(pos: THREE.Vector3, maxDist: number): Nugget | null;
  /** Nearest hostile creature (targets list entry) for a bot to fight. */
  nearestCreature(pos: THREE.Vector3, maxDist: number): Targetable | null;
  /** A bot's bolt connected with a creature — damage through the entity. */
  damageCreature(id: number, dmg: number, fromPos: THREE.Vector3): void;
}

export class GameBot extends RemotePlayer {
  team: TeamId;
  botHp = BOT_HP;
  respawnAt = 0;
  // brain state
  private thinkT = Math.random() * BOT_THINK_S;
  private goal = new THREE.Vector3();
  private huntTarget: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } | null = null;
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

  constructor(scene: THREE.Scene, name: string, team: TeamId, spawn: THREE.Vector3, terrain: Terrain) {
    super(scene, `bot:${name}`, { x: spawn.x, y: spawn.y, z: spawn.z }, terrain);
    this.team = team;
    this.setGizmoColor(TEAM_COLORS[team]);
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

/**
 * TeamBots — owns the roster, scores, and the local damage authority.
 * `world.remotePlayers` holds the GameBots so creature/projectile funnels
 * pick them up; this class is the referee.
 */
export class TeamBots {
  readonly bots: GameBot[] = [];
  readonly scores: TeamScores = makeScores();
  readonly teamOf = new Map<string, TeamId>(); // 'local' + bot:names
  over: TeamId | null = null;

  constructor(
    readonly deps: BotsDeps,
    private hooks: BotHooks,
    playerTeam: TeamId,
    counts: { alpha: number; bravo: number },
  ) {
    this.teamOf.set('local', playerTeam);
    const player = deps.lazyPlayer();
    const terrain = deps.lazyTerrain();
    const scene = deps.lazyScene();
    let ni = 0;
    const mk = (team: TeamId, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 20 + Math.random() * 40;
        const spawn = new THREE.Vector3(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
        spawn.y = terrain.getHeight(spawn.x, spawn.z) + EYE;
        const name = `${BOT_NAMES[ni++ % BOT_NAMES.length]}-${team === 'alpha' ? 'A' : 'B'}`;
        const bot = new GameBot(scene, name, team, spawn, terrain);
        this.bots.push(bot);
        this.teamOf.set(bot.playerId, team);
        deps.world.remotePlayers.set(bot.playerId, bot);
      }
    };
    mk('alpha', counts.alpha);
    mk('bravo', counts.bravo);
  }

  /** Per-frame: brains, fire resolution, respawns, win check. */
  update(dt: number): void {
    const terrain = deps0(this).terrain;
    const player = deps0(this).player;
    for (const bot of this.bots) {
      if (bot.isDead) {
        bot.respawnAt -= dt;
        if (bot.respawnAt <= 0) {
          const a = Math.random() * Math.PI * 2;
          const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * 50, 0, player.pos.z + Math.sin(a) * 50);
          sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
          bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
          bot.botHp = BOT_HP;
          bot.show();
          bot.setGizmoColor(TEAM_COLORS[bot.team]);
        }
        continue;
      }
      const enemies = this.enemyList(bot);
      const shot = bot.think(dt, {
        terrain,
        enemies,
        nugget: this.hooks.nearestNugget(bot.position, 60),
      });
      this.tickBolts(dt);
      if (shot) this.resolveShot(bot, shot.targetId, shot.aim);
    }
    if (!this.over) {
      const w = winner(this.scores);
      if (w) this.over = w;
    }
  }

  /** Everything the bot may legally shoot: enemy-team players (the local
   *  player included) and hostile creatures. */
  private enemyList(bot: GameBot): { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    _enemies.length = 0;
    const player = this.deps.lazyPlayer();
    if (this.teamOf.get('local') !== bot.team) {
      _enemies.push({ id: 'local', pos: player.pos, vel: player.vel, alive: !player.isDead });
    }
    for (const [id, rp] of this.deps.world.remotePlayers) {
      if (id === bot.playerId) continue;
      const team = this.teamOf.get(id);
      if (team === bot.team) continue;
      _enemies.push({ id, pos: rp.pos, vel: rp.vel, alive: !rp.isDead });
    }
    const c = this.hooks.nearestCreature(bot.position, 35);
    if (c) _enemies.push({ id: `creature:${c.id}`, pos: c.pos, vel: c.vel, alive: !c.dead });
    return _enemies;
  }

  /** Resolve a bot's bolt: instant claim with the aim point — the same
   *  legal-claim funnel pvptest bots use, minus the network. */
  private resolveShot(bot: GameBot, targetId: string, aim: THREE.Vector3): void {
    // A glowing bolt streak: cheap pooled line.
    this.spawnBolt(bot.position, aim);
    const dmg = BOT_DMG;

    if (targetId === 'local') {
      const p = this.deps.lazyPlayer();
      if (!p.isDead && aim.distanceTo(p.pos) < 1.6) {
        p.health = Math.max(0, p.health - dmg);
        p.lastDamageSource = `${bot.playerId.replace('bot:', '')} bolt`;
        p.applyKnockback(bot.position, 4);
        this.deps.lazyHud().showDamage(bot.position, dmg);
        sfx.playerHurt();
        if (p.health <= 0) this.hooks.localPlayerKilled(bot.playerId.replace('bot:', ''));
      }
      return;
    }
    if (targetId.startsWith('creature:')) {
      const id = +targetId.slice(9);
      const t = this.deps.targets.find(x => x.id === id);
      if (t && !t.dead && aim.distanceTo(t.pos) < t.radius + 1) {
        this.hooks.damageCreature(t.id, dmg, bot.position);
      }
      return;
    }
    const rp = this.deps.world.remotePlayers.get(targetId);
    if (rp instanceof GameBot && aim.distanceTo(rp.pos) < 1.6) {
      if (rp.takeDamageLocal(dmg, bot.position)) this.botKilled(bot.playerId, rp);
    }
  }

  /** Player/explosion damage routed here when the victim is a bot —
   *  combat consults `hit` before predictDamage. */
  hit(playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local'): boolean {
    const rp = this.deps.world.remotePlayers.get(playerId);
    if (!(rp instanceof GameBot)) return false;
    this.deps.lazyHealthBarSystem().spawn(playerId, dmg, rp.botHp);
    if (rp.takeDamageLocal(dmg, fromPos)) this.botKilled(attackerId, rp);
    return true;
  }

  private botKilled(killerId: string, bot: GameBot): void {
    // Kills drop nuggets — bots feed the economy like everything else.
    this.hooks.dropNuggets(bot.position, 3, bot.vel);
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    this.hooks.remoteKillFeed(`${kn} fragged ${bot.playerId.replace('bot:', '')}`);
    if (killerId === 'local') sfx.killConfirm();
  }

  /** A nugget was collected by 'local' or a bot id — bank it for the team. */
  collect(collectorId: string): void {
    const team = this.teamOf.get(collectorId);
    if (!team || this.over) return;
    bank(this.scores, team);
    this.pushScore();
    const w = winner(this.scores);
    if (w && !this.over) {
      this.over = w;
      this.hooks.remoteKillFeed(`${TEAM_LABEL[w]} WINS — ${this.scores.alpha}:${this.scores.bravo}`);
    }
  }

  /** Collectors nuggets should magnet toward — entities consults this each
   *  frame so bots sweep gems the same way the player does. */
  collectors(): { id: string; pos: THREE.Vector3; alive: boolean }[] {
    _collectors.length = 0;
    const p = this.deps.lazyPlayer();
    _collectors.push({ id: 'local', pos: p.pos, alive: !p.isDead });
    for (const b of this.bots) _collectors.push({ id: b.playerId, pos: b.position, alive: !b.isDead });
    return _collectors;
  }

  private pushScore(): void {
    this.deps.lazyHud().setTeamScore?.(this.scores.alpha, this.scores.bravo);
  }

  private bolts: { line: THREE.Line; t: number }[] = [];

  private spawnBolt(from: THREE.Vector3, to: THREE.Vector3): void {
    const g = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const line = new THREE.Line(g, BOLT_MAT);
    this.deps.lazyScene().add(line);
    this.bolts.push({ line, t: 0.12 });
  }

  tickBolts(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.deps.lazyScene().remove(b.line);
        b.line.geometry.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const b of this.bots) {
      this.deps.world.remotePlayers.delete(b.playerId);
      b.dispose();
    }
    this.bots.length = 0;
  }
}

const _enemies: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] = [];
const _collectors: { id: string; pos: THREE.Vector3; alive: boolean }[] = [];
const BOLT_MAT = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });

// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return { terrain: m.deps.lazyTerrain(), player: m.deps.lazyPlayer() }; }
