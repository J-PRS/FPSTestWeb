import * as THREE from 'three';

import { GameBot, BOT_DMG, EYE } from './botBrain.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { TEAM_COLORS, TEAM_LABEL, MODES, bank, makeScores, type TeamId, type TeamScores, type ModeId } from '../../../shared/teams.js';
import { PlayerDebris } from '../effects/debris.js';
import type { Terrain } from '../world/terrain.js';
import { MELEE_RANGE, MELEE_DAMAGE } from '../core/config.js';
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
  lazyCamera(): THREE.Camera;
  lazyHealthBarSystem(): { spawn(id: string, dmg: number, hp: number): void };
  /** Live creature list — bots fight these too. */
  targets: Targetable[];
}

interface BotHooks {
  /** Drop nuggets where a bot died (entities owns the nugget factory). */
  dropNuggets(pos: THREE.Vector3, n: number, inheritVel: THREE.Vector3): void;
  /** Local player died to a bot — mirrors netHandlers' kill path. */
  localPlayerKilled(killerName: string): void;
  /** Match announcements — win banners, NEW MATCH, flag grabs. Center-screen. */
  remoteKillFeed(text: string): void;
  /** A kill happened — CS-style killfeed row in the corner, not the
   *  center banner (that's reserved for YOUR frags/deaths). */
  killFeed(shooter: string, victim: string, localIsShooter: boolean, localIsVictim: boolean): void;
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
    private playerTeam: string,
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
        // Tier mix mirrors the server roster: ~1 light, ~1 heavy per
        // squad, mediums filling — enough for silhouettes to read. Class
        // rides the ctor so a heavy lands the knight model, not just stats.
        const bot = new GameBot(scene, name, team === 'alpha' ? 'alpha' : 'bravo', spawn, terrain,
          ni % 4 === 1 ? 'light' : ni % 4 === 3 ? 'heavy' : 'medium');
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
    const player = deps0(this).lazyPlayer();
    // Separation sense — every live body the steerer should keep space
    // from. A bot's own position reads as dist 0 and is skipped inside.
    const others: THREE.Vector3[] = [];
    for (const b of this.bots) if (!b.isDead) others.push(b.position);
    others.push(player.pos);
    this.tickBots(dt, others);
    if (this.spec.flags) {
      this.ctf?.update(dt);
      // Flag markers ride the player-indicator overlay — a DOM element
      // projects through terrain, which is the entire point.
      if (this.ctf) {
        const cam = this.deps.lazyCamera();
        for (const m of this.ctf.markers()) {
          // +3.4 → the indicator's own +1.0 puts the diamond at the 4m
          // pole tip instead of at the base's feet.
          m.pos.y += 3.4;
          this.deps.lazyHud().updateFlagIndicator(`flag:${m.team}`, m.pos, cam, m.team);
          m.pos.y -= 3.4;
        }
      }
    }
    this.watchdog(dt);
    this.syncLocalTeam();
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

  /** Per-bot think pass — interp tick, respawn countdown, brain, fire. */
  private tickBots(dt: number, others: THREE.Vector3[]): void {
    const terrain = this.deps.lazyTerrain();
    this.tickBolts(dt); // frame-rate, not per-bot — it was over-integrating in the loop
    for (const bot of this.bots) {
      // Local bots aren't in the wire roster, so remotes.ts never ticks
      // them — tick() is what advances the snapshot interpolation and
      // AnimationMixer onto the model. Without it think() moves the
      // logical position but the rendered body stands frozen at spawn.
      bot.tick(dt);
      if (bot.isDead) {
        bot.respawnAt -= dt;
        if (bot.respawnAt <= 0) this.respawnBot(bot);
        continue;
      }
      const enemies = this.enemyList(bot);
      const shot = bot.think(dt, {
        terrain,
        enemies,
        nugget: this.spec.flags ? null : this.hooks.nearestNugget(bot.position, 60),
        objective: this.ctf?.objectiveFor(bot) ?? null,
        others,
      });
      if (shot && !this.over) this.resolveShot(bot, shot.targetId, shot.aim); // ceasefire while the banner's up
      this.sheepTick(bot, dt, terrain);
    }
  }

