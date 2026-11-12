import * as THREE from 'three';

import { GameBot, EYE } from './botBrain.js';
import { BotWatchdog } from './botWatchdog.js';
import { SheepMeter } from './botSheep.js';
import { BOT_LOADOUTS, BOT_ALT_SLOTS, WILDCARD_SLOTS, botClassForLoadout, rollWildcard, rollBotPerk, type BotLoadout } from '../../../../shared/botLoadouts.js';
import { botRand } from '../../../../shared/botRand.js';
import { WeaponType } from '../../../../shared/weapons.js';
import { gunGameWeapon, igunChassis } from '../../../../shared/gunGame.js';
import { ENERGY } from '../../../../shared/movement.js';
import type { Nugget } from '../../entities/Nugget.js';
import type { Targetable } from '../../entities/balls.js';
import type { GameContext } from '../context.js';
import { MODES, makeScores, type TeamId, type TeamScores, type ModeId } from '../../../../shared/teams.js';
import type { Terrain } from '../../world/terrain.js';
import { CtfBridge } from './botCtf.js';
import { RabbitBridge } from './botRabbit.js';
import { FlagRunBridge } from '../flagRun.js';
import * as sfx from '../../core/sfx.js';
import { BotSenses, type BotEntry } from './botSenses.js';
import { BotFire } from './botFire.js';
import { respawnBotF, hitF, hurtLocal, botKilledF, botSay, botSayDrain } from './botKill.js';
import { chatter, chatKindFor, vgsCommandFor, radioAimFor, type ChatterKind } from '../../../../shared/botTaunts.js';
import { RoomNoticer } from '../../../../shared/roomNoticer.js';
import { winText, checkWin, clockWin, resetMatch, creditKill, creditDamage, collect, pushScore, syncLocalTeam, syncHeld, awardPersonal } from './botMatch.js';
import { decomposeTokens, heldBuffRates, type PickupKind } from '../../../../shared/pickups.js';
import { simRand } from '../../../../shared/simRand.js';

/**
 * TeamBots - the mode referee. Bot brains/bodies live in botBrain.ts;
 * this file owns roster, scoring, damage authority, and the CTF flags.
 * Nugget Wars bots - in-world fake players. A GameBot is a RemotePlayer
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

import { BOT_NAMES } from '../../../../shared/botNames.js';
import { CLASS_STATS, classCapsule, classMass, type ArmorClass } from '../../../../shared/botClasses.js';
import type { BodyCapsule } from '../../../../shared/movement.js';
import type { DeployOwner } from '../deployables.js';
import type { MapSpec } from '../../../../shared/mapSpec.js';

const _seedVel = new THREE.Vector3(); // seeded tokens drop in place

export interface BotsDeps extends GameContext {
  lazyScene(): THREE.Scene;
  lazyCamera(): THREE.Camera;
  lazyHealthBarSystem(): { spawn(id: string, dmg: number, hp: number): void };
  /** Live creature list — bots fight these too. */
  targets: Targetable[];
}

interface BotHooks {
  /** Drop pickups where a bot died (entities owns the nugget factory). */
  dropNuggets(pos: THREE.Vector3, n: number, inheritVel: THREE.Vector3, kind?: PickupKind, val?: number): void;
  /** Local player died to a bot — mirrors netHandlers' kill path. */
  localPlayerKilled(killerName: string): void;
  /** Match announcements — win banners, NEW MATCH, flag grabs. Center-screen. */
  remoteKillFeed(text: string): void;
  /** YOUR frag — mid-tier center line (FragMessages.showKill). A frag is
   *  below a flag grab/death in hierarchy; it doesn't get the red slab. */
  fragBanner?(text: string): void;
  /** A kill happened — CS-style killfeed row in the corner, not the
   *  center banner (that's reserved for YOUR frags/deaths). */
  killFeed(shooter: string, victim: string, localIsShooter: boolean, localIsVictim: boolean,
    meta?: { shooter?: string; target?: string; weapon?: number; air?: number }): void;
  /** Find nearest nugget to a position. */
  nearestNugget(pos: THREE.Vector3, maxDist: number): Nugget | null;
  /** Nearest hostile creature (targets list entry) for a bot to fight. */
  nearestCreature(pos: THREE.Vector3, maxDist: number): Targetable | null;
  /** This map spawns real (scored) creatures — mirrors the server's
   *  creatureSim.pops check for huntCreatures. */
  hasCreatures(): boolean;
  /** A bot's bolt connected with a creature — damage through the entity.
   *  Returns true on kill (DM credits the bot). */
  damageCreature(id: number, dmg: number, attackerId: string): boolean;
  /** A builder bot wants to plant — owner wrapper keeps the item's foes,
   *  anchors, and heals pointed at the bot, not the local player. */
  botDeploy?(kind: string, pos: { x: number; y: number; z: number }, owner: DeployOwner): void;
  /** Damaged friendly deployable the bot could weld — mirrors the
   *  server senses' repairJob scan (nearest within ~45m). */
  botRepairJob?(team: string, pos: THREE.Vector3, botId: string): { key: string; pos: THREE.Vector3; frac: number } | null;
  /** Apply a weld tick — returns true while the item still exists. */
  botWeld?(key: string): boolean;
  /** Nearest hostile emplacement the bot could shell — mirrors the
   *  server senses' hostileGear scan. */
  hostileGear?(team: string | undefined, pos: THREE.Vector3, range: number): { pos: THREE.Vector3; kind: string } | null;
}
// Small accessor so update() reads deps once per frame.
function deps0(m: TeamBots): BotsDeps { return m.deps; }



export class TeamBots {
  readonly bots: GameBot[] = [];
  readonly scores: TeamScores = makeScores();
  readonly teamOf = new Map<string, string>(); // 'local' + bot:names → team key
  /** FFA scores (dm): per playerId. Team modes use `scores`. */
  readonly ffaScores = new Map<string, number>();
  readonly dmgPool = new Map<string, number>(); // CTF damage-economy remainder
  over: string | null = null;
  /** Match-clock origin — headhunt resolves by timeLimitS, not a bank. */
  matchStart = performance.now();
  readonly spec: (typeof MODES)[ModeId];

  // Public — botMatch.ts (the match referee) reads/resets flags through it.
  ctf: CtfBridge | null = null;
  /** Single neutral flag + carrier gate — offline mirror of the
   *  server's rabbit rules (botRabbit.ts owns flag state + scoring). */
  rabbit: RabbitBridge | null = null;
  /** Solo cap circuit — flagrun's own ruleset (any-stand cap, lap
   *  timing), not the two-team CtfBridge referee. */
  flagrun: FlagRunBridge | null = null;
  /** Solo conquest module — owns the lattice when mode is conquest;
   *  minted by setupOfflineMode after construction. */
  conquest: { objectiveInfoFor(bot: GameBot): { pos: THREE.Vector3; infiltrating: boolean } | null; reset?(): void } | null = null;
  /** Node-linked spawn rings — the conquest sim's setSpawns lands here;
   *  spawnSpot consults them before the authored spec pools. */
  nodeSpawns: Record<TeamId, { x: number; y: number; z: number; r: number }[]> | null = null;
  /** Conquest core kill = match end — the update win check reads this
   *  before checkWin (node counts never reach the 999 winAt). */
  conquestWin: string | null = null;
  private senses: BotSenses;
  private readonly notices = new RoomNoticer();
  private fire: BotFire;
  // Anti-pedestrian meter (idle/ignore/bleed/coverage) lives in
  // botSheep.ts — rates mirror the server meter.
  sheep = new SheepMeter({ warn: (m): void => this.deps.logger.warn(m) });

