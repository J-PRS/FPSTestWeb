import * as THREE from 'three';

import { GameBot, EYE } from './botBrain.js';
import { BotWatchdog } from './botWatchdog.js';
import { SheepMeter } from './botSheep.js';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { MODES, makeScores, type TeamId, type TeamScores, type ModeId } from '../../../shared/teams.js';
import type { Terrain } from '../world/terrain.js';
import { CtfBridge } from './botCtf.js';
import * as sfx from '../core/sfx.js';
import { BotSenses } from './botSenses.js';
import { BotFire } from './botFire.js';
import { respawnBotF, hitF, hurtLocal, botKilledF } from './botKill.js';
import { winText, checkWin, resetMatch, creditKill, collect, pushScore, syncLocalTeam } from './botMatch.js';

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

import { BOT_NAMES } from '../../../shared/botNames.js';

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
  /** A builder bot wants to plant — owner wrapper keeps the item's foes,
   *  anchors, and heals pointed at the bot, not the local player. */
  botDeploy?(kind: string, pos: { x: number; y: number; z: number }, owner: import('./deployables.js').DeployOwner): void;
}

export class TeamBots {
  readonly bots: GameBot[] = [];
  readonly scores: TeamScores = makeScores();
  readonly teamOf = new Map<string, string>(); // 'local' + bot:names → team key
  /** FFA scores (dm): per playerId. Team modes use `scores`. */
  readonly ffaScores = new Map<string, number>();
  over: string | null = null;
  readonly spec: (typeof MODES)[ModeId];

  // Public — botMatch.ts (the match referee) reads/resets flags through it.
  ctf: CtfBridge | null = null;
  private senses: BotSenses;
  private fire: BotFire;
  // Anti-pedestrian meter (idle/ignore/bleed/coverage) lives in
  // botSheep.ts — rates mirror the server meter.
  sheep = new SheepMeter({ warn: (m) => this.deps.logger.warn(m) });

