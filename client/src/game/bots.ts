import * as THREE from 'three';

import { GameBot, BOT_HP, BOT_DMG, EYE } from './botBrain.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { TEAM_COLORS, TEAM_LABEL, MODES, bank, makeScores, type TeamId, type TeamScores, type ModeId } from '../../../shared/teams.js';
import { CtfFlags } from './ctfFlags.js';
import * as sfx from '../core/sfx.js';

/**
 * TeamBots — the mode referee. Bot brains/bodies live in botBrain.ts;
 * this file owns roster, scoring, damage authority, and the CTF flags.
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
  /** A bot's bolt connected with a creature — damage through the entity.
   *  Returns true on kill (DM credits the bot). */
  damageCreature(id: number, dmg: number, attackerId: string): boolean;
}

export class TeamBots {
  readonly bots: GameBot[] = [];
  readonly scores: TeamScores = makeScores();
  readonly teamOf = new Map<string, string>(); // 'local' + bot:names → team key
  /** FFA scores (dm): per playerId. Team modes use `scores`. */
  readonly ffaScores = new Map<string, number>();
  over: string | null = null;
  readonly spec: (typeof MODES)[ModeId];

  private ctf: CtfFlags | null = null;

  constructor(
    readonly deps: BotsDeps,
    private hooks: BotHooks,
    playerTeam: string,
    counts: { alpha: number; bravo: number },
    private mode: ModeId,
  ) {
    this.spec = MODES[mode]; // param props assign after field inits — do it here
    const ffa = this.spec.ffa;
    this.teamOf.set('local', ffa ? 'local' : playerTeam);
    if (ffa) this.ffaScores.set('local', 0);
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
        const name = ffa ? BOT_NAMES[ni++ % BOT_NAMES.length] : `${BOT_NAMES[ni++ % BOT_NAMES.length]}-${team === 'alpha' ? 'A' : 'B'}`;
        const bot = new GameBot(scene, name, team === 'alpha' ? 'alpha' : 'bravo', spawn, terrain);
        if (ffa) {
          // FFA pseudo-team = own id — everyone is everyone else's enemy.
          bot.team = bot.playerId;
          this.ffaScores.set(bot.playerId, 0);
        }
        this.bots.push(bot);
        this.teamOf.set(bot.playerId, bot.team);
        deps.world.remotePlayers.adopt(bot.playerId, bot);
      }
    };
    if (ffa) {
      mk('alpha', counts.alpha + counts.bravo);
    } else {
      mk('alpha', counts.alpha);
      mk('bravo', counts.bravo);
    }
    if (this.spec.flags) {
      this.ctf = new CtfFlags({
        lazyTerrain: deps.lazyTerrain,
        lazyScene: deps.lazyScene,
        carrierPos: (id) => this.carrierPos(id),
        teamOf: (id) => this.teamOf.get(id),
        touchers: () => this.touchers(),
        bots: this.bots,
        scores: this.scores,
        onCapture: () => this.pushScore(),
        onFeed: (t) => this.hooks.remoteKillFeed(t),
      }, deps.lazyPlayer().pos);
    }
  }

  /** Per-frame: brains, fire resolution, respawns, win check. */
  update(dt: number): void {
    const terrain = deps0(this).terrain;
    const player = deps0(this).player;
    for (const bot of this.bots) {
      // Local bots aren't in the wire roster, so remotes.ts never ticks
      // them — tick() is what advances the snapshot interpolation and
      // AnimationMixer onto the model. Without it think() moves the
      // logical position but the rendered body stands frozen at spawn.
      bot.tick(dt);
      if (bot.isDead) {
        bot.respawnAt -= dt;
        if (bot.respawnAt <= 0) {
          const a = Math.random() * Math.PI * 2;
          const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * 50, 0, player.pos.z + Math.sin(a) * 50);
          sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
          bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
          bot.botHp = BOT_HP;
          bot.show();
          bot.setGizmoColor(bot.team === 'ffa' ? 0xcc66ff : TEAM_COLORS[bot.team as TeamId]);
        }
        continue;
      }
      this.tickBolts(dt);
      const enemies = this.enemyList(bot);
      const shot = bot.think(dt, {
        terrain,
        enemies,
        nugget: this.spec.flags ? null : this.hooks.nearestNugget(bot.position, 60),
        objective: this.ctf?.objectiveFor(bot) ?? null,
      });
      if (shot && !this.over) this.resolveShot(bot, shot.targetId, shot.aim); // ceasefire while the banner's up
    }
    if (this.spec.flags) this.ctf?.update(dt);
    if (!this.over) {
      const w = this.checkWin();
      if (w) {
        this.over = w;
        this.hooks.remoteKillFeed(this.winText(w));
        sfx.pickup();
        this.overAt = performance.now();
      }
    } else if (performance.now() - this.overAt > 8000) {
      this.resetMatch();
    }
  }

  private overAt = 0;

  private winText(w: string): string {
    if (!this.spec.ffa) return `${TEAM_LABEL[w as TeamId]} WINS — ${this.scores.alpha}:${this.scores.bravo}`;
    const name = w === 'local' ? 'YOU' : w.replace('bot:', '');
    return `${name} WINS the deathmatch — ${this.ffaScores.get(w)} pts`;
  }

  /** Match over → wipe scores, respawn every bot, flags home. */
  private resetMatch(): void {
    this.over = null;
    this.scores.alpha = 0; this.scores.bravo = 0;
    for (const k of this.ffaScores.keys()) this.ffaScores.set(k, 0);
    const player = this.deps.lazyPlayer();
    const terrain = this.deps.lazyTerrain();
    for (const bot of this.bots) {
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 40;
      const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
      sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
      bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
      bot.botHp = BOT_HP;
      bot.carryingFlag = false;
      bot.show();
    }
    this.ctf?.reset();
    this.pushScore();
    this.hooks.remoteKillFeed(`${this.spec.label} — NEW MATCH`);
  }

  private checkWin(): string | null {
    if (!this.spec.ffa) {
      const s = this.scores;
      if (s.alpha >= this.spec.winAt) return 'alpha';
      if (s.bravo >= this.spec.winAt) return 'bravo';
      return null;
    }
    for (const [id, sc] of this.ffaScores) if (sc >= this.spec.winAt) return id;
    return null;
  }

  /** DM kill credit — a player/bot frag vs a creature frag. */
  creditKill(id: string, isCreature: boolean): void {
    if (!this.spec.ffa || this.over) return;
    const pts = isCreature ? this.spec.ptsCreatureKill : this.spec.ptsPlayerKill;
    this.ffaScores.set(id, (this.ffaScores.get(id) ?? 0) + pts);
    const me = this.ffaScores.get('local') ?? 0;
    let lead = 0;
    for (const [, v] of this.ffaScores) if (v > lead) lead = v;
    this.deps.lazyHud().setTeamScore(me, lead);
  }

  /** Bots hostile to the LOCAL player — the deployable turret's target
   *  list. Enemy-team members in team modes, everyone in FFA. */
  enemyBotsForLocal(): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    const myTeam = this.teamOf.get('local');
    return this.bots
      .filter(b => !b.isDead && b.team !== myTeam)
      .map(b => ({ playerId: b.playerId, pos: b.pos, vel: b.vel, alive: true }));
  }

  /** Everything the bot may legally shoot: enemy-team players (the local
   *  player included) and hostile creatures. */
  private enemyList(bot: GameBot): { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    _enemies.length = 0;
    const player = this.deps.lazyPlayer();
    if (this.teamOf.get('local') !== bot.team) {
      _enemies.push({ id: 'local', pos: player.pos, vel: player.vel, alive: !player.isDead && !player.isCloaked });
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
        if (p.health <= 0) {
          this.deps.world.killCounts.set(bot.playerId, (this.deps.world.killCounts.get(bot.playerId) ?? 0) + 1);
          this.creditKill(bot.playerId, false);
          this.localDied();
          this.hooks.localPlayerKilled(bot.playerId.replace('bot:', ''));
        }
      }
      return;
    }
    if (targetId.startsWith('creature:')) {
      const id = +targetId.slice(9);
      const t = this.deps.targets.find(x => x.id === id);
      if (t && !t.dead && aim.distanceTo(t.pos) < t.radius + 1) {
        if (this.hooks.damageCreature(t.id, dmg, bot.playerId)) this.creditKill(bot.playerId, true);
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
    if (!this.spec.ffa) this.hooks.dropNuggets(bot.position, 3, bot.vel);
    this.deps.world.killCounts.set(killerId, (this.deps.world.killCounts.get(killerId) ?? 0) + 1);
    this.creditKill(killerId, false);
    this.dropCarriedFlag(bot.playerId, bot.position);
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    this.hooks.remoteKillFeed(`${kn} fragged ${bot.playerId.replace('bot:', '')}`);
    if (killerId === 'local') sfx.killConfirm();
  }

  /** DM: local player's creature kill — combat calls this from
   *  onTargetDestroyed via the botKilled path for creature credit. */
  creatureKilled(attackerId: string): void {
    this.creditKill(attackerId, true);
  }

  /** The local player died (any mode) — release a carried flag. */
  localDied(): void {
    this.dropCarriedFlag('local', this.deps.lazyPlayer().pos);
  }

  // ---- CTF (mechanics live in ctfFlags.ts; this bridges roster/scores) ----

  private carrierPos(id: string): THREE.Vector3 | null {
    if (id === 'local') { const p = this.deps.lazyPlayer(); return p.isDead ? null : p.pos; }
    const rp = this.deps.world.remotePlayers.get(id);
    return rp && !rp.isDead ? rp.pos : null;
  }

  private touchers(): [string, THREE.Vector3][] {
    const player = this.deps.lazyPlayer();
    _touchers.length = 0;
    if (!player.isDead) _touchers.push(['local', player.pos]);
    for (const b of this.bots) if (!b.isDead) _touchers.push([b.playerId, b.position]);
    return _touchers;
  }

  private dropCarriedFlag(carrierId: string, at: THREE.Vector3): void {
    this.ctf?.dropCarried(carrierId, at);
  }

  /** A nugget was collected by 'local' or a bot id — bank it for the team. */
  collect(collectorId: string): void {
    if (this.spec.ffa || this.over) return; // dm: nuggets heal, don't score
    // Networked matches score through server-owned gems (RoomPickups
    // touch) — the teamScore echo is the truth; this local board is the
    // offline path's own scoreboard.
    const team = this.teamOf.get(collectorId) as TeamId | undefined;
    if (!team) return;
    bank(this.scores, team);
    this.pushScore();
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

  // Bolt tracers share a pool — a fresh BufferGeometry per shot meant a GL
  // buffer upload + dispose for a 120ms visual.
  private bolts: { line: THREE.Line; t: number }[] = [];
  private boltPool: THREE.Line[] = [];

  private spawnBolt(from: THREE.Vector3, to: THREE.Vector3): void {
    let line = this.boltPool.pop();
    if (!line) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      line = new THREE.Line(g, BOLT_MAT);
    }
    const a = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    a.setXYZ(0, from.x, from.y, from.z);
    a.setXYZ(1, to.x, to.y, to.z);
    a.needsUpdate = true;
    this.deps.lazyScene().add(line);
    this.bolts.push({ line, t: 0.12 });
  }

  tickBolts(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.deps.lazyScene().remove(b.line);
        this.boltPool.push(b.line);
        this.bolts[i] = this.bolts[this.bolts.length - 1];
        this.bolts.pop();
      }
    }
  }

  dispose(): void {
    for (const b of this.bots) this.deps.world.remotePlayers.remove(b.playerId);
    this.bots.length = 0;
    for (const b of this.bolts) this.deps.lazyScene().remove(b.line);
    this.bolts.length = 0;
    for (const l of this.boltPool) l.geometry.dispose();
    this.boltPool.length = 0;
  }
}

const _touchers: [string, THREE.Vector3][] = [];
const _enemies: { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] = [];
const _collectors: { id: string; pos: THREE.Vector3; alive: boolean }[] = [];
const BOLT_MAT = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });

// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return { terrain: m.deps.lazyTerrain(), player: m.deps.lazyPlayer() }; }