  /** Sheep meter accrual — fills while the bot moves like a pedestrian
   *  (slow, grounded, or parked), drains while it's doing Tribes things
   *  (covering ground, airborne, jetting). At 100 it gets yeeted: an
   *  impulse launch that forces the behavior the meter wants. */
  private sheepTick(bot: GameBot, dt: number, terrain: Terrain): void {
    const v = bot.vel;
    const speedXZ = Math.hypot(v.x, v.z);
    const grounded = bot.pos.y - terrain.getHeight(bot.pos.x, bot.pos.z) < 2;
    const tribesing = speedXZ > 8 || !grounded || bot.yeetT > 0;
    const moving = speedXZ > 1;
    const delta = tribesing ? -(8 + speedXZ * 0.5 + (bot.yeetT > 0 ? 12 : 0)) : moving ? 6 : 14;
    bot.sheep = Math.max(0, Math.min(100, bot.sheep + delta * dt));
    // ~2s trailing average for display — the raw meter jitters ±10/s
    // around the fill/drain boundary, which reads as flicker.
    bot.sheepShown += (bot.sheep - bot.sheepShown) * Math.min(1, dt * 0.5);
    if (bot.sheep >= 100) {
      bot.yeet();
      this.deps.logger.warn(`bot ${bot.playerId} yeeted — sheep meter hit 100`);
    }
  }

  /** The player's live team is world.localTeam — a connected room can
   *  re-seat you on bravo after the boot-time alpha. teamOf must follow
   *  or the bots' friend/foe reads the WRONG side of the scoreboard.
   *  And if the flip lands you on the 5-bot side, a bot crosses over:
   *  the match is authored as you+4 vs 5 either way. */
  private syncLocalTeam(): void {
    if (this.spec.ffa) return;
    let lt = this.deps.world.localTeam;
    if (lt !== 'alpha' && lt !== 'bravo') {
      // A teamless/quiet wire (offline, or a mode-less room) has no say —
      // the local squad owns the team frame. Re-assert it or every
      // friendly check (indicators, tint, scoreboard) reads all-red.
      const own = this.teamOf.get('local');
      if (own !== 'alpha' && own !== 'bravo') return;
      this.deps.world.localTeam = own;
      lt = own;
    }
    if (this.teamOf.get('local') === lt) return;
    this.teamOf.set('local', lt);
    const other: TeamId = lt === 'alpha' ? 'bravo' : 'alpha';
    const wantAllies = Math.floor(this.bots.length / 2);
    while (this.bots.filter(b => b.team === lt).length > wantAllies) {
      const b = this.bots.find(x => x.team === lt);
      if (!b) break;
      // Jersey swap — rename the id so the scoreboard's -A/-B suffix
      // stays truthful, then re-key every roster that holds it.
      const oldId = b.playerId;
      const newId = oldId.replace(/-[AB]$/, `-${other === 'alpha' ? 'A' : 'B'}`);
      if (newId !== oldId) {
        this.deps.world.remotePlayers.rename(oldId, newId);
        this.teamOf.delete(oldId);
        b.playerId = newId;
      }
      b.team = other;
      this.teamOf.set(b.playerId, other);
      b.setGizmoColor(TEAM_COLORS[other]);
      this.hooks.killFeed(other === 'alpha' ? 'ALPHA' : 'BRAVO', `${b.playerId.replace('bot:', '')} defects`, false, false);
    }
  }

  // ---- Watchdog ----
  // Bots failing silently is the recurring bug class (tick dropped, brains
  // wedged). Every 4s we diff each bot's LOGICAL position against where
  // the rendered model actually is:
  //   - logic moved but model didn't → tick/interp stall (frozen statue)
  //   - NOTHING moved, all alive bots → brains aren't running at all
  // Warns once per episode per bot (recovers → re-arms). Match-over and
  // all-dead windows are legit stillness, not failures.
  private watchdogT = 0;
  private readonly wdLogic = new Map<string, THREE.Vector3>();
  private readonly wdRender = new Map<string, THREE.Vector3>();
  private readonly wdStalled = new Set<string>();
  // Displacement anchor — where the bot stood ~10s ago. A bot stuck in a
  // corner keeps producing 4s motion deltas (jiggle, repulsion pushback),
  // so the stall test is NET displacement over a longer window: pacing in
  // a 3m circle cancels out, real travel doesn't.
  private readonly wdAnchor = new Map<string, { p: THREE.Vector3; t: number }>();
  private readonly wdStuck = new Set<string>();
  private wdIdleWindows = 0;
  private static readonly WD_DT = 4;
  private static readonly WD_STUCK_T = 10; // seconds per displacement window
  private static readonly WD_STUCK_D = 10; // meters of net travel expected