  constructor(
    readonly deps: BotsDeps,
    readonly hooks: BotHooks,
    private playerTeam: string,
    counts: { alpha: number; bravo: number },
    private mode: ModeId,
  ) {
    this.spec = MODES[mode]; // param props assign after field inits — do it here
    this.senses = new BotSenses({
      bots: this.bots,
      teamOf: this.teamOf,
      player: () => this.deps.lazyPlayer(),
      world: () => this.deps.world,
      mode: () => this.mode,
      nearestCreature: (p, d) => this.hooks.nearestCreature(p, d),
    });
    this.fire = new BotFire({
      scene: () => this.deps.lazyScene(),
      player: () => this.deps.lazyPlayer(),
      world: () => this.deps.world,
      targets: this.deps.targets,
      online: () => this.deps.lazyNetworkManager?.()?.isConnected() ?? false,
      logger: this.deps.logger,
      damageCreature: (id, dmg, att) => this.hooks.damageCreature(id, dmg, att),
      creditKill: (id, cr) => this.creditKill(id, cr),
      botKilled: (k, b) => botKilledF(this, k, b),
      hurtLocal: (d, fp, src, m, att) => hurtLocal(this, d, fp, att, { src, melee: m }),
    });
    this.wd = new BotWatchdog(deps.logger, () => this.over !== null);
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
        // Same roster the dedicated server fields — loadout picks the
        // weapon by engagement range instead of one generic bolt.
        bot.setLoadout(BOT_LOADOUTS[(ni - 1) % BOT_LOADOUTS.length]!);
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
      this.ctf = new CtfBridge(deps, {
        bots: this.bots,
        teamOf: this.teamOf,
        scores: this.scores,
        playerTeam: this.playerTeam as TeamId,
        modsFor: (id) => this.modsFor(id),
        onCapture: () => pushScore(this),
        onFeed: (t) => this.hooks.remoteKillFeed(t),
      });
    }
  }

  // Rebuilt each frame but never reallocated — one ~10-slot array of
  // Vector3 refs per frame was steady GC churn for zero benefit.
  private readonly othersScratch: THREE.Vector3[] = [];

  /** Per-frame: brains, fire resolution, respawns, win check. */
  update(dt: number): void {
    const player = deps0(this).lazyPlayer();
    // Separation sense — every live body the steerer should keep space
    // from. A bot's own position reads as dist 0 and is skipped inside.
    const others = this.othersScratch;
    others.length = 0;
    for (const b of this.bots) if (!b.isDead) others.push(b.position);
    others.push(player.pos);
    this.tickBots(dt, others);
    this.ctf?.update(dt);
    this.wd.step(dt, this.bots);
    syncLocalTeam(this);
    if (!this.over) {
      const w = checkWin(this);
      if (w) {
        this.over = w;
        this.hooks.remoteKillFeed(winText(this, w));
        sfx.pickup();
        this.overAt = performance.now();
      }
    } else if (performance.now() - this.overAt > 8000) {
      resetMatch(this);
    }
  }

  overAt = 0; // public — botMatch writes it via the host interface

  /** Per-bot think pass — interp tick, respawn countdown, brain, fire. */
  private tickBots(dt: number, others: THREE.Vector3[]): void {
    const terrain = this.deps.lazyTerrain();
    this.fire.tickBolts(dt); // frame-rate, not per-bot — it was over-integrating in the loop
    // Sheep coverage windows run on sim ms advanced ONCE per frame —
    // doing it inside sheepTick scaled every 5s window by the roster
    // size (9 bots → windows fired ~9x too often, cover-dominated max-outs).
    this.sheep.advance(dt);
    let i = 0;
    for (const bot of this.bots) this.tickBot(bot, dt, others, terrain, i++);
  }

  // Think rate: brains decide at ~10Hz (staggered per bot so thinks
  // don't pile onto one frame), fed the real elapsed since the last
  // think — steering reads identically, senses/fire just run at the
  // human-plausible cadence instead of 60+.
  private static readonly THINK_PERIOD = 0.1;
  private thinkAccum = new Map<string, number>();

  private tickBot(bot: GameBot, dt: number, others: THREE.Vector3[], terrain: Terrain, rosterIdx = 0): void {
    // Local bots aren't in the wire roster, so remotes.ts never ticks
    // them — tick() is what advances the snapshot interpolation and
    // AnimationMixer onto the model. Without it think() moves the
    // logical position but the rendered body stands frozen at spawn.
    bot.tick(dt);
    if (bot.isDead) {
      bot.respawnAt -= dt;
      if (bot.respawnAt <= 0) this.respawnBot(bot);
      return;
    }
    // Movement integrates every frame — the 10Hz think gate below is for
    // decisions only; gating movement made every bot warp in 100ms hops.
    bot.stepFrame(dt, { terrain });
    // Roster-indexed start phase spreads thinks across the period —
    // without it every bot thinks on the same frame and stays aligned.
    const acc = (this.thinkAccum.get(bot.playerId)
      ?? (rosterIdx * TeamBots.THINK_PERIOD) / Math.max(1, this.bots.length)) + dt;
    this.thinkAccum.set(bot.playerId, acc);
    if (acc < TeamBots.THINK_PERIOD) return;
    this.thinkAccum.set(bot.playerId, 0);
    const foes = this.senses.enemyList(bot);
    const shot = bot.think(acc, this.ctxFor(bot, foes, others, terrain));
    if (this.over) { this.sheep.tick(bot, acc, terrain); return; }
    this.afterThink(bot, shot, acc, foes, terrain);
  }

  private afterThink(bot: GameBot, shot: ReturnType<GameBot['think']>, acc: number,
    foes: Parameters<GameBot['think']>[1]['enemies'], terrain: Terrain): void {
    if (shot) this.fire.resolveShot(bot, shot.targetId, shot.aim);
    // Belt + propel are real-spawn actions — offline only, same gate
    // as resolveShot (a connected room's wire remotes can't attribute).
    const online = this.deps.lazyNetworkManager?.()?.isConnected() ?? false;
    if (!online) {
      if (bot.wantBelt) this.fire.throwBelt(bot);
      if (bot.wantDeploy) this.tryDeploy(bot);
      this.fire.tryPropel(bot, !!shot);
    }
    if (shot) this.sheep.markShot(bot.playerId);
    // "Ignoring" means a sustained refusal to fire — volley cadence
    // legitimately goes ~2s between bursts, so a mid-fight gap isn't a
    // tell. Same 3s recency window the server meter uses.
    const ignoring = !shot && this.sheep.notShooting(bot.playerId);
    const hasDest = Math.hypot(bot.lastDest.x - bot.pos.x, bot.lastDest.z - bot.pos.z) >= 0.5;
    this.sheep.tick(bot, acc, terrain, this.senses.foeSeen(bot, foes, terrain), ignoring, hasDest);
  }

  // Per-bot persistent think ctx — the literal was a fresh ~1KB object
  // (plus two sense arrays) per bot per frame; the brain consumes it
  // synchronously so reusing the same record is safe.
  private ctxCache = new Map<string, Parameters<GameBot['think']>[1]>();

  /** One brain ctx per bot per tick — every sense the server feeds its
   *  brains (objective+infiltrating, huntCreatures, hearing, dodge) has
   *  a client-side mirror here. */
  private ctxFor(bot: GameBot, enemies: Parameters<GameBot['think']>[1]['enemies'], others: THREE.Vector3[], terrain: Terrain): Parameters<GameBot['think']>[1] {
    const info = this.ctf?.objectiveInfoFor(bot);
    let ctx = this.ctxCache.get(bot.playerId);
    if (!ctx) {
      ctx = {
        terrain, enemies: [], nugget: null, objective: null,
        infiltrating: false, thief: null, huntCreatures: false,
        others: [], allies: undefined, engageRange: undefined,
        sounds: [], threats: [],
      };
      this.ctxCache.set(bot.playerId, ctx);
    }
    ctx.terrain = terrain;
    ctx.enemies = enemies;
    ctx.nugget = this.spec.flags ? null : this.hooks.nearestNugget(bot.position, 60);
    ctx.objective = info?.pos ?? null;
    ctx.infiltrating = info?.infiltrating ?? false;
    ctx.thief = info?.thief ? { id: info.thief.id, pos: info.thief.pos, vel: info.thief.vel, alive: true } : null;
    // Nuggets rooms farm wildlife for the objective — the server
    // flips the same flag only in economy modes.
    ctx.huntCreatures = this.mode === 'nuggets';
    ctx.others = others;
    ctx.allies = this.alliesOf(bot);
    // Mortar heavies reach past the duel band — same reach rule the
    // server senses applies.
    ctx.engageRange = bot.loadout?.far === WeaponType.Mortar ? 95 : undefined;
    // Hearing: fresh blasts pull idle bots toward the action — the
    // same noisesNear sense the server feeds its brains.
    ctx.sounds = this.senses.recentNoises(bot.position);
    ctx.threats = this.senses.incomingNear(bot.position);
    return ctx;
  }

  /** Rally channel = live teammates (incl. the local player). Team
   *  modes have a real squad to fold onto; FFA passes nothing (there's
   *  nobody safe to run to — bot.team is its own playerId there). */
  private alliesOf(bot: GameBot): THREE.Vector3[] | undefined {
    if (bot.team !== 'alpha' && bot.team !== 'bravo') return undefined;
    // Reused scratch: think() consumes it synchronously before the next bot.
    const allies = _alliesScratch;
    allies.length = 0;
    const player = this.deps.lazyPlayer();
    if (this.playerTeam === bot.team && !player.isDead) allies.push(player.pos);
    for (const b of this.bots) if (b !== bot && !b.isDead && b.team === bot.team) allies.push(b.position);
    return allies;
  }

  /** Sheep meter accrual — fills while the bot moves like a pedestrian
   *  (slow, grounded, or parked), drains while it's doing Tribes things
   *  (covering ground, airborne, jetting). At 100 it clamps — a
   *  readout for the badge, not a punish lever. */
  // Coverage window — mirrors BotSheepMeter.coverageDebit on the wire:
  // under ~30m of real displacement per 5s while the brain claims a
  // destination reads as sheeping even when per-tick speed squeaks by.
  /** Terrain swapped under the roster — re-seat every live bot on the
   *  spawn ring near the player without touching hp/meters/loadout. */
  reseatAll(): void {
    const player = this.deps.lazyPlayer();
    const terrain = this.deps.lazyTerrain();
    for (const bot of this.bots) {
      if (bot.isDead) continue;
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 40;
      const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
      sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
      // respawn() clears the interp state a teleport needs; it doesn't
      // touch hp or meters so it doubles as a quiet re-seat.
      bot.respawn(sp);
    }
  }

  /** The player's live team is world.localTeam — a connected room can
   *  re-seat you on bravo after the boot-time alpha. teamOf must follow
   *  or the bots' friend/foe reads the WRONG side of the scoreboard.
   *  And if the flip lands you on the 5-bot side, a bot crosses over:
   *  the match is authored as you+4 vs 5 either way. */
  // Bots failing silently is the recurring bug class — the watchdog
  // diffs logic vs render motion; see botWatchdog.ts. Assigned in the
  // ctor: param props aren't visible to field initializers.
  private wd: BotWatchdog;

  respawnBot(bot: GameBot): void { respawnBotF(this, bot); } // public — botMatch's resetMatch calls it


  /** Match over → wipe scores, flags home. Rounds are seamless: live
   *  bots keep their ground (hp/meters refilled), only the dead come
   *  back through the spawn ring — teleporting a healthy squad reads
   *  as a glitch, not a new match. */
  /** DM kill credit — a player/bot frag vs a creature frag. */
  creditKill(id: string, isCreature: boolean): void {
    creditKill(this, id, isCreature);
  }

  /** Builder bots plant — the brain picked kind+spot, the deployables
   *  pipeline owns the pod+item (mirrors the server's handleDeploy). */
  private tryDeploy(bot: GameBot): void {
    const want = bot.wantDeploy;
    if (!want) return;
    bot.wantDeploy = null;
    if (want.kind !== 'turret' && want.kind !== 'mine' && want.kind !== 'station' && want.kind !== 'drone') return;
    this.hooks.botDeploy?.(want.kind, want.pos, {
      id: bot.playerId,
      team: bot.team,
      pos: bot.position,
      yaw: () => bot.rotation.yaw,
      heal: (n) => bot.heal(n),
      addEnergy: (n) => bot.addEnergy(n),
    });
  }

  /** Bots hostile to the LOCAL player — the deployable turret's target
   *  list. Enemy-team members in team modes, everyone in FFA. */
  enemyBotsForLocal(): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    return this.senses.enemyBotsForLocal();
  }

  /** Players hostile to a GIVEN team — bot-owned turrets/mines scan
   *  these: enemy bots AND the local player on the other side. */
  enemyBotsForTeam(team: string): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    return this.senses.enemyBotsForTeam(team);
  }

  /** Player/explosion damage routed here when the victim is a bot —
   *  combat consults `hit` before predictDamage. A bot shell can also
   *  hit 'local' (sweepLocal) — that resolves through the same funnel. */
  hit(playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local', weapon?: number): boolean {
    return hitF(this, playerId, dmg, fromPos, attackerId, weapon);
  }

  /** DM: local player's creature kill — combat calls this from
   *  onTargetDestroyed via the botKilled path for creature credit. */
  creatureKilled(attackerId: string): void {
    this.creditKill(attackerId, true);
  }

  /** The local player died (any mode) — release a carried flag. */
  localDied(): void {
    this.ctf?.dropCarried('local', this.deps.lazyPlayer().pos);
  }


  /** A nugget was collected by 'local' or a bot id — bank it for the team. */
  collect(collectorId: string): void {
    collect(this, collectorId);
  }

  /** Per-id perk mods — 'local' reads the live player. */
  private modsFor(id: string) {
    return id === 'local' ? this.deps.lazyPlayer().mods : this.bots.find(b => b.playerId === id)?.perkMods;
  }

  collectors(): { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] {
    _collectors.length = 0;
    const p = this.deps.lazyPlayer();
    _collectors.push({ id: 'local', pos: p.pos, alive: !p.isDead, pickupScale: p.mods.pickupRadius });
    for (const b of this.bots) _collectors.push({ id: b.playerId, pos: b.position, alive: !b.isDead, pickupScale: b.perkMods.pickupRadius });
    return _collectors;
  }

  private pushScore(): void {
    pushScore(this);
  }

  dispose(): void {
    for (const b of this.bots) this.deps.world.remotePlayers.remove(b.playerId);
    this.bots.length = 0;
    this.fire.dispose();
  }
}

const _collectors: { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] = [];
const _alliesScratch: THREE.Vector3[] = [];
// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return m.deps; }
