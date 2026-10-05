import type { Vec3 } from './types.ts';
import type { BrainOut } from '../../shared/botBrain.ts';
import type { Room } from './Room.ts';
import { logger } from './logger.ts';
import { appendFileSync } from 'node:fs';
import { SheepCore, type SheepVec } from '../../shared/botSheep.ts';
import { isBotId } from '../../shared/botNames.ts';

/** Wire-side sheep adapter — the meter itself lives in
 *  shared/botSheep.ts so wire humans, offline bots, and the local
 *  player's own readout all get the same verdict on the same inputs.
 *  This file only translates Room state into SheepSamples and owns
 *  the server-specific logging (file divert + 'high' info line). */
export class BotSheepMeter {
  private core = new SheepCore();
  /** Last sim-ms each body's maxed warn fired — a true llama re-maxes
   *  every life, so the alarm needs a cooldown or it floods anyway. */
  private maxWarnedAt = new Map<string, number>();

  constructor(private room: Room) {}

  step(dt: number): void { this.core.step(dt); }

  /** A player's real shot — humans don't emit BrainOut.fire, so the
   *  combat claim path reports fires here and the ignore debit sees
   *  the same recency evidence a bot's own fire intent gives it. */
  noteFire(id: string): void { this.core.noteFire(id); }

  clear(id: string): void { this.core.clear(id); }

  /** No ticks on record = unproven = full meter. */
  of(id: string): number { return this.core.of(id); }
  set(id: string, v: number): void { this.core.set(id, v); }

  check(id: string, p: { position: Vec3; velocity: Vec3 }, m: { out: BrainOut; airborne: boolean; hasDest: boolean; foe?: boolean; dt: number; height?: number }, _now: number): void {
    // The bot's own fire intent refreshes the recency window the same
    // way a human's claim does — an engaged bot in legal volley cadence
    // isn't refusing to shoot.
    if (m.out.fire?.targetId) this.core.noteFire(id);
    const v = this.core.tick(id, {
      pos: p.position,
      vel: p.velocity,
      height: m.height ?? 0,
      dt: m.dt,
      foe: !!m.foe,
      hasDest: m.hasDest,
      dest: m.out.dest,
      jetting: !!m.out.move?.jet,
      repair: !!m.out.repair,
    });
    // Humans get metered for the scoreboard but never warned: a parked
    // human is a playstyle observation, not a broken-agent signal, and
    // the warn channel is for the latter.
    if (!isBotId(id)) return;
    if (v.newlyMaxed) this.warnMaxed(id, v.why);
    else if (v.crossedHigh) logger.info('Sheep meter high', { room: this.room.name, bot: id, meter: v.meter });
  }

  /** Ledger sums are charge points, not seconds — each channel's share
   *  of the fill (pedestrian ticks / refused shots / deadstops / one
   *  patch of ground), so the dominant channel reads at a glance.
   *  Soak runs are flooded by these verdicts (every llama re-maxes per
   *  life), so FPS_SHEEP_LOG diverts them to a file and drops the
   *  console copy to info. */
  private warnMaxed(id: string, why: { idle: number; ignore: number; bleed: number; cover: number }): void {
    if (this.core.now - (this.maxWarnedAt.get(id) ?? -600_000) < 600_000) return;
    this.maxWarnedAt.set(id, this.core.now);
    const whyPts = { idle: +why.idle.toFixed(1), ignore: +why.ignore.toFixed(1), bleed: +why.bleed.toFixed(1), cover: +why.cover.toFixed(1) };
    const sheepLog = process.env.FPS_SHEEP_LOG;
    if (sheepLog) {
      try {
        appendFileSync(sheepLog,
          `${(this.core.now / 1000).toFixed(1)}s ${this.room.name} ${id} idle=${whyPts.idle} ignore=${whyPts.ignore} bleed=${whyPts.bleed} cover=${whyPts.cover}\n`);
      } catch { /* a bad log path must never break a match */ }
      logger.info('Sheep meter maxed', { room: this.room.name, bot: id, whyPts });
    } else {
      logger.warn('Sheep meter maxed', { room: this.room.name, bot: id, whyPts });
    }
  }

  /** Test hook — the 5s coverage window, driven by explicit sim ms. */
  coverageDebit(id: string, p: { position: SheepVec }, hasDest: boolean, simMs: number): number {
    return this.core.coverageDebit(id, p.position, hasDest, simMs);
  }
}