  private watchdog(dt: number): void {
    this.watchdogT += dt;
    if (this.watchdogT < TeamBots.WD_DT) return;
    this.watchdogT = 0;
    const log = this.deps.logger;
    let alive = 0, stuckNow = 0, stuckEval = 0;
    for (const bot of this.bots) {
      if (bot.isDead) continue;
      alive++;
      const prev = this.wdLogic.get(bot.playerId);
      const logicD = prev ? prev.distanceTo(bot.position) : 99;
      if (prev) prev.copy(bot.position); else this.wdLogic.set(bot.playerId, bot.position.clone());

      // Displacement check — every WD_STUCK_T seconds compare against the
      // anchor, then re-anchor at the current spot.
      const evald = this.wdCheckDisplacement(bot);
      if (evald === 'stuck') { stuckEval++; stuckNow++; }
      else if (evald === 'ok') stuckEval++;

      this.wdCheckRender(bot, logicD);
    }
    // Whole-squad freeze: every bot that finished a displacement window
    // this tick came up stuck. Two consecutive all-stuck ticks = brains
    // aren't producing travel at all (not just one wedged path).
    if (stuckEval > 0 && stuckNow === stuckEval && stuckEval >= Math.max(1, alive >> 1) && !this.over) {
      if (++this.wdIdleWindows >= 2) {
        log.warn(`all ${alive} bots pinned — <${TeamBots.WD_STUCK_D}m net travel per ${TeamBots.WD_STUCK_T}s window (brains not ticking?)`);
        this.wdIdleWindows = 0; // re-arm the counter, not the warning state
      }
    } else {
      this.wdIdleWindows = 0;
    }
  }

  /** One displacement-window verdict for the watchdog: 'stuck' | 'ok' when
   *  a window just closed, 'pending' while still accumulating. */
  private wdCheckDisplacement(bot: GameBot): 'stuck' | 'ok' | 'pending' {
    const a = this.wdAnchor.get(bot.playerId);
    if (!a) {
      this.wdAnchor.set(bot.playerId, { p: bot.position.clone(), t: 0 });
      return 'pending';
    }
    a.t += TeamBots.WD_DT;
    if (a.t < TeamBots.WD_STUCK_T) return 'pending';
    const disp = a.p.distanceTo(bot.position);
    a.p.copy(bot.position);
    a.t = 0;
    if (disp < TeamBots.WD_STUCK_D && !this.over) {
      if (!this.wdStuck.has(bot.playerId)) {
        this.wdStuck.add(bot.playerId);
        this.deps.logger.warn(`bot ${bot.playerId} stuck — only ${disp.toFixed(1)}m net travel in ${TeamBots.WD_STUCK_T}s (wedged or brain loop?)`);
      }
      return 'stuck';
    }
    if (this.wdStuck.delete(bot.playerId)) {
      this.deps.logger.info(`bot ${bot.playerId} unstuck — ${disp.toFixed(1)}m net travel`);
    }
    return 'ok';
  }

  /** Render-side watchdog leg — model position vs its own last sample.
   *  Feet sit EYE below the logical pos; we only need the delta. */
  private wdCheckRender(bot: GameBot, logicD: number): void {
    const have = bot.model.getModelPosition(_wdPos);
    if (!have) return;
    const rp = this.wdRender.get(bot.playerId);
    if (!rp) {
      this.wdRender.set(bot.playerId, _wdPos.clone());
      return;
    }
    const renderD = rp.distanceTo(_wdPos);
    rp.copy(_wdPos);
    if (logicD > 1.5 && renderD < 0.2 && !this.wdStalled.has(bot.playerId)) {
      this.wdStalled.add(bot.playerId);
      this.deps.logger.warn(`bot ${bot.playerId} render stalled — logic moved ${logicD.toFixed(1)}m, model moved ${renderD.toFixed(2)}m (tick/interp not running)`);
    } else if (renderD > 0.5 && this.wdStalled.delete(bot.playerId)) {
      this.deps.logger.info(`bot ${bot.playerId} render recovered`);
    }
  }

  private winText(w: string): string {
    if (!this.spec.ffa) return `${TEAM_LABEL[w as TeamId]} WINS — ${this.scores.alpha}:${this.scores.bravo}`;
    const name = w === 'local' ? 'YOU' : w.replace('bot:', '');
    return `${name} WINS the deathmatch — ${this.ffaScores.get(w)} pts`;
  }

