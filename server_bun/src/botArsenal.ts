/**
 * BotArsenal - the trigger half of ServerBots: weapon selection, muzzle
 * geometry, ballistic lobs, and the disc-jump propel. Everything a bot
 * fires goes through the same projectiles/botFire paths a client's
 * claims do - this file decides WHEN and AT WHAT, never adjudicates.
 */
import type { Vec3, PlayerState } from './types.ts';
import type { Room } from './Room.ts';
import { classCapsule, classCanFire } from '../../shared/botClasses.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S, BELT_THROW_COST, payShotCost, spendAmmo, jitter01, coneDir, bloomRadius, bloomGrow } from '../../shared/weapons.ts';
import { gunGameWeapon } from '../../shared/gunGame.ts';
import { pHitFactor } from '../../shared/botHitChance.ts';
import { idSeed } from '../../shared/weaponTable.ts';
import { SELF_SPLASH_MAX,aoeDamageAt, hitRadiusAt } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import { GRAVITY, type MoveState } from '../../shared/movement.ts';
import { hmHeight, hmChord } from '../../shared/heightfield.ts';
import { BOT_LOADOUTS, pickBotWeapon, pickBotWeaponSafe, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { botRand } from '../../shared/botRand.ts';
import { BOT_TUNING as T } from '../../shared/botTuning.ts';
import type { BotVec, BrainOut } from '../../shared/botBrain.ts';
import { fireAtBall as beamAtBall, fireSpeedless, type BeamHost } from './botBeam.ts';
import { isSuper } from './superBot.ts';
import { simNow } from './simClock.ts';
import { weaponStats } from './weaponStats.ts';
import { BotSelfBlast } from './botSelfBlast.ts';
import { trackAim, deltaRide } from './botTrackAim.ts';

// Ordnance aim: expected-damage argmax (true) vs the grounded/airborne
// heuristic (false). The heuristic stays as the cheap fallback - the EV
// model costs one aoeDamageAt + a couple of hypot per ordnance pull, but
// if that ever reads hot in profiling, flip this and the rule returns.
const ORDNANCE_EV = true;
/** Returns the aim.y the ordnance shot should fly at. Grounded or near-
 *  ground targets get the ground point under them - direct still counts,
 *  every near-miss detonates inside the envelope. Airborne targets score
 *  ~0 ground EV and fall back to the risky direct shot automatically. */
export function ordnanceAimY(aim: BotVec, gY: number, dist: number, wt: number): number {
  const st = getWeaponStats(wt);
  if (!ORDNANCE_EV) {return aim.y - gY <= 4 ? gY + 0.5 : aim.y;}
  const tImpact = dist / (st.speed || 1);
  const reachR = Math.min(20, 4 * tImpact * tImpact); // ±accel² wobble on the led point
  // Direct odds use the wake proxy grown to IMPACT time, not hitMax:
  // hitMax is the lifetime cap - an 8m-cap bolt reads 100% hit at 0.3s
  // where its real proxy is ~1m, and the whole ground-shot branch died.
  const pDirect = Math.min(1, (hitRadiusAt(wt, tImpact) / Math.max(1, reachR)) ** 2);
  const eDirect = (st.directDamage || 0) * pDirect;
  // pickFire already baked drop comp into aim.y for gravity shells; undo
  // it for the lift read, re-add it on the ground shot - aiming the
  // literal ground point drops the shell into dirt ~10m short instead
  // of popping under the target's feet (the 43m lethality stall).
  const drop = st.gravity ? -0.5 * GRAVITY * tImpact * tImpact : 0;
  const gap = Math.max(0, aim.y - drop - gY - 0.5);
  // A feet shot at a grounded target is direct-or-splash, not splash-only:
  // the shell still crosses the lower capsule when the target is nearly
  // level with the ground point (the direct share fades over ~3m of lift).
  const eGround = aoeDamageAt(Math.hypot(gap, reachR * 0.3), wt)
    + eDirect * Math.max(0, 1 - gap / 3);
  return eGround > eDirect ? gY + 0.5 + drop : aim.y;
}

const BOLT_SPEED = 60; // m/s - the melee swing's visual bolt

// FPS_SUPERBOT knob lives in superBot.ts - leaf import so beam/drive/
// roster don't reach back through this file.

export type BotBody = { id: string; position: Vec3; velocity: Vec3; armorClass: string; rotation: { yaw: number; pitch?: number } };

/** The body's look dir from its wire rotation — same convention the
 *  drive writes (yaw=atan2(x,z), pitch positive looks DOWN). A bot's
 *  shots launch along this: the model always faces where it shoots
 *  (Quake's rule — the crosshair IS the view, not a hidden aim var). */
function normalize3(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

function faceDir(p: BotBody): Vec3 {
  const cp = Math.cos(p.rotation.pitch ?? 0);
  return { x: Math.sin(p.rotation.yaw) * cp, y: -Math.sin(p.rotation.pitch ?? 0), z: Math.cos(p.rotation.yaw) * cp };
}
/** cos(20°): a trigger pull waits until the body's facing is inside
 *  this cone of the wanted dir — acquisition is a visible wind-up, not
 *  a silent snap. The trigger stays live across the miss. */
const SETTLE_COS = Math.cos(0.35);
function settled(p: BotBody, dir: Vec3): boolean {
  const f = faceDir(p);
  return f.x * dir.x + f.y * dir.y + f.z * dir.z >= SETTLE_COS;
}
/** One-off shots (lobs, point suppression) aren't a held trigger - the
 *  honest read is the throwing flick: snap the facing onto the launch
 *  dir the instant the shot leaves. */
function faceLaunch(p: BotBody, dir: Vec3): void {
  p.rotation.yaw = Math.atan2(dir.x, dir.z);
  p.rotation.pitch = -Math.asin(Math.max(-1, Math.min(1, dir.y)));
}

const j = (): number => (botRand() - 0.5) * 0.07;

/** One held trigger. `aim` rides the target's movement so the brain's
 *  lead/error offset is preserved while it drags; `lag`/`err`/`tv`/`diff`
 *  only do work in tracking mode (speed-0 weapons: smooth pursuit, not
 *  frozen offset - humans hover near target, not on it). */
export interface TriggerRec {
  targetId: string; aim: Vec3; lastPos: Vec3 | null; until: number;
  lag: Vec3 | null; err: Vec3; track: boolean | undefined; sig: number;
  tv: Vec3 | null; diff: number; wt: number | undefined;
}

/** The pull geometry every serve reads/mutates - aim is rewritten in
 *  place to where the shell should actually land. */
interface ServeCtx { p: BotBody; target: PlayerState; aim: Vec3; muzzle: Vec3; dist: number; dx0: number; dz0: number }

/** tryPropel's shared geometry/state - one bag so the launch helpers
 *  don't each re-derive the goal vector and gate values. */
interface PropelCtx {
  id: string; p: BotBody; out: BrainOut;
  goal: { pos: BotVec; runner?: boolean; wave?: boolean };
  sh: MoveState; now: number; surge: boolean; carrying: boolean;
  hp: number; maxHp: number; dist: number; dx: number; dz: number;
  lo: BotLoadout;
}

export class BotArsenal implements BeamHost {
  /** Propel cooldown + the post-shove jet pin - owned here because only
   *  firing decisions set them; the driver just reads the pin so the
   *  launch impulse rides out like a real disc-jump. */
  private propelT = new Map<string, number>();
  private propelJetUntil = new Map<string, number>();
  private wasCarrying = new Map<string, boolean>();
  /** Last shot time per bot - the weapon-rate gate that keeps a fast
   *  brain cadence from out-shooting the drawn weapon's legal rate. */
  private lastShot = new Map<string, number>();
  /** Cumulative self-damage budget per bot - decrements on splash fire,
   *  regenerates over time (+10 HP/sim-second, capped at 100). Prevents
   *  gradual self-destruction from repeated self-splash hits that
   *  individually pass the per-shot gate. botSelfBlast reads/writes it. */
  selfDamageBudget = new Map<string, number>();
  /** The self-preservation gates - extracted cluster, same semantics. */
  private readonly selfBlast = new BotSelfBlast(this);
  /** groundedOnly picks that lost to the ground rule - true = wants
   *  artillery but is still moving, so the drive should plant it. */
  private deployPick = new Map<string, boolean>();
  /** Held trigger per bot: brains decide press/release cadence and aim
   *  direction - a human holds M1 and tracks, the gun streams at its own
   *  legal rate between thinks. `aim` rides the target's movement so the
   *  brain's lead/error offset is preserved while it drags. */
  private trigger = new Map<string, TriggerRec>();
  /** Sim clock - the rate gate compares in sim-ms, not wall time, so
   *  scenario tests and slow-tick servers measure the same cadence. */
  private clock = 0;
  /** Launch telemetry per bot: heel blast / pull surf / crest pop -
   *  the soak report reads this to prove disc-jumps actually fire. */
  readonly propels = new Map<string, { heel: number; pull: number; crest: number }>();
  private lastPropelAt = new Map<string, number>();
  private propelMark(id: string, kind: 'heel' | 'pull' | 'crest', now: number): void {
    const s = this.propels.get(id) ?? { heel: 0, pull: 0, crest: 0 };
s[kind] += 1; this.propels.set(id, s);
    this.lastPropelAt.set(id, now);
  }

  /** Sim-ms of the bot's most recent propel - the selfK autopsy splits
   *  heel-blast frags from aimed-shot suicides on it. */
  lastPropel(id: string): number | undefined { return this.lastPropelAt.get(id); }

  constructor(
    public room: Room,
    public loadouts: Map<string, BotLoadout>,
    private lastHuntCb: (botId: string) => string | null,
    private huntSeenCb: (botId: string) => (BotVec & { vel?: BotVec }) | null = (): null => null,
    /** The shooter brain's skill matrix - biases the draw toward the
     *  gun the bot is actually good with (same bias the senses use,
     *  so advertised weaponSpeed and fired weapon agree). */
    readonly skillOfCb: (botId: string) => BotSkill | undefined = (): undefined => undefined,
  ) {}

  /** BeamHost surface - botBeam resolves super-bot contact through it. */
  lastHunt(id: string): string | null { return this.lastHuntCb(id); }

  /** While > now the bot's jet stays pinned - read by the driver. */
  jetPinUntil(id: string): number {
    return this.propelJetUntil.get(id) ?? 0;
  }

  /** The live aim point a held trigger is tracking - the drive reads it
   *  to pitch the bot's head at its target. Between volleys the trigger
   *  is dead but the HUNT is still live: a duelist keeps their crosshair
   *  on the enemy between pulls, so the look falls back to the last-seen
   *  spot - without it every volley re-paid the full spring acquisition
   *  before the settle gate opened (volley weapons lost ~half their
   *  uptime to re-acquire, stream weapons didn't). */
  aimPoint(id: string): Vec3 | null {
    const tr = this.trigger.get(id);
    if (tr && tr.until > this.clock) {return tr.aim;}
    return this.huntSeenCb?.(id) ?? null;
  }

  /** Part of a bot's teardown - see ServerBots.untrack. */
  untrack(id: string): void {
    this.trigger.delete(id);
    this.propelT.delete(id);
    this.propelJetUntil.delete(id);
    this.wasCarrying.delete(id);
    this.lastShot.delete(id);
    this.lastPropelAt.delete(id);
    this.propels.delete(id);
    this.deployPick.delete(id);
  }

  /** True while the band pick wants deploy artillery the body can't
   *  fire yet - firePhase parks so the next think is feet-down. */
  deployWanted(id: string): boolean {
    return this.deployPick.get(id) === true;
  }

  /** Players can't out-run a weapon's rate either - the drawn gun owns
   *  the trigger interval, not the brain's cadence. Held triggers keep
   *  streaming here: each tick re-aims along the target's delta and
   *  discharges the moment the weapon's own interval allows - a 0.09s
   *  chaingun hoses, a 0.45s disc still pops once per pull. */
  step(dt: number): void {
    this.clock += dt * 1000;
    // Regenerate self-damage budget: +10 HP/sim-second, capped at 100.
    for (const [id, b] of this.selfDamageBudget) {
      this.selfDamageBudget.set(id, Math.min(100, b + dt * 1000 * 0.01));
    }
    for (const [id, tr] of this.trigger) {
      if (tr.until <= this.clock) { this.trigger.delete(id); continue; }
      const p = this.room.players.getPlayer(id);
      if (!p || p.isDead) { this.trigger.delete(id); continue; }
      const live = this.targetPos(tr.targetId);
      // undefined until the first discharge stamps it - delta-ride
      // for that one tick, pursuit the moment the weapon is known.
      if (tr.track) {trackAim(this.room, tr, live, dt, id);}
      else {deltaRide(tr, live);}
      if (live) {tr.lastPos = live;}
      this.discharge(p, tr);
    }
  }

  /** Where the held target is now - the aim rides its delta, so a
   *  sweeping beam tracks the runner instead of painting where he was. */
  private targetPos(targetId: string): Vec3 | null {
    if (targetId.startsWith('b:')) {return this.room.ballSim?.ballAt(Number(targetId.slice(2))) ?? null;}
    if (targetId.startsWith('c:')) {return this.room.creatureSim?.crawlerAt(Number(targetId.slice(2))) ?? null;}
    const t = this.room.players.getPlayer(targetId);
    return t && !t.isDead ? t.position : null;
  }

  /** Covers one think gap plus jitter - the brain re-arms every pull
   *  while it wants the gun hot; silence for this long is a release. */
  private static readonly TRIGGER_HOLD_MS = 500;

  fireAt(p: BotBody, targetId: string, aim: Vec3): void {
    const tr = {
      targetId, aim: Object.assign({}, aim),
      lastPos: this.targetPos(targetId),
      until: this.clock + BotArsenal.TRIGGER_HOLD_MS,
      lag: null as Vec3 | null, err: { x: 0, y: 0, z: 0 },
      track: undefined as boolean | undefined, sig: 1,
      tv: null as Vec3 | null, diff: 0.5,
      wt: undefined as number | undefined,
    };
    this.trigger.set(p.id, tr);
    this.discharge(p, tr);
  }

  rateOk(id: string, wt: number): boolean {
    const interval = (WEAPON_FIRE_INTERVAL_S[wt as WeaponType] ?? 0.1) * 1000;
    if (this.clock - (this.lastShot.get(id) ?? -interval) < interval) {return false;}
    this.lastShot.set(id, this.clock);
    // Decloak-on-fire: every legal shot stamps the reveal clock. Bots
    // emit no 'fire' event, so the human path's Room-handler stamp
    // can't cover them - rateOk is the one gate every shot clears.
    const p = this.room.players.getPlayer(id);
    if (p) {p.lastFireSim = simNow();}
    return true;
  }

  /** Deterministic-world tests drive the arsenal without a room tick -
   *  nudge the sim clock so rate-gating still measures a cadence. */
  testAdvance(ms: number): void {
    this.clock += ms;
  }

  private discharge(p: BotBody, tr: { targetId: string; aim: Vec3; track: boolean | undefined; sig: number; err: Vec3; wt: number | undefined }): void {
    const { targetId, aim } = tr;
    const muzzleB = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const wantB = normalize3(aim.x - muzzleB.x, aim.y - muzzleB.y, aim.z - muzzleB.z);
    // Still turning? The pull waits — a shot that leaves before the body
    // has swung on target is a silent aimbot (the model never looked).
    if (!settled(p, wantB)) {return;}
    const fdir = faceDir(p);
    if (targetId.startsWith('b:')) {
      beamAtBall(this, p, Number(targetId.slice(2)), aim, BOT_LOADOUTS[0]!);
      return;
    }
    if (targetId.startsWith('c:')) {
      this.dischargeCrawler(p, tr, aim, fdir);
      return;
    }
    this.dischargePlayer(p, tr, fdir);
  }

  /** The player-target pull: range-band select, serve, gates, then the
   *  launch along the body's FACING - where the model looks IS where it
   *  shoots (the settle gate up top held the pull until it was true). */
  private dischargePlayer(p: BotBody, tr: { targetId: string; aim: Vec3; track: boolean | undefined; sig: number; err: Vec3; wt: number | undefined }, fdir: Vec3): void {
    const { targetId, aim } = tr;
    const target = this.room.players.getPlayer(targetId);
    if (!target || target.isDead) {return;}
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dx0 = aim.x - muzzle.x, dy0 = aim.y - muzzle.y, dz0 = aim.z - muzzle.z;
    const dist = (dx0 * dx0 + dy0 * dy0 + dz0 * dz0) ** 0.5 || 1;
    const distXZ = (dx0 * dx0 + dz0 * dz0) ** 0.5;
    // Range-band weapon select - same judgment a player makes: a fist
    // inside 3m, the hold-out in knife range, hitscan close, the loadout's
    // mid-band primary, rockets at standoff. The fist check rides planar
    // distance: muzzle sits +1.4y over feet, so a flat 3m gap already reads
    // 3.3m+ in 3D and the band could never open.
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt = this.pullWeapon(lo, target, distXZ, dist, p.id);
    if (wt < 0) {return;} // ArmorGrenade - firing it at an enemy is arming him
    // Fuse-only carriers (MRV) detonate wherever the shell is at fuse -
    // aim the POP point, not the target. aimServe mutates aim with the
    // arm-window bounce-serve / flak feet-serve / splash-serve / fuse
    // solve; 'veto' = refuse the pull (past ~1.15x carry the burst
    // always overshoots).
    const serve = this.aimServe({ p, target, aim, muzzle, dist, dx0, dz0 }, wt);
    if (serve === 'veto') {return;}
    const fuseSolved = serve === 'fuse';
    if (!this.shotGates(p, tr, wt, aim)) {return;}
    this.stampShot(p, aim, wt, dist);
    if (wt === WeaponType.Melee) {
      this.meleeSwing(p, targetId, { muzzle, dx0, dy0, dz0, dist });
      return;
    }
    // Ordnance aim = max expected damage over direct vs ground shots -
    // see ordnanceAimY. The blast, not the body, decides where to aim.
    // Radius ≥4 covers plasma-cannon-class slow splash too: a 90m/s bolt
    // can't airshot a skier, but its pop eats whoever stands under it.
    // Fuse-solved shots skip it - the pop point is already the aim.
    if (!fuseSolved && getWeaponStats(wt).aoeRadius >= 4) {
      const gY = this.room.field
        ? Math.max(hmHeight(this.room.field, aim.x, aim.z), hmChord(this.room.field, aim.x, aim.z), this.room.moveSim.structureTop(aim.x, aim.z))
        : aim.y - 1.5;
      aim.y = ordnanceAimY(aim, gY, dist, wt);
    }
    // The brain's aim already leads by target velocity over real flight
    // time (weaponSpeed hook below) - adding lead here would double it.
    // The shot launches along the body's FACING, not the aim point: the
    // serve/fuse mutations above rewrote tr.aim, the drive's slew chases
    // it, and the settle gate up top held this pull until the body was
    // inside the cone - so where the model looks IS where it shoots.
    const dir = fdir;
    const me0 = this.room.players.getPlayer(p.id);
    if (me0) {this.bloomCone(me0, dir, wt);}
    if (this.selfBlast.selfBlastVeto(p, target, targetId, { muzzle, dir, wt, dist })) {return;}
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      fireSpeedless(this, p.id, muzzle, dir, wt);
    }
  }

  /** Recoil + telemetry stamped once the gates pass: the launcher kick
   *  is real movement, bots feel it too. */
  private stampShot(p: BotBody, aim: Vec3, wt: number, dist: number): void {
    const recoil = getWeaponStats(wt).recoilImpulse ?? 0;
    if (recoil > 0 && aim) {
      const dl = Math.hypot(aim.x - p.position.x, aim.y - (p.position.y + 1.4), aim.z - p.position.z) || 1;
      this.room.moveSim.applyImpulse(p.id, { x: -(aim.x - p.position.x) / dl * recoil, y: -(aim.y - (p.position.y + 1.4)) / dl * recoil, z: -(aim.z - p.position.z) / dl * recoil }, 3);
    }
    weaponStats.recordShot(this.room.mode, `w${wt}`, dist);
    this.room.events.emit({ type: 'botShot', id: p.id, weapon: wt });
  }

  /** Range-band weapon select - same judgment a player makes: a fist
   *  inside 3m, the hold-out in knife range, hitscan close, the loadout's
   *  mid-band primary, rockets at standoff. -1 = veto the pull.
   *  Finisher pull: a wounded target (<25% hp) tempts the easy hold-out
   *  instead of another heroic lob - the sidearm is a chip on a thin
   *  target. ~40% of discharges take it; the rest stay on the primary,
   *  because going all easy-hit is the dishonorable version. */
  private pullWeapon(lo: BotLoadout, target: PlayerState, distXZ: number, dist: number, botId: string): number {
    const airborne = Math.abs(target.velocity?.y ?? 0) > 4;
    let wt = this.pickWeapon(lo, distXZ, dist, botId, airborne);
    if (target.maxHealth > 0 && target.health / target.maxHealth < 0.25 && botRand() < 0.4) {wt = lo.side;}
    // Armor grenade coats everyone in the blast - firing it at an enemy
    // is arming him. Team plating goes through the belt path; a duel
    // never wants this shot.
    if (wt === WeaponType.ArmorGrenade) {return -1;}
    return wt;
  }

  /** The punch IS the player's swing - combat funnels it identically,
   *  and the broadcast swing lets observers see the melee. Speed is 0
   *  on the stat line so the visual uses the raw aim, not the led dir. */
  private meleeSwing(p: BotBody, targetId: string, a: { muzzle: Vec3; dx0: number; dy0: number; dz0: number; dist: number }): void {
    const { muzzle, dx0, dy0, dz0, dist } = a;
    this.room.messages.botAttack(p.id, targetId, WeaponType.Melee);
    this.room.messages.botFire(p.id, null, muzzle,
      { x: (dx0 / dist) * BOLT_SPEED, y: (dy0 / dist) * BOLT_SPEED, z: (dz0 / dist) * BOLT_SPEED },
      WeaponType.Melee, true);
  }

  /** Every gate a drawn weapon passes before it may leave: energy
   *  (Blaster drains the moveSim tank - same magazine, same bill),
   *  first-pull tracking stamp, cadence, the grounded-only deploy
   *  rule (feet on dirt AND not skiing), then pool ammo LAST - the
   *  cadence gate stamps first so a rate-blocked pull doesn't eat a
   *  round; a dry pool then refuses like a dry tank. */
  private shotGates(p: BotBody, tr: { targetId: string; aim: Vec3; track: boolean | undefined; sig: number; err: Vec3; wt: number | undefined }, wt: number, aim: Vec3): boolean {
    if (!payShotCost(wt, p.id,
      (id): number | null => this.room.moveSim.energyOf(id),
      (id, n): void => { this.room.moveSim.drainEnergy?.(id, n); })) {return false;}
    if (tr.track === undefined) {this.markTrack(tr, wt, aim);}
    if (!this.rateOk(p.id, wt)) {return false;}
    if (getWeaponStats(wt).groundedOnly) {
      const sim = this.room.moveSim.simOf(p.id);
      if (!sim?.state.onGround || sim.input.skiHeld) {return false;}
    }
    return spendAmmo(this.room.players.getPlayer(p.id)?.ammoPool ?? new Map(), wt, this.clock / 1000);
  }


  /** Species pops contest the same projectile sweep as balls - fire
   *  real shells so a shot can still whiff or body-block, identical
   *  to a human's travel time. The projectile detonate pays damage
   *  through crawlerHit and scores :prey telemetry. */
  private dischargeCrawler(p: BotBody, tr: { targetId: string; aim: Vec3; track: boolean | undefined; sig: number; err: Vec3; wt: number | undefined }, aim: Vec3, fdir: Vec3): void {
    const { targetId } = tr;
    const muzzle0 = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const cdx = aim.x - muzzle0.x, cdy = aim.y - muzzle0.y, cdz = aim.z - muzzle0.z;
    const cdist = Math.hypot(cdx, cdy, cdz) || 1;
    const lo0 = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt0 = this.pickWeapon(lo0, Math.hypot(cdx, cdz), cdist, p.id);
    if (!this.shotGates(p, tr, wt0, aim)) {return;}
    // Launcher recoil: the kick is real movement, bots feel it too.
    const recoil0 = getWeaponStats(wt0).recoilImpulse ?? 0;
    if (recoil0 > 0) {this.room.moveSim.applyImpulse(p.id, { x: -cdx / cdist * recoil0, y: -cdy / cdist * recoil0, z: -cdz / cdist * recoil0 }, 3);}
    weaponStats.recordShot(this.room.mode, `w${wt0}`, cdist);
    this.room.events.emit({ type: 'botShot', id: p.id, weapon: wt0 });
    if (wt0 === WeaponType.Melee) {
      const stats = getWeaponStats(WeaponType.Melee);
      const bug = this.room.creatureSim.crawlerAt(Number(targetId.slice(2)));
      if (bug && stats && Math.hypot(bug.x - muzzle0.x, bug.y - muzzle0.y, bug.z - muzzle0.z) <= stats.aoeRadius + 1.4) {
        const {killed} = this.room.creatureSim.handleHit(p.id, bug.id, isSuper(p.id) ? 300 : stats.aoeDamage);
        weaponStats.record(this.room.mode, `w${wt0}:prey`, stats.aoeDamage, killed, true);
      }
      this.room.messages.botAttack(p.id, targetId, WeaponType.Melee);
      this.room.messages.botFire(p.id, null, muzzle0,
        { x: (cdx / cdist) * BOLT_SPEED, y: (cdy / cdist) * BOLT_SPEED, z: (cdz / cdist) * BOLT_SPEED },
        wt0, false);
      return;
    }
    if (!this.room.projectiles.spawn(p.id, wt0, muzzle0, fdir, p.velocity)) {
      fireSpeedless(this, p.id, muzzle0, fdir, wt0);
    }
  }

  /** Shared context for the serve picks - the shooter's pull geometry.
   *  aim is mutated in place: every serve rewrites the pull's target
   *  point to where the shell should actually land. */
  private serveGround(c: ServeCtx, gx: number, gz: number, fallback: number): void {
    c.aim.x = gx; c.aim.z = gz;
    c.aim.y = this.room.field ? hmHeight(this.room.field, gx, gz) : fallback;
  }

  /** Arm-gated ordnance under the arm window plays the BOUNCE-SERVE:
   *  lob the dirt ~10m AHEAD of the runner's path - the shell thuds,
   *  skids forward still cooking, and pops where they're headed.
   *  Gate on the BODY arm time: GL's armTime is only its dirt-skip
   *  window (bodyArmTime 0 pops bodies at any age), so lobbing the
   *  dirt ahead at knife range throws away a hit it already has. */
  private bounceServe(c: ServeCtx, stF: ReturnType<typeof getWeaponStats>): boolean {
    const bodyArmF = stF?.bodyArmTime ?? stF?.armTime ?? 0;
    if (bodyArmF <= 0 || stF.speed <= 0 || c.dist >= stF.speed * bodyArmF * 0.35 || c.dist <= 8) {return false;}
    const { target, aim } = c;
    const tv = target.velocity, ts = Math.hypot(tv.x, tv.z);
    const lx = ts > 2 ? (tv.x / ts) * 10 : 0, lz = ts > 2 ? (tv.z / ts) * 10 : 0;
    this.serveGround(c, aim.x + lx, aim.z + lz, aim.y - 1.5);
    return true;
  }

  /** Flak feet-serve, conditionally: a ground-skip beats the LEAD, not
   *  the lob - it pays vs fast lateral movers whose jink inside the
   *  ~0.3s flight undoes velocity lead, and only on ground they can
   *  land/cross. Direct lob wins vs straight runners and standoffs
   *  (bench: unconditional serve cost 11% kills). */
  private flakServe(c: ServeCtx, wt: number): boolean {
    const { target, aim, dist, dx0, dz0 } = c;
    if (wt !== WeaponType.Flak || dist <= 8 || dist >= 30) {return false;}
    const tv = target.velocity;
    const ux = dx0 / dist, uz = dz0 / dist; // unit shooter->target
    const lat = Math.abs(tv.x * -uz + tv.z * ux); // lateral speed across the aim axis
    const grounded = (this.room.field ? target.position.y - hmHeight(this.room.field, target.position.x, target.position.z) : 0) < 4;
    if (lat <= 8 || !grounded) {return false;}
    const ts = Math.hypot(tv.x, tv.z) || 1;
    this.serveGround(c, aim.x + (tv.x / ts) * 4, aim.z + (tv.z / ts) * 4, aim.y - 1.4);
    return true;
  }

  /** Splash-serve for direct-fire aoe guns (PlasmaCannon & friends):
   *  vs fast lateral movers at range, aim the dirt under the led point -
   *  a whiff becomes a guaranteed splash tag instead of a bolt landing
   *  40m behind them. Straight runners still eat the direct hit. */
  private splashServe(c: ServeCtx, stF: ReturnType<typeof getWeaponStats>): boolean {
    const { target, aim, dist, dx0, dz0 } = c;
    if (!stF || stF.aoeRadius <= 0 || stF.fuseOnly || stF.terrainBounce || (stF.bodyArmTime ?? stF.armTime ?? 0) !== 0 || stF.speed <= 0 || dist <= 20 || dist >= 80) {return false;}
    const tv = target.velocity;
    const ux = dx0 / dist, uz = dz0 / dist;
    const lat = Math.abs(tv.x * -uz + tv.z * ux);
    if (lat <= 8) {return false;}
    this.serveGround(c, aim.x, aim.z, aim.y - 1.4);
    return true;
  }

  /** Fuse-only carriers (MRV) detonate wherever the shell is at fuse -
   *  aim the POP point, not the target. Solve the launch dir that puts
   *  the fuse-end position on the target's led position; the ±5% band
   *  that used to gate this starved every reach-capped aoe slug (rail,
   *  plasma: contact pops, not airbursts - they were refused forever).
   *  Bomblets release FORWARD of the pop, so the burst only pays when
   *  it lands at-or-just-past the target - a close target gets overflown
   *  (MRV's ~82m carry is a >60m weapon; inside the 45m acquire cap it
   *  honestly has no shot), and confetti past ~1.4x is waste. */
  private fuseSolve(c: ServeCtx, stF: ReturnType<typeof getWeaponStats>): 'fuse' | 'direct' | 'veto' {
    if (!stF?.fuseOnly || stF.maxLifetime == null || stF.speed <= 0) {return 'direct';}
    const { p, target, aim, muzzle, dist, dx0, dz0 } = c;
    const f = stF.maxLifetime, inh = stF.inherit ?? 0.5;
    const tv = target.velocity;
    const qx = target.position.x + tv.x * f - muzzle.x - p.velocity.x * inh * f;
    const qy = target.position.y + 1.2 + tv.y * f - muzzle.y - p.velocity.y * inh * f + 0.5 * GRAVITY * f * f;
    const qz = target.position.z + tv.z * f - muzzle.z - p.velocity.z * inh * f;
    const sf = stF.speed * f;
    const ul = Math.hypot(qx, qy, qz) / sf;
    if (ul < 0.85) {
      // Too close for the fuse solve? Pop the carrier on the GROUND
      // ~10m short of the led point - terrain contact detonates it
      // point-blank and the rain falls on their path (the human
      // 3-kills/min lane the carry band refused to model at all).
      this.serveGround(c, aim.x - (dx0 / dist) * 10, aim.z - (dz0 / dist) * 10, target.position.y - 1.4);
    } else if (ul > 1.15) {return 'veto';} // past ~1.15x carry the burst always overshoots (soak: 282 volleys at 120+m, 0 hits)
    else {aim.x = muzzle.x + qx / sf; aim.y = muzzle.y + qy / sf; aim.z = muzzle.z + qz / sf;}
    return 'fuse';
  }

  /** Aim-point serves, chosen once per pull. 'fuse' = the pop point is
   *  the aim (skip the ordnance aim-y pass); 'veto' = refuse the pull. */
  private aimServe(c: ServeCtx, wt: number): 'fuse' | 'direct' | 'veto' {
    const stF = getWeaponStats(wt);
    if (!this.bounceServe(c, stF) && !this.flakServe(c, wt)) {this.splashServe(c, stF);}
    return this.fuseSolve(c, stF);
  }

  /** First discharge stamps the tracking mode from the drawn weapon:
   *  speed-0 = beam (pursuit + OU wander), else projectile (delta-ride).
   *  sig scales the wander with the pull's initial miss - a bot that
   *  pulled 5m off target drifts wider than one that pulled 1m. */
  private markTrack(tr: { targetId: string; track: boolean | undefined; sig: number; err: Vec3; aim: Vec3; wt: number | undefined }, wt: number, aim: Vec3): void {
    tr.wt = wt;
    // Beams track (speed-0). Stream projectiles track too - a hose that
    // re-leads every bolt is how a human fires it; delta-ride only serves
    // slow one-shot pulls whose aim was reasoned once.
    const stats = getWeaponStats(wt);
    tr.track = stats.speed === 0 || (stats.speed > 0 && (WEAPON_FIRE_INTERVAL_S[wt as WeaponType] ?? 1) <= 0.3);
    if (!tr.track) {return;}
    const live = this.targetPos(tr.targetId);
    const miss = live ? Math.hypot(aim.x - live.x, aim.y - live.y - 1.2, aim.z - live.z) : 1;
    tr.sig = Math.max(0.3, Math.min(1.5, miss * 0.5));
    tr.err.x = aim.x - (live?.x ?? aim.x);
    tr.err.y = aim.y - (live ? live.y + 1.2 : aim.y);
    tr.err.z = aim.z - (live?.z ?? aim.z);
  }

  /** Suppression shots at a world point - a runner pre-softens the
   *  stand while closing (disc/GL/bolt, whatever the loadout bands
   *  pick). A few degrees of scatter: chip fire, not a snipe. Same
   *  legal spawn + self-blast checks a player shot goes through. */

  firePoint(p: BotBody, point: Vec3): void {
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dx = point.x - muzzle.x, dy = point.y - muzzle.y, dz = point.z - muzzle.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt = this.pickWeapon(lo, Math.hypot(dx, dz), dist, p.id);
    if (!this.rateOk(p.id, wt)) {return;}
    weaponStats.recordShot(this.room.mode, `w${wt}`, dist);
    this.room.events.emit({ type: 'botShot', id: p.id, weapon: wt });
    const dir = { x: dx / dist + j(), y: dy / dist + j(), z: dz / dist + j() };
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir.x /= l; dir.y /= l; dir.z /= l;
    faceLaunch(p, dir); // one-off shot - the throwing flick makes the look honest
    const me2 = this.room.players.getPlayer(p.id);
    if (me2) {this.bloomCone(me2, dir, wt);}
    // Human imperfection: occasionally skip self-splash checks entirely,
    // simulating "fuck it" moments or not paying attention. No absolutes.
    const imperfect = botRand() < 0.05;
    if (this.selfBlast.blastGate(p, { muzzle, dir, wt }, imperfect)) {return;}
    // Self-splash HP gate - a point shot has no target, so no willKill
    // or urgent exception applies: just survive the blast and keep
    // inside the self-damage budget.
    if (this.selfBlast.pointHpVeto(p, wt, dist)) {return;}
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      fireSpeedless(this, p.id, muzzle, dir, wt);
    }
  }


  /** Server-bot bloom: the same seeded cone the intent path applies to
   *  humans - bot shots have no shotId, so a per-arsenal sequence mixes
   *  with the id hash for the draw (deterministic per run order). */
  private bloomSeq = 0;
  private bloomCone(me: { id: string; bloom: number; bloomAt: number }, dir: Vec3, wt: number): void {
    const bs = bloomRadius(me.bloom, me.bloomAt, wt, this.clock / 1000);
    if (bs.radius > 0) {
      const [u1, u2] = jitter01(idSeed(me.id) ^ this.bloomSeq); this.bloomSeq += 1;
      const jd = coneDir(dir, u1 * Math.PI * 2, Math.sqrt(u2) * bs.radius);
      dir.x = jd.x; dir.y = jd.y; dir.z = jd.z;
    }
    me.bloom = bloomGrow(bs.bloom, wt);
    me.bloomAt = this.clock / 1000;
  }


  pickWeapon(lo: BotLoadout, distXZ: number, dist: number, botId?: string, airborne = false): number {
    // Gun-game: the ladder IS the arsenal - kit tables can't offer a
    // weapon the rung gate would refuse anyway.
    if (this.room.mods.gungame === true) {return gunGameWeapon(botId ? this.room.gunRungOf(botId) : 0, this.room.mods.igun === true);}
    const s = botId ? this.skillOfCb(botId) : undefined;
    // Hit-probability folded into proficiency: a ballistic target prices
    // every weapon by flight-time error (splash can't help midair), a
    // grounded one credits aoe's near-miss damage. pHitFactor is the
    // shared scorer - situational picks fall out of physics, no table.
    const skill = s ? (t: number): number => aimSkillFor(s, t, 0) * pHitFactor(t, dist, airborne) : undefined;
    // The wounded-explosive gate lives in shared pickBotWeaponSafe so
    // offline bots get the same self-preservation.
    if (!botId) {return pickBotWeapon(lo, distXZ, dist, skill, s?.courage);}
    const body = this.room.players.getAllPlayers().get(botId);
    const hp = body?.health ?? 100;
    const picked = pickBotWeaponSafe(lo, distXZ, dist, hp, skill, s?.courage);
    const alt = this.deployPickFallback(botId, lo, picked, body?.armorClass);
    if (alt !== undefined) {return alt;}
    return this.classGatePick(lo, picked, body?.armorClass);
  }

  /** Same class gate players get in CombatHandler - the loadout tables
   *  stay honest, but a pick is refused at fire time too, not assumed. */
  private classGatePick(lo: BotLoadout, picked: number, armorClass: string | undefined): number {
    if (classCanFire(armorClass, picked)) {return picked;}
    return [lo.side, lo.near, lo.mid, lo.far].find((w): boolean => classCanFire(armorClass, w)) ?? WeaponType.Disc;
  }

  /** Deploy artillery only draws feet-down. If the band picked a
   *  groundedOnly gun while the body is airborne/skiing, the bot's
   *  real answer is PLANT: firePhase reads deployWanted and parks, so
   *  the next think is feet-down and the artillery actually fires.
   *  While it can't plant instantly, the fallback slot keeps it
   *  shooting instead of dry-pulling. Returns the fallback pick, or
   *  undefined to continue the normal class gate. */
  private deployPickFallback(botId: string, lo: BotLoadout, picked: number, armorClass: string | undefined): number | undefined {
    if (!getWeaponStats(picked).groundedOnly) {this.deployPick.delete(botId); return undefined;}
    const sim = this.room.moveSim.simOf(botId);
    const plantable = Boolean(sim?.state.onGround) && !sim?.input.skiHeld;
    this.deployPick.set(botId, !plantable);
    if (plantable) {return undefined;}
    return [lo.far, lo.mid, lo.near, lo.side]
      .find((w): boolean => !getWeaponStats(w).groundedOnly && classCanFire(armorClass, w));
  }

  /** Belt throw - a lobbed grenade at the hunt's last-seen spot. Same
   *  spawn path as the plasma bolt: RoomProjectiles owns the flight.
   *  Aims at lastSeen, never the live body - a cloaked or occluded
   *  target is only as findable as memory says. */
  throwBelt(p: BotBody): void {
    // Gungame: belt ordnance is off-ladder - the spawn gate would refuse
    // every shell, so don't spend the think on a guaranteed whiff.
    if (this.room.mods.gungame === true) {return;}
    if (!this.lastHunt(p.id)) {return;}
    // Same wounded-explosive gate as the primary pick: a bot under one
    // self-blast's price doesn't throw ordnance that can pop short.
    const s = this.skillOfCb(p.id);
    const nerve = s?.courage ?? 0.5;
    const hp = this.room.players.getAllPlayers().get(p.id)?.health ?? 100;
    const beltWt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    // Hook is a mobility tool, not ordnance - the enemy-throw path fired
    // grapples at players because it's "a belt". Locomotion lobs go
    // through pickHook -> lobAt directly and stay untouched.
    if (beltWt === WeaponType.Hook) {return;}
    const beltSplash = getWeaponStats(beltWt)?.aoeDamage ?? SELF_SPLASH_MAX;
    if (hp <= beltSplash * (1.5 - nerve)) {return;}
    const seen = this.huntSeenCb(p.id);
    if (seen) {this.lobAt(p, seen);}
  }

  /** Lob the belt weapon at an explicit point - used for hunt targets
   *  (the last-seen spot) and for hostile emplacements blocking the
   *  bot's objective. False when the throw was refused (belt dry or
   *  the arc can't clear the shooter's own blast envelope). `riskSelf`
   *  skips the self-splash veto: a besieger hugging a generator must
   *  lob closer than its own blast envelope - eating falloff IS the
   *  sabotage, humans disc a gen point-blank. */
  lobAt(p: BotBody, aim: Vec3 & { vel?: BotVec }, riskSelf = false): boolean {
    // Gungame: every belt throw is off-ladder ordnance - refuse up front
    // rather than relying on each caller to know the room's rules.
    if (this.room.mods.gungame === true) {return false;}
    const want = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const wt = classCanFire(p.armorClass, want) ? want : WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) {return false;}
    // The belt pool pays for every toss - a dry bot's lob intents quietly
    // fizzle until a nugget restocks it (brains see ctx.pickup for that).
    const body = this.room.players.getPlayer(p.id);
    if (body && body.beltCharges < BELT_THROW_COST) {return false;}
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dirN = this.lobDir(p, aim, stats);
    if (!riskSelf && this.selfBlast.selfBlastBlocked(muzzle, dirN, wt, p.velocity, p.id, body?.team ?? undefined)) {return false;}
    if (body) {body.beltCharges -= BELT_THROW_COST;}
    faceLaunch(p, dirN); // the throwing flick - model faces where it lobs
    this.room.projectiles.spawn(p.id, wt, muzzle, dirN, p.velocity);
    return true;
  }

  /** The lob's launch dir: seen-velocity lead (the aim point is a
   *  memory, not the live body - splash belts shrug off a ~5m drift,
   *  a Javelin's 0.25m skewer does not), ballistic θ solved from
   *  range = v²·sin(2θ)/|g| instead of a guessed pitch (the grenade's
   *  13m splash can't cover a 15m overshoot; rails stay flat), then
   *  counter-aimed against the inherited half of the bot's own
   *  velocity - a skiing bot's 10+ m/s of carry still swings a 40 m/s
   *  toss off target (see RoomProjectiles.spawn). */
  private lobDir(p: BotBody, aim: Vec3 & { vel?: BotVec }, stats: NonNullable<ReturnType<typeof getWeaponStats>>): Vec3 {
    let dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    let d = Math.hypot(dx, dz) || 1;
    if (aim.vel) {
      const flight = d / stats.speed;
      dx += aim.vel.x * flight; dz += aim.vel.z * flight;
      d = Math.hypot(dx, dz) || 1;
    }
    let pitch = 0.15;
    if (!stats.rayDelay) {
      const g = Math.abs(GRAVITY);
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const vx = (dir.x / len) * stats.speed - p.velocity.x * 0.5;
    const vy = (dir.y / len) * stats.speed - p.velocity.y * 0.5;
    const vz = (dir.z / len) * stats.speed - p.velocity.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    return { x: vx / vl, y: vy / vl, z: vz / vl };
  }

  /** First push-class AOE weapon in the kit that can actually LAUNCH -
   *  forceMode 'push' (a pull weapon would drag the bot toward its own
   *  feet) and real shove behind it. AoeRadius alone let Bombard (9m of
   *  self-damage, 12 m/s of shard thump) qualify as a jump gun - the
   *  feet blast cost a third of the bot's health and moved it a step. */
  private propelWeapon(lo: BotLoadout): number {
    const pick = [lo.mid, lo.far].find((wt): boolean => {
      const s = getWeaponStats(wt);
      return s && s.aoeRadius > 0 && s.speed > 0 && s.forceMode !== 'pull' && s.knockbackForce >= 20;
    });
    return pick ?? WeaponType.Disc;
  }

  /** Disc-jump / implosion ride. A grounded bot launching a long open run
   *  fires an explosive into the ground at its heels and surfs the blast -
   *  the self-shove lands via processAOE's bot-only branch, so the speed is
   *  real physics, not a cheat impulse. Pull-belt carriers ride forward
   *  instead: lob the implosion ahead and let the pop drag them. Gated to
   *  launches worth a fuse (long run, low speed, tank for the climb);
   *  distant pursuits may boost mid-volley since out-shooting never
   *  closes ground on a fleeing carrier. */
  tryPropel(id: string, p: BotBody, out: BrainOut, goal: { pos: BotVec; runner?: boolean; wave?: boolean } | null, sh: MoveState | null, now: number): void {
    const surge = goal ? Boolean(goal.runner || goal.wave) : false;
    if (!goal || !sh) {return;}
    // Grab edge: the instant a bot becomes carrier his getaway blast
    // re-arms - the approach blasts' cooldown is up to 3.5s dead, and
    // the soak's return-leg autopsy reads carriers dying at ~3% of the
    // route home: they die AT the stand inside that window.
    // Carrier truth lives in the flag sim, not the brain's goal pick -
    // a carrier fighting at the stand can hold a combat goal (running
    // unset) and the feet blast then fires as if he weren't loaded.
    const carrying = this.propelCarrier(id, goal);
    // Self-splash costs real health now. A wounded bot holds fire -
    // except a desperate chaser: a loose enemy carrier far away means
    // the pursuit is already lost without the launch, so it may still
    // pay blood. Never enough to outright suicide on the pad.
    const hp = this.room.players.getAllPlayers().get(id)?.health ?? 100;
    // The wounded gate guards self-splash only - a pull belt's drag costs
    // no hp at all, so a wounded carrier keeps surfing it even when a
    // feet blast would be a suicide.
    const beltPull = getWeaponStats((this.loadouts.get(id) ?? BOT_LOADOUTS[0]!).belt)?.forceMode === 'pull';
    if (this.woundedPropelStop(id, p, sh, hp, carrying, beltPull)) {return;}
    const dx = goal.pos.x - p.position.x, dz = goal.pos.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    const maxHp = this.room.players.getAllPlayers().get(id)?.maxHealth ?? 200;
    const c: PropelCtx = { id, p, out, goal, sh, now, surge, carrying, hp, maxHp, dist, dx, dz, lo: this.loadouts.get(id) ?? BOT_LOADOUTS[0]! };
    if (this.propelCadenceGates(c)) {return;}
    this.propelLaunch(c, beltPull);
  }

  /** Carrier truth lives in the flag sim, not the brain's goal pick -
   *  a carrier fighting at the stand can hold a combat goal (running
   *  unset) and the feet blast then fires as if he weren't loaded.
   *  Also re-arms the getaway blast on the grab edge (the approach
   *  blasts' cooldown is up to 3.5s dead; soak's return-leg autopsy:
   *  carriers die AT the stand inside that window). */
  private propelCarrier(id: string, goal: { pos: BotVec; runner?: boolean; wave?: boolean }): boolean {
    const carrying = this.room.flags
      ? this.room.flagCarriedBy(id)
      : Boolean((goal as { running?: boolean }).running);
    if (carrying && !this.wasCarrying.get(id)) {this.propelT.delete(id);}
    this.wasCarrying.set(id, carrying);
    return carrying;
  }

  /** The wounded gate guards self-splash only - a pull belt's drag
   *  costs no hp at all, so a wounded carrier keeps surfing it even
   *  when a feet blast would be a suicide. true = veto. */
  private woundedPropelStop(id: string, p: BotBody, sh: MoveState, hp: number, carrying: boolean, beltPull: boolean): boolean {
    return hp < 45 && !(beltPull && carrying) && this.woundedPropelVeto(id, p, sh, carrying);
  }

  /** The launch half: pull-surf when the belt allows, crest when the
   *  dirt drops away, heel blast otherwise - plus the post-launch
   *  cooldown + jet pin. */
  private propelLaunch(c: PropelCtx, beltPull: boolean): void {
    // The strike window: inside it a runner refires the moment its speed
    // dips under the ceiling so the LAST blast's shove is still live at
    // ring entry - cadence-firing spends it mid-approach and the capper
    // arrives at ~23m/s inside the defense's kill zone (ring autopsy:
    // in@28mps, 3.0s inside, 0 grabs).
    const strike = c.goal.runner === true && c.dist < T.moves.strikeGd;
    // A pull-belt carrier never feet/crest-blasts: lobbing the implosion
    // ahead drags him forward with ZERO self-splash - the feet blast at
    // the stand is how healthy grabs turned into one-hit carriers
    // (grab re-arm stacked a second blast right after the approach one).
    // The nitron trick powers the APPROACH too - but only once the route
    // has spent real hp: the pull pop is a weaker shove than the feet
    // blast, so a healthy runner pays hp for full-speed launches, then
    // swaps to hp-free pull surfs so the grab still arrives half-alive.
    // A carrier never pays: hp at the flag is the whole game.
    const spendHp = c.goal.runner === true && c.hp > c.maxHp * 0.6;
    if (beltPull && (c.carrying || (c.goal.runner && !spendHp)) && this.pullSurf(c)) {return;}
    // A blast doesn't need contact, it needs dirt close enough to pop
    // inside the shove envelope - a hop-gait transit (wave members:
    // soak spd@13, near0% arrival) is airborne half the time and was
    // falling through to the crest path that almost never qualifies.
    const { p, sh } = c;
    const floor = this.room.field ? Math.max(hmHeight(this.room.field, p.position.x, p.position.z), hmChord(this.room.field, p.position.x, p.position.z)) : p.position.y;
    if (!sh.onGround && p.position.y - floor > 6) {
      this.crestBlast(c, floor);
      return;
    }
    // A long pursuit is allowed to boost mid-engagement - a chaser that
    // must choose between shooting and disc-jumping never catches a
    // carrier. Close goals still don't trade fire for speed - except
    // the runner: dueling interceptors at 60m is how pushes die at ~40m
    // out (ring autopsy: mdD@41m). His clear is the escort's job; his
    // blast is the only pass through.
    if (this.propelShotGates(c, strike)) {return;}
    this.heelOrPull(c);
    // Runners chain on the human cadence (~2.8s between disc-jumps);
    // everyone else pays the full 8s - chaining is blood + ammo, and a
    // bot with somewhere to be trades it gladly while a roamer shouldn't.
    this.propelT.set(c.id, c.now + (c.surge ? 2200 : 8000));
    this.propelJetUntil.set(c.id, c.now + 900); // ride the shove skyward like a real disc-jump
    logger.info('Bot propel', { id: c.id });
  }

  /** Cadence + survivability gates ahead of the launch pick: the chain
   *  refire window (each shove must land before the next, ~1s apart),
   *  the quarter-hp hard floor (a 50% grab-hp budget can't survive the
   *  route - capRun regression: kata never grabbed at all), and the
   *  near-pole stop (the last blast IS the blow-by). true = veto. */
  private propelCadenceGates(c: PropelCtx): boolean {
    if (!this.blastChain(c) && (this.propelT.get(c.id) ?? 0) > c.now) {return true;}
    if (c.goal.runner && c.dist > 60 && c.hp < c.maxHp * 0.25) {return true;}
    // Runners keep the burn going until the pole - the last blast IS
    // the blow-by through the intercept line (overshoot = the grab).
    return c.dist < (c.surge ? 10 : 35);
  }

  /** The chain refire window: inside the strike window a runner refires
   *  the moment its speed dips under the ceiling so the LAST blast's
   *  shove is still live at ring entry; wave members chain too (a tasked
   *  push/escort transiting at the hop-gait mean ~13m/s is food for the
   *  midfield blob - soak "called wave never arrives": d542m, near0%).
   *  Still ~1s apart - each shove must land before the next. */
  private blastChain(c: PropelCtx): boolean {
    const strike = c.goal.runner === true && c.dist < T.moves.strikeGd;
    const waveChain = !strike && c.goal.wave === true;
    const chainCap = strike ? 48 : 30;
    return (strike && c.dist < 80 || waveChain) &&
      Math.hypot(c.sh.vel.x, c.sh.vel.z) < chainCap &&
      (this.propelT.get(c.id) ?? 0) < c.now + 1400;
  }

  /** The last vetoes before the launch pick: a close non-surge goal
   *  doesn't trade fire for speed (a chaser that must choose never
   *  catches a carrier; dueling interceptors at 60m is how pushes die
   *  at ~40m out - ring autopsy mdD@41m), the moving ceiling (12m/s for
   *  roamers, 50/55 inside the surge/strike bands - ring entries at
   *  ~27m/s die in ~3s where a 45m/s blow-through clears it), and the
   *  mild-descent rule (don't buy with a fuse what gravity sells for
   *  free; a STEEP face still earns the flat speed-disc geometry).
   *  No energy gate by design: a heel blast costs ammo + hp, NOT jet
   *  fuel - gating it on a charged tank stranded every trapped climber. */
  private propelShotGates(c: PropelCtx, strike: boolean): boolean {
    if (c.out.fire && !c.surge && c.dist < 60) {return true;}
    let movingCap = 12;
    if (c.surge) {movingCap = strike ? 50 : 55;}
    if (Math.hypot(c.sh.vel.x, c.sh.vel.z) > movingCap) {return true;}
    if (!this.room.field) {return false;}
    const nx0 = c.dx / c.dist, nz0 = c.dz / c.dist;
    const drop40 = c.p.position.y - hmHeight(this.room.field, c.p.position.x + nx0 * 40, c.p.position.z + nz0 * 40);
    return drop40 > 6 && drop40 < 14;
  }

  /** The wounded-bot gate's exception logic: a wounded chaser still
   *  pays blood when the enemy carrier is loose far away or pulling
   *  gap (the pursuit is already lost without the launch), and a
   *  wounded carrier always gets the launch - he dies AT the stand
   *  inside the approach cooldown and drops the flag anyway (leg
   *  autopsy: return deaths at ~2% of route = at the stand). Never
   *  enough to outright suicide on the pad: the weapon's real splash
   *  price is the floor, not a flat constant. true = veto. */
  private woundedPropelVeto(id: string, p: BotBody, sh: MoveState, carrying: boolean): boolean {
    const me = this.room.players.getAllPlayers().get(id);
    const hp = me?.health ?? 100;
    const urgent = this.propelUrgent(id, p, sh, carrying, me);
    const splashDmg = getWeaponStats((this.loadouts.get(id) ?? BOT_LOADOUTS[0]!).near)?.aoeDamage ?? SELF_SPLASH_MAX;
    return !urgent || hp <= splashDmg * perkMods(me?.perk).selfDamage + 5;
  }

  /** Urgent = the chase is lost without the launch: carrying always
   *  counts (a wounded carrier dies AT the stand and drops the flag
   *  anyway), else the enemy carrier is far or the gap is actively
   *  growing - his velocity pulls away along the chase line faster
   *  than the bot closes. */
  private propelUrgent(id: string, p: BotBody, sh: MoveState, carrying: boolean, me: PlayerState | undefined): boolean {
    let thief: string | null = null;
    for (const f of this.room.flags?.flags.values() ?? []) {
      const cid = f.carrier;
      if (cid && cid !== id && this.room.players.getAllPlayers().get(cid)?.team !== me?.team) { thief = cid; break; }
    }
    const carrier = thief ? this.room.players.getAllPlayers().get(thief) : undefined;
    if (!carrier) {return carrying;}
    const gx = carrier.position.x - p.position.x, gz = carrier.position.z - p.position.z;
    const gap = Math.hypot(gx, gz);
    const sep = gap > 60;
    const pulling = gap > 1 &&
      ((carrier.velocity.x - sh.vel.x) * (gx / gap) + (carrier.velocity.z - sh.vel.z) * (gz / gap)) > 4;
    return sep || pulling;
  }

  /** The nitron pull-surf launch: implosion ~18m ahead, the bot's own
   *  approach speed puts it in the pull envelope when the disc pops.
   *  true = propel handled (launched, or vetoed - dry belt or unsafe
   *  arc inside the cap zone where holding is still correct). */
  private pullSurf(c: PropelCtx): boolean {
    const nx = c.dx / c.dist, nz = c.dz / c.dist;
    if (this.lobAt(c.p, { x: c.p.position.x + nx * 18, y: c.p.position.y - 1, z: c.p.position.z + nz * 18 })) {
      this.propelMark(c.id, 'pull', c.now);
      this.propelT.set(c.id, c.now + 3500);
      this.propelJetUntil.set(c.id, c.now + 900);
      logger.info('Bot pull surf', { id: c.id });
      return true;
    }
    // Dry belt or unsafe arc: a carrier still pays hp for speed on the
    // open leg - real cappers disc-jump through the midfield; the no-pay
    // rule exists for the STAND (grab re-arm stacked blasts into
    // one-hit carriers), not for 300m of dry transit where a 5-charge
    // belt is long since spent (capdbg: 2 pulls then nothing - carry
    // held ~32m/s on hop-gait alone). Inside the cap zone or low hp,
    // holding is still correct: a fragile carrier's last blast is the
    // ring entry, not another burn.
    return c.carrying && (c.dist < 120 || c.hp < c.maxHp * 0.45);
  }

  /** Crest blast: jetting up a face, the hill drops away under the bot -
   *  a straight-down shot at its own feet banks the blast as pure
   *  height, the T2 "lose contact, shoot the floor" trick. All the
   *  early outs simply don't launch (caller returns). */
  private crestBlast(c: PropelCtx, floor: number): void {
    const { p, sh, dist } = c;
    if (!this.room.field || dist < 60) {return;}
    if (floor < p.position.y - 18) {return;}         // too high already - blast can't reach the dirt
    if (Math.hypot(sh.vel.x, sh.vel.z) < 8) {return;} // needs real run speed to mean anything
    if (sh.vel.y < -2) {return;}                      // falling - the moment passed
    const wt = this.propelWeapon(c.lo);
    this.room.projectiles.spawn(c.id, wt,
      { x: p.position.x, y: p.position.y + 0.2, z: p.position.z },
      { x: 0, y: -1, z: 0 }, p.velocity);
    this.propelT.set(c.id, c.now + 8000);
    this.propelMark(c.id, 'crest', c.now);
    logger.info('Bot crest blast', { id: c.id });
  }

  /** Pull-preference isn't exclusive: the main-gun heel blast stays in
   *  the toolkit - a pull surfer still disc-jumps off the spinfusor a
   *  share of the time like a human mixing techniques. */
  private heelOrPull(c: PropelCtx): void {
    const { p, id } = c;
    const nx = c.dx / c.dist, nz = c.dz / c.dist;
    const wantsPull = getWeaponStats(c.lo.belt)?.forceMode === 'pull'
      && botRand() < ((this.skillOfCb(id)?.beltPull ?? false) ? 0.8 : 0.4);
    if (wantsPull) {
      // Implosion ~18m ahead - the bot's own approach speed puts it in
      // the pull envelope when the disc pops. A refused lob (dry belt,
      // unsafe arc) still buys the heel blast instead of a dry cooldown.
      if (this.lobAt(p, { x: p.position.x + nx * 18, y: p.position.y - 1, z: p.position.z + nz * 18 })) {
        this.propelMark(id, 'pull', c.now);
      } else {
        this.heelLaunch(c, this.propelWeapon(c.lo), 1.8, classCapsule(p.armorClass).eye);
      }
    } else {
      // Classic disc-jump, angled by the slope: firing back-and-low
      // behind the heels on a descent puts the shove mostly horizontal
      // into the ski line (pure speed), while flat/uphill starts aim
      // under the body so the blast banks as height.
      let back = 1.8, drop = classCapsule(p.armorClass).eye;
      if (this.room.field) {
        const aheadH = hmHeight(this.room.field, p.position.x + nx * 20, p.position.z + nz * 20);
        const slope = p.position.y - aheadH; // >0 means the route falls away
        if (slope > 4) { back = 3; drop *= 0.55; } // speed-disc geometry
      }
      this.heelLaunch(c, this.propelWeapon(c.lo), back, drop);
    }
  }

  /** The heel blast itself: back-and-low behind the heels at `back`/`drop`
   *  - real projectile, real self-shove via processAOE's bot branch. */
  private heelLaunch(c: PropelCtx, wt: number, back: number, drop: number): void {
    const { p, id } = c;
    const nx = c.dx / c.dist, nz = c.dz / c.dist;
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const hx = p.position.x - nx * back - muzzle.x;
    const hy = p.position.y - drop - muzzle.y;
    const hz = p.position.z - nz * back - muzzle.z;
    const len = Math.hypot(hx, hy, hz) || 1;
    this.room.projectiles.spawn(id, wt, muzzle, { x: hx / len, y: hy / len, z: hz / len }, p.velocity);
    this.propelMark(id, 'heel', c.now);
  }
}
