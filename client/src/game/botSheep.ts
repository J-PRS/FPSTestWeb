import { Terrain } from '../world/terrain.js';

/** The meter only reads body state — the same tick runs on bots and on
 *  the local player (playerSheep.ts feeds a Player through this shape). */
export interface SheepBody {
  playerId: string;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  sheep: number;
  sheepShown: number;
}

/**
 * SheepMeter — the anti-pedestrian meter for offline bots. Charged on
 * four channels (idle, ignoring a visible foe, energy bleed, coverage
 * stall) and clamps at 100 — it's a readout, not a lever. Rates
 * mirror the server meter — a bot offline is held to the same
 * standard it is on the wire.
 */

interface SheepHost {
  warn(msg: string): void;
}

export class SheepMeter {
  // Coverage windows run on sim dt, not wall clock — a throttled frame
  // would otherwise mis-measure the distance.
  private cov = new Map<string, { start: number; dist: number; lx: number; ly: number; lz: number }>();
  private simMs = 0;

  /** Last sampled mechanical energy (per unit mass) — the momentum
   *  conservation probe: ½v² + g·height-above-terrain. */
  private eLast = new Map<string, number>();
  /** EMA of the same E — the "recent" term for the tribesing credit:
   *  brief ground contact mid-ski doesn't zero the credit the kinetic
   *  peak just earned. */
  private eSm = new Map<string, number>();

  /** Per-source ledger — positive charge points each channel contributed,
   *  dumped into the warn so tuning reads "why" instead of "that". */
  private why = new Map<string, { idle: number; ignore: number; bleed: number; cover: number }>();
  /** Wall-ms of each bot's last fired shot — the ignore debit needs
   *  recency, not a per-tick fire flag. */
  private lastShot = new Map<string, number>();
  /** Bots currently pinned at 100 — dedupes the maxed warn. */
  private maxedSet = new Set<string>();

  constructor(private h: SheepHost) {}

  /** Advance once per frame — NOT per bot: doing it inside tick() scaled
   *  every 5s window by the roster size. */
  advance(dt: number): void {
    this.simMs += dt * 1000;
  }

  markShot(id: string): void {
    this.lastShot.set(id, performance.now());
  }

  /** >3s since this bot last fired — long enough that holding fire in
   *  front of a visible foe is a tell, not a reload beat. */
  notShooting(id: string): boolean {
    return performance.now() - (this.lastShot.get(id) ?? -Infinity) > 3000;
  }

  /** Respawn clears the bot's meter state — a fresh life starts clean. */
  clear(id: string): void {
    this.eLast.delete(id);
    this.eSm.delete(id);
    this.why.delete(id);
    this.maxedSet.delete(id);
  }

  tick(bot: SheepBody, dt: number, terrain: Terrain, s: { foe?: boolean; ignoring?: boolean; hasDest?: boolean; busy?: boolean } = {}): void {
    const { foe = false, ignoring = false, hasDest = false, busy = false } = s;
    const v = bot.vel;
    const { mech, bonusSpeed } = this.energy(bot, dt, terrain);
    // Welding a stand's gear is honest work — a parked welder is
    // productive, not a pedestrian (mirrors the server meter).
    const tribesing = SheepMeter.isTribesing(bonusSpeed) || busy;
    const moving = Math.hypot(v.x, v.z) > 1;
    const why = this.ledger(bot.playerId);
    // Drain is rate-capped like the server meter — a high-E burst
    // (60m/s plummet) used to zero the meter in a second, reading as
    // a reset. Faster play still drains faster, never in one step.
    let delta = tribesing ? -Math.min(10 + bonusSpeed * 0.5, 25) : moving ? 9 : 18;
    if (!tribesing) why.idle += delta * dt;
    // Parked within reach of a visible enemy and holding fire — the
    // fastest tell. Only counts while NOT tribesing: a bot that's
    // skiing or repositioning is playing even with its finger off.
    if (foe && ignoring && !tribesing) { delta += 40; why.ignore += 40 * dt; }
    // Bleeding total energy without a fight on screen is the deadstop
    // signature — Tribes play is converting height↔speed losslessly,
    // so E stays flat through clean skiing and only drops on
    // face-plants, wall hits, and pedestrian friction.
    const bleed = this.energyBleed(bot, mech, foe);
    why.bleed += bleed;
    bot.sheep += bleed;
    // Coverage is the ground truth — gate it on the weld exemption, not
    // tribesing: a bot going nowhere accrues even if a stale velocity or
    // altitude leak is still crediting it energy.
    const cover = busy ? 0 : this.coverageDebit(bot, hasDest);
    why.cover += cover;
    bot.sheep += cover;
    bot.sheep = Math.max(0, Math.min(100, bot.sheep + delta * dt));
    // ~2s trailing average for display — the raw meter jitters ±10/s
    // around the fill/drain boundary, which reads as flicker.
    bot.sheepShown += (bot.sheep - bot.sheepShown) * Math.min(1, dt * 0.5);
    if (bot.sheep >= 100) this.maxed(bot);
    else this.maxedSet.delete(bot.playerId);
  }

