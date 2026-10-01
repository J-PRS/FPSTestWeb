import type { Vec3 } from './types.ts';
import type { BrainOut } from '../../shared/botBrain.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';

/** Sheep meter: fills when a bot plays like a pedestrian (walking under
 *  ski speed or parked) and drains while it does Tribes things (covering
 *  ground, airborne, jetting). At 100 it clamps — the meter is a readout
 *  for badges/telemetry, not a punish lever. A slower 5s coverage window
 *  catches bots that squeak past the per-tick speed check but never
 *  actually go anywhere. */
export class BotSheepMeter {
  private meter = new Map<string, number>();
  private window = new Map<string, { start: number; dist: number; lx: number; ly: number; lz: number }>();
  /** Sim-ms of the bot's last actual fire — the ignore charge needs a
   *  recency window or legal volley cadence (0.8–1.9s between bursts)
   *  reads as passivity and buries every other channel in the ledger. */
  private lastFire = new Map<string, number>();
  /** Per-source charge ledger — dumped into the maxed warn so tuning
   *  reads "why" instead of "that". */
  private why = new Map<string, { idle: number; ignore: number; cover: number }>();
  /** Windows that measure play must run on sim time — wall clock lies
   *  whenever the tick is throttled. */
  private simMs = 0;
  /** Per-bot EMA of mechanical energy ½v²+g·h (J/kg above ground) — the
   *  "recent" term the tribesing credit reads: momentary ground contact
   *  mid-ski doesn't zero the credit the kinetic peak just earned. */
  private eSm = new Map<string, number>();
  /** Bots currently pinned at 100 — dedupes the maxed-warn so a bot
   *  idling at the cap doesn't re-log every tick. */
  private maxed = new Set<string>();

  constructor(private room: Room) {}

  step(dt: number): void { this.simMs += dt * 1000; }

  clear(id: string): void {
    this.meter.delete(id);
    this.window.delete(id);

    this.why.delete(id);
    this.lastFire.delete(id);
    this.eSm.delete(id);
    this.maxed.delete(id);
  }

  of(id: string): number { return Math.round(this.meter.get(id) ?? 0); }
  set(id: string, v: number): void { this.meter.set(id, v); }

  check(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; airborne: boolean; hasDest: boolean; foe?: boolean; dt: number; height?: number }, _now: number): void {
    // Total mechanical energy (kinetic + potential) is the Tribes
    // currency — a fast bot low to the ground and a slow bot on a perch
    // are both holding real E. bonusSpeed converts it back to the
    // equivalent flat-ground speed so the thresholds stay familiar.
    const v = p.velocity;
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
    // Potential counts at half gravity past a 2m deadband — and only
    // while the bot is moving: a parked body at altitude isn't holding
    // energy to convert, it's sleeping on the deposit (the drain-forever
    // bug that kept sleepers at sheep=0).
    const mech = 0.5 * speedSq + (speedSq > 4 ? 4.9 * Math.max(0, (m.height ?? 0) - 2) : 0);
    const ePrev = this.eSm.get(id) ?? mech;
    const eSm = ePrev + (mech - ePrev) * Math.min(1, m.dt * 5);
    this.eSm.set(id, eSm);
    const bonusSpeed = Math.sqrt(Math.max(0, 2 * eSm));
    const jetting = !!m.out.move?.jet;
    // Welding the stand's gear is honest work — a parked welder is
    // productive, not a pedestrian.
    const tribesing = bonusSpeed > 14 || m.airborne || jetting || !!m.out.repair;
    const prev = this.meter.get(id) ?? 0;
    let why = this.why.get(id);
    if (!why) { why = { idle: 0, ignore: 0, cover: 0 }; this.why.set(id, why); }
    const base = this.charge(m, tribesing, bonusSpeed, jetting, why);
    let meter = prev + base;
    // The foe-ignoring charge only counts a PARKED bot — one that's
    // skiing/jetting/covering ground is playing Tribes even while it
    // holds fire.
    if (m.out.fire?.targetId) this.lastFire.set(id, this.simMs);
    meter += this.debits(id, p, m, tribesing, why);

    if (meter >= 100) {
      // The meter is a readout only — a full meter clamps and the bot
      // plays on (the launch penalty is retired: it was a joke mechanic).
      // Dump the ledger once so tuning still reads "why".
      meter = 100;
      this.meter.set(id, meter);
      if (!this.maxed.delete(id)) {
        this.maxed.add(id);
        logger.warn('Sheep meter maxed', { room: this.room.name, bot: id, why: { idle: +why.idle.toFixed(1), ignore: +why.ignore.toFixed(1), cover: +why.cover.toFixed(1) } });
      }
      return;
    }
    this.maxed.delete(id);
    if (meter < 0) {
      meter = 0;
    } else if (prev < 60 && meter >= 60) {
      logger.info('Sheep meter high', { room: this.room.name, bot: id, meter: Math.round(meter) });
    }
    this.meter.set(id, meter);
  }

  /** Fastest cowardice tell: a visible live enemy in range and the
   *  brain elects not to shoot. The 3s recency window matters — volley
   *  pacing means an ENGAGED bot legitimately goes ~2s between shots,
   *  so the charge only counts a sustained refusal to fire. */
  /** Base idle charge — negative while the bot is doing Tribes things.
   *  The drain is rate-capped: a high-E burst (say a 60m/s plummet) used
   *  to bleed a full meter to zero inside a second, reading as a reset.
   *  Faster play still drains faster — just never in a single step. */
  private charge(m: { out: BrainOut; hasDest: boolean; dt: number }, tribesing: boolean, speedXZ: number, jetting: boolean, why: { idle: number }): number {
    const base = m.dt * (tribesing
      ? -Math.min(10 + speedXZ * 0.5 + (jetting ? 15 : 0), 25)
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
