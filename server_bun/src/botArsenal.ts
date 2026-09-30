/**
 * BotArsenal — the trigger half of ServerBots: weapon selection, muzzle
 * geometry, ballistic lobs, and the disc-jump propel. Everything a bot
 * fires goes through the same projectiles/botFire paths a client's
 * claims do — this file decides WHEN and AT WHAT, never adjudicates.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { EYE_OFFSET, PLAYER_RADIUS } from '../../shared/constants.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import { GRAVITY, type MoveState } from '../../shared/movement.ts';
import { segFieldHit, segPointDist, segPointT } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import type { BotVec, BrainOut } from '../../shared/botBrain.ts';

const BOLT_SPEED = 60; // m/s visual bolt + hitscan travel is instant

// Demo/debug knob: FPS_SUPERBOT=<id-substring> gives the matching bot
// superpowers — 3× ground speed and a hit roll that never misses.
const SUPERBOT = process.env.FPS_SUPERBOT ?? '';
export const isSuper = (id: string) => SUPERBOT !== '' && id.includes(SUPERBOT);

type BotBody = { id: string; position: Vec3; velocity: Vec3 };

export class BotArsenal {
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

  constructor(
    private room: Room,
    private loadouts: Map<string, BotLoadout>,
    private lastHunt: (botId: string) => string | null,
  ) {}

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

  private rateOk(id: string, wt: number): boolean {
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
      this.fireAtBall(p, Number(targetId.slice(2)), aim);
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
    const wt = this.pickWeapon(lo, distXZ, dist);
    if (!this.rateOk(p.id, wt)) return;
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
      this.fireSpeedless(p.id, muzzle, dir, wt);
    }
  }

  private pickWeapon(lo: BotLoadout, distXZ: number, dist: number): number {
    return pickBotWeapon(lo, distXZ, dist);
  }

  /** Creature targets fire REAL shells — the projectile sim sweeps them
   *  against live balls and pays through handleHit, so a bot kill drops
   *  its gem/FFA point identically to a player's. Melee and projectile-
   *  less weapons keep the honest geometric checks. */
  private fireAtBall(p: BotBody, ball: number, aim: Vec3): void {
    const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
    const dxb = aim.x - muzzle.x;
    const dyb = aim.y - muzzle.y;
    const dzb = aim.z - muzzle.z;
    const lenb = Math.sqrt(dxb * dxb + dyb * dyb + dzb * dzb) || 1;
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt = this.pickWeapon(lo, Math.hypot(dxb, dzb), lenb);
    if (!this.rateOk(p.id, wt)) return;
    if (wt === WeaponType.Melee) {
      // The punch lands if the creature is inside the swing's reach —
      // geometry decides, not a dice roll.
      const b = this.room.ballSim.ballAt(ball);
      const stats = getWeaponStats(WeaponType.Melee);
      if (b && stats) {
        const d = Math.hypot(b.x - muzzle.x, b.y - muzzle.y, b.z - muzzle.z);
        if (d <= stats.aoeRadius + b.radius) {
          this.room.ballSim.handleHit(p.id, ball, isSuper(p.id) ? 300 : stats.aoeDamage);
        }
      }
      return;
    }
    if (!this.room.projectiles.spawn(p.id, wt, muzzle,
      { x: dxb / lenb, y: dyb / lenb, z: dzb / lenb }, p.velocity)) {
      this.fireSpeedless(p.id, muzzle, { x: dxb / lenb, y: dyb / lenb, z: dzb / lenb }, wt);
    }
  }

  /** Projectile-less weapons (beam-class): an honest ray decides contact —
   *  earliest of terrain/wall/player/creature pays, a whiff is a real
   *  miss. Damage lands via the same funnels the projectile paths use. */
  private fireSpeedless(id: string, muzzle: Vec3, dir: Vec3, wt: number): void {
    const stats = getWeaponStats(wt);
    const c = isSuper(id) ? null : this.beamContact(id, muzzle, dir);
    const playerId = isSuper(id) ? this.lastHunt(id) : (c?.playerId ?? null);
    this.room.messages.botFire(id, playerId, muzzle,
      { x: dir.x * BOLT_SPEED, y: dir.y * BOLT_SPEED, z: dir.z * BOLT_SPEED }, wt, !!playerId);
    if (c?.ballId !== undefined && stats) {
      this.room.ballSim.handleHit(id, c.ballId, stats.directDamage || stats.aoeDamage);
    }
  }

  /** First thing a 60m ray actually strikes: terrain face, wall, player
   *  chest, or creature — earliest contact wins, like dischargeRay. */
  private beamContact(shooterId: string, muzzle: Vec3, dir: Vec3, range = 60): { playerId?: string; ballId?: number } | null {
    const end = { x: muzzle.x + dir.x * range, y: muzzle.y + dir.y * range, z: muzzle.z + dir.z * range };
    let bestT = 1;
    if (this.room.field) {
      const th = segFieldHit(muzzle, end, this.room.field);
      if (th) bestT = segPointT(muzzle, end, th);
    }
    const solids = this.room.projectiles.solidColliders;
    if (solids.length) {
      const sh = segSolidHit(muzzle, end, solids);
      if (sh) bestT = Math.min(bestT, segPointT(muzzle, end, sh));
    }
    return this.beamEntityAt(shooterId, muzzle, end, bestT);
  }

  /** Players and creatures the ray reaches before its first world
   *  contact — earliest wins; none = the beam ended in dirt. */
  private beamEntityAt(shooterId: string, muzzle: Vec3, end: Vec3, worldT: number): { playerId?: string; ballId?: number } | null {
    let bestT = worldT;
    let playerId: string | undefined;
    for (const [pid, t] of this.room.players.getAllPlayers()) {
      if (pid === shooterId || t.isDead) continue;
      const c = { x: t.position.x, y: t.position.y + 1.0, z: t.position.z };
      if (segPointDist(muzzle, end, c) > PLAYER_RADIUS + 0.2) continue;
      const tt = segPointT(muzzle, end, c);
      if (tt <= bestT) { bestT = tt; playerId = pid; }
    }
    const bc = this.room.ballSim?.sweepHit(muzzle, end, 0.2);
    if (bc && bc.t <= bestT) return { ballId: bc.id };
    if (playerId !== undefined) return { playerId };
    return worldT < 1 ? {} : null;
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
   *  launches worth a fuse (long run, low speed, tank for the climb) and
   *  never mid-firefight. */
  tryPropel(id: string, p: BotBody, out: BrainOut, goal: { pos: BotVec } | null, sh: MoveState | null, now: number): void {
    if (!goal || !sh?.onGround || out.fire) return;
    if ((this.propelT.get(id) ?? 0) > now) return;
    const dx = goal.pos.x - p.position.x, dz = goal.pos.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 35) return;
    if (Math.hypot(sh.vel.x, sh.vel.z) > 12) return; // already moving — boost is for launches
    if ((this.room.moveSim.energyOf(id) ?? 0) < 30) return;
    const lo = this.loadouts.get(id) ?? BOT_LOADOUTS[0]!;
    const nx = dx / dist, nz = dz / dist;
    if (getWeaponStats(lo.belt)?.forceMode === 'pull') {
      // Implosion ~18m ahead — the bot's own approach speed puts it in
      // the pull envelope when the disc pops.
      this.lobAt(p, { x: p.position.x + nx * 18, y: p.position.y - 1, z: p.position.z + nz * 18 });
    } else {
      // Classic disc-jump: shell into the heels, blast pushes forward+up.
      const wt = this.propelWeapon(lo);
      const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
      const hx = p.position.x - nx * 1.8 - muzzle.x;
      const hy = p.position.y - EYE_OFFSET - muzzle.y;
      const hz = p.position.z - nz * 1.8 - muzzle.z;
      const len = Math.hypot(hx, hy, hz) || 1;
      this.room.projectiles.spawn(id, wt, muzzle, { x: hx / len, y: hy / len, z: hz / len }, p.velocity);
    }
    this.propelT.set(id, now + 8000);
    this.propelJetUntil.set(id, now + 900); // ride the shove skyward like a real disc-jump
    logger.info('Bot propel', { id });
  }
}
