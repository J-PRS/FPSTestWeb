import type { Vec3 } from './types.ts';
import type { BrainOut } from '../../shared/botBrain.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';

/** Sheep meter: fills when a bot plays like a pedestrian (walking under
 *  ski speed or parked) and drains while it does Tribes things (covering
 *  ground, airborne, jetting). At 100 the bot gets yeeted — an impulse
 *  launch plus pinned jets — so the penalty for sheepish play IS the
 *  cure. A slower 5s coverage window catches bots that squeak past the
 *  per-tick speed check but never actually go anywhere. */
export class BotSheepMeter {
  private meter = new Map<string, number>();
  private window = new Map<string, { start: number; dist: number; lx: number; lz: number }>();
  private yeetUntil = new Map<string, number>();
  /** Windows that measure play must run on sim time — wall clock lies
   *  whenever the tick is throttled. */
  private simMs = 0;

  constructor(private room: Room) {}

  step(dt: number): void { this.simMs += dt * 1000; }

  clear(id: string): void {
    this.meter.delete(id);
    this.window.delete(id);
    this.yeetUntil.delete(id);
  }

  of(id: string): number { return Math.round(this.meter.get(id) ?? 0); }
  yeetUntilMs(id: string): number { return this.yeetUntil.get(id) ?? 0; }
  set(id: string, v: number): void { this.meter.set(id, v); }

  check(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; airborne: boolean; hasDest: boolean; dt: number }, now: number): void {
    const speedXZ = Math.hypot(p.velocity.x, p.velocity.z);
    const jetting = !!m.out.move?.jet || this.yeetUntilMs(id) > now;
    const tribesing = speedXZ > 10 || m.airborne || jetting;
    const prev = this.meter.get(id) ?? 0;
    let meter = prev + m.dt * (tribesing
      ? -(10 + speedXZ * 0.5 + (jetting ? 15 : 0))
      : m.hasDest ? 9 : 18);
    meter += this.coverageDebit(id, p, m.hasDest, this.simMs);
    if (meter >= 100) {
      const yaw = Math.random() * Math.PI * 2;
      this.room.moveSim.applyImpulse(id, { x: Math.cos(yaw) * 12, y: 18, z: Math.sin(yaw) * 12 });
      this.yeetUntil.set(id, now + 1500);
      meter = 40;
      logger.warn('Sheep yeet', { room: this.room.name, bot: id });
    } else if (meter < 0) {
      meter = 0;
    } else if (prev < 60 && meter >= 60) {
      logger.info('Sheep meter high', { room: this.room.name, bot: id, meter: Math.round(meter) });
    }
    this.meter.set(id, meter);
  }

  /** Coverage window: under ~30m of real displacement per 5s while the
   *  brain claims a destination reads as sheeping even when the per-tick
   *  speed check squeaks by. Returns the meter debit for the window. */
  coverageDebit(id: string, p: { position: Vec3 }, hasDest: boolean, simMs: number): number {
    let w = this.window.get(id);
    if (!w) { w = { start: simMs, dist: 0, lx: p.position.x, lz: p.position.z }; this.window.set(id, w); }
    w.dist += Math.hypot(p.position.x - w.lx, p.position.z - w.lz);
    w.lx = p.position.x; w.lz = p.position.z;
    if (simMs - w.start < 5000) return 0;
    const owed = hasDest && w.dist < 30 ? 20 : 0;
    w.start = simMs; w.dist = 0;
    return owed;
  }
}