  /** Re-seat a dead bot on the spawn ring — shared by the respawn timer
   *  and match reset (same spot-finding, hp, and gizmo re-tint). */
  private respawnBot(bot: GameBot): void {
    const player = this.deps.lazyPlayer();
    const terrain = this.deps.lazyTerrain();
    const a = Math.random() * Math.PI * 2;
    const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * 50, 0, player.pos.z + Math.sin(a) * 50);
    sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
    bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
    bot.botHp = bot.botMaxHp;
    bot.sheep = 0; // fresh leash on the meter
    bot.sheepShown = 0;
    bot.yeetT = 0;
    bot.show();
    bot.setGizmoColor(bot.team === 'ffa' ? 0xcc66ff : TEAM_COLORS[bot.team as TeamId]);
  }

  /** Match over → wipe scores, respawn every bot, flags home. */
  private resetMatch(): void {
    this.over = null;
    this.scores.alpha = 0; this.scores.bravo = 0;
    for (const k of this.ffaScores.keys()) this.ffaScores.set(k, 0);
    for (const bot of this.bots) {
      bot.carryingFlag = false;
      this.respawnBot(bot);
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
   *  legal-claim funnel pvptest bots use, minus the network. Inside fist
   *  range the bot punches instead — a fist lands flat 60, no bolt streak. */
  private resolveShot(bot: GameBot, targetId: string, aim: THREE.Vector3): void {
    const melee = bot.position.distanceTo(aim) <= MELEE_RANGE;
    if (!melee) this.spawnBolt(bot.position, aim); // cheap pooled tracer
    const dmg = melee ? MELEE_DAMAGE : BOT_DMG;
    const src = `${bot.playerId.replace('bot:', '')} ${melee ? 'fist' : 'bolt'}`;

    if (targetId === 'local') {
      this.resolveShotOnLocal(bot, aim, dmg, melee, src);
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

  /** Bot bolt lands on the local player — damage, knockback, death feed. */
  private resolveShotOnLocal(bot: GameBot, aim: THREE.Vector3, dmg: number, melee: boolean, src: string): void {
    const p = this.deps.lazyPlayer();
    if (p.isDead || aim.distanceTo(p.pos) >= 1.6) return;
    p.health = Math.max(0, p.health - dmg);
    p.lastDamageSource = src;
    p.applyKnockback(bot.position, melee ? 6 : 4);
    this.deps.lazyHud().showDamage(bot.position, dmg);
    sfx.playerHurt();
    if (p.health > 0) return;
    this.deps.world.killCounts.set(bot.playerId, (this.deps.world.killCounts.get(bot.playerId) ?? 0) + 1);
    this.creditKill(bot.playerId, false);
    this.localDied();
    this.hooks.killFeed(bot.playerId.replace('bot:', ''), 'YOU', false, true);
    this.hooks.localPlayerKilled(bot.playerId.replace('bot:', ''));
  }

  /** Player/explosion damage routed here when the victim is a bot —
   *  combat consults `hit` before predictDamage. */
  hit(playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local'): boolean {
    const rp = this.deps.world.remotePlayers.get(playerId);
    if (!(rp instanceof GameBot)) return false;
    const died = rp.takeDamageLocal(dmg, fromPos);
    this.deps.lazyHealthBarSystem().spawn(playerId, dmg, died ? 0 : rp.botHp);
    if (died) this.botKilled(attackerId, rp);
    return true;
  }

  private botKilled(killerId: string, bot: GameBot): void {
    // Same shatter as wire remotes — the corpse pops into team-colored
    // shards instead of just shrinking away.
    const t = bot.team;
    let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined;
    try { parts = bot.model.deathParts() ?? undefined; }
    catch { /* fall through to generic shards */ }
    this.deps.world.playerDebrisList.push(new PlayerDebris(
      this.deps.lazyScene(), this.deps.lazyTerrain(),
      { x: bot.position.x, y: bot.position.y + 1.0, z: bot.position.z },
      new THREE.Color(t === 'alpha' || t === 'bravo' ? TEAM_COLORS[t] : 0xcc66ff),
      { inheritVel: bot.vel, parts },
    ));
    // Kills drop nuggets — bots feed the economy like everything else.
    if (!this.spec.ffa) this.hooks.dropNuggets(bot.position, 3, bot.vel);
    this.deps.world.killCounts.set(killerId, (this.deps.world.killCounts.get(killerId) ?? 0) + 1);
    this.creditKill(killerId, false);
    this.dropCarriedFlag(bot.playerId, bot.position);
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    this.hooks.killFeed(kn, bot.playerId.replace('bot:', ''), killerId === 'local', false);
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
const _wdPos = new THREE.Vector3();
const BOLT_MAT = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });

// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return m.deps; }