  constructor(
    readonly deps: BotsDeps,
    readonly hooks: BotHooks,
    private playerTeam: string,
    counts: { alpha: number; bravo: number },
    readonly mode: ModeId,
    /** Solo map spec (maps/<X>.json resolved client-side) — feeds flag
     *  homes and authored spawn anchors; absent = the old around-player
     *  ±70m default bases. */
    private mapSpec?: MapSpec,
  ) {
    this.spec = MODES[mode]; // param props assign after field inits — do it here
    this.deps.world.mode = mode; // wire rooms set this on gameState; offline must too (scoreboard title)
    this.senses = new BotSenses({
      bots: this.bots,
      teamOf: this.teamOf,
      player: () => this.deps.lazyPlayer(),
      world: () => this.deps.world,
      mode: (): ModeId => this.mode,
      targets: this.deps.targets,
    });
    this.fire = new BotFire({
      scene: (): THREE.Scene<THREE.Object3DEventMap> => this.deps.lazyScene(),
      player: () => this.deps.lazyPlayer(),
      world: () => this.deps.world,
      targets: this.deps.targets,
      online: (): boolean => this.deps.lazyNetworkManager?.()?.isConnected() ?? false,
      logger: this.deps.logger,
      damageCreature: (id, dmg, att): boolean => this.hooks.damageCreature(id, dmg, att),
      creditKill: (id, cr): void => this.creditKill(id, cr),
      botKilled: (k, b, weapon): void => botKilledF(this, k, b, weapon),
      hurtLocal: (d, fp, src, m, att): void => hurtLocal(this, d, fp, att, { src, melee: m }),
    });
    this.wd = new BotWatchdog(deps.logger, (): boolean => this.over !== null);
    const {ffa} = this.spec;
    this.teamOf.set('local', ffa ? 'local' : playerTeam);
    if (ffa) {this.ffaScores.set('local', 0);}
    const player = deps.lazyPlayer();
    const terrain = deps.lazyTerrain();
    const scene = deps.lazyScene();
    let ni = 0;
    const mk = (team: TeamId, n: number): void => {
      for (let i = 0; i < n; i += 1) {
        const spawn = this.spawnSpot(team);
        const name = ffa ? BOT_NAMES[((ni += 1) - 1) % BOT_NAMES.length] : `${BOT_NAMES[((ni += 1) - 1) % BOT_NAMES.length]}-${team === 'alpha' ? 'A' : 'B'}`;
        // Same roster the dedicated server fields — loadout picks the
        // weapon by engagement range instead of one generic bolt, and
        // the kit picks the body (botClassForLoadout) so the class gate
        // never arms an offline bot with contraband guns.
        const kitIdx = (ni - 1) % BOT_LOADOUTS.length;
        const wildcard = botRand() < 0.125;
        const base = wildcard ? rollWildcard(botRand) : BOT_LOADOUTS[kitIdx]!;
        // Same perk roll the server roster makes - kit fields weapons,
        // perk table fields the person; class derives after the roll.
        // Instagib rooms field the same forced kit the server roster does:
        // railgun everywhere, hook belt, light frame, no alternates to adapt into.
        const insta = deps.world.instagib;
        const gg = deps.world.gungame;
        const lo: BotLoadout = insta
          ? { perk: 'jumpstart', near: WeaponType.Railgun, mid: WeaponType.Railgun, far: WeaponType.Railgun, belt: WeaponType.Hook, side: WeaponType.Railgun }
          : gg
            // Gun game: rung 0 weapon in every slot, hook belt, no perk
            // force - skill/perk stay live picks like the server roster.
            ? { perk: rollBotPerk(base, botRand), near: gunGameWeapon(0, deps.world.igun === true), mid: gunGameWeapon(0, deps.world.igun === true), far: gunGameWeapon(0, deps.world.igun === true), side: gunGameWeapon(0, deps.world.igun === true), belt: WeaponType.Hook }
            : Object.assign({}, base, {perk: rollBotPerk(base, botRand)});
        const cls = insta ? 'light' : (deps.world.igun === true ? igunChassis(gunGameWeapon(0, true)) : botClassForLoadout(lo));
        const bot = new GameBot(scene, name, team === 'alpha' ? 'alpha' : 'bravo', spawn, terrain, cls);
        bot.setLoadout(lo);
        // Q-skill: same per-class pool the server roster rolls - lights
        // favor mobility teleports, heavies the dive/endurance.
        bot.skillId = insta ? 'blink'
          : cls === 'light' ? (botRand() < 0.6 ? 'blink' : 'dash')
          : cls === 'heavy' ? (botRand() < 0.5 ? 'slam' : 'medkit')
          : (['dash', 'bounce', 'warp', 'shield'] as const)[Math.floor(botRand() * 4)]!;
        bot.loadoutAlts = (insta || gg) ? {} : (wildcard ? WILDCARD_SLOTS : BOT_ALT_SLOTS[kitIdx]);
        // The spawn pick is skill-weighted, not flat — the brain's own
        // matrix rerolls every open slot toward what it hits with.
        if (!insta && !gg) {bot.adaptLoadout();}
        if (ffa) {
          // FFA pseudo-team = own id — everyone is everyone else's enemy.
          bot.team = bot.playerId;
          this.ffaScores.set(bot.playerId, 0);
        }
        // Debug hitbox tint matches the name-gizmo verdict — squadmates
        // green, everything else red (FFA pseudo-teams never match 'local').
        const friendly = bot.team === this.teamOf.get('local');
        bot.setColliderColor(friendly ? 0x00_FF_00 : 0xFF_33_33);
        // Same team marks remotes.ts applies per wire update - offline
        // bots have no wire path, so the roster does it (pending until
        // the GLB lands; setOutline/setRim defer on !model).
        bot.model.setOutline(friendly ? null : 0xF0_4A_4A);
        bot.model.setRim(friendly ? 0x44_CC_55 : 0xF0_4A_4A);
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
    // CtfBridge is a two-team sim — rabbit's single neutral flag has no
    // offline referee yet, so only team-flag modes wire it. flagrun owns
    // its flag circuit through FlagRunBridge instead.
    if (this.spec.flags && this.spec.teams && mode !== 'flagrun') {
      this.ctf = new CtfBridge(deps, {
        bots: this.bots,
        teamOf: this.teamOf,
        scores: this.scores,
        playerTeam: this.playerTeam as TeamId,
        modsFor: (id) => this.modsFor(id),
        onCapture: (): void => pushScore(this),
        onFeed: (t): void => this.hooks.remoteKillFeed(t),
        onPersonalPoints: (id, n): void => awardPersonal(this, id, n),
        onFlagNotice: (kind, actorId, actorTeam, at): void =>
          // Grabs/drops pin the flag spot for the DEFENDING side — the
          // grabber's team already knows where their runner is.
          this.notice(kind, actorId, actorTeam,
            kind === 'flaggrab' || kind === 'flagdrop' ? at : undefined, 'other'),
        bases: this.mapSpec?.bases,
        structures: this.mapSpec?.structures,
      });
    }
    if (mode === 'rabbit') {
      this.rabbit = new RabbitBridge(deps, (t): void => this.hooks.remoteKillFeed(t));
    }
    if (mode === 'headhunt') {
      // Field seeding — the server mints tokens at spawn points; offline
      // has no RoomPickups, so scatter a ring of 1-coins around the local
      // spawn. Zero tokens on the field stays 0-0 to the horn.
      const terr = deps.lazyTerrain();
      for (let i = 0; i < 10; i += 1) {
        const a = simRand() * Math.PI * 2;
        const r = 25 + simRand() * 55;
        const sx = player.pos.x + Math.cos(a) * r, sz = player.pos.z + Math.sin(a) * r;
        const gy = terr.getHeight(sx, sz);
        this.hooks.dropNuggets(new THREE.Vector3(sx, (Number.isFinite(gy) ? gy : 0) + 1.5, sz), 1, _seedVel, 'token', 1);
      }
    }
    if (mode === 'flagrun') {
      this.flagrun = new FlagRunBridge(deps, {
        playerTeam: this.playerTeam as TeamId,
        bots: this.bots,
        teamOf: this.teamOf,
        scores: this.scores,
        onFeed: (t): void => this.hooks.remoteKillFeed(t),
        onCapture: (): void => pushScore(this),
      }, player.pos);
    }
  }

  // Rebuilt each frame but never reallocated — one ~10-slot array of
  // Vector3 refs per frame was steady GC churn for zero benefit.
  private readonly othersScratch: THREE.Vector3[] = [];
  // Contact capsules for the same live bodies — bodyblock physics reads
  // this (the steerer's separation sense reads the positions above).
  private readonly bodyScratch: BodyCapsule[] = [];

  /** Per-frame: brains, fire resolution, respawns, win check. */
  update(dt: number): void {
    const player = deps0(this).lazyPlayer();
    // Separation sense — every live body the steerer should keep space
    // from. A bot's own position reads as dist 0 and is skipped inside.
    const others = this.othersScratch;
    others.length = 0;
    for (const b of this.bots) {if (!b.isDead) {others.push(b.position);}}
    others.push(player.pos);
    const bodies = this.bodyScratch;
    // Pooled per index — length is only trimmed at the end, so entries
    // survive between frames and reuse kills ~3 allocs/bot/frame (the
    // literal plus classCapsule's fresh object per call).
    let bn = 0;
    for (const b of this.bots) {
      if (b.isDead) {continue;}
      const cap = classCapsule(b.armorClass);
      const e = bodies[bn] ?? (bodies[bn] = {} as BodyCapsule);
      e.id = b.playerId; e.x = b.position.x; e.y = b.position.y; e.z = b.position.z;
      e.h = cap.eye; e.mass = classMass(b.armorClass); e.r = cap.radius; e.vx = b.vel.x; e.vz = b.vel.z;
bn += 1;
    }
    const pst = CLASS_STATS[player.appliedClass];
    const le = bodies[bn] ?? (bodies[bn] = {} as BodyCapsule);
    le.id = 'local'; le.x = player.pos.x; le.y = player.pos.y; le.z = player.pos.z;
    le.h = pst.eyeHeight; le.mass = pst.mass; le.r = pst.radius; le.vx = player.vel.x; le.vz = player.vel.z;
bn += 1;
    bodies.length = bn;
    this.tickBots(dt, others, bodies);
    this.ctf?.update(dt);
    this.rabbit?.update(dt, this.collectors(), (id): THREE.Vector3 | null => this.posOf(id), (id): void => this.holdPoint(id));
    this.rabbit?.tickIndicator();
    this.flagrun?.update(dt);
    this.wd.step(dt, this.bots);
    syncLocalTeam(this);
    if (this.mode === 'headhunt') {this.headhuntBadges(); this.headhuntDrip(dt);}
    if (!this.over) {
      const w = this.conquestWin ?? clockWin(this) ?? checkWin(this);
      if (w) {
        this.over = w;
        this.hooks.remoteKillFeed(winText(this, w) + (this.flagrun?.statsLine() ?? ''));
        sfx.pickup();
        // Standings window — pin the board unless the player already
        // had it open, so auto-shown means auto-dismissed only.
        const hud = this.deps.lazyHud();
        hud.setScoreboardCountdown?.(10);
        if (!hud.scoreboardVisible) {
          hud.setScoreboardVisible?.(true);
          this.sbAutoShown = true;
        }
        this.notice('gg', 'match');
        this.overAt = performance.now();
      }
    } else if (performance.now() - this.overAt > 10_000) {
      this.deps.lazyHud().setScoreboardCountdown?.(null);
      if (this.sbAutoShown) {
        this.sbAutoShown = false;
        this.deps.lazyHud().setScoreboardVisible?.(false);
      }
      resetMatch(this);
    }
  }

  overAt = 0; // public — botMatch writes it via the host interface
  private sbAutoShown = false;

  /** Headhunt held-token crowns — the marker itself rides remotes.ts's
   *  local-bot lane (position + renderLift anchor, same as wire remotes);
   *  a second writer here flickered the chevron ~2m every frame. This
   *  pass now only syncs the crown count. */
  private headhuntBadges(): void {
    for (const b of this.bots) {b.setHeld(b.heldTokens);} // the crown is the pile
  }

  /** Per-bot think pass — interp tick, respawn countdown, brain, fire. */
  private tickBots(dt: number, others: THREE.Vector3[], bodies: BodyCapsule[]): void {
    const terrain = this.deps.lazyTerrain();
    this.fire.tickBolts(dt); // frame-rate, not per-bot — it was over-integrating in the loop
    // Sheep coverage windows run on sim ms advanced ONCE per frame —
    // doing it inside sheepTick scaled every 5s window by the roster
    // size (9 bots → windows fired ~9x too often, cover-dominated max-outs).
    this.sheep.advance(Math.min(dt, 1)); // stall frames can't bankroll idle windows
    let i = 0;
    for (const bot of this.bots) {this.tickBot(bot, dt, others, bodies, terrain, ((i += 1) - 1));}
  }

  // Think rate: brains decide at ~10Hz (staggered per bot so thinks
  // don't pile onto one frame), fed the real elapsed since the last
  // think — steering reads identically, senses/fire just run at the
  // human-plausible cadence instead of 60+.
  private static readonly THINK_PERIOD = 0.1;
  private thinkAccum = new Map<string, number>();

  private tickBot(bot: GameBot, dt: number, others: THREE.Vector3[], bodies: BodyCapsule[], terrain: Terrain, rosterIdx = 0): void {
    // Local bots aren't in the wire roster, so remotes.ts never ticks
    // them — tick() is what advances the snapshot interpolation and
    // AnimationMixer onto the model. Without it think() moves the
    // logical position but the rendered body stands frozen at spawn.
    bot.tick(dt);
    // Friendly cloak renders the ghost shimmer instead of vanishing —
    // refresh the verdict's team each frame so a re-seat flips it live.
    bot.localTeam = this.teamOf.get('local');
    if (bot.isDead) {
      bot.respawnAt -= dt;
      if (bot.respawnAt <= 0) {this.respawnBot(bot);}
      return;
    }
    // Movement integrates every frame — the 10Hz think gate below is for
    // decisions only; gating movement made every bot warp in 100ms hops.
    // Shared list like the server shadows — the sim skips its own
    // capsule by selfId instead of keeping a filtered copy per bot.
    bot.movement.selfId = bot.playerId;
    bot.movement.bodies = bodies;
    bot.stepFrame(dt, { terrain });
    // Roster-indexed start phase spreads thinks across the period —
    // without it every bot thinks on the same frame and stays aligned.
    const acc = (this.thinkAccum.get(bot.playerId)
      ?? (rosterIdx * TeamBots.THINK_PERIOD) / Math.max(1, this.bots.length)) + dt;
    this.thinkAccum.set(bot.playerId, acc);
    if (acc < TeamBots.THINK_PERIOD) {return;}
    this.thinkAccum.set(bot.playerId, 0);
    let foes = this.senses.enemyList(bot);
    // Rabbit: while a carrier exists, a plain hunter's only legal
    // targets are the rabbit and any bottom feeders — feeding the
    // brain the full roster just wastes bolts on blocked hits. The
    // rabbit itself (and bottom feeders) keeps open season.
    const rb = this.rabbit;
    if (rb) {
      const c = rb.carrierId();
      const bottom = this.bottomFeeders();
      if (c && bot.playerId !== c && !bottom.has(bot.playerId)) {
        foes = foes.filter((e): boolean => e.id === c || bottom.has(e.id));
      }
    }
    const ctx = this.ctxFor(bot, foes, others, terrain);
    // The sweatlord's reset key: instant self-frag through the local
    // damage funnel (attackerId === self reads as a suicide), same as
    // the server's serverHit path — not a splash war of attrition.
    if (ctx.kout) {this.hit(bot.playerId, 1e9, bot.position, bot.playerId); return;}
    const shot = bot.think(acc, ctx);
    // Standing down between rounds is correct play — metering it would
    // charge every bot a guaranteed ~150 idle points per match end.
    if (this.over) {return;}
    this.afterThink(bot, shot, acc, foes, terrain);
  }

  private afterThink(bot: GameBot, shot: ReturnType<GameBot['think']>, acc: number,
    foes: Parameters<GameBot['think']>[1]['enemies'], terrain: Terrain): void {
    this.speakEdge(bot);
    if (shot) {this.fire.resolveShot(bot, shot.targetId, shot.aim);}
    // Belt + propel are real-spawn actions — offline only, same gate
    // as resolveShot (a connected room's wire remotes can't attribute).
    const online = this.deps.lazyNetworkManager?.()?.isConnected() ?? false;
    if (!online) {
      if (bot.wantBelt) {this.fire.throwBelt(bot);}
      if (bot.wantDeploy) {this.tryDeploy(bot);}
      // Flag pass: the carrier's intent carries the receiver's pos -
      // same arc a human G-press resolves, aimed at the teammate.
      if (bot.wantPass) {this.ctf?.throwBot(bot, bot.wantPass); bot.wantPass = null;}
      if (bot.wantRepair) {
        // Welding — the heal rate mirrors a human trigger hold (~50hp/s
        // at think cadence). A welded item counts as productive work for
        // the meter: parked but not sheeping.
        const welded = this.hooks.botWeld?.(bot.wantRepair) ?? false;
        if (welded) {this.sheep.markShot(bot.playerId);}
        else {bot.wantRepair = null;} // died mid-walk — drop the intent
      }
      this.trySiege(bot);
      this.fire.tryPropel(bot, Boolean(shot));
    }
    if (shot) {this.sheep.markShot(bot.playerId);}
    this.sheepTick(bot, acc, foes, terrain);
  }

  /** Offline siege — mirror of ServerBots' hostileGear lob: an idle bot
   *  with belt charges shells the nearest enemy emplacement. Bots with a
   *  live hunt target fight that instead (players > gear). */
  private readonly gearLobT = new Map<string, number>();
  private trySiege(bot: GameBot): void {
    if (bot.huntTargetId) {return;}
    const now = performance.now();
    if ((this.gearLobT.get(bot.playerId) ?? 0) > now) {return;}
    const gear = this.hooks.hostileGear?.(bot.team ?? undefined, bot.position, 80);
    if (!gear) {return;}
    this.fire.siegeLob(bot, gear.pos);
    this.gearLobT.set(bot.playerId, now + 4000);
  }

  /** Sheep-meter bookkeeping tail of afterThink — foe-sight, dest
   *  progress, weld-busy. */
  private sheepTick(bot: GameBot, acc: number,
    foes: Parameters<GameBot['think']>[1]['enemies'], terrain: Terrain): void {
    const hasDest = Math.hypot(bot.lastDest.x - bot.pos.x, bot.lastDest.z - bot.pos.z) >= 0.5;
    this.sheep.tick(bot, Math.min(acc, 1), terrain, { foe: this.senses.foeSeen(bot, foes, terrain), hasDest, dest: bot.lastDest, busy: bot.wantRepair !== null });
  }

  /** Situation chatter edge — same pools + throttle as the wire path,
   *  resolved locally since offline bots never touch the chat wire. */
  private speakEdge(bot: GameBot): void {
    if (!bot.wantSay) {return;}
    const tgt = bot.wantSay.target;
    const c = chatter(bot.wantSay.kind, bot.playerId,
      tgt === 'local' ? 'YOU' : tgt?.replace('bot:', ''),
      { d: bot.wantSay.d, h: bot.wantSay.h });
    if (c) {
      // A spoken command chord is a real call — teammates get the pin,
      // same as the wire's botSpoke→radio path. Barks stay replies.
      const goal = c.vgs ? this.radioGoal(c.vgs, bot.playerId) : undefined;
      this.notice(goal ? 'ack' : 'reply', bot.playerId, bot.team ?? undefined, goal);
    }
    botSay(bot.playerId, c?.text ?? null, c?.vgs, c?.team && bot.team !== null);
    bot.wantSay = null;
  }

  /** Offline-only action intents — belt throw, emplacement, weld, disc
   *  jump. A connected room's wire remotes can't attribute these. */
  private offlineActs(bot: GameBot, hasShot: boolean): void {
    if (bot.wantBelt) {this.fire.throwBelt(bot);}
    if (bot.wantDeploy) {this.tryDeploy(bot);}
    if (bot.wantSkill) {this.applySkill(bot);}
    if (bot.wantHook) {this.fire.siegeLob(bot, bot.wantHook); bot.wantHook = null;}
    // Flag pass: the carrier's intent carries the receiver's pos -
    // same arc a human G-press resolves, aimed at the teammate.
    if (bot.wantPass) {this.ctf?.throwBot(bot, bot.wantPass); bot.wantPass = null;}
    if (bot.wantRepair) {
      // Welding — the heal rate mirrors a human trigger hold (~50hp/s
      // at think cadence). A welded item counts as productive work for
      // the meter: parked but not sheeping.
      const welded = this.hooks.botWeld?.(bot.wantRepair) ?? false;
      if (welded) {this.sheep.markShot(bot.playerId);}
      else {bot.wantRepair = null;} // died mid-walk — drop the intent
    }
    this.fire.tryPropel(bot, hasShot);
  }

  // Per-bot persistent think ctx — the literal was a fresh ~1KB object
  // (plus two sense arrays) per bot per frame; the brain consumes it
  // synchronously so reusing the same record is safe.
  private ctxCache = new Map<string, Parameters<GameBot['think']>[1]>();

  /** One brain ctx per bot per tick — every sense the server feeds its
   *  brains (objective+infiltrating, huntCreatures, hearing, dodge) has
   *  a client-side mirror here. */
  private ctxFor(bot: GameBot, enemies: Parameters<GameBot['think']>[1]['enemies'], others: THREE.Vector3[], terrain: Terrain): Parameters<GameBot['think']>[1] {
    const info = (this.ctf?.objectiveInfoFor(bot) ?? this.flagrun?.objectiveInfoFor(bot) ?? this.conquest?.objectiveInfoFor(bot)) as
      { pos: THREE.Vector3; infiltrating?: boolean; running?: boolean; flagsHome?: boolean; posted?: number; kout?: boolean;
        thief?: { id: string; pos: THREE.Vector3; vel: THREE.Vector3 } | null } | null;
    let ctx = this.ctxCache.get(bot.playerId);
    if (!ctx) {
      ctx = {
        terrain, enemies: [], nugget: null, objective: null,
        infiltrating: false, thief: null, huntCreatures: false,
        others: [], allies: undefined, engageRange: undefined,
        sounds: [], threats: [], repair: null,
      };
      this.ctxCache.set(bot.playerId, ctx);
    }
    ctx.terrain = terrain;
    ctx.enemies = enemies;
    // Nuggets mode KNOWS the field — wide scan like the server's, and
    // the goal picker's distance falloff decides whether the hike is
    // worth it. Elsewhere a short scan is opportunism, not an objective.
    ctx.nugget = this.spec.flags ? null : this.hooks.nearestNugget(bot.position, this.mode === 'nuggets' || this.mode === 'headhunt' ? 500 : 60);
    const rabbitGoal = this.rabbit?.goalFor(bot.playerId, (id): THREE.Vector3 | null => this.posOf(id)) ?? null;
    ctx.objective = info?.pos ?? rabbitGoal;
    ctx.infiltrating = info?.infiltrating ?? false;
    ctx.running = info?.running ?? rabbitGoal !== null;
    // Rabbit hunters get the server's runner commitment — the flag
    // outranks combat/hunt senses. Without this they only crash it
    // inside 40m, which read as "bots don't care about the flag".
    ctx.runner = rabbitGoal !== null;
    ctx.wave = false;
    ctx.marshal = false;
    ctx.posted = info?.posted ?? undefined;
    ctx.thief = info?.thief ? { id: info.thief.id, pos: info.thief.pos, vel: info.thief.vel, alive: true } : null;
    ctx.flagsHome = info?.flagsHome ?? false;
    ctx.kout = info?.kout ?? false;
    // The objective flag's REAL position: the shared brain's altitude
    // vetoes measure this, not the (possibly offset) aim point. A
    // carrier reads its own stand; an infiltrator reads the live enemy
    // flag. Without it "over the flag" vetoes fired on a fake anchor.
    const flagTeam = this.ctf && bot.team
      ? (info?.running ? bot.team : info?.infiltrating ? (bot.team === 'alpha' ? 'bravo' : 'alpha') : bot.team)
      : null;
    ctx.flagPos = flagTeam ? this.ctf!.flagPos(flagTeam, false) ?? null : null;
    ctx.moveSkill = bot.skill?.movement;
    ctx.thrift = bot.skill?.thrift;
    ctx.airLove = bot.skill?.airLove;
    ctx.speedScale = CLASS_STATS[bot.armorClass as ArmorClass].speedScale;
    ctx.skill = bot.skillId;
    ctx.beltItem = bot.loadout?.belt;
    ctx.pickupVal = ctx.nugget?.val;
    this.fillSenses(ctx, bot, others);
    return ctx;
  }

  /** Sense fields that don't depend on the objective info — wildlife,
   *  squad, reach, hearing, repair jobs. */
  private fillSenses(ctx: Parameters<GameBot['think']>[1], bot: GameBot, others: THREE.Vector3[]): void {
    // Nuggets rooms farm wildlife for the objective — the server
    // flips the same flag only in economy modes.
    ctx.huntCreatures = this.mode === 'nuggets' || this.mode === 'headhunt' || this.hooks.hasCreatures();
    ctx.others = others;
    ctx.allies = this.alliesOf(bot);
    // Mortar heavies reach past the duel band — same reach rule the
    // server senses applies.
    this.fillNerve(ctx, bot);
    // Economy + desperation channels — the shared brain already reads
    // these fields; feeding them isn't a leak, just correct wiring.
    // convoy = richest ally hoard worth drifting to escort; spillSoon =
    // a rich ally visibly dying (vultures camp the corpse). desperate =
    // score deficit x endgame pressure, ~0..2 like the server's.
    if (this.spec.teams && (bot.team === 'alpha' || bot.team === 'bravo')) {
      const other: 'alpha' | 'bravo' = bot.team === 'alpha' ? 'bravo' : 'alpha';
      const winAt = Math.max(1, this.spec.winAt);
      const deficit = (this.scores[other] - this.scores[bot.team]) / winAt;
      const leaderFrac = Math.min(1, Math.max(this.scores.alpha, this.scores.bravo) / winAt);
      ctx.desperate = Math.max(0, deficit) * leaderFrac * 2;
      if (this.mode === 'headhunt') {
        let rich: THREE.Vector3 | null = null, richHeld = 14, spill: THREE.Vector3 | null = null;
        for (const b of this.bots) {
          if (b === bot || b.team !== bot.team || b.botHp <= 0) {continue;}
          if (b.heldTokens > richHeld) {rich = b.position; richHeld = b.heldTokens;}
          else if (!spill && b.heldTokens >= 5 && b.botHp < b.botMaxHp * 0.35) {spill = b.position;}
        }
        ctx.convoy = rich;
        ctx.spillSoon = spill;
      }
    }
  }

  /** Flag/killFeed-worthy room event → chatter sense. The CTF bridge
   *  pushes these; the actor never hears their own ping. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string, goal?: { x: number; y: number; z: number },
    goalSide?: 'same' | 'other'): void {
    this.notices.notice(kind, actorId, actorTeam, performance.now(), goal, goalSide);
  }

  /** The local player's own chat/VGS — offline never sees the wire, so
   *  this is the parity hook a real room gets through Room's chat event:
   *  classify the line, mention-check it, aim team commands at a spot. */
  hearLocal(text: string, team: boolean, vgs?: string): void {
    const kind = chatKindFor(text)
      ?? (vgs ? vgsCommandFor(vgs) : null)
      ?? (this.bots.some((b): boolean => text.toLowerCase().includes(b.playerId.slice(4).toLowerCase())) ? 'mention' : null);
    const goal = vgs && team ? this.radioGoal(vgs) : undefined;
    if (kind) {this.notice(kind, 'local', this.teamOf.get('local'), goal);}
  }

  /** Same chord→spot resolution Room.radioGoal runs on the wire —
   *  offline flag stands live in the ctf bridge, actor pos is the local
   *  player's. */
  private radioGoal(chord: string, actorId = 'local'): { x: number; y: number; z: number } | undefined {
    const aim = radioAimFor(chord);
    if (!aim) {return undefined;}
    if (aim === 'actor') {
      const a = actorId === 'local' ? this.deps.lazyPlayer().pos : this.bots.find((b): boolean => b.playerId === actorId)?.position;
      return a ? { x: a.x, y: a.y, z: a.z } : undefined;
    }
    const team = this.teamOf.get(actorId);
    if (!team) {return undefined;}
    if (aim === 'carrier') {return this.ctf?.flagPos(team, true);}
    let flagTeam = team;
    if (aim !== 'own') {flagTeam = team === 'alpha' ? 'bravo' : 'alpha';}
    return this.ctf?.flagPos(flagTeam, false);
  }

  /** Mirrors ServerBotSenses.confidenceOf — the goal picker's nerve
   *  input must read the same scoreboard offline that it reads on the
   *  wire, or solo bots herd differently than hosted ones. */
  private confidenceOf(bot: GameBot): number | undefined {
    if (!this.spec.teams || (bot.team !== 'alpha' && bot.team !== 'bravo')) {return undefined;}
    const other = bot.team === 'alpha' ? 'bravo' : 'alpha';
    const margin = (this.scores[bot.team] - this.scores[other]) / Math.max(1, this.spec.winAt);
    const kd = Math.tanh(((this.deps.world.killCounts.get(bot.playerId) ?? 0)
      - (this.deps.world.deathCounts.get(bot.playerId) ?? 0)) / 4);
    return Math.min(1, Math.max(0, 0.5 + margin * 0.35 + kd * 0.25));
  }

  /** Room-event ping + hero feed — the nerve channels the shared brain
   *  reads; split out of fillSenses to keep both under the complexity cap. */
  private fillNerve(ctx: Parameters<GameBot['think']>[1], bot: GameBot): void {
    ctx.engageRange = bot.loadout?.far === WeaponType.Mortar ? 95 : undefined;
    ctx.sounds = this.senses.recentNoises(bot.position);
    ctx.threats = this.senses.incomingNear(bot.position);
    ctx.repair = this.hooks.botRepairJob?.(bot.team, bot.position, bot.playerId) ?? null;
    // Same nerve the server senses feeds: team margin + own K/D.
    ctx.confidence = this.confidenceOf(bot);
    ctx.hero = this.heroOf(bot);
    ctx.notice = this.notices.for(bot.playerId, bot.team, performance.now());
  }

  /** Mirrors ServerBotSenses.heroOf — the shared brain's resolve feed
   *  must read the same scoreboard offline that it reads on the wire. */
  private heroOf(bot: GameBot): { deficit: number; ownPerf: number; menace: number; menacePos?: { x: number; y: number; z: number }; menaceHp?: number } | undefined {
    const teams = this.spec.teams === true && (bot.team === 'alpha' || bot.team === 'bravo');
    const other = bot.team === 'alpha' ? 'bravo' : 'alpha';
    const w = this.deps.world;
    const ownKd = Math.tanh(((w.killCounts.get(bot.playerId) ?? 0) - (w.deathCounts.get(bot.playerId) ?? 0)) / 4);
    const ownPerf = Math.min(1, Math.max(0, 0.5 + ownKd));
    // The menace: best ENEMY K/D - teams reads the other side; FFA is
    // everyone (the local player counts too - they're a foe to all).
    const scan = this.menaceScan(bot, teams, other);
    const {menace} = scan, menacePos = scan.pos;
    const topKills = Math.max(w.killCounts.get(bot.playerId) ?? 0, scan.topKills);
    // Team-kill gap is the deficit channel when the mode doesn't score
    // teams (headhunt leaves teamScores at 0) - mirrors serverSenses.
    const scoreDeficit = teams ? (this.scores[other] - this.scores[bot.team as 'alpha' | 'bravo']) / Math.max(1, this.spec.winAt) : 0;
    const teamKillGap = teams ? (scan.foeTeamKills - scan.myTeamKills) / Math.max(4, this.spec.winAt) : 0;
    const killGap = teams ? 0 : (topKills - (w.killCounts.get(bot.playerId) ?? 0)) / Math.max(4, this.spec.winAt ?? 10);
    const deficit = Math.min(1, Math.max(0, Math.max(-scoreDeficit, teamKillGap, killGap) * 0.7 + Math.max(0, -ownKd) * 0.5));
    return { deficit, ownPerf, menace, menacePos, menaceHp: scan.hp };
  }

  /** Lobby scan behind heroOf: strongest enemy K/D + pos + the top
   *  kill count (the FFA leader mark the kill-gap measures). */
  private menaceScan(bot: GameBot, teams: boolean, other: string): { menace: number; pos?: { x: number; y: number; z: number }; topKills: number; foeTeamKills: number; myTeamKills: number; hp?: number } {
    const w = this.deps.world;
    const kdOf = (id: string): number => Math.tanh(((w.killCounts.get(id) ?? 0) - (w.deathCounts.get(id) ?? 0)) / 4);
    let menace = 0, pos: { x: number; y: number; z: number } | undefined;
    let topKills = 0, foeTeamKills = 0, myTeamKills = 0, hp: number | undefined;
    const player = this.deps.lazyPlayer();
    if (!player.isDead && (teams ? this.playerTeam === other : true)) {
      menace = Math.max(0, kdOf('local')); ({ pos } = player); hp = player.health;
      topKills = w.killCounts.get('local') ?? 0;
    } else if (teams && this.playerTeam === bot.team) {myTeamKills += w.killCounts.get('local') ?? 0;}
    for (const b of this.bots) {
      if (b === bot || b.isDead) {continue;}
      if (teams && b.team !== other) {myTeamKills += w.killCounts.get(b.playerId) ?? 0; continue;}
      foeTeamKills += w.killCounts.get(b.playerId) ?? 0;
      topKills = Math.max(topKills, w.killCounts.get(b.playerId) ?? 0);
      const m = kdOf(b.playerId);
      if (m > menace) {menace = m; pos = b.position; hp = b.botHp;}
    }
    return { menace, pos, topKills, foeTeamKills, myTeamKills, hp };
  }

  /** Rally channel = live teammates (incl. the local player). Team
   *  modes have a real squad to fold onto; FFA passes nothing (there's
   *  nobody safe to run to — bot.team is its own playerId there). */
  private alliesOf(bot: GameBot): THREE.Vector3[] | undefined {
    if (bot.team !== 'alpha' && bot.team !== 'bravo') {return undefined;}
    // Reused scratch: think() consumes it synchronously before the next bot.
    const allies = _alliesScratch;
    allies.length = 0;
    const player = this.deps.lazyPlayer();
    if (this.playerTeam === bot.team && !player.isDead) {allies.push(player.pos);}
    for (const b of this.bots) {if (b !== bot && !b.isDead && b.team === bot.team) {allies.push(b.position);}}
    return allies;
  }

  /** Sheep meter accrual — fills while the bot moves like a pedestrian
   *  (slow, grounded, or parked), drains while it's doing Tribes things
   *  (covering ground, airborne, jetting). At 100 it clamps — a
   *  readout for the badge, not a punish lever. */
  // Coverage window — mirrors BotSheepMeter.coverageDebit on the wire:
  // under ~30m of real displacement per 5s while the brain claims a
  // destination reads as sheeping even when per-tick speed squeaks by.
  /** Bot spawn point — spec teamSpawns/spawns when a map authored them
   *  (with a jitter so a stack doesn't overlap), else the legacy ±50m
   *  ring around the player. FFA pseudo-teams fall through to 'spawns'. */
  spawnSpot(team: string): THREE.Vector3 {
    const terrain = this.deps.lazyTerrain();
    const rings = this.nodeSpawns?.[team as TeamId];
    if (rings?.length) {
      // Conquest spawn spheres — a live point inside the ring, snapped.
      const ring = rings[Math.floor(simRand() * rings.length)]!;
      const a = simRand() * Math.PI * 2;
      const r = simRand() * ring.r;
      const sx = ring.x + Math.cos(a) * r, sz = ring.z + Math.sin(a) * r;
      const g = terrain.getHeight(sx, sz);
      return new THREE.Vector3(sx, (Number.isFinite(g) ? g : 0) + EYE, sz);
    }
    const pool = this.mapSpec?.teamSpawns?.[team as TeamId] ?? this.mapSpec?.spawns;
    const floorAt = (x: number, z: number): number => {
      const g = terrain.getHeight(x, z);
      return Number.isFinite(g) ? g : 0;
    };
    if (pool?.length) {
      // Enemy clearance — the shared pool means alpha and bravo can
      // draw the same anchor, which is a spawn-kill, not a spawn. Same
      // rule the server's spawnPicker scores on: random among anchors
      // with a live-foe buffer; if every draw is camped, take the
      // safest instead of feeding a camper.
      const foes: { x: number; z: number }[] = [];
      const lp = this.deps.lazyPlayer();
      if (!lp.isDead && this.teamOf.get('local') !== team) {foes.push(lp.pos);}
      for (const ob of this.bots) {
        if (ob.isDead) {continue;}
        if (team !== 'ffa' && ob.team === team) {continue;}
        foes.push(ob.position);
      }
      const clear = (p: { x: number; z: number }): number => {
        let m = Infinity;
        for (const f of foes) {const d = Math.hypot(p.x - f.x, p.z - f.z); if (d < m) {m = d;}}
        return m === Infinity ? 1e9 : m;
      };
      let p = pool[Math.floor(simRand() * pool.length)]!;
      for (let i = 0; i < 4 && clear(p) < 40; i += 1) {p = pool[Math.floor(simRand() * pool.length)]!;}
      if (clear(p) < 40) {for (const q of pool) {if (clear(q) > clear(p)) {p = q;}}}
      const jx = (simRand() - 0.5) * 8, jz = (simRand() - 0.5) * 8;
      return new THREE.Vector3(p.x + jx, Math.max(p.y, floorAt(p.x + jx, p.z + jz) + EYE), p.z + jz);
    }
    const player = this.deps.lazyPlayer();
    const a = simRand() * Math.PI * 2;
    const r = 20 + simRand() * 40;
    const sx = player.pos.x + Math.cos(a) * r, sz = player.pos.z + Math.sin(a) * r;
    return new THREE.Vector3(sx, floorAt(sx, sz) + EYE, sz);
  }

  /** Terrain swapped under the roster — re-seat every live bot on its
   *  team's spawn anchors without touching hp/meters/loadout. */
  reseatAll(): void {
    for (const bot of this.bots) {
      if (bot.isDead) {continue;}
      // respawn() clears the interp state a teleport needs; it doesn't
      // touch hp or meters so it doubles as a quiet re-seat.
      bot.respawn(this.spawnSpot(bot.team));
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

  /** botMatch's jersey swap renames a bot in place — every id-keyed
   *  meter follows or the defector leaks a stale cell and restarts
   *  think-stagger/sheep/seen windows from zero. */
  rekeyBot(oldId: string, newId: string): void {
    const mv = <T>(m: Map<string, T>): void => { const v = m.get(oldId); m.delete(oldId); if (v !== undefined) {m.set(newId, v);} };
    mv(this.thinkAccum); mv(this.ctxCache); mv(this.ffaScores); mv(this.dmgPool);
    this.senses.rekey(oldId, newId);
    this.sheep.rekey(oldId, newId);
    this.notices.rekey(oldId, newId);
    this.fire.rekey(oldId, newId);
    this.wd.rekey(oldId, newId);
    this.ctf?.rekey(oldId, newId);
    this.flagrun?.rekey(oldId, newId);
  }


  /** Match over → wipe scores, flags home. Rounds are seamless: live
   *  bots keep their ground (hp/meters refilled), only the dead come
   *  back through the spawn ring — teleporting a healthy squad reads
   *  as a glitch, not a new match. */
  /** DM kill credit — a player/bot frag vs a creature frag. */
  creditKill(id: string, isCreature: boolean, victimPos?: { x: number; y: number; z: number }): void {
    creditKill(this, id, isCreature, victimPos);
    this.deathStreak.delete(id); // a frag clears the victim's tilt counter — server's announce does the same
  }

  /** Unanswered-death counter per victim — feeds the 'tilt' line at 3+,
   *  the offline mirror of server killFeed.deathStreak. */
  readonly deathStreak = new Map<string, number>();

  /** CTF damage points — hitF/hurtLocal call after their gates so
   *  friendly or rabbit-blocked damage never banks. */
  creditDamage(attackerId: string, victimId: string, dmg: number): void {
    creditDamage(this, attackerId, victimId, dmg);
  }

  /** Builder bots plant — the brain picked kind+spot, the deployables
   *  pipeline owns the pod+item (mirrors the server's handleDeploy). */
  /** Instant Q-skill press on a local bot — same ante + effect terms as
   *  the server actuation: dash/bounce ride the velocity, slam dives +
   *  lands a blast, blink/warp teleport toward the current goal. */
  private applySkill(bot: GameBot): void {
    const id = bot.wantSkill;
    bot.wantSkill = null;
    if (!id || id !== bot.skillId || bot.energy < ENERGY.skillCost) {return;}
    bot.energy -= ENERGY.skillCost;
    const dx = bot.lastDest.x - bot.position.x, dz = bot.lastDest.z - bot.position.z;
    const dl = Math.hypot(dx, dz) || 1;
    switch (id) {
      case 'dash': {
        bot.velocity.x += (dx / dl) * 16; bot.velocity.y += 2; bot.velocity.z += (dz / dl) * 16;
        break;
      }
      case 'bounce': {
        bot.velocity.y += 10;
        break;
      }
      case 'slam': {
        bot.velocity.y -= 16;
        for (const foe of this.senses.enemyList(bot)) {
          if (foe.pos.distanceTo(bot.position) < 8) {this.hit(foe.id, 70, bot.position, bot.playerId);}
        }
        break;
      }
      case 'blink':
      case 'warp': {
        bot.position.x += (dx / dl) * 14;
        bot.position.z += (dz / dl) * 14;
        bot.position.y = (bot.terrain ? bot.terrain.getHeight(bot.position.x, bot.position.z) : bot.position.y) + 0.5;
        break;
      }
    }
  }

  private tryDeploy(bot: GameBot): void {
    const want = bot.wantDeploy;
    if (!want) {return;}
    bot.wantDeploy = null;
    if (want.kind !== 'turret' && want.kind !== 'mine' && want.kind !== 'station' && want.kind !== 'drone') {return;}
    this.hooks.botDeploy?.(want.kind, want.pos, {
      id: bot.playerId,
      team: bot.team,
      pos: bot.position,
      yaw: (): number => bot.rotation.yaw,
      heal: (n): void => bot.heal(n),
      addEnergy: (n): void => bot.addEnergy(n),
    });
  }

  /** Bots hostile to the LOCAL player — the deployable turret's target
   *  list. Enemy-team members in team modes, everyone in FFA. */
  enemyBotsForLocal(): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[] {
    return this.senses.enemyBotsForLocal();
  }

  /** Players hostile to a GIVEN team — bot-owned turrets/mines scan
   *  these: enemy bots AND the local player on the other side. */
  enemyBotsForTeam(team: string): BotEntry[] {
    return this.senses.enemyBotsForTeam(team);
  }

  /** Player/explosion damage routed here when the victim is a bot —
   *  combat consults `hit` before predictDamage. A bot shell can also
   *  hit 'local' (sweepLocal) — that resolves through the same funnel. */
  hit(playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local', meta?: { weapon?: number; air?: number }): boolean {
    return hitF(this, playerId, dmg, fromPos, attackerId, meta);
  }

  /** DM: local player's creature kill — combat calls this from
   *  onTargetDestroyed via the botKilled path for creature credit. */
  creatureKilled(attackerId: string): void {
    this.creditKill(attackerId, true);
  }

  /** The local player died (any mode) — release a carried flag; in
   *  rabbit every corpse is a flag event (first one spawns it). */
  localDied(): void {
    const {pos} = this.deps.lazyPlayer();
    const p = this.deps.lazyPlayer();
    // Same corpse-loot rule bot deaths and the server both run:
    // headhunt scatters held tokens + 1 bounty; other team modes drop 3
    // nuggets so a death feeds the economy, not just pain.
    if (this.mode === 'headhunt') {this.scatterTokens('local', pos, p.vel, 1);}
    else if (!this.spec.ffa) {this.hooks.dropNuggets(pos, 3, p.vel);}
    this.ctf?.dropCarried('local', pos);
    this.rabbit?.onDeath('local', pos);
    this.flagrun?.dropCarried('local', pos);
  }

  /** Live position by roster id — 'local' or a bot. */
  private posOf(id: string): THREE.Vector3 | null {
    if (id === 'local') {return this.deps.lazyPlayer().pos;}
    return this.bots.find((b): boolean => b.playerId === id)?.position ?? null;
  }

  /** Rabbit +1/sec — same FFA board the wire's hold grants write. */
  private holdPoint(id: string): void {
    this.ffaScores.set(id, (this.ffaScores.get(id) ?? 0) + 1);
    const me = this.ffaScores.get('local') ?? 0;
    let lead = 0;
    for (const [, v] of this.ffaScores) {if (v > lead) {lead = v;}}
    this.deps.lazyHud().setTeamScore?.(me, lead);
  }

  /** Tied-for-last FFA ids — the server's bottomFeeders rule: exempt
   *  only while someone is actually below them (full-field tie = none). */
  bottomFeeders(): ReadonlySet<string> {
    if (this.ffaScores.size === 0) {return _emptySet;}
    let min = Infinity;
    for (const [, v] of this.ffaScores) {if (v < min) {min = v;}}
    _bottomScratch.clear();
    for (const [id, v] of this.ffaScores) {if (v === min) {_bottomScratch.add(id);}}
    if (_bottomScratch.size === this.ffaScores.size) {_bottomScratch.clear();}
    return _bottomScratch;
  }


  /** A nugget was collected by 'local' or a bot id — bank it for the team. */
  collect(collectorId: string, kind?: string, val?: number): void {
    collect(this, collectorId, kind, val);
  }

  /** Headhunt held — 'local' is the player's own counter (the HUD reads
   *  it directly), bots carry theirs on the GameBot. */
  heldOf(id: string): number {
    if (id === 'local') {return this.deps.lazyPlayer().heldTokens;}
    return this.bots.find((b): boolean => b.playerId === id)?.heldTokens ?? 0;
  }
  setHeld(id: string, n: number): void {
    if (id === 'local') {this.deps.lazyPlayer().heldTokens = n; return;}
    const b = this.bots.find((x): boolean => x.playerId === id);
    if (b) {b.heldTokens = n;}
  }
  /** Headhunt hoard-drip for bots — the local player's channels run in
   *  Player.tick (its yourHealth-mirror path), bots tick here. hp only:
   *  bots carry no armor pool offline and their belt isn't charge-counted. */
  private headhuntDrip(dt: number): void {
    const now = performance.now();
    for (const b of this.bots) {
      if (b.heldTokens <= 0 || b.botHp <= 0) {continue;}
      const hb = heldBuffRates(b.heldTokens, now - b.lastHitAt);
      if (hb.hp > 0) {b.botHp = Math.min(b.botMaxHp, b.botHp + hb.hp * dt);}
    }
  }

  /** Headhunt death/leaver scatter — base-3 coin denominations, same
   *  decompose the server runs (10-held corpse = blue + two whites). */
  scatterTokens(id: string, pos: THREE.Vector3, vel: THREE.Vector3, bonus: number): void {
    const held = this.heldOf(id);
    this.setHeld(id, 0);
    if (held + bonus > 0) {
      for (const val of decomposeTokens(held + bonus)) {
        this.hooks.dropNuggets(pos, 1, vel, 'token', val);
      }
    }
    syncHeld(this);
  }

  /** Per-id perk mods — 'local' reads the live player. */
  private modsFor(id: string) {
    return id === 'local' ? this.deps.lazyPlayer().mods : this.bots.find((b): boolean => b.playerId === id)?.perkMods;
  }

  collectors(): { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] {
    _collectors.length = 0;
    const p = this.deps.lazyPlayer();
    _collectors.push({ id: 'local', pos: p.pos, alive: !p.isDead, pickupScale: p.mods.pickupRadius });
    for (const b of this.bots) {_collectors.push({ id: b.playerId, pos: b.position, alive: !b.isDead, pickupScale: b.perkMods.pickupRadius });}
    return _collectors;
  }

  private pushScore(): void {
    pushScore(this);
  }

  dispose(): void {
    botSayDrain(); // queued taunts belong to this match's roster, not the next one's feed
    const hud = this.mode === 'headhunt' ? this.deps.lazyHud() : null;
    for (const b of this.bots) {
      hud?.removePlayerIndicator?.(b.playerId);
      this.deps.world.remotePlayers.remove(b.playerId);
    }
    this.bots.length = 0;
    this.fire.dispose();
    this.rabbit?.dispose();
    this.ctf?.dispose();
    this.flagrun?.dispose();
  }
}

const _collectors: { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number }[] = [];
const _alliesScratch: THREE.Vector3[] = [];
const _bottomScratch = new Set<string>();
const _emptySet: ReadonlySet<string> = new Set();
