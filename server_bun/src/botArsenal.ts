/**
 * BotArsenal — the trigger half of ServerBots: weapon selection, muzzle
 * geometry, ballistic lobs, and the disc-jump propel. Everything a bot
 * fires goes through the same projectiles/botFire paths a client's
 * claims do — this file decides WHEN and AT WHAT, never adjudicates.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S, BELT_THROW_COST } from '../../shared/weapons.ts';
import { SELF_SPLASH_MAX } from '../../shared/combat.ts';
import { GRAVITY, type MoveState } from '../../shared/movement.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { botRand } from '../../shared/botRand.ts';
import type { BotVec, BrainOut } from '../../shared/botBrain.ts';
import { fireAtBall as beamAtBall, fireSpeedless, type BeamHost } from './botBeam.ts';
import { isSuper } from './superBot.ts';
import { weaponStats } from './weaponStats.ts';

const BOLT_SPEED = 60; // m/s — the melee swing's visual bolt

// FPS_SUPERBOT knob lives in superBot.ts — leaf import so beam/drive/
// roster don't reach back through this file.

type BotBody = { id: string; position: Vec3; velocity: Vec3; armorClass: string };

export class BotArsenal implements BeamHost {
  /** Propel cooldown + the post-shove jet pin — owned here because only
   *  firing decisions set them; the driver just reads the pin so the
   *  launch impulse rides out like a real disc-jump. */
  private propelT = new Map<string, number>();
  private propelJetUntil = new Map<string, number>();
  private wasCarrying = new Map<string, boolean>();
  /** Last shot time per bot — the weapon-rate gate that keeps a fast
   *  brain cadence from out-shooting the drawn weapon's legal rate. */
  private lastShot = new Map<string, number>();
  /** Sim clock — the rate gate compares in sim-ms, not wall time, so
   *  scenario tests and slow-tick servers measure the same cadence. */
  private clock = 0;
  /** Launch telemetry per bot: heel blast / pull surf / crest pop —
   *  the soak report reads this to prove disc-jumps actually fire. */
  readonly propels = new Map<string, { heel: number; pull: number; crest: number }>();
  private lastPropelAt = new Map<string, number>();
  private propelMark(id: string, kind: 'heel' | 'pull' | 'crest', now: number): void {
    const s = this.propels.get(id) ?? { heel: 0, pull: 0, crest: 0 };
    s[kind]++; this.propels.set(id, s);
    this.lastPropelAt.set(id, now);
  }

  /** Sim-ms of the bot's most recent propel — the selfK autopsy splits
   *  heel-blast frags from aimed-shot suicides on it. */
  lastPropel(id: string): number | undefined { return this.lastPropelAt.get(id); }

  constructor(
    public room: Room,
    public loadouts: Map<string, BotLoadout>,
    private lastHuntCb: (botId: string) => string | null,
    private huntSeenCb: (botId: string) => BotVec | null = () => null,
    /** The shooter brain's skill matrix — biases the draw toward the
     *  gun the bot is actually good with (same bias the senses use,
     *  so advertised weaponSpeed and fired weapon agree). */
    private skillOfCb: (botId: string) => BotSkill | undefined = () => undefined,
  ) {}

  /** BeamHost surface — botBeam resolves super-bot contact through it. */
  lastHunt(id: string): string | null { return this.lastHuntCb(id); }

  /** While > now the bot's jet stays pinned — read by the driver. */
  jetPinUntil(id: string): number {
    return this.propelJetUntil.get(id) ?? 0;
  }

  /** Part of a bot's teardown — see ServerBots.untrack. */
  untrack(id: string): void {
    this.propelT.delete(id);
    this.propelJetUntil.delete(id);
    this.wasCarrying.delete(id);
    this.lastShot.delete(id);
    this.lastPropelAt.delete(id);
  }

  /** Players can't out-run a weapon's rate either — the drawn gun owns
   *  the trigger interval, not the brain's cadence. */
  step(dt: number): void {
    this.clock += dt * 1000;
  }

  rateOk(id: string, wt: number): boolean {
    const interval = (WEAPON_FIRE_INTERVAL_S[wt as WeaponType] ?? 0.1) * 1000;
    if (this.clock - (this.lastShot.get(id) ?? -interval) < interval) return false;
    this.lastShot.set(id, this.clock);
    return true;
  }

  /** Deterministic-world tests drive the arsenal without a room tick —
   *  nudge the sim clock so rate-gating still measures a cadence. */
  testAdvance(ms: number): void {
    this.clock += ms;
  }

  fireAt(p: BotBody, targetId: string, aim: Vec3): void {
    if (targetId.startsWith('b:')) {
      beamAtBall(this, p, Number(targetId.slice(2)), aim, BOT_LOADOUTS[0]!);
      return;
    }
    if (targetId.startsWith('c:')) {
      // Species pops contest the same projectile sweep as balls — fire
      // real shells so a shot can still whiff or body-block, identical
      // to a human's travel time. The projectile detonate pays damage
      // through crawlerHit and scores :prey telemetry.
      const muzzle0 = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
      const cdx = aim.x - muzzle0.x, cdy = aim.y - muzzle0.y, cdz = aim.z - muzzle0.z;
      const cdist = Math.hypot(cdx, cdy, cdz) || 1;
      const lo0 = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
      const wt0 = this.pickWeapon(lo0, Math.hypot(cdx, cdz), cdist, p.id);
      if (!this.rateOk(p.id, wt0)) return;
      weaponStats.recordShot(this.room.mode, `w${wt0}`, cdist);
      if (wt0 === WeaponType.Melee) {
        const stats = getWeaponStats(WeaponType.Melee);
        const bug = this.room.creatureSim.crawlerAt(Number(targetId.slice(2)));
        if (bug && stats && Math.hypot(bug.x - muzzle0.x, bug.y - muzzle0.y, bug.z - muzzle0.z) <= stats.aoeRadius + 1.4) {
          const killed = this.room.creatureSim.handleHit(p.id, bug.id, isSuper(p.id) ? 300 : stats.aoeDamage);
          weaponStats.record(this.room.mode, `w${wt0}:prey`, stats.aoeDamage, killed, true);
        }
        this.room.messages.botAttack(p.id, targetId, WeaponType.Melee);
        this.room.messages.botFire(p.id, null, muzzle0,
          { x: (cdx / cdist) * BOLT_SPEED, y: (cdy / cdist) * BOLT_SPEED, z: (cdz / cdist) * BOLT_SPEED },
          wt0, false);
        return;
      }
      if (!this.room.projectiles.spawn(p.id, wt0, muzzle0,
        { x: cdx / cdist, y: cdy / cdist, z: cdz / cdist }, p.velocity)) {
        fireSpeedless(this, p.id, muzzle0, { x: cdx / cdist, y: cdy / cdist, z: cdz / cdist }, wt0);
      }
      return;
    }
    const target = this.room.players.getPlayer(targetId);
    if (!target || target.isDead) return;
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dx0 = aim.x - muzzle.x, dy0 = aim.y - muzzle.y, dz0 = aim.z - muzzle.z;
    const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0) || 1;
    const distXZ = Math.sqrt(dx0 * dx0 + dz0 * dz0);
    // Range-band weapon select — same judgment a player makes: a fist
    // inside 3m, the hold-out in knife range, hitscan close, the loadout's
    // mid-band primary, rockets at standoff. The fist check rides planar
    // distance: muzzle sits +1.4y over feet, so a flat 3m gap already reads
    // 3.3m+ in 3D and the band could never open.
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt = this.pickWeapon(lo, distXZ, dist, p.id);
    if (!this.rateOk(p.id, wt)) return;
    weaponStats.recordShot(this.room.mode, `w${wt}`, dist);
    if (wt === WeaponType.Melee) {
      // The punch IS the player's swing — combat funnels it identically,
      // and the broadcast swing lets observers see the melee. Speed is 0
      // on the stat line so the visual uses the raw aim, not the led dir.
      this.room.messages.botAttack(p.id, targetId, WeaponType.Melee);
      this.room.messages.botFire(p.id, null, muzzle,
        { x: (dx0 / dist) * BOLT_SPEED, y: (dy0 / dist) * BOLT_SPEED, z: (dz0 / dist) * BOLT_SPEED },
        WeaponType.Melee, true);
      return;
    }
    // The brain's aim already leads by target velocity over real flight
    // time (weaponSpeed hook below) — adding lead here would double it.
    const ax = aim.x - muzzle.x;
    const ay = aim.y - muzzle.y;
    const az = aim.z - muzzle.z;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const dir = { x: ax / alen, y: ay / alen, z: az / alen };
    if (this.selfBlastBlocked(muzzle, dir, wt, p.velocity, p.id, this.room.players.getPlayer(p.id)?.team ?? undefined)) return;
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      fireSpeedless(this, p.id, muzzle, dir, wt);
    }
  }

  /** Self-radius clearance: an AOE shell that detonates on terrain or a
   *  structure inside its own blast radius of the muzzle is a guaranteed
   *  self-splash — humans see the hump between them and the target and
   *  hold the rocket. March the ray fine enough not to skip a lip; if
   *  ground or a wall top crosses it inside the blast envelope, the
   *  shot doesn't exist to be taken. */
  private selfBlastBlocked(muzzle: Vec3, dir: Vec3, wt: WeaponType, ownerVel: Vec3, shooterId?: string, shooterTeam?: string): boolean {
    const stats = getWeaponStats(wt);
    const aoer = stats?.aoeRadius ?? 0;
    if (!this.room.field || !stats || aoer <= 0) return false;
    // March the REAL ballistic path, not the aim ray: the shell inherits
    // half the shooter's velocity, so a bot skiing downhill bends every
    // shot below the checked line and clips lips the ray clears (soak
    // autopsy: all self-frag blasts <2m over ground @~6m from muzzle).
    let vx = dir.x * stats.speed + ownerVel.x * 0.5;
    let vy = dir.y * stats.speed + ownerVel.y * 0.5;
    let vz = dir.z * stats.speed + ownerVel.z * 0.5;
    const g = stats.gravity ? GRAVITY : 0;
    let px = muzzle.x, py = muzzle.y, pz = muzzle.z;
    let travelled = 0;
    let flightT = 0;
    let hitX: number | null = null, hitY = 0, hitZ = 0;
    // Enemy bodies on the path pop the shell too — an intercept at 5m
    // self-splashes exactly like a lip hit, and "a point-blank trade is
    // a trade" only holds when the blast actually kills him (soak
    // autopsy: most untraded selfK was a foe body eating the shell
    // inside the shooter's blast envelope and surviving it).
    const foes = [...this.room.players.getAllPlayers().values()]
      .filter((q) => q.id !== shooterId && !q.isDead && (!shooterTeam || q.team !== shooterTeam));
    let bodyHit: { health: number } | null = null;
    // Flight pops on segments; this march samples points — a razor lip
    // apex between two samples is invisible to the check but real to
    // the sim (residual lip selfK @4-5m). Fine-march the blast envelope
    // where a pop is lethal, coarse-march the rest of the flight.
    for (let stepN = 0; stepN < 400 && travelled < 80; stepN++) {
      const dt = travelled < aoer + 3 ? 0.005 : 0.02;
      vy += g * dt;
      px += vx * dt; py += vy * dt; pz += vz * dt;
      flightT += dt;
      travelled += Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
      const line = py + stats.bodyRadius;
      const ground = Math.max(hmHeight(this.room.field, px, pz), this.room.moveSim.structureTop(px, pz));
      if (ground > line) {
        if (travelled < aoer) return true;
        hitX = px; hitY = py; hitZ = pz;
        break;
      }
      for (const f of foes) {
        const bx = f.position.x - px, by = f.position.y + 1 - py, bz = f.position.z - pz;
        if (bx * bx + by * by + bz * bz < 2.6) {
          if (travelled < aoer) {
            // Trade test: the pop lands inside our own blast envelope,
            // so the shot only exists if the splash likely kills the
            // body it's about to hit — a sacrifice, not a whiff.
            bodyHit = f.health <= stats.aoeDamage * 0.8 ? f : null;
            if (!bodyHit) return true;
          }
          hitX = px; hitY = py; hitZ = pz;
          stepN = 400;
          break;
        }
      }
      if (hitX !== null) break;
    }
    // Self-collision ahead: the blast radius is measured shooter→pop at
    // detonation, and a bot skiing INTO his own shot covers real distance
    // during flight — a rocket the muzzle clears still frags him if his
    // velocity delivers him inside the radius by impact time. A body hit
    // that survives the trade test still has to clear this check.
    if (hitX !== null) {
      const sx = muzzle.x + ownerVel.x * flightT - hitX;
      const sy = muzzle.y + ownerVel.y * flightT - hitY;
      const sz = muzzle.z + ownerVel.z * flightT - hitZ;
      // The projection assumes constant speed, but a skier on a descent
      // (or a mid-flight propel — soak autopsy: propelK:0, aimed shots
      // are the lip selfK) gains real m/s before the shell lands. Price
      // the gain a downhill runner actually picks up in-flight (~half
      // his speed again over the short flight), not a full safety band.
      const speedGain = Math.min(6, Math.hypot(ownerVel.x, ownerVel.z) * flightT * 0.5);
      const reach = aoer + speedGain;
      if (sx * sx + sy * sy + sz * sz < reach * reach && !bodyHit) return true;
    }
    // Entity intercepts inside the blast envelope: a wandering ball,
    // a species pop, or a teammate body on the muzzle line pops the
    // shell at ITS distance — inside the shooter's own blast radius,
    // for zero enemy damage (soak: point-blank selfK @5m, foe@140m).
    // Enemy bodies stay legal — a point-blank trade is a trade.
    const to = { x: muzzle.x + dir.x * aoer, y: muzzle.y + dir.y * aoer, z: muzzle.z + dir.z * aoer };
    // Enemy domes eat the shell at the field edge — the flight sweep
    // models them (projContact.shieldBlock), the clearance march can't
    // miss what flight will hit: a bot firing across a dome edge pops
    // his own shell inside his own blast envelope.
    if (this.room.deployables.shieldBlock(muzzle, to, shooterId ?? '') !== null) return true;
    if (this.room.ballSim?.sweepHit(muzzle, to, 1)) return true;
    if (this.room.creatureSim?.sweepHit(muzzle, to, 1)) return true;
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === shooterId || q.isDead) continue;
      if (shooterTeam && q.team !== shooterTeam) continue;
      const ex = q.position.x - muzzle.x, ey = q.position.y - muzzle.y, ez = q.position.z - muzzle.z;
      const t = Math.max(0, Math.min(1, (ex * dir.x + ey * dir.y + ez * dir.z) / aoer));
      const rx = ex - dir.x * aoer * t, ry = ey - dir.y * aoer * t, rz = ez - dir.z * aoer * t;
      if (rx * rx + ry * ry + rz * rz < 4) return true;
    }
    return false;
  }

  pickWeapon(lo: BotLoadout, distXZ: number, dist: number, botId?: string): number {
    const s = botId ? this.skillOfCb(botId) : undefined;
    const wt = pickBotWeapon(lo, distXZ, dist, s ? (t) => aimSkillFor(s, t, 0) : undefined, s?.courage);
    // Self-preservation with nerve: a blast inside its own radius can
    // cost up to SELF_SPLASH_MAX health — cautious bots (low courage
    // draw) swap to a non-explosive slot early, heroes ride the
    // explosive down to the last hit and eat the occasional self-frag.
    if (botId) {
      const hp = this.room.players.getAllPlayers().get(botId)?.health ?? 100;
      const wstats = getWeaponStats(wt);
      const nerve = (s?.courage ?? 0.5);
      // Two self-splashes frag anyone under ~2×SELF_SPLASH_MAX — trading
      // a point-blank disc is only a win while it can't kill you twice.
      // A stray shell popped early — terrain lip, wandering ball, body
      // block — lands inside the blast edge regardless of target range.
      // Below roughly one self-blast's price, ANY aoe primary is a
      // loaded gun pointed at the holster: swap to a non-explosive.
      // Nerve scales the floor: heroes fly launchers into the grave.
      // The low-hp swap only matters where a blast can still reach back:
      // a shell landing 60m+ away can't splash the shooter, so holstering
      // the launcher at standoff range just spams the sidearm at enemies
      // it can't touch (the Pistol 120m+ shot pile).
      const woundedGate = wstats?.aoeRadius && (
        (dist < wstats.aoeRadius && hp <= (1 - nerve) * (SELF_SPLASH_MAX * 2 + 15)) ||
        (dist < 60 && hp <= SELF_SPLASH_MAX * (1.5 - nerve)));
      if (woundedGate) {
        // Redraw inside the non-explosive shelf by the same band fit —
        // grabbing slot-order's first clean gun made wounded bots spam
        // the hold-out pistol at 80m (the Pistol 1%-accuracy column).
        const alt = pickBotWeapon(lo, distXZ, dist, s ? (t) => aimSkillFor(s, t, 0) : undefined, s?.courage, true);
        if (alt !== wt) return alt;
      }
    }
    return wt;
  }

  /** Belt throw — a lobbed grenade at the hunt's last-seen spot. Same
   *  spawn path as the plasma bolt: RoomProjectiles owns the flight.
   *  Aims at lastSeen, never the live body — a cloaked or occluded
   *  target is only as findable as memory says. */
  throwBelt(p: BotBody): void {
    if (!this.lastHunt(p.id)) return;
    // Same wounded-explosive gate as the primary pick: a bot under one
    // self-blast's price doesn't throw ordnance that can pop short.
    const s = this.skillOfCb(p.id);
    const nerve = s?.courage ?? 0.5;
    const hp = this.room.players.getAllPlayers().get(p.id)?.health ?? 100;
    if (hp <= SELF_SPLASH_MAX * (1.5 - nerve)) return;
    const seen = this.huntSeenCb(p.id);
    if (seen) this.lobAt(p, seen);
  }

  /** Lob the belt weapon at an explicit point — used for hunt targets
   *  (the last-seen spot) and for hostile emplacements blocking the
   *  bot's objective. False when the throw was refused (belt dry or
   *  the arc can't clear the shooter's own blast envelope). */
  lobAt(p: BotBody, aim: Vec3): boolean {
    const wt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) return false;
    // The belt pool pays for every toss — a dry bot's lob intents quietly
    // fizzle until a nugget restocks it (brains see ctx.pickup for that).
    const body = this.room.players.getPlayer(p.id);
    if (body && body.beltCharges < BELT_THROW_COST) return false;
    const dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    const d = Math.hypot(dx, dz) || 1;
    // Ballistic lob: range = v²·sin(2θ)/|g| — solve θ for the target's
    // distance instead of guessing a pitch, since the grenade's 13m
    // splash can't cover a 15m overshoot. Rails stay flat.
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
    // The throw inherits half the bot's velocity (see RoomProjectiles.spawn)
    // — a skiing bot's 10+ m/s of carry still swings a 40 m/s toss off
    // target, so aim the launch against it.
    const vx = (dir.x / len) * stats.speed - p.velocity.x * 0.5;
    const vy = (dir.y / len) * stats.speed - p.velocity.y * 0.5;
    const vz = (dir.z / len) * stats.speed - p.velocity.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dirN = { x: vx / vl, y: vy / vl, z: vz / vl };
    if (this.selfBlastBlocked(muzzle, dirN, wt, p.velocity, p.id, body?.team ?? undefined)) return false;
    if (body) body.beltCharges -= BELT_THROW_COST;
    this.room.projectiles.spawn(p.id, wt, muzzle, dirN, p.velocity);
    return true;
  }

  /** First push-class AOE weapon in the kit — the blast needs forceMode
   *  'push' (a pull weapon would drag the bot toward its own feet). */
  private propelWeapon(lo: BotLoadout): number {
    const pick = [lo.mid, lo.far].find((wt) => {
      const s = getWeaponStats(wt);
      return s && s.aoeRadius > 0 && s.speed > 0 && s.forceMode !== 'pull';
    });
    return pick ?? WeaponType.Disc;
  }

  /** Disc-jump / implosion ride. A grounded bot launching a long open run
   *  fires an explosive into the ground at its heels and surfs the blast —
   *  the self-shove lands via processAOE's bot-only branch, so the speed is
   *  real physics, not a cheat impulse. Pull-belt carriers ride forward
   *  instead: lob the implosion ahead and let the pop drag them. Gated to
   *  launches worth a fuse (long run, low speed, tank for the climb);
   *  distant pursuits may boost mid-volley since out-shooting never
   *  closes ground on a fleeing carrier. */
  tryPropel(id: string, p: BotBody, out: BrainOut, goal: { pos: BotVec; runner?: boolean; wave?: boolean } | null, sh: MoveState | null, now: number): void {
    const surge = goal ? !!(goal.runner || goal.wave) : false;
    if (!goal || !sh) return;
    // Grab edge: the instant a bot becomes carrier his getaway blast
    // re-arms — the approach blasts' cooldown is up to 3.5s dead, and
    // the soak's return-leg autopsy reads carriers dying at ~3% of the
    // route home: they die AT the stand inside that window.
    const carrying = !!(goal as { running?: boolean }).running;
    if (carrying && !this.wasCarrying.get(id)) this.propelT.delete(id);
    this.wasCarrying.set(id, carrying);
    // Self-splash costs real health now. A wounded bot holds fire —
    // except a desperate chaser: a loose enemy carrier far away means
    // the pursuit is already lost without the launch, so it may still
    // pay blood. Never enough to outright suicide on the pad.
    const hp = this.room.players.getAllPlayers().get(id)?.health ?? 100;
    if (hp < 45) {
      const me = this.room.players.getAllPlayers().get(id);
      const thief = [...(this.room.flags?.flags.values() ?? [])]
        .map((f) => f.carrier)
        .find((cid) => cid && cid !== id &&
          this.room.players.getAllPlayers().get(cid)?.team !== me?.team);
      const carrier = thief ? this.room.players.getAllPlayers().get(thief) : undefined;
      // Carrying IS urgency: a wounded carrier that can't blast dies
      // at the stand inside the approach cooldown and drops the flag
      // anyway — the launch buys the run home the grab already paid
      // for (leg autopsy: return deaths at ~2% of route = at the stand).
      let urgent = carrying;
      if (carrier) {
        const gx = carrier.position.x - p.position.x, gz = carrier.position.z - p.position.z;
        const gap = Math.hypot(gx, gz);
        // Urgent = the chase is lost without the launch: carrier far,
        // or the gap is actively growing — carrier velocity pulls away
        // along the chase line faster than the bot closes.
        const sep = gap > 60;
        const pulling = gap > 1 &&
          ((carrier.velocity.x - sh.vel.x) * (gx / gap) + (carrier.velocity.z - sh.vel.z) * (gz / gap)) > 4;
        urgent = sep || pulling;
      }
      // Even a lost chase doesn't buy a funeral: the feet blast costs
      // up to SELF_SPLASH_MAX — under that plus a hair, the "launch" is
      // just a suicide with extra steps.
      if (!urgent || hp <= SELF_SPLASH_MAX + 5) return;
    }
    if ((this.propelT.get(id) ?? 0) > now) return;
    const dx = goal.pos.x - p.position.x, dz = goal.pos.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    // Runners keep the burn going until the pole — the last blast IS
    // the blow-by through the intercept line (overshoot = the grab).
    if (dist < (surge ? 10 : 35)) return;
    const lo = this.loadouts.get(id) ?? BOT_LOADOUTS[0]!;
    if (!sh.onGround) {
      // Crest blast: jetting up a face, the hill drops away under the
      // bot — a straight-down shot at its own feet banks the blast as
      // pure height, the T2 "lose contact, shoot the floor" trick.
      if (!this.room.field || dist < 60) return;
      const floor = hmHeight(this.room.field, p.position.x, p.position.z);
      if (floor > p.position.y - 4) return;          // still on the slope — the grounded path owns this
      if (floor < p.position.y - 18) return;         // too high already — blast can't reach the dirt
      if (Math.hypot(sh.vel.x, sh.vel.z) < 8) return; // needs real run speed to mean anything
      if (sh.vel.y < -2) return;                      // falling — the moment passed
      const wt = this.propelWeapon(lo);
      this.room.projectiles.spawn(id, wt,
        { x: p.position.x, y: p.position.y + 0.2, z: p.position.z },
        { x: 0, y: -1, z: 0 }, p.velocity);
      this.propelT.set(id, now + 8000);
      this.propelMark(id, 'crest', now);
      logger.info('Bot crest blast', { id });
      return;
    }
    // A long pursuit is allowed to boost mid-engagement — a chaser that
    // must choose between shooting and disc-jumping never catches a
    // carrier. Close goals still don't trade fire for speed — except
    // the runner: dueling interceptors at 60m is how pushes die at ~40m
    // out (ring autopsy: mdD@41m). His clear is the escort's job; his
    // blast is the only pass through.
    if (out.fire && !surge && dist < 60) return;
    // A heel blast at speed is only "wasted" if the bot isn't running a
    // route — a capper's job is SUSTAINED 25-35m/s, and speed decays on
    // every flat stretch, so runners re-blast before the run dies.
    // Holding the 12m/s launch ceiling for everyone else capped route
    // arrivals at ~10-18m/s — inside ring defense's kill zone.
    const movingCap = surge ? 30 : 12;
    if (Math.hypot(sh.vel.x, sh.vel.z) > movingCap) return;
    // No energy gate here by design: a heel blast costs ammo + hp, NOT
    // jet fuel — gating it on a charged tank stranded every trapped
    // climber whose tank was dry from the climb (the massif-pocket soak
    // orbit). Players disc-jump on an empty tank precisely because it's
    // the fuel-free launch.
    // Don't buy with a fuse what gravity sells for free: a mild descent
    // skis to speed without the launch, and the blast's fixed up-share
    // is just wasted hang time. A STEEP face is different — the
    // speed-disc geometry fires nearly flat and trades almost no up-pop.
    if (this.room.field) {
      const nx0 = dx / dist, nz0 = dz / dist;
      const ahead = hmHeight(this.room.field, p.position.x + nx0 * 40, p.position.z + nz0 * 40);
      const drop40 = p.position.y - ahead;
      if (drop40 > 6 && drop40 < 14) return;
    }
    const nx = dx / dist, nz = dz / dist;
    // Pull-preference isn't exclusive: the main-gun heel blast stays in
    // the toolkit — a pull surfer still disc-jumps off the spinfusor a
    // share of the time like a human mixing techniques.
    const wantsPull = getWeaponStats(lo.belt)?.forceMode === 'pull'
      && botRand() < ((this.skillOfCb(id)?.beltPull ?? false) ? 0.8 : 0.4);
    if (wantsPull) {
      // Implosion ~18m ahead — the bot's own approach speed puts it in
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
        if (slope > 4) { back = 3.0; drop *= 0.55; } // speed-disc geometry
      }
      const hx = p.position.x - nx * back - muzzle.x;
      const hy = p.position.y - drop - muzzle.y;
      const hz = p.position.z - nz * back - muzzle.z;
      const len = Math.hypot(hx, hy, hz) || 1;
      this.room.projectiles.spawn(id, wt, muzzle, { x: hx / len, y: hy / len, z: hz / len }, p.velocity);
      this.propelMark(id, 'heel', now);
    }
    // Runners chain on the human cadence (~3.5s between disc-jumps);
    // everyone else pays the full 8s — chaining is blood + ammo, and a
    // bot with somewhere to be trades it gladly while a roamer shouldn't.
    this.propelT.set(id, now + (surge ? 3500 : 8000));
    this.propelJetUntil.set(id, now + 900); // ride the shove skyward like a real disc-jump
    logger.info('Bot propel', { id });
  }
}
