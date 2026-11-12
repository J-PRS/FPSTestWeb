import type { Terrain } from '../../world/terrain.js';
import { SheepCore, type SheepVec } from '../../../../shared/botSheep.js';
import { isBotId } from '../../../../shared/botNames.js';

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
 * SheepMeter — offline-side adapter over shared/botSheep.ts SheepCore.
 * The verdict math is single-source with the wire meter; this file only
 * translates body/terrain into samples, writes the meter back onto the
 * body (sheep + the ~2s trailing display average), and forwards the
 * maxed warn to the host logger.
 */

interface SheepHost {
  warn(msg: string): void;
}

export class SheepMeter {
  private core = new SheepCore();

  constructor(private h: SheepHost) {}

  /** Advance once per frame — NOT per bot: doing it inside tick() scaled
   *  every 5s window by the roster size. */
  advance(dt: number): void { this.core.step(dt); }

  markShot(id: string): void { this.core.noteFire(id); }

  rekey(oldId: string, newId: string): void { this.core.rekey(oldId, newId); }

  /** >3s since this body last fired — long enough that holding fire in
   *  front of a visible foe is a tell, not a reload beat. */
  notShooting(id: string): boolean { return this.core.notShooting(id); }

  /** Respawn clears the body's meter state — a fresh life starts clean. */
  clear(id: string): void { this.core.clear(id); }

  energyOf(id: string): { ke: number; pe: number; mech: number } | undefined {
    return this.core.energyOf(id);
  }

  /** Test hook — seed the meter directly; accrual tests shouldn't need
   *  to park a bot for 30 simulated seconds to fill the meter. */
  set(id: string, v: number): void { this.core.set(id, v); }

  tick(bot: SheepBody, dt: number, terrain: Terrain, s: {
    foe?: boolean; ignoring?: boolean; hasDest?: boolean; dest?: SheepVec;
    jetting?: boolean; repair?: boolean; busy?: boolean;
  } = {}): void {
    const sh = terrain.getHeight(bot.pos.x, bot.pos.z);
    const height = Number.isFinite(sh) ? Math.max(0, bot.pos.y - sh) : 0;
    const v = this.core.tick(bot.playerId, {
      pos: bot.pos,
      vel: bot.vel,
      height,
      dt,
      foe: s.foe ?? false,
      hasDest: s.hasDest ?? false,
      dest: s.dest,
      jetting: s.jetting,
      repair: s.repair,
      busy: s.busy,
      refusingFire: s.ignoring,
    });
    bot.sheep = v.meter;
    // ~2s trailing average for display — the raw meter jitters ±10/s
    // around the fill/drain boundary, which reads as flicker.
    bot.sheepShown += (bot.sheep - bot.sheepShown) * Math.min(1, dt * 0.5);
    // The meter also runs on the local player for the HUD readout — a
    // parked human is observation, not an agent fault, so only bot ids
    // reach the warn channel (same gate the server meter uses).
    if (v.newlyMaxed && isBotId(bot.playerId)) {
      const w = v.why;
      // dest/foe/busy state at warn-time separates "legal parked hold"
      // (atPost, no foe) from "brain dead under fire" (idle + bleed).
      this.h.warn(
        `bot ${bot.playerId} maxed sheep (why: idle=${w.idle.toFixed(1)} ignore=${w.ignore.toFixed(1)} bleed=${w.bleed.toFixed(1)} cover=${w.cover.toFixed(1)} dest=${s.hasDest ? 'y' : 'n'} foe=${s.foe ? 'y' : 'n'} busy=${s.busy ? 'y' : 'n'}) at (${bot.pos.x.toFixed(0)},${bot.pos.y.toFixed(0)},${bot.pos.z.toFixed(0)})`);
    }
  }
}
