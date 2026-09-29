import type { Vec3 } from './types.ts';
import type { BotBrain } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';

// Stuck leash: ~2m of travel re-arms; a flag carrier gets the short leash
// because a parked carrier stalls the whole match.
const STUCK_DIST = 2;
const STUCK_MS = 5000;
const STUCK_MS_FLAG = 2500;

// Sheep audit: mobile bots should spend a decent slice of travel ticks
// skiing/airborne, and move faster than a walk.
const SHEEP_WIN_MS = 10000;
const SHEEP_MIN_TICKS = 60;
const SHEEP_SKIAIR = 0.5;
const SHEEP_SPEED = 4;

interface StuckState { x: number; z: number; since: number; warned: boolean }
interface SheepState { winStart: number; ticks: number; skiAir: number; air: number; jet: number; dist: number; lx: number; lz: number }

/**
 * Bot mobility watchdog — two alarms that catch "sheepish" behavior in
 * logs rather than in playtests: a stuck warn when an alive bot covers
 * no ground for a few seconds, and a rolling mobility audit that flags
 * bots staying flat-footed while they claim to be travelling.
 */
export class BotWatchdog {
  private stuck = new Map<string, StuckState>();
  private sheep = new Map<string, SheepState>();

  constructor(private roomName: string) {}

  remove(id: string): void {
    this.stuck.delete(id);
    this.sheep.delete(id);
  }

  /** Warn when an alive bot hasn't covered ~2m in a few seconds. Re-arms
   *  each time the bot actually moves, so the log line marks the stall
   *  boundary rather than spamming every tick. Stand-and-shoot is a legal
   *  pick — the timer is parked while the brain holds a combat spot. */
  checkStuck(id: string, pos: Vec3, brain: BotBrain, carryingFlag: boolean, now: number): void {
    let w = this.stuck.get(id);
    if (!w) {
      this.stuck.set(id, { x: pos.x, z: pos.z, since: now, warned: false });
      return;
    }
    const dx = pos.x - w.x, dz = pos.z - w.z;
    if (dx * dx + dz * dz >= STUCK_DIST * STUCK_DIST) {
      w.x = pos.x; w.z = pos.z; w.since = now; w.warned = false;
      return;
    }
    if (!carryingFlag && brain.holding) { w.since = now; return; }
    const leash = carryingFlag ? STUCK_MS_FLAG : STUCK_MS;
    if (!w.warned && now - w.since > leash) {
      w.warned = true;
      logger.warn('Bot stuck', {
        room: this.roomName, bot: id,
        ms: now - w.since, carrying: carryingFlag,
        hunting: brain.currentHuntId !== null,
        pos: { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) },
      });
    }
  }

  /** Rolling mobility audit. 'trying' = the brain has a destination this
   *  tick — defenders parked on a stand don't accrue. Warns once per 10s
   *  window when a mobile bot stays flat-footed: under half of its
   *  travel ticks skiing/airborne, or averaging walking pace. Healthy
   *  mobility is logged too, so a regression is visible not just failures. */
  checkSheep(id: string, pos: Vec3, trying: boolean, ski: boolean, airborne: boolean, jetting: boolean, dtRef: number, now: number): void {
    let s = this.sheep.get(id);
    if (!s) {
      this.sheep.set(id, { winStart: now, ticks: 0, skiAir: 0, air: 0, jet: 0, dist: 0, lx: pos.x, lz: pos.z });
      return;
    }
    const dx = pos.x - s.lx, dz = pos.z - s.lz;
    s.lx = pos.x; s.lz = pos.z;
    if (trying) {
      s.ticks++; s.dist += Math.hypot(dx, dz);
      if (ski || airborne) s.skiAir++;
      // airPct is the honest "dynamic Tribes bot" number — skiHeld on the
      // ground counts as ski, but only real altitude counts as air.
      if (airborne) s.air++;
      if (jetting) s.jet++;
    }
    const winMs = now - s.winStart;
    if (winMs < SHEEP_WIN_MS) return;
    if (s.ticks >= SHEEP_MIN_TICKS) {
      const frac = s.skiAir / s.ticks;
      const avgSpeed = s.dist / (s.ticks * dtRef); // per-tick distance → m/s
      const stats = {
        room: this.roomName, bot: id,
        skiAirPct: Math.round(frac * 100),
        airPct: Math.round((s.air / s.ticks) * 100),
        jetPct: Math.round((s.jet / s.ticks) * 100),
        avgSpeed: +avgSpeed.toFixed(1),
        covered: +s.dist.toFixed(1),
      };
      logger.info('Bot mobility', stats);
      if (frac < SHEEP_SKIAIR || avgSpeed < SHEEP_SPEED) {
        logger.warn('Bot sheeping', stats);
      }
    }
    s.winStart = now; s.ticks = 0; s.skiAir = 0; s.air = 0; s.jet = 0; s.dist = 0;
  }
}
