/**
 * BotArsenal — the trigger half of ServerBots: weapon selection, muzzle
 * geometry, ballistic lobs, and the disc-jump propel. Everything a bot
 * fires goes through the same projectiles/botFire paths a client's
 * claims do — this file decides WHEN and AT WHAT, never adjudicates.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { EYE_OFFSET } from '../../shared/constants.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { GRAVITY, type MoveState } from '../../shared/movement.ts';
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
      this.fireFallback(p.id, targetId, muzzle, dir, wt, dist);
    }
  }

  private pickWeapon(lo: BotLoadout, distXZ: number, dist: number): number {
    return pickBotWeapon(lo, distXZ, dist);
  }

  /** Creature targets route through the same claim funnel a client's
   *  creatureHit uses — plausibility check and all — so a bot kill drops
   *  its gem/FFA point identically. */
  private fireAtBall(p: BotBody, ball: number, aim: Vec3): void {
    const dxb = aim.x - p.position.x;
    const dyb = aim.y - p.position.y;
    const dzb = aim.z - p.position.z;
    const lenb = Math.sqrt(dxb * dxb + dyb * dyb + dzb * dzb) || 1;
    const lo = this.loadouts.get(p.id) ?? BOT_LOADOUTS[0]!;
    const wt = this.pickWeapon(lo, Math.hypot(dxb, dzb), lenb);
    this.room.messages.botFire(
      p.id, null,
      { x: p.position.x, y: p.position.y + 1.4, z: p.position.z },
      { x: (dxb / lenb) * BOLT_SPEED, y: (dyb / lenb) * BOLT_SPEED, z: (dzb / lenb) * BOLT_SPEED },
      wt, false,
    );
    if (isSuper(p.id) || Math.random() < Math.max(0.15, 0.6 - lenb / 200)) {
      this.room.ballSim.handleHit(p.id, ball, isSuper(p.id) ? 30 : 8);
    }
  }

  /** Spawn refused (owner gone / hitscan stat line like Chaingun) —
   *  rolled-tracer fallback keeps the bot armed rather than disarmed. */
  private fireFallback(id: string, targetId: string, muzzle: Vec3, dir: Vec3, wt: number, dist: number): void {
    const hit = isSuper(id) || Math.random() < Math.max(0.15, 0.6 - dist / 200);
    this.room.messages.botFire(
      id, hit ? targetId : null, muzzle,
      { x: dir.x * BOLT_SPEED, y: dir.y * BOLT_SPEED, z: dir.z * BOLT_SPEED },
      wt, hit,
    );
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
