/**
 * BotArsenal - the trigger half of ServerBots: weapon selection, muzzle
 * geometry, ballistic lobs, and the disc-jump propel. Everything a bot
 * fires goes through the same projectiles/botFire paths a client's
 * claims do - this file decides WHEN and AT WHAT, never adjudicates.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { classCapsule, classCanFire } from '../../shared/botClasses.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S, BELT_THROW_COST, payShotCost, spendAmmo, jitter01, coneDir, bloomRadius, bloomGrow } from '../../shared/weapons.ts';
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

type BotBody = { id: string; position: Vec3; velocity: Vec3; armorClass: string; rotation: { yaw: number; pitch?: number } };

/** The body's look dir from its wire rotation — same convention the
 *  drive writes (yaw=atan2(x,z), pitch positive looks DOWN). A bot's
 *  shots launch along this: the model always faces where it shoots
 *  (Quake's rule — the crosshair IS the view, not a hidden aim var). */
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
   *  regenerates over time. Prevents gradual self-destruction from
   *  repeated self-splash hits that individually pass the per-shot gate. */
  private selfDamageBudget = new Map<string, number>();
  /** groundedOnly picks that lost to the ground rule - true = wants
   *  artillery but is still moving, so the drive should plant it. */
  private deployPick = new Map<string, boolean>();
  /** Held trigger per bot: brains decide press/release cadence and aim
   *  direction - a human holds M1 and tracks, the gun streams at its own
   *  legal rate between thinks. `aim` rides the target's movement so the
   *  brain's lead/error offset is preserved while it drags. */
  private trigger = new Map<string, {
    targetId: string; aim: Vec3; lastPos: Vec3 | null; until: number;
    /** Tracking mode (speed-0 weapons): smooth pursuit, not frozen
     *  offset - `lag` is the pursuit-smoothed target point, `err` an
     *  Ornstein-Uhlenbeck wander whose magnitude scales with how far
     *  off the pull's aim was. Humans hover near target, not on it. */
    lag: Vec3 | null; err: Vec3; track: boolean | undefined; sig: number;
    tv: Vec3 | null; diff: number; wt: number | undefined;
  }>();
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
    private skillOfCb: (botId: string) => BotSkill | undefined = (): undefined => undefined,
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
      if (tr.track) {
        // Smooth pursuit: the aim point chases the live target with a
        // ~100ms lag (a jink pulls ahead honestly). The error is an
        // OU wander weighted along the target's motion axis - real
        // tracking overshoots ahead then lags behind - and its size
        // scales with target unpredictability: a straight-line runner
        // gets tracked clean even by modest aim, a jinking one doesn't.
        if (live) {
          if (!tr.lag) {tr.lag = Object.assign({}, live);}
          // Beams pursue tighter: 0.85/tick is ~230ms of lag = ~2.3m of
          // permanent miss on a strafing target - fair for a lobbed bolt,
          // but a hitscan shaft owes no flight time. 0.96 lands ~45%
          // shaft-uptime on impossible skill (the T:Tribes LG bar) while
          // still leaving jink reaction room.
          const chase = (tr.wt !== undefined && (getWeaponStats(tr.wt)?.speed ?? 1) === 0) ? 0.96 : 0.85;
          tr.lag.x += (live.x - tr.lag.x) * chase;
          tr.lag.y += (live.y - tr.lag.y) * chase;
          tr.lag.z += (live.z - tr.lag.z) * chase;
          // Instantaneous velocity + its turn rate - the difficulty
          // signal humans price in when they decide a shot is easy.
          if (tr.lastPos && dt > 0) {
            const vx = (live.x - tr.lastPos.x) / dt;
            const vy = (live.y - tr.lastPos.y) / dt;
            const vz = (live.z - tr.lastPos.z) / dt;
            const turn = tr.tv ? Math.hypot(vx - tr.tv.x, vy - tr.tv.y, vz - tr.tv.z) : 0;
            tr.tv = { x: vx, y: vy, z: vz };
            const speed = Math.hypot(vx, vy, vz);
            const goal = Math.min(1, speed * 0.02 + turn * 0.04);
            tr.diff += (goal - tr.diff) * 0.3; // ease so one jink tick doesn't flip the grade
          }
        }
        const e = tr.err, s = (dt) ** 0.5;
        // Beams (speed-0) wander far less than projectile aim - a shaft
        // misses through tracking lag, not ballistic uncertainty; full-
        // strength scatter just sweeps the ray across the target instead
        // of dwelling (~22% uptime measured vs the ~85% a human holds).
        const beam = tr.wt !== undefined && (getWeaponStats(tr.wt)?.speed ?? 1) === 0;
        const sig = tr.sig * (0.35 + 1.3 * tr.diff) * (beam ? 0.35 : 1);
        // Unit motion axis for ahead/behind weighting (zero speed → isotropic).
        const v = tr.tv, vl = v ? Math.hypot(v.x, v.y, v.z) : 0;
        const ax = vl > 1 ? v!.x / vl : 1, ay = vl > 1 ? v!.y / vl : 0, az = vl > 1 ? v!.z / vl : 0;
        // Noise: strong along the motion axis (lead/lag oscillation),
        // light perpendicular (settled wobble).
        const n1 = (botRand() - 0.5) * 2, n2 = (botRand() - 0.5) * 2, n3 = (botRand() - 0.5) * 2;
        const dot = n1 * ax + n2 * ay + n3 * az;
        const amp = 1.6 * sig * s;
        e.x += -2.5 * e.x * dt + amp * (n1 * 0.7 + ax * dot * 0.8);
        e.y += -2.5 * e.y * dt + amp * (n2 * 0.7 + ay * dot * 0.8);
        e.z += -2.5 * e.z * dt + amp * (n3 * 0.7 + az * dot * 0.8);
        const tp = tr.lag ?? tr.aim;
        // Stream projectiles (sprinkler hose, chaingun) track like beams
        // but the aim point still owes flight-time lead + gravity drop -
        // the pursuit lag alone lands every bolt behind the runner.
        let leadX = 0, leadY = 0, leadZ = 0;
        if (tr.wt !== undefined) {
          const st = getWeaponStats(tr.wt);
          const p0 = this.room.players.getPlayer(id);
          if (st && st.speed > 0 && p0) {
            const flightT = Math.hypot(tp.x - p0.position.x, tp.y - p0.position.y, tp.z - p0.position.z) / st.speed;
            const v = tr.tv;
            leadX = (v?.x ?? 0) * flightT; leadZ = (v?.z ?? 0) * flightT;
            leadY = st.gravity ? 0.5 * GRAVITY * flightT * flightT : 0;
          }
        }
        tr.aim.x = tp.x + e.x + leadX;
        tr.aim.y = tp.y + 1.2 + e.y + leadY; // capsule midpoint off the feet pos
        tr.aim.z = tp.z + e.z + leadZ;
      } else {
        if (live && tr.lastPos) {
          tr.aim.x += live.x - tr.lastPos.x;
          tr.aim.y += live.y - tr.lastPos.y;
          tr.aim.z += live.z - tr.lastPos.z;
        }
      }
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
    const bdx = aim.x - muzzleB.x, bdy = aim.y - muzzleB.y, bdz = aim.z - muzzleB.z;
    const bl = Math.hypot(bdx, bdy, bdz) || 1;
    const wantB = { x: bdx / bl, y: bdy / bl, z: bdz / bl };
    // Still turning? The pull waits — a shot that leaves before the body
    // has swung on target is a silent aimbot (the model never looked).
    if (!settled(p, wantB)) {return;}
    const fdir = faceDir(p);
    if (targetId.startsWith('b:')) {
      beamAtBall(this, p, Number(targetId.slice(2)), aim, BOT_LOADOUTS[0]!);
      return;
    }
    if (targetId.startsWith('c:')) {
      // Species pops contest the same projectile sweep as balls - fire
      // real shells so a shot can still whiff or body-block, identical
      // to a human's travel time. The projectile detonate pays damage
      // through crawlerHit and scores :prey telemetry.
      const muzzle0 = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
      const cdx = aim.x - muzzle0.x, cdy = aim.y - muzzle0.y, cdz = aim.z - muzzle0.z;
      const cdist = Math.hypot(cdx, cdy, cdz) || 1;
      const lo0 = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
      const wt0 = this.pickWeapon(lo0, Math.hypot(cdx, cdz), cdist, p.id);
      if (!payShotCost(wt0, p.id,
        (id): number | null => this.room.moveSim.energyOf(id),
        (id, n): void => { this.room.moveSim.drainEnergy?.(id, n); })) {return;}
      if (tr.track === undefined) {this.markTrack(tr, wt0, aim);}
      if (!this.rateOk(p.id, wt0)) {return;}
      // Pool ammo - same dry rule humans get on the intent path; bot
      // pools live on their player record and accrue on the sim clock.
      // Deploy weapons obey the same grounded rule humans do - feet on
      // dirt AND not skiing, or the draw itself is refused.
      if (getWeaponStats(wt0).groundedOnly) {
        const sim = this.room.moveSim.simOf(p.id);
        if (!sim?.state.onGround || sim.input.skiHeld) {return;}
      }
      if (!spendAmmo(this.room.players.getPlayer(p.id)?.ammoPool ?? new Map(), wt0, this.clock / 1000)) {return;}
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
      return;
    }
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
    let wt = this.pickWeapon(lo, distXZ, dist, p.id);
    // Finisher pull: a wounded target (<25% hp) tempts the easy hold-out
    // instead of another heroic lob - the sidearm is a chip on a thin
    // target. ~40% of discharges take it; the rest stay on the primary,
    // because going all easy-hit is the dishonorable version.
    if (target.maxHealth > 0 && target.health / target.maxHealth < 0.25 && botRand() < 0.4) {wt = lo.side;}
    // Armor grenade coats everyone in the blast - firing it at an enemy
    // is arming him. Team plating goes through the belt path; a duel
    // never wants this shot.
    if (wt === WeaponType.ArmorGrenade) {return;}
    // Fuse-only carriers (MRV) detonate wherever the shell is at fuse -
    // aim the POP point, not the target. Solve the launch dir that puts
    // the fuse-end position on the target's led position; the ±5% band
    // that used to gate this starved every reach-capped aoe slug (rail,
    // plasma: contact pops, not airbursts - they were refused forever).
    // Bomblets release FORWARD of the pop, so the burst only pays when
    // it lands at-or-just-past the target - a close target gets overflown
    // (MRV's ~82m carry is a >60m weapon; inside the 45m acquire cap it
    // honestly has no shot), and confetti past ~1.4x is waste.
    let fuseSolved = false;
    const stF = getWeaponStats(wt);
    // Arm-gated ordnance under the arm window plays the BOUNCE-SERVE:
    // lob the dirt ~10m AHEAD of the runner's path - the shell thuds,
    // skids forward still cooking, and pops where they're headed.
    // Gate on the BODY arm time: GL's armTime is only its dirt-skip
    // window (bodyArmTime 0 pops bodies at any age), so lobbing the
    // dirt ahead at knife range throws away a hit it already has.
    const bodyArmF = stF?.bodyArmTime ?? stF?.armTime;
    if ((bodyArmF ?? 0) > 0 && stF.speed > 0 && dist < stF.speed * (bodyArmF ?? 0) * 0.35 && dist > 8) {
      const tv = target.velocity, ts = Math.hypot(tv.x, tv.z);
      const lx = ts > 2 ? (tv.x / ts) * 10 : 0, lz = ts > 2 ? (tv.z / ts) * 10 : 0;
      const gx = aim.x + lx, gz = aim.z + lz;
      aim.x = gx; aim.z = gz;
      aim.y = this.room.field ? hmHeight(this.room.field, gx, gz) : aim.y - 1.5;
    }
    // Flak feet-serve, conditionally: a ground-skip beats the LEAD, not
    // the lob - it pays vs fast lateral movers whose jink inside the
    // ~0.3s flight undoes velocity lead, and only on ground they can
    // land/cross. Direct lob wins vs straight runners and standoffs
    // (bench: unconditional serve cost 11% kills).
    else if (wt === WeaponType.Flak && dist > 8 && dist < 30) {
      const tv = target.velocity;
      const ux = dx0 / dist, uz = dz0 / dist; // unit shooter->target
      const lat = Math.abs(tv.x * -uz + tv.z * ux); // lateral speed across the aim axis
      const grounded = (this.room.field ? target.position.y - hmHeight(this.room.field, target.position.x, target.position.z) : 0) < 4;
      if (lat > 8 && grounded) {
        const ts = Math.hypot(tv.x, tv.z) || 1;
        const gx = aim.x + (tv.x / ts) * 4, gz = aim.z + (tv.z / ts) * 4;
        aim.x = gx; aim.z = gz;
        aim.y = this.room.field ? hmHeight(this.room.field, gx, gz) : aim.y - 1.4;
      }
    }
    // Splash-serve for direct-fire aoe guns (PlasmaCannon & friends):
    // vs fast lateral movers at range, aim the dirt under the led point -
    // a whiff becomes a guaranteed splash tag instead of a bolt landing
    // 40m behind them. Straight runners still eat the direct hit.
    else if (stF && stF.aoeRadius > 0 && !stF.fuseOnly && !stF.terrainBounce && (stF.bodyArmTime ?? stF.armTime ?? 0) === 0 && stF.speed > 0 && dist > 20 && dist < 80) {
      const tv = target.velocity;
      const ux = dx0 / dist, uz = dz0 / dist;
      const lat = Math.abs(tv.x * -uz + tv.z * ux);
      if (lat > 8) {
        const gx = aim.x, gz = aim.z;
        aim.y = this.room.field ? hmHeight(this.room.field, gx, gz) : aim.y - 1.4;
      }
    }
    if (stF?.fuseOnly && stF.maxLifetime != null && stF.speed > 0) {
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
        const bx = aim.x - (dx0 / dist) * 10, bz = aim.z - (dz0 / dist) * 10;
        aim.x = bx; aim.z = bz;
        aim.y = this.room.field ? hmHeight(this.room.field, bx, bz) : target.position.y - 1.4;
      } else if (ul > 1.15) {return;} // past ~1.15x carry the burst always overshoots (soak: 282 volleys at 120+m, 0 hits)
      else {aim.x = muzzle.x + qx / sf; aim.y = muzzle.y + qy / sf; aim.z = muzzle.z + qz / sf;}
      fuseSolved = true;
    }
    // Energy-paid weapons (Blaster): bots drain their own moveSim tank
    // through the shared payShotCost gate - same magazine, same bill.
    if (!payShotCost(wt, p.id,
      (id): number | null => this.room.moveSim.energyOf(id),
      (id, n): void => { this.room.moveSim.drainEnergy?.(id, n); })) {return;}
    if (tr.track === undefined) {this.markTrack(tr, wt, aim);}
    if (!this.rateOk(p.id, wt)) {return;}
    // Pool ammo - the cadence gate stamps first so a rate-blocked pull
    // doesn't eat a round; a dry pool then refuses like a dry tank.
    if (getWeaponStats(wt).groundedOnly) {
      const sim = this.room.moveSim.simOf(p.id);
      if (!sim?.state.onGround || sim.input.skiHeld) {return;}
    }
    if (!spendAmmo(this.room.players.getPlayer(p.id)?.ammoPool ?? new Map(), wt, this.clock / 1000)) {return;}
    const recoil = getWeaponStats(wt).recoilImpulse ?? 0;
    if (recoil > 0 && aim) {
      const dl = Math.hypot(aim.x - p.position.x, aim.y - (p.position.y + 1.4), aim.z - p.position.z) || 1;
      this.room.moveSim.applyImpulse(p.id, { x: -(aim.x - p.position.x) / dl * recoil, y: -(aim.y - (p.position.y + 1.4)) / dl * recoil, z: -(aim.z - p.position.z) / dl * recoil }, 3);
    }
    weaponStats.recordShot(this.room.mode, `w${wt}`, dist);
    this.room.events.emit({ type: 'botShot', id: p.id, weapon: wt });
    if (wt === WeaponType.Melee) {
      // The punch IS the player's swing - combat funnels it identically,
      // and the broadcast swing lets observers see the melee. Speed is 0
      // on the stat line so the visual uses the raw aim, not the led dir.
      this.room.messages.botAttack(p.id, targetId, WeaponType.Melee);
      this.room.messages.botFire(p.id, null, muzzle,
        { x: (dx0 / dist) * BOLT_SPEED, y: (dy0 / dist) * BOLT_SPEED, z: (dz0 / dist) * BOLT_SPEED },
        WeaponType.Melee, true);
      return;
    }
    // Ordnance aim = max expected damage over direct vs ground shots -
    // see ordnanceAimY. The blast, not the body, decides where to aim.
    // Radius ≥4 covers plasma-cannon-class slow splash too: a 90m/s bolt
    // can't airshot a skier, but its pop eats whoever stands under it.
    // Fuse-solved shots skip it - the pop point is already the aim.
    const statsW = getWeaponStats(wt);
    if (!fuseSolved && statsW.aoeRadius >= 4) {
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
    // Human imperfection: occasionally skip self-splash checks entirely,
    // simulating "fuck it" moments or not paying attention. No absolutes.
    const imperfect = botRand() < 0.05;
    if (!(imperfect && (getWeaponStats(wt)?.aoeRadius ?? 0) > 0) && this.selfBlastBlocked(muzzle, dir, wt, p.velocity, p.id, this.room.players.getPlayer(p.id)?.team ?? undefined)) {
      return;
    }
    // Self-splash HP gate: don't fire splash weapons if the bot can't
    // survive its own blast at the target's distance. Use the actual
    // splash damage at that range, not the flat SELF_SPLASH_MAX.
    // Heroic exception: if the shot will kill the target, fire anyway
    // (the bot accepts the self-damage for the kill). No rigid rules.
    const statsW2 = getWeaponStats(wt);

    if (statsW2 && statsW2.aoeRadius > 0) {
      const me = this.room.players.getAllPlayers().get(p.id);
      const hp = me?.health ?? 100;
      const selfSplash = aoeDamageAt(Math.max(0.5, dist), wt);
      const willKill = target.health <= statsW2.directDamage;
      // Cumulative self-damage budget: if the bot has taken too much
      // self-damage recently, hold fire unless the shot will kill the
      // target (heroic) or the situation is urgent (carrier chase -
      // a shot at a flag carrier buys cap denial, not a duel).
      const urgent = [...(this.room.flags?.flags.values() ?? [])].some((f): boolean => f.carrier === targetId);
      const budget = this.selfDamageBudget.get(p.id) ?? 100;
      const perk = perkMods(me?.perk);

      if (selfSplash > 0 && !willKill && !urgent) {
        const courage = this.skillOfCb?.(p.id)?.courage ?? 0.5;
        // Courage scales the veto: brave bots (0.9) fire unless HP is below
        // half the self-splash; timid ones (0.3) hold at 2x. No rigid rule.
        const threshold = selfSplash * perk.selfDamage * (2 - courage);
        // Humans sometimes don't pay attention or say "fuck it" - a small
        // chance the bot skips the self-splash check entirely, simulating
        // imperfect decision-making. No absolutes.
        if (!imperfect && hp <= threshold + 5 && botRand() > 0.1) { return; }
        if (budget < selfSplash * perk.selfDamage * 0.5 && botRand() > 0.05) { return; }
      }
      // Decrement budget on fire (regenerates in step())
      if (selfSplash > 0) {
        this.selfDamageBudget.set(p.id, budget - selfSplash * perk.selfDamage);
      }
    }
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      fireSpeedless(this, p.id, muzzle, dir, wt);
    }
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
    if (!(imperfect && (getWeaponStats(wt)?.aoeRadius ?? 0) > 0) && this.selfBlastBlocked(muzzle, dir, wt, p.velocity, p.id, this.room.players.getPlayer(p.id)?.team ?? undefined)) {
      return;
    }
    // Self-splash HP gate - a point shot has no target, so no willKill
    // or urgent exception applies: just survive the blast and keep
    // inside the self-damage budget.
    const statsW2 = getWeaponStats(wt);

    if (statsW2 && statsW2.aoeRadius > 0) {
      const me = this.room.players.getAllPlayers().get(p.id);
      const hp = me?.health ?? 100;
      const selfSplash = aoeDamageAt(Math.max(0.5, dist), wt);
      const budget = this.selfDamageBudget.get(p.id) ?? 100;
      const perk = perkMods(me?.perk);

      if (selfSplash > 0) {
        if (hp <= selfSplash * perk.selfDamage * 1.5 + 5) { return; } // can't survive 1.5 hits
        if (budget < selfSplash * perk.selfDamage * 1) { return; } // budget exhausted
      }
      // Decrement budget on fire (regenerates in step())
      if (selfSplash > 0) {
        this.selfDamageBudget.set(p.id, budget - selfSplash * perk.selfDamage);
      }
    }
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
      const [u1, u2] = jitter01(idSeed(me.id) ^ this.bloomSeq++);
      const jd = coneDir(dir, u1 * Math.PI * 2, Math.sqrt(u2) * bs.radius);
      dir.x = jd.x; dir.y = jd.y; dir.z = jd.z;
    }
    me.bloom = bloomGrow(bs.bloom, wt);
    me.bloomAt = this.clock / 1000;
  }

  /** Self-radius clearance: an AOE shell that detonates on terrain or a
   *  structure inside its own blast radius of the muzzle is a guaranteed
   *  self-splash - humans see the hump between them and the target and
   *  hold the rocket. March the ray fine enough not to skip a lip; if
   *  ground or a wall top crosses it inside the blast envelope, the
   *  shot doesn't exist to be taken. */
  private selfBlastBlocked(muzzle: Vec3, dir: Vec3, wt: WeaponType, ownerVel: Vec3, shooterId?: string, shooterTeam?: string): boolean {
    const stats = getWeaponStats(wt);
    const aoer = stats?.aoeRadius ?? 0;
    if (!this.room.field || !stats || aoer <= 0) {return false;}
    // March the REAL ballistic path, not the aim ray: the shell inherits
    // half the shooter's velocity, so a bot skiing downhill bends every
    // shot below the checked line and clips lips the ray clears (soak
    // autopsy: all self-frag blasts <2m over ground @~6m from muzzle).
    const inh = stats.inherit ?? 0.5;
    const vx = dir.x * stats.speed + ownerVel.x * inh;
    let vy = dir.y * stats.speed + ownerVel.y * inh;
    const vz = dir.z * stats.speed + ownerVel.z * inh;
    const g = stats.gravity ? GRAVITY : 0;
    let px = muzzle.x, py = muzzle.y, pz = muzzle.z;
    let travelled = 0;
    let flightT = 0;
    let hitX: number | null = null, hitY = 0, hitZ = 0;
    // Enemy bodies on the path pop the shell too - an intercept at 5m
    // self-splashes exactly like a lip hit, and "a point-blank trade is
    // a trade" only holds when the blast actually kills him (soak
    // autopsy: most untraded selfK was a foe body eating the shell
    // inside the shooter's blast envelope and surviving it).
    const foes = [...this.room.players.getAllPlayers().values()]
      .filter((q): boolean => q.id !== shooterId && !q.isDead && (!shooterTeam || q.team !== shooterTeam));
    let bodyHit: { health: number } | null = null;
    // Flight pops on segments; this march samples points - a razor lip
    // apex between two samples is invisible to the check but real to
    // the sim (residual lip selfK @4-5m). Fine-march the blast envelope
    // where a pop is lethal, coarse-march the rest of the flight.
    for (let stepN = 0; stepN < 400 && travelled < 80; stepN += 1) {
      const dt = travelled < aoer + 3 ? 0.005 : 0.02;
      vy += g * dt;
      px += vx * dt; py += vy * dt; pz += vz * dt;
      flightT += dt;
      travelled += (vx * vx + vy * vy + vz * vz) ** 0.5 * dt;
      const line = py + stats.bodyRadius;
      const ground = Math.max(hmHeight(this.room.field, px, pz), hmChord(this.room.field, px, pz), this.room.moveSim.structureTop(px, pz));
      if (ground > line) {
        if (travelled < aoer) {return true;}
        hitX = px; hitY = py; hitZ = pz;
        break;
      }
      for (const f of foes) {
        const bx = f.position.x - px, by = f.position.y + 1 - py, bz = f.position.z - pz;
        if (bx * bx + by * by + bz * bz < 2.6) {
          if (travelled < aoer) {
            // Trade test: the pop lands inside our own blast envelope,
            // so the shot only exists if the splash likely kills the
            // body it's about to hit - a sacrifice, not a whiff.
            bodyHit = f.health <= stats.aoeDamage * 0.8 ? f : null;
            if (!bodyHit) {return true;}
          }
          hitX = px; hitY = py; hitZ = pz;
          stepN = 400;
          break;
        }
      }
      if (hitX !== null) {break;}
    }
    // Self-collision ahead: the blast radius is measured shooter→pop at
    // detonation, and a bot skiing INTO his own shot covers real distance
    // during flight - a rocket the muzzle clears still frags him if his
    // velocity delivers him inside the radius by impact time. A body hit
    // that survives the trade test still has to clear this check.
    if (hitX !== null) {
      const sx = muzzle.x + ownerVel.x * flightT - hitX;
      const sy = muzzle.y + ownerVel.y * flightT - hitY;
      const sz = muzzle.z + ownerVel.z * flightT - hitZ;
      // The projection assumes constant speed, but a skier on a descent
      // (or a mid-flight propel - soak autopsy: propelK:0, aimed shots
      // are the lip selfK) gains real m/s before the shell lands. Price
      // the gain a downhill runner actually picks up in-flight (~half
      // his speed again over the short flight), not a full safety band.
      const speedGain = Math.min(6, Math.hypot(ownerVel.x, ownerVel.z) * flightT * 0.5);
      const reach = aoer + speedGain;
      if (sx * sx + sy * sy + sz * sz < reach * reach && !bodyHit) {return true;}
    }
    // Entity intercepts inside the blast envelope: a wandering ball,
    // a species pop, or a teammate body on the muzzle line pops the
    // shell at ITS distance - inside the shooter's own blast radius,
    // for zero enemy damage (soak: point-blank selfK @5m, foe@140m).
    // Enemy bodies stay legal - a point-blank trade is a trade.
    const to = { x: muzzle.x + dir.x * aoer, y: muzzle.y + dir.y * aoer, z: muzzle.z + dir.z * aoer };
    // Enemy domes eat the shell at the field edge - the flight sweep
    // models them (projContact.shieldBlock), the clearance march can't
    // miss what flight will hit: a bot firing across a dome edge pops
    // his own shell inside his own blast envelope.
    if (this.room.deployables.shieldBlock(muzzle, to, shooterId ?? '') !== null) {return true;}
    if (this.room.ballSim?.sweepHit(muzzle, to, 1)) {return true;}
    if (this.room.creatureSim?.sweepHit(muzzle, to, 1)) {return true;}
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === shooterId || q.isDead) {continue;}
      if (shooterTeam && q.team !== shooterTeam) {continue;}
      const ex = q.position.x - muzzle.x, ey = q.position.y - muzzle.y, ez = q.position.z - muzzle.z;
      const t = Math.max(0, Math.min(1, (ex * dir.x + ey * dir.y + ez * dir.z) / aoer));
      const rx = ex - dir.x * aoer * t, ry = ey - dir.y * aoer * t, rz = ez - dir.z * aoer * t;
      if (rx * rx + ry * ry + rz * rz < 4) {return true;}
    }
    return false;
  }

  pickWeapon(lo: BotLoadout, distXZ: number, dist: number, botId?: string): number {
    const s = botId ? this.skillOfCb(botId) : undefined;
    const skill = s ? (t: number): number => aimSkillFor(s, t, 0) : undefined;
    // The wounded-explosive gate lives in shared pickBotWeaponSafe so
    // offline bots get the same self-preservation.
    if (!botId) {return pickBotWeapon(lo, distXZ, dist, skill, s?.courage);}
    const body = this.room.players.getAllPlayers().get(botId);
    const hp = body?.health ?? 100;
    const picked = pickBotWeaponSafe(lo, distXZ, dist, hp, skill, s?.courage);
    const alt = this.deployPickFallback(botId, lo, picked, body?.armorClass);
    if (alt !== undefined) {return alt;}
    // Same class gate players get in CombatHandler - the loadout tables
    // stay honest, but a pick is refused at fire time too, not assumed.
    if (classCanFire(body?.armorClass, picked)) {return picked;}
    return [lo.side, lo.near, lo.mid, lo.far].find((w): boolean => classCanFire(body?.armorClass, w)) ?? WeaponType.Disc;
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
    if (!this.lastHunt(p.id)) {return;}
    // Same wounded-explosive gate as the primary pick: a bot under one
    // self-blast's price doesn't throw ordnance that can pop short.
    const s = this.skillOfCb(p.id);
    const nerve = s?.courage ?? 0.5;
    const hp = this.room.players.getAllPlayers().get(p.id)?.health ?? 100;
    const beltWt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
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
    const want = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const wt = classCanFire(p.armorClass, want) ? want : WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) {return false;}
    // The belt pool pays for every toss - a dry bot's lob intents quietly
    // fizzle until a nugget restocks it (brains see ctx.pickup for that).
    const body = this.room.players.getPlayer(p.id);
    if (body && body.beltCharges < BELT_THROW_COST) {return false;}
    let dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    let d = Math.hypot(dx, dz) || 1;
    // Seen-velocity lead: the aim point is a memory, not the live body -
    // splash belts shrug off a ~5m drift; a Javelin's 0.25m skewer does
    // not. Lead by the same velocity the eye measured, roughly the
    // shell's flat flight time.
    if (aim.vel) {
      const flight = d / stats.speed;
      dx += aim.vel.x * flight; dz += aim.vel.z * flight;
      d = Math.hypot(dx, dz) || 1;
    }
    // Ballistic lob: range = v²·sin(2θ)/|g| - solve θ for the target's
    // distance instead of guessing a pitch, since the grenade's 13m
    // splash can't cover a 15m overshoot. Rails stay flat.
    let pitch = 0.15;
    if (!stats.rayDelay) {
      const g = Math.abs(GRAVITY);
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    // The throw inherits half the bot's velocity (see RoomProjectiles.spawn)
    // - a skiing bot's 10+ m/s of carry still swings a 40 m/s toss off
    // target, so aim the launch against it.
    const vx = (dir.x / len) * stats.speed - p.velocity.x * 0.5;
    const vy = (dir.y / len) * stats.speed - p.velocity.y * 0.5;
    const vz = (dir.z / len) * stats.speed - p.velocity.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dirN = { x: vx / vl, y: vy / vl, z: vz / vl };
    if (!riskSelf && this.selfBlastBlocked(muzzle, dirN, wt, p.velocity, p.id, body?.team ?? undefined)) {return false;}
    if (body) {body.beltCharges -= BELT_THROW_COST;}
    faceLaunch(p, dirN); // the throwing flick - model faces where it lobs
    this.room.projectiles.spawn(p.id, wt, muzzle, dirN, p.velocity);
    return true;
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
    const carrying = this.room.flags
      ? this.room.flagCarriedBy(id)
      : Boolean((goal as { running?: boolean }).running);
    if (carrying && !this.wasCarrying.get(id)) {this.propelT.delete(id);}
    this.wasCarrying.set(id, carrying);
    // Self-splash costs real health now. A wounded bot holds fire -
    // except a desperate chaser: a loose enemy carrier far away means
    // the pursuit is already lost without the launch, so it may still
    // pay blood. Never enough to outright suicide on the pad.
    const hp = this.room.players.getAllPlayers().get(id)?.health ?? 100;
    // The wounded gate guards self-splash only - a pull belt's drag costs
    // no hp at all, so a wounded carrier keeps surfing it even when a
    // feet blast would be a suicide.
    const beltPull = getWeaponStats((this.loadouts.get(id) ?? BOT_LOADOUTS[0]!).belt)?.forceMode === 'pull';
    if (hp < 45 && !(beltPull && carrying)) {
      const me = this.room.players.getAllPlayers().get(id);
      let thief: string | null = null;
      for (const f of this.room.flags?.flags.values() ?? []) {
        const cid = f.carrier;
        if (cid && cid !== id && this.room.players.getAllPlayers().get(cid)?.team !== me?.team) { thief = cid; break; }
      }
      const carrier = thief ? this.room.players.getAllPlayers().get(thief) : undefined;
      // Carrying IS urgency: a wounded carrier that can't blast dies
      // at the stand inside the approach cooldown and drops the flag
      // anyway - the launch buys the run home the grab already paid
      // for (leg autopsy: return deaths at ~2% of route = at the stand).
      let urgent = carrying;
      if (carrier) {
        const gx = carrier.position.x - p.position.x, gz = carrier.position.z - p.position.z;
        const gap = Math.hypot(gx, gz);
        // Urgent = the chase is lost without the launch: carrier far,
        // or the gap is actively growing - carrier velocity pulls away
        // along the chase line faster than the bot closes.
        const sep = gap > 60;
        const pulling = gap > 1 &&
          ((carrier.velocity.x - sh.vel.x) * (gx / gap) + (carrier.velocity.z - sh.vel.z) * (gz / gap)) > 4;
        urgent = sep || pulling;
      }
      // Even a lost chase doesn't buy a funeral: the feet blast costs
      // the weapon's actual splash damage (halved by lightfoot) - under
      // that plus a hair, the "launch" is just a suicide with extra steps.
      // Scale the threshold by the weapon's aoeDamage, not a flat constant,
      // so high-splash weapons (Mortar 80, Bombard 140) veto at realistic
      // HP instead of the generic 30-hp floor.
      const splashDmg = getWeaponStats((this.loadouts.get(id) ?? BOT_LOADOUTS[0]!).near)?.aoeDamage ?? SELF_SPLASH_MAX;
      if (!urgent || hp <= splashDmg * perkMods(me?.perk).selfDamage + 5) {return;}
    }
    const dx = goal.pos.x - p.position.x, dz = goal.pos.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    // The entry blast is a timed instrument, not a cadence: inside the
    // strike window a runner refires the moment its speed dips under the
    // ceiling so the LAST blast's shove is still live at ring entry -
    // cadence-firing spends it mid-approach and the capper arrives at
    // ~23m/s inside the defense's kill zone (ring autopsy: in@28mps,
    // 3.0s inside, 0 grabs).
    const strike = goal.runner === true && dist < T.moves.strikeGd;
    // Wave members chain too: a tasked push/escort transiting at the
    // hop-gait mean (~13m/s) is food for the midfield blob - the soak's
    // whole "called wave never arrives" defect (d542m, near0%, spd@13).
    // Refiring on the speed trigger holds a wave member near his own
    // ceiling instead of decaying back to walking between cadence shots.
    const waveChain = !strike && goal.wave === true;
    const chainCap = strike ? 48 : 30;
    const blastNow = (strike && dist < 80 || waveChain) &&
      Math.hypot(sh.vel.x, sh.vel.z) < chainCap &&
      (this.propelT.get(id) ?? 0) < now + 1400; // still ~1s apart - each shove must land before the next
    if (!blastNow && (this.propelT.get(id) ?? 0) > now) {return;}
    // Hard floor only: a 50% grab-hp budget can't survive the route -
    // propels ARE the speed and starving them flatlines transit (capRun
    // regression: kata never grabbed at all). A quarter-hp floor keeps
    // the grab from arriving one hit from a corpse while the blow-by
    // stays armed inside the ring.
    const maxHp = this.room.players.getAllPlayers().get(id)?.maxHealth ?? 200;
    if (goal.runner && dist > 60 && hp < maxHp * 0.25) {return;}
    // Runners keep the burn going until the pole - the last blast IS
    // the blow-by through the intercept line (overshoot = the grab).
    if (dist < (surge ? 10 : 35)) {return;}
    const lo = this.loadouts.get(id) ?? BOT_LOADOUTS[0]!;
    // A pull-belt carrier never feet/crest-blasts: lobbing the implosion
    // ahead drags him forward with ZERO self-splash - the feet blast at
    // the stand is how healthy grabs turned into one-hit carriers
    // (grab re-arm stacked a second blast right after the approach one).
    // The nitron trick powers the APPROACH too - but only once the route
    // has spent real hp: the pull pop is a weaker shove than the feet
    // blast, so a healthy runner pays hp for full-speed launches, then
    // swaps to hp-free pull surfs so the grab still arrives half-alive.
    // A carrier never pays: hp at the flag is the whole game.
    const spendHp = goal.runner === true && hp > maxHp * 0.6;
    if (beltPull && (carrying || (goal.runner && !spendHp))) {
      const nx = dx / dist, nz = dz / dist;
      if (this.lobAt(p, { x: p.position.x + nx * 18, y: p.position.y - 1, z: p.position.z + nz * 18 })) {
        this.propelMark(id, 'pull', now);
        this.propelT.set(id, now + 3500);
        this.propelJetUntil.set(id, now + 900);
        logger.info('Bot pull surf', { id });
        return;
      }
      // Dry belt or unsafe arc: a carrier still pays hp for speed on the
      // open leg - real cappers disc-jump through the midfield; the no-pay
      // rule exists for the STAND (grab re-arm stacked blasts into
      // one-hit carriers), not for 300m of dry transit where a 5-charge
      // belt is long since spent (capdbg: 2 pulls then nothing - carry
      // held ~32m/s on hop-gait alone). Inside the cap zone or low hp,
      // holding is still correct: a fragile carrier's last blast is the
      // ring entry, not another burn.
      if (carrying && (dist < 120 || hp < maxHp * 0.45)) {return;}
    }
    // A blast doesn't need contact, it needs dirt close enough to pop
    // inside the shove envelope - a hop-gait transit (wave members:
    // soak spd@13, near0% arrival) is airborne half the time and was
    // falling through to the crest path that almost never qualifies.
    const floor = this.room.field ? Math.max(hmHeight(this.room.field, p.position.x, p.position.z), hmChord(this.room.field, p.position.x, p.position.z)) : p.position.y;
    if (!sh.onGround && p.position.y - floor > 6) {
      // Crest blast: jetting up a face, the hill drops away under the
      // bot - a straight-down shot at its own feet banks the blast as
      // pure height, the T2 "lose contact, shoot the floor" trick.
      if (!this.room.field || dist < 60) {return;}
      if (floor < p.position.y - 18) {return;}         // too high already - blast can't reach the dirt
      if (Math.hypot(sh.vel.x, sh.vel.z) < 8) {return;} // needs real run speed to mean anything
      if (sh.vel.y < -2) {return;}                      // falling - the moment passed
      const wt = this.propelWeapon(lo);
      this.room.projectiles.spawn(id, wt,
        { x: p.position.x, y: p.position.y + 0.2, z: p.position.z },
        { x: 0, y: -1, z: 0 }, p.velocity);
      this.propelT.set(id, now + 8000);
      this.propelMark(id, 'crest', now);
      logger.info('Bot crest blast', { id });
      return;
    }
    // A long pursuit is allowed to boost mid-engagement - a chaser that
    // must choose between shooting and disc-jumping never catches a
    // carrier. Close goals still don't trade fire for speed - except
    // the runner: dueling interceptors at 60m is how pushes die at ~40m
    // out (ring autopsy: mdD@41m). His clear is the escort's job; his
    // blast is the only pass through.
    if (out.fire && !surge && dist < 60) {return;}
    // A heel blast at speed is only "wasted" if the bot isn't running a
    // route - a capper's job is SUSTAINED 25-35m/s, and speed decays on
    // every flat stretch, so runners re-blast before the run dies.
    // Holding the 12m/s launch ceiling for everyone else capped route
    // arrivals at ~10-18m/s - inside ring defense's kill zone.
    // The strike window escalates it: inside the defended ring a runner
    // disc-jumps on a tighter cadence and keeps blasting past the usual
    // ceiling - ring entries at ~27m/s die in ~3s where a 45m/s
    // blow-through clears the ring before the defense re-acquires.
    let movingCap = 12;
  if (surge) {movingCap = strike ? 50 : 55;}
    if (Math.hypot(sh.vel.x, sh.vel.z) > movingCap) {return;}
    // No energy gate here by design: a heel blast costs ammo + hp, NOT
    // jet fuel - gating it on a charged tank stranded every trapped
    // climber whose tank was dry from the climb (the massif-pocket soak
    // orbit). Players disc-jump on an empty tank precisely because it's
    // the fuel-free launch.
    // Don't buy with a fuse what gravity sells for free: a mild descent
    // skis to speed without the launch, and the blast's fixed up-share
    // is just wasted hang time. A STEEP face is different - the
    // speed-disc geometry fires nearly flat and trades almost no up-pop.
    if (this.room.field) {
      const nx0 = dx / dist, nz0 = dz / dist;
      const ahead = hmHeight(this.room.field, p.position.x + nx0 * 40, p.position.z + nz0 * 40);
      const drop40 = p.position.y - ahead;
      if (drop40 > 6 && drop40 < 14) {return;}
    }
    const nx = dx / dist, nz = dz / dist;
    // Pull-preference isn't exclusive: the main-gun heel blast stays in
    // the toolkit - a pull surfer still disc-jumps off the spinfusor a
    // share of the time like a human mixing techniques.
    const wantsPull = getWeaponStats(lo.belt)?.forceMode === 'pull'
      && botRand() < ((this.skillOfCb(id)?.beltPull ?? false) ? 0.8 : 0.4);
    if (wantsPull) {
      // Implosion ~18m ahead - the bot's own approach speed puts it in
      // the pull envelope when the disc pops. A refused lob (dry belt,
      // unsafe arc) still buys the heel blast instead of a dry cooldown.
      if (this.lobAt(p, { x: p.position.x + nx * 18, y: p.position.y - 1, z: p.position.z + nz * 18 })) {
        this.propelMark(id, 'pull', now);
      } else {
        const wt0 = this.propelWeapon(lo);
        const muzzle0 = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
        const hy0 = p.position.y - classCapsule(p.armorClass).eye - muzzle0.y;
        const hl0 = Math.hypot(-nx * 1.8, hy0, -nz * 1.8) || 1;
        this.room.projectiles.spawn(id, wt0, muzzle0, { x: (-nx * 1.8) / hl0, y: hy0 / hl0, z: (-nz * 1.8) / hl0 }, p.velocity);
        this.propelMark(id, 'heel', now);
      }
    } else {
      // Classic disc-jump, angled by the slope: firing back-and-low
      // behind the heels on a descent puts the shove mostly horizontal
      // into the ski line (pure speed), while flat/uphill starts aim
      // under the body so the blast banks as height.
      const wt = this.propelWeapon(lo);
      const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
      let back = 1.8, drop = classCapsule(p.armorClass).eye;
      if (this.room.field) {
        const aheadH = hmHeight(this.room.field, p.position.x + nx * 20, p.position.z + nz * 20);
        const slope = p.position.y - aheadH; // >0 means the route falls away
        if (slope > 4) { back = 3; drop *= 0.55; } // speed-disc geometry
      }
      const hx = p.position.x - nx * back - muzzle.x;
      const hy = p.position.y - drop - muzzle.y;
      const hz = p.position.z - nz * back - muzzle.z;
      const len = Math.hypot(hx, hy, hz) || 1;
      this.room.projectiles.spawn(id, wt, muzzle, { x: hx / len, y: hy / len, z: hz / len }, p.velocity);
      this.propelMark(id, 'heel', now);
    }
    // Runners chain on the human cadence (~2.8s between disc-jumps);
    // everyone else pays the full 8s - chaining is blood + ammo, and a
    // bot with somewhere to be trades it gladly while a roamer shouldn't.
    this.propelT.set(id, now + (surge ? 2200 : 8000));
    this.propelJetUntil.set(id, now + 900); // ride the shove skyward like a real disc-jump
    logger.info('Bot propel', { id });
  }
}
