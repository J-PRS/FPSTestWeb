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
  private window = new Map<string, { start: number; dist: number; lx: number; ly: number; lz: number }>();
  private yeetUntil = new Map<string, number>();
  /** Sim-ms of the bot's last actual fire — the ignore charge needs a
   *  recency window or legal volley cadence (0.8–1.9s between bursts)
   *  reads as passivity and buries every other channel in the ledger. */
  private lastFire = new Map<string, number>();
  /** Per-source charge ledger since the last yeet — dumped into the
   *  yeet warn so tuning reads "why" instead of "that". */
  private why = new Map<string, { idle: number; ignore: number; cover: number }>();
  /** Windows that measure play must run on sim time — wall clock lies
   *  whenever the tick is throttled. */
  private simMs = 0;

  constructor(private room: Room) {}

  step(dt: number): void { this.simMs += dt * 1000; }

  clear(id: string): void {
    this.meter.delete(id);
    this.window.delete(id);
    this.yeetUntil.delete(id);
    this.why.delete(id);
    this.lastFire.delete(id);
  }

  of(id: string): number { return Math.round(this.meter.get(id) ?? 0); }
  yeetUntilMs(id: string): number { return this.yeetUntil.get(id) ?? 0; }
  set(id: string, v: number): void { this.meter.set(id, v); }

  /** Returns true on the tick the yeet fires — ServerBots uses the edge
   *  to press the bot's own jump input once. */
  check(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; airborne: boolean; hasDest: boolean; foe?: boolean; dt: number }, now: number): boolean {
    const speedXZ = Math.hypot(p.velocity.x, p.velocity.z);
    const jetting = !!m.out.move?.jet || this.yeetUntilMs(id) > now;
    const tribesing = speedXZ > 10 || m.airborne || jetting;
    const prev = this.meter.get(id) ?? 0;
    let why = this.why.get(id);
    if (!why) { why = { idle: 0, ignore: 0, cover: 0 }; this.why.set(id, why); }
    const base = this.charge(m, tribesing, speedXZ, jetting, why);
    let meter = prev + base;
    // The foe-ignoring charge only counts a PARKED bot — one that's
    // skiing/jetting/covering ground is playing Tribes even while it
    // holds fire, and charging it produces a yeet loop: meter lands at
    // 40 post-yeet and an unlucky perch re-fills in ~1s forever. The 3s
    // grace after a yeet is the same fix: the bot is airborne mid-yeet
    // then must land and re-acquire — charging during that window is
    // the loop the previous comment described.
    if (m.out.fire?.targetId) this.lastFire.set(id, this.simMs);
    if ((this.yeetUntil.get(id) ?? -Infinity) + 3000 <= now)
      meter += this.debits(id, p, m, tribesing, why);

    if (meter >= 100) {
      // The yeet is pinned INPUT, not injected velocity — ServerBots
      // holds the bot's jump+jets for the window, exactly the keys a
      // player would press. A direct impulse would be a move no legal
      // player can make.
      this.yeetUntil.set(id, now + 1500);
      meter = 40;
      this.meter.set(id, meter);
      this.why.set(id, { idle: 0, ignore: 0, cover: 0 });
      logger.warn('Sheep yeet', { room: this.room.name, bot: id, why: { idle: +why.idle.toFixed(1), ignore: +why.ignore.toFixed(1), cover: +why.cover.toFixed(1) } });
      return true;
    } else if (meter < 0) {
      meter = 0;
    } else if (prev < 60 && meter >= 60) {
      logger.info('Sheep meter high', { room: this.room.name, bot: id, meter: Math.round(meter) });
    }
    this.meter.set(id, meter);
    return false;
  }

  /** Fastest cowardice tell: a visible live enemy in range and the
   *  brain elects not to shoot. The 3s recency window matters — volley
   *  pacing means an ENGAGED bot legitimately goes ~2s between shots,
   *  so the charge only counts a sustained refusal to fire. */
  /** Base idle charge — negative while the bot is doing Tribes things. */
  private charge(m: { out: BrainOut; hasDest: boolean; dt: number }, tribesing: boolean, speedXZ: number, jetting: boolean, why: { idle: number }): number {
    const base = m.dt * (tribesing
      ? -(10 + speedXZ * 0.5 + (jetting ? 15 : 0))
      : m.hasDest ? 9 : 18);
    if (base > 0) why.idle += base;
    return base;
  }

  /** Post-grace debits: foe-ignoring (only a parked bot — a skiing one
   *  is playing Tribes even while it holds fire) + coverage stall. */
  private debits(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; hasDest: boolean; foe?: boolean; dt: number }, tribesing: boolean, why: { idle: number; ignore: number; cover: number }): number {
    const ig = tribesing ? 0 : this.ignoreDebit(id, m);
    const cov = this.coverageDebit(id, p, m.hasDest, this.simMs);
    why.ignore += ig; why.cover += cov;
    return ig + cov;
  }

  private ignoreDebit(id: string, m: { out: BrainOut; foe?: boolean; dt: number }): number {
    return m.foe && this.simMs - (this.lastFire.get(id) ?? -Infinity) > 3000 ? m.dt * 40 : 0;
  }

  /** Coverage window: under ~30m of real displacement per 5s while the
   *  brain claims a destination reads as sheeping even when the per-tick
   *  speed check squeaks by. Returns the meter debit for the window. */
  coverageDebit(id: string, p: { position: Vec3 }, hasDest: boolean, simMs: number): number {
    let w = this.window.get(id);
    if (!w) { w = { start: simMs, dist: 0, lx: p.position.x, ly: p.position.y, lz: p.position.z }; this.window.set(id, w); }
    // 3D displacement — XZ-only reads a bot grinding up a steep
    // slope (half of every T2 port) as covering no ground.
    w.dist += Math.hypot(p.position.x - w.lx, p.position.y - w.ly, p.position.z - w.lz);
    w.lx = p.position.x; w.ly = p.position.y; w.lz = p.position.z;
    if (simMs - w.start < 5000) return 0;
    const owed = hasDest && w.dist < 30 ? 20 : 0;
    w.start = simMs; w.dist = 0;
    return owed;
  }
}
