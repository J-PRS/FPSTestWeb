import * as THREE from 'three';

import { GameBot, BOT_DMG, EYE } from './botBrain.js';
import { BotWatchdog } from './botWatchdog.js';
import { BOT_LOADOUTS, pickBotWeapon } from '../../../shared/botLoadouts.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { Projectile } from '../projectiles/Projectile.js';
import { SLOT_DEFS } from '../weapons.js';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.js';
import { GRAVITY } from '../../../shared/movement.js';
import type { Nugget } from '../entities/Nugget.js';
import type { Targetable } from '../entities/balls.js';
import type { GameContext } from './context.js';
import { TEAM_COLORS, TEAM_LABEL, MODES, bank, makeScores, FLAG_PICKUP_R, type TeamId, type TeamScores, type ModeId } from '../../../shared/teams.js';
import { PlayerDebris } from '../effects/debris.js';
import type { Terrain } from '../world/terrain.js';
import { MELEE_RANGE, MELEE_DAMAGE } from '../core/config.js';
import { CtfFlags } from './ctfFlags.js';
import { Explosion } from '../effects/explosion.js';
import * as sfx from '../core/sfx.js';
import { poissonDisc } from '../utils/poissonSpread.js';
import { killTaunt, deathTaunt } from '../../../shared/botTaunts.js';
import { chatSink } from './chat.js';
import { noteKill } from '../core/stateDebug.js';
import { BotSenses } from './botSenses.js';

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

  private ctf: CtfFlags | null = null;
  private senses: BotSenses;

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
      this.ctf = new CtfFlags({
        lazyTerrain: deps.lazyTerrain,
        lazyScene: deps.lazyScene,
        carrierPos: (id) => this.carrierPos(id),
        teamOf: (id) => this.teamOf.get(id),
        pickupRadiusOf: (id) => FLAG_PICKUP_R * (this.modsFor(id)?.pickupRadius ?? 1),
        touchers: () => this.touchers(),
        bots: this.bots,
        scores: this.scores,
        onCapture: () => this.pushScore(),
        onFeed: (t) => this.hooks.remoteKillFeed(t),
        onFlagEvent: (kind, team, at) => {
          sfx.flagCue(kind, team === this.playerTeam);
          deps.world.explosions.push(new Explosion(
            deps.lazyScene(), _flagBurst.copy(at).setY(at.y + 1.2), false, 0,
            deps.lazyTerrain(), kind === 'captured' ? 2.4 : kind === 'dropped' ? 1.0 : 1.4,
            TEAM_COLORS[team]));
        },
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
      const foes = this.senses.enemyList(bot);
      const shot = bot.think(dt, this.ctxFor(bot, foes, others, terrain));
      if (this.over) { this.sheepTick(bot, dt, terrain); continue; }
      if (shot) this.resolveShot(bot, shot.targetId, shot.aim);
      // Belt + propel are real-spawn actions — offline only, same gate
      // as resolveShot (a connected room's wire remotes can't attribute).
      const online = this.deps.lazyNetworkManager?.()?.isConnected() ?? false;
      if (!online) {
        if (bot.wantBelt) this.throwBelt(bot);
        if (bot.wantDeploy) this.tryDeploy(bot);
        this.tryPropel(bot, !!shot);
      }
      this.sheepTick(bot, dt, terrain, this.senses.foeSeen(bot, foes, terrain), !shot);
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
   *  (covering ground, airborne, jetting). At 100 it gets yeeted: an
   *  impulse launch that forces the behavior the meter wants. */
  private sheepTick(bot: GameBot, dt: number, terrain: Terrain, foe = false, ignoring = false): void {
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

  /** Resolve a bot's shot. Range-band pick comes from the shared loadout
   *  roster; the trigger pull then spawns a REAL projectile — same sweep
   *  + blast pipeline as the player's own shells, so travel time,
   *  gravity, splash, and misses are all honest. Only offline: in a
   *  connected room a shell landing on a WIRE remote would misattribute
   *  the claim to the local player — server bots own that case anyway. */
  private resolveShot(bot: GameBot, targetId: string, aim: THREE.Vector3): void {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const dx = aim.x - bot.position.x, dy = aim.y - bot.position.y, dz = aim.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const wt = pickBotWeapon(lo, Math.hypot(dx, dz), dist);
    const melee = wt === WeaponType.Melee || dist <= MELEE_RANGE;
    const cfg = melee ? undefined : getProjectileConfig(wt);
    const online = this.deps.lazyNetworkManager?.()?.isConnected() ?? false;

    if (melee || !cfg || cfg.speed <= 0 || online) {
      this.claimShot(bot, targetId, aim, melee, melee ? MELEE_DAMAGE : BOT_DMG);
      return;
    }
    this.spawnShells(bot, wt, cfg, dx / dist, dy / dist, dz / dist);
  }

  /** Real shells into the world projectile list — pellet weapons fan
   *  out per their def, everything else lobs a single round. */
  private spawnShells(bot: GameBot, wt: number, cfg: NonNullable<ReturnType<typeof getProjectileConfig>>, nx: number, ny: number, nz: number): void {
    const dir = _shotDir.set(nx, ny, nz);
    const muzzle = _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z);
    const pellets = SLOT_DEFS.find(w => w.weaponType === wt)?.pellets;
    for (const d of pelletDirs(dir, pellets?.count ?? 1, pellets?.spread ?? 0)) {
      // Perk mods the server folds in: bombardier widens the boom,
      // sharpshooter tightens it (damage scaling lands at claim time).
      const radius = cfg.aoeRadius * bot.perkMods.aoeRadius;
      const dmg = cfg.aoeDamage * bot.perkMods.directDamage;
      const p = new Projectile(this.deps.lazyScene(), muzzle, d, bot.vel,
        { ...cfg, aoeRadius: radius, aoeDamage: dmg, needsServerTracking: false });
      p.shooterId = bot.playerId;
      // 'local' isn't in remotePlayerPositions — this lets a bot shell
      // actually CONNECT with you instead of relying on a trigger-time claim.
      p.sweepLocal = () => {
        const pl = this.deps.lazyPlayer();
        return pl.isDead ? null : pl.pos;
      };
      this.deps.world.projectiles.push(p);
    }
    sfx.shoot(wt);
  }

  /** Live position of a brain hunt target — belt throws arc at it. */
  private targetPos(targetId: string | null): THREE.Vector3 | null {
    if (!targetId) return null;
    if (targetId === 'local') { const p = this.deps.lazyPlayer(); return p.isDead ? null : p.pos; }
    if (targetId.startsWith('creature:')) {
      const t = this.deps.targets.find(x => x.id === +targetId.slice(9));
      return t && !t.dead ? t.pos : null;
    }
    const rp = this.deps.world.remotePlayers.get(targetId);
    return rp && !rp.isDead ? rp.pos : null;
  }

  /** Belt throw — a lobbed grenade at the hunt's last-seen spot. Mirrors
   *  ServerBots.throwBelt: real projectile, ballistic pitch, 50% vel
   *  inheritance handled inside the Projectile ctor. */
  private throwBelt(bot: GameBot): void {
    bot.wantBelt = false;
    const aim = this.targetPos(bot.huntTargetId);
    if (aim) this.lobAt(bot, aim);
  }

  /** Lob the belt weapon at an explicit point — ballistic arc solves
   *  θ from the target's range instead of a flat guess. */
  private lobAt(bot: GameBot, aim: { x: number; y: number; z: number }): void {
    const wt = bot.loadout?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    const cfg = getProjectileConfig(wt);
    if (!stats || stats.speed <= 0 || !cfg) return;
    const dx = aim.x - bot.position.x, dz = aim.z - bot.position.z;
    const d = Math.hypot(dx, dz) || 1;
    let pitch: number;
    if (stats.rayDelay) {
      pitch = 0.15;
    } else {
      const g = Math.abs(GRAVITY);
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    // The ctor inherits half the bot's velocity — steer the launch
    // against the carry the same way the server does.
    const vx = (dir.x / len) * stats.speed - bot.vel.x * 0.5;
    const vy = (dir.y / len) * stats.speed - bot.vel.y * 0.5;
    const vz = (dir.z / len) * stats.speed - bot.vel.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const p = new Projectile(this.deps.lazyScene(),
      _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z),
      _shotDir.set(vx / vl, vy / vl, vz / vl), bot.vel,
      { ...cfg, aoeRadius: cfg.aoeRadius * bot.perkMods.aoeRadius,
        aoeDamage: cfg.aoeDamage * bot.perkMods.directDamage,
        needsServerTracking: false });
    p.shooterId = bot.playerId;
    p.sweepLocal = () => { const pl = this.deps.lazyPlayer(); return pl.isDead ? null : pl.pos; };
    this.deps.world.projectiles.push(p);
    sfx.shoot(wt);
  }

  /** First push-class AOE weapon in the kit — pull weapons would drag
   *  the bot toward its own feet. */
  private propelWeapon(bot: GameBot): number {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const pick = [lo.mid, lo.far].find((wt) => {
      const s = getWeaponStats(wt);
      return s && s.aoeRadius > 0 && s.speed > 0 && s.forceMode !== 'pull';
    });
    return pick ?? WeaponType.Disc;
  }

  /** Disc-jump / implosion ride — a grounded bot starting a long open
   *  run detonates an explosive at its heels and surfs the blast (or
   *  lobs a pull-belt implosion ahead and rides the drag). Same gates
   *  as ServerBots.tryPropel: long run, low speed, fuel for the climb,
   *  never mid-firefight. */
  private tryPropel(bot: GameBot, firing: boolean): void {
    const now = performance.now();
    if (firing || !bot.grounded || bot.propelUntil > now) return;
    const dx = bot.lastDest.x - bot.position.x, dz = bot.lastDest.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 35) return;
    const v = bot.vel;
    if (Math.hypot(v.x, v.z) > 12) return; // already moving — boost is for launches
    if (bot.energy < 30) return;
    const nx = dx / dist, nz = dz / dist;
    if (getWeaponStats(bot.loadout?.belt)?.forceMode === 'pull') {
      this.lobAt(bot, { x: bot.position.x + nx * 18, y: bot.position.y - 1, z: bot.position.z + nz * 18 });
    } else {
      const wt = this.propelWeapon(bot);
      const cfg = getProjectileConfig(wt);
      if (cfg && cfg.speed > 0) {
        const mx = bot.position.x, my = bot.position.y + 1.4, mz = bot.position.z;
        const hx = bot.position.x - nx * 1.8 - mx;
        const hy = bot.position.y - 1.8 - my;
        const hz = bot.position.z - nz * 1.8 - mz;
        const len = Math.hypot(hx, hy, hz) || 1;
        const p = new Projectile(this.deps.lazyScene(),
          _shotMuzzle.set(mx, my, mz), _shotDir.set(hx / len, hy / len, hz / len), bot.vel,
          { ...cfg, needsServerTracking: false });
        p.shooterId = bot.playerId;
        this.deps.world.projectiles.push(p);
        sfx.shoot(wt);
      }
    }
    bot.propelUntil = now + 8000;
    bot.propelJetT = 0.9; // ride the shove skyward like a real disc-jump
    this.deps.logger.debug(`bot ${bot.playerId} propel`);
  }

  /** Instant-claim resolution: melee, beams, and connected rooms where
   *  local shells can't own the attribution. */
  private claimShot(bot: GameBot, targetId: string, aim: THREE.Vector3, melee: boolean, dmg: number): void {
    if (!melee) this.spawnBolt(bot.position, aim);
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
    this.hurtLocal(dmg, bot.position, src, melee, bot.playerId);
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
    this.dropCarriedFlag(bot.playerId, bot.position);
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
const _collectors: { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] = [];
const _flagBurst = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _shotMuzzle = new THREE.Vector3();
const _pelletRight = new THREE.Vector3();
const _pelletUp = new THREE.Vector3();
const _pelletUp0 = new THREE.Vector3(0, 1, 0);

/** Pellet fan for flak/shotgun bots — one random cone dir per pellet;
 *  count 1 collapses to a single straight shot. */
function pelletDirs(dir: THREE.Vector3, count: number, spread: number): THREE.Vector3[] {
  if (count <= 1 || spread <= 0) return [dir.clone()];
  _pelletRight.crossVectors(dir, _pelletUp0);
  if (_pelletRight.lengthSq() < 1e-8) _pelletRight.set(1, 0, 0); else _pelletRight.normalize();
  _pelletUp.crossVectors(_pelletRight, dir);
  const rot = Math.random() * Math.PI * 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return poissonDisc(count).map(pt => {
    const ox = (pt.x * cs - pt.y * sn) * spread;
    const oy = (pt.x * sn + pt.y * cs) * spread;
    return dir.clone().addScaledVector(_pelletRight, ox).addScaledVector(_pelletUp, oy).normalize();
  });
}
const BOLT_MAT = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });

// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots) { return m.deps; }
