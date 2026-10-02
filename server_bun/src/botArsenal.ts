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
import { GRAVITY, type MoveState } from '../../shared/movement.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { botRand } from '../../shared/botRand.ts';
import type { BotVec, BrainOut } from '../../shared/botBrain.ts';
import { fireAtBall as beamAtBall, fireSpeedless as beamSpeedless, type BeamHost } from './botBeam.ts';
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
  /** Last shot time per bot — the weapon-rate gate that keeps a fast
   *  brain cadence from out-shooting the drawn weapon's legal rate. */
  private lastShot = new Map<string, number>();
  /** Sim clock — the rate gate compares in sim-ms, not wall time, so
   *  scenario tests and slow-tick servers measure the same cadence. */
  private clock = 0;
  /** Launch telemetry per bot: heel blast / pull surf / crest pop —
   *  the soak report reads this to prove disc-jumps actually fire. */
  readonly propels = new Map<string, { heel: number; pull: number; crest: number }>();
  private propelMark(id: string, kind: 'heel' | 'pull' | 'crest'): void {
    const s = this.propels.get(id) ?? { heel: 0, pull: 0, crest: 0 };
    s[kind]++; this.propels.set(id, s);
  }

  constructor(
    public room: Room,
    public loadouts: Map<string, BotLoadout>,
    private lastHuntCb: (botId: string) => string | null,
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
    this.lastShot.delete(id);
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
    weaponStats.recordShot(this.room.mode, `w${wt}`);
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
    if (!this.room.projectiles.spawn(p.id, wt, muzzle, dir, p.velocity)) {
      beamSpeedless(this, p.id, muzzle, dir, wt);
    }
  }

  pickWeapon(lo: BotLoadout, distXZ: number, dist: number, botId?: string): number {
    const s = botId ? this.skillOfCb(botId) : undefined;
    return pickBotWeapon(lo, distXZ, dist, s ? (t) => aimSkillFor(s, t, 0) : undefined);
  }

  /** Belt throw — a lobbed grenade at the hunt's last-seen spot. Same
   *  spawn path as the plasma bolt: RoomProjectiles owns the flight. */
  throwBelt(p: BotBody): void {
    const hunt = this.room.players.getPlayer(this.lastHunt(p.id) ?? '');
    if (hunt) this.lobAt(p, hunt.position);
  }

  /** Lob the belt weapon at an explicit point — used for hunt targets
   *  and for hostile emplacements blocking the bot's objective. */
  lobAt(p: BotBody, aim: Vec3): void {
    const wt = this.loadouts.get(p.id)?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    if (!stats || stats.speed <= 0) return;
    // The belt pool pays for every toss — a dry bot's lob intents quietly
    // fizzle until a nugget restocks it (brains see ctx.pickup for that).
    const body = this.room.players.getPlayer(p.id);
    if (body && body.beltCharges < BELT_THROW_COST) return;
    if (body) body.beltCharges -= BELT_THROW_COST;
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
    this.room.projectiles.spawn(p.id, wt,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: vx / vl, y: vy / vl, z: vz / vl }, p.velocity);
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
  tryPropel(id: string, p: BotBody, out: BrainOut, goal: { pos: BotVec } | null, sh: MoveState | null, now: number): void {
    if (!goal || !sh) return;
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
      let urgent = false;
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
      if (!urgent || hp < 35) return;
    }
    if ((this.propelT.get(id) ?? 0) > now) return;
    const dx = goal.pos.x - p.position.x, dz = goal.pos.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 35) return;
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
      this.propelMark(id, 'crest');
      logger.info('Bot crest blast', { id });
      return;
    }
    // A long pursuit is allowed to boost mid-engagement — a chaser that
    // must choose between shooting and disc-jumping never catches a
    // carrier. Close goals still don't trade fire for speed.
    if (out.fire && dist < 60) return;
    if (Math.hypot(sh.vel.x, sh.vel.z) > 12) return; // already moving — boost is for launches
    if ((this.room.moveSim.energyOf(id) ?? 0) < 30) return;
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
      // the pull envelope when the disc pops.
      this.lobAt(p, { x: p.position.x + nx * 18, y: p.position.y - 1, z: p.position.z + nz * 18 });
      this.propelMark(id, 'pull');
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
      this.propelMark(id, 'heel');
    }
    this.propelT.set(id, now + 8000);
    this.propelJetUntil.set(id, now + 900); // ride the shove skyward like a real disc-jump
    logger.info('Bot propel', { id });
  }
}