  /** Total mechanical energy (kinetic + potential) is the Tribes
   *  currency — a fast bot low to the ground and a slow bot on a perch
   *  are both holding real E. Returns the instantaneous mech (the bleed
   *  probe reads it) plus bonusSpeed: the EMA converted back to the
   *  equivalent flat-ground speed so thresholds stay familiar.
   *  Potential counts at half gravity past a 2m deadband — and only
   *  while moving: a parked body at altitude isn't holding energy to
   *  convert, it's sleeping on the deposit. */
  private energy(bot: SheepBody, dt: number, terrain: Terrain): { mech: number; bonusSpeed: number } {
    const v = bot.vel;
    const height = Math.max(0, bot.pos.y - terrain.getHeight(bot.pos.x, bot.pos.z));
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
    const mech = 0.5 * speedSq + (speedSq > 4 ? 4.9 * Math.max(0, height - 2) : 0);
    const ePrev = this.eSm.get(bot.playerId) ?? mech;
    const eSm = ePrev + (mech - ePrev) * Math.min(1, dt * 5);
    this.eSm.set(bot.playerId, eSm);
    return { mech, bonusSpeed: Math.sqrt(Math.max(0, 2 * eSm)) };
  }

  private maxed(bot: SheepBody): void {
    // A full meter just sits — the readout is the point (the launch
    // penalty is retired). Dedupe the ledger dump so a bot parked at
    // the cap doesn't re-log every frame.
    if (this.maxedSet.has(bot.playerId)) return;
    this.maxedSet.add(bot.playerId);
    const w = this.why.get(bot.playerId) ?? { idle: 0, ignore: 0, bleed: 0, cover: 0 };
    this.h.warn(
      `bot ${bot.playerId} maxed sheep (why: idle=${w.idle.toFixed(1)} ignore=${w.ignore.toFixed(1)} bleed=${w.bleed.toFixed(1)} cover=${w.cover.toFixed(1)}) at (${bot.pos.x.toFixed(0)},${bot.pos.y.toFixed(0)},${bot.pos.z.toFixed(0)})`);
  }

  private coverageDebit(bot: SheepBody, hasDest: boolean): number {
    const now = this.simMs;
    let w = this.cov.get(bot.playerId);
    if (!w) { w = { start: now, dist: 0, lx: bot.pos.x, ly: bot.pos.y, lz: bot.pos.z }; this.cov.set(bot.playerId, w); }
    // 3D displacement — XZ-only reads a bot grinding up a steep
    // slope (half of every T2 port) as covering no ground.
    w.dist += Math.hypot(bot.pos.x - w.lx, bot.pos.y - w.ly, bot.pos.z - w.lz);
    w.lx = bot.pos.x; w.ly = bot.pos.y; w.lz = bot.pos.z;
    if (now - w.start < 5000) return 0;
    const owed = hasDest && w.dist < 30 ? 20 : 0;
    w.start = now; w.dist = 0;
    return owed;
  }

  /** Instantaneous E loss since last sample, clamped — a bot sliding
   *  to a deadstop bleeds once, not forever. */
  private energyBleed(bot: SheepBody, mech: number, foe: boolean): number {
    const ePrev = this.eLast.get(bot.playerId);
    this.eLast.set(bot.playerId, mech);
    if (ePrev === undefined || mech >= ePrev || foe) return 0;
    return Math.min(8, (ePrev - mech) * 0.08);
  }

  private ledger(id: string): { idle: number; ignore: number; bleed: number; cover: number } {
    let w = this.why.get(id);
    if (!w) { w = { idle: 0, ignore: 0, bleed: 0, cover: 0 }; this.why.set(id, w); }
    return w;
  }

  /** Tribesing = holding or converting real mechanical energy, nothing
   *  else. bonusSpeed is sqrt(2·E_recent): >14 sits above jog speed, so
   *  a body cruising, diving, or riding height↔speed converts drains —
   *  while a low-E hop or a slow fall is just pedestrian motion that
   *  happens to be off the ground. */
  private static isTribesing(bonusSpeed: number): boolean {
    return bonusSpeed > 14;
  }
}
