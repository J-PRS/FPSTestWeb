import * as THREE from 'three';

import { GameBot, EYE } from './botBrain.js';
import { BotWatchdog } from './botWatchdog.js';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.js';
import { WeaponType } from '../../../shared/weapons.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { TEAM_COLORS, TEAM_LABEL, MODES, bank, makeScores, type TeamId, type TeamScores, type ModeId } from '../../../shared/teams.js';
import { PlayerDebris } from '../effects/debris.js';
import type { Terrain } from '../world/terrain.js';
import { CtfBridge } from './botCtf.js';
import * as sfx from '../core/sfx.js';
import { killTaunt, deathTaunt } from '../../../shared/botTaunts.js';
import { chatSink } from './chat.js';
import { noteKill } from '../core/stateDebug.js';
import { BotSenses } from './botSenses.js';
import { BotFire } from './botFire.js';

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

  private ctf: CtfBridge | null = null;
  private senses: BotSenses;
  private fire: BotFire;

  constructor(
    readonly deps: BotsDeps,
    private hooks: BotHooks,
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
      botKilled: (k, b) => this.botKilled(k, b),
      hurtLocal: (d, fp, src, m, att) => this.hurtLocal(d, fp, src, m, att),
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
        onCapture: () => this.pushScore(),
        onFeed: (t) => this.hooks.remoteKillFeed(t),
      });
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
    this.ctf?.update(dt);
    this.wd.step(dt, this.bots);
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
    this.fire.tickBolts(dt); // frame-rate, not per-bot — it was over-integrating in the loop
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
      const foes = this.senses.enemyList(bot);
      const shot = bot.think(dt, this.ctxFor(bot, foes, others, terrain));
      if (this.over) { this.sheepTick(bot, dt, terrain); continue; }
      if (shot) this.fire.resolveShot(bot, shot.targetId, shot.aim);
      // Belt + propel are real-spawn actions — offline only, same gate
      // as resolveShot (a connected room's wire remotes can't attribute).
      const online = this.deps.lazyNetworkManager?.()?.isConnected() ?? false;
      if (!online) {
        if (bot.wantBelt) this.fire.throwBelt(bot);
        if (bot.wantDeploy) this.tryDeploy(bot);
        this.fire.tryPropel(bot, !!shot);
      }
      const hasDest = Math.hypot(bot.lastDest.x - bot.pos.x, bot.lastDest.z - bot.pos.z) >= 0.5;
      this.sheepTick(bot, dt, terrain, this.senses.foeSeen(bot, foes, terrain), !shot, hasDest);
    }
  }

  /** One brain ctx per bot per tick — every sense the server feeds its
   *  brains (objective+infiltrating, huntCreatures, hearing, dodge) has
   *  a client-side mirror here. */
  private ctxFor(bot: GameBot, enemies: Parameters<GameBot['think']>[1]['enemies'], others: THREE.Vector3[], terrain: Terrain): Parameters<GameBot['think']>[1] {
    const info = this.ctf?.objectiveInfoFor(bot);
    return {
      terrain,
      enemies,
      nugget: this.spec.flags ? null : this.hooks.nearestNugget(bot.position, 60),
      objective: info?.pos ?? null,
      infiltrating: info?.infiltrating ?? false,
      // Nuggets rooms farm wildlife for the objective — the server
      // flips the same flag only in economy modes.
      huntCreatures: this.mode === 'nuggets',
      others,
      // Hearing: fresh blasts pull idle bots toward the action — the
      // same noisesNear sense the server feeds its brains.
      sounds: this.senses.recentNoises(bot.position),
      threats: this.senses.incomingNear(bot.position),
    };
  }

  /** Sheep meter accrual — fills while the bot moves like a pedestrian
   *  (slow, grounded, or parked), drains while it's doing Tribes things
   *  (covering ground, airborne, jetting). At 100 it gets yeeted: jump+
   *  jets pinned as inputs, exactly the keys a player would hold. */
  // Coverage window — mirrors BotSheepMeter.coverageDebit on the wire:
  // under ~30m of real displacement per 5s while the brain claims a
  // destination reads as sheeping even when per-tick speed squeaks by.
  // Windows run on sim dt, not wall clock — a throttled frame would
  // otherwise mis-measure the distance.
  private sheepCov = new Map<string, { start: number; dist: number; lx: number; lz: number }>();
  private sheepSimMs = 0;

  private coverageDebit(bot: GameBot, hasDest: boolean): number {
    const now = this.sheepSimMs;
    let w = this.sheepCov.get(bot.playerId);
    if (!w) { w = { start: now, dist: 0, lx: bot.pos.x, lz: bot.pos.z }; this.sheepCov.set(bot.playerId, w); }
    w.dist += Math.hypot(bot.pos.x - w.lx, bot.pos.z - w.lz);
    w.lx = bot.pos.x; w.lz = bot.pos.z;
    if (now - w.start < 5000) return 0;
    const owed = hasDest && w.dist < 30 ? 20 : 0;
    w.start = now; w.dist = 0;
    return owed;
  }

  private sheepTick(bot: GameBot, dt: number, terrain: Terrain, foe = false, ignoring = false, hasDest = false): void {
    this.sheepSimMs += dt * 1000;
    const v = bot.vel;
    const speedXZ = Math.hypot(v.x, v.z);
    const grounded = bot.pos.y - terrain.getHeight(bot.pos.x, bot.pos.z) < 2;
    const tribesing = speedXZ > 10 || !grounded || bot.yeetT > 0;
    const moving = speedXZ > 1;
    // Rates mirror the server meter — a bot offline is held to the same
    // standard it is on the wire.
    let delta = tribesing ? -(10 + speedXZ * 0.5 + (bot.yeetT > 0 ? 15 : 0)) : moving ? 9 : 18;
    // Parked within reach of a visible enemy and holding fire — the
    // fastest tell. Only counts while NOT tribesing: a bot that's
    // skiing or repositioning is playing even with its finger off.
    if (foe && ignoring && !tribesing) delta += 40;
    if (!tribesing) bot.sheep += this.coverageDebit(bot, hasDest);
    bot.sheep = Math.max(0, Math.min(100, bot.sheep + delta * dt));
    // ~2s trailing average for display — the raw meter jitters ±10/s
    // around the fill/drain boundary, which reads as flicker.
    bot.sheepShown += (bot.sheep - bot.sheepShown) * Math.min(1, dt * 0.5);
    if (bot.sheep >= 100) {
      // Post-yeet the meter lands at 40 like the server — otherwise the
      // pinned jet ends inside a still-full meter and re-yeets forever.
      bot.sheep = 40;
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

  // Bots failing silently is the recurring bug class — the watchdog
  // diffs logic vs render motion; see botWatchdog.ts. Assigned in the
  // ctor: param props aren't visible to field initializers.
  private wd: BotWatchdog;

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

  /** Match over → wipe scores, flags home. Rounds are seamless: live
   *  bots keep their ground (hp/meters refilled), only the dead come
   *  back through the spawn ring — teleporting a healthy squad reads
   *  as a glitch, not a new match. */
  private resetMatch(): void {
    this.over = null;
    this.scores.alpha = 0; this.scores.bravo = 0;
    for (const k of this.ffaScores.keys()) this.ffaScores.set(k, 0);
    for (const bot of this.bots) {
      bot.carryingFlag = false;
      if (bot.isDead) this.respawnBot(bot);
      else {
        bot.botHp = bot.botMaxHp;
        bot.sheep = 0;
        bot.sheepShown = 0;
        bot.yeetT = 0;
      }
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

  /** Shared local-hit funnel: trigger-time claims and real bot-shell
   *  impacts land here — damage, knockback, death feed + credit. */
  private hurtLocal(dmg: number, fromPos: THREE.Vector3, src: string, melee: boolean, attackerId: string, weapon?: number): void {
    const p = this.deps.lazyPlayer();
    if (p.isDead) return;
    p.health = Math.max(0, p.health - dmg);
    p.lastDamageSource = src;
    p.applyKnockback(fromPos, melee ? 6 : 4);
    this.deps.lazyHud().showDamage(fromPos, dmg);
    sfx.playerHurt();
    if (p.health > 0) return;
    this.deps.world.killCounts.set(attackerId, (this.deps.world.killCounts.get(attackerId) ?? 0) + 1);
    this.creditKill(attackerId, false);
    this.localDied();
    noteKill(attackerId, 'local', weapon ?? (melee ? WeaponType.Melee : undefined));
    this.hooks.killFeed(attackerId.replace('bot:', ''), 'YOU', false, true);
    this.botSay(attackerId, killTaunt(attackerId, 'YOU'));
    this.hooks.localPlayerKilled(attackerId.replace('bot:', ''));
  }

  /** Player/explosion damage routed here when the victim is a bot —
   *  combat consults `hit` before predictDamage. A bot shell can also
   *  hit 'local' (sweepLocal) — that resolves through the same funnel. */
  hit(playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local', weapon?: number): boolean {
    if (playerId === 'local') {
      this.hurtLocal(dmg, fromPos, attackerId.replace('bot:', ''), false, attackerId, weapon);
      return true;
    }
    const rp = this.deps.world.remotePlayers.get(playerId);
    if (!(rp instanceof GameBot)) return false;
    const died = rp.takeDamageLocal(dmg, fromPos);
    this.deps.lazyHealthBarSystem().spawn(playerId, dmg, died ? 0 : rp.botHp);
    if (died) this.botKilled(attackerId, rp, weapon);
    return true;
  }

  /** A bot's line lands a beat after the frag like a typed reply — the
   *  same delay envelope the server killfeed uses over the wire. */
  private botSay(id: string, line: string | null): void {
    if (!line) return;
    const name = id.replace('bot:', '');
    setTimeout(() => chatSink.add?.(name, line), 1200 + Math.random() * 1800);
  }

  private botKilled(killerId: string, bot: GameBot, weapon?: number): void {
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
    this.ctf?.dropCarried(bot.playerId, bot.position);
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    noteKill(killerId === 'local' ? 'local' : killerId, bot.playerId, weapon);
    this.hooks.killFeed(kn, bot.playerId.replace('bot:', ''), killerId === 'local', false);
    if (killerId !== 'local') this.botSay(killerId, killTaunt(killerId, kn));
    this.botSay(bot.playerId, deathTaunt(bot.playerId, kn));
    if (killerId === 'local') sfx.killConfirm();
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
    if (this.spec.ffa || this.over) return; // dm: nuggets heal, don't score
    // Networked matches score through server-owned gems (RoomPickups
    // touch) — the teamScore echo is the truth; this local board is the
    // offline path's own scoreboard.
    const team = this.teamOf.get(collectorId) as TeamId | undefined;
    if (!team) return;
    bank(this.scores, team);
    this.pushScore();
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
    this.deps.lazyHud().setTeamScore?.(this.scores.alpha, this.scores.bravo);
  }

  dispose(): void {
    for (const b of this.bots) this.deps.world.remotePlayers.remove(b.playerId);
    this.bots.length = 0;
    this.fire.dispose();
  }
}

const _collectors: { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] = [];
// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return m.deps; }
