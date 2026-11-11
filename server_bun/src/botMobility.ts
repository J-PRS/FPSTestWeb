import type { Vec3 } from './types.ts';
import type { BotBrain } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';

// Stuck leash: ~2m of travel re-arms; a flag carrier gets the short leash
// because a parked carrier stalls the whole match.
const STUCK_DIST = 2;
const STUCK_MS = 5000;
const STUCK_MS_FLAG = 2500;

// Sheep audit: mobile bots should spend most travel ticks skiing/
// airborne, jet a slice of the time, and actually cover ground.
const SHEEP_WIN_MS = 10_000;
const SHEEP_MIN_TICKS = 60;
const SHEEP_SKIAIR = 0.65;
const SHEEP_JETPCT = 0.05;
const SHEEP_SPEED = 6;
const SHEEP_COVER_M = 40;

interface StuckState { x: number; z: number; since: number; warned: boolean; boostAt: number }
interface SheepState { winStart: number; ticks: number; skiAir: number; air: number; jet: number; dist: number; lx: number; lz: number; wasSheep?: boolean; sheepStreak?: number }

/** One tick of mobility evidence for checkSheep. */
export interface MobilitySample {
  trying: boolean;
  ski: boolean;
  airborne: boolean;
  jetting: boolean;
  dt: number;
}

/**
 * MobilityWatchdog — two alarms that catch "sheepish" behavior in
 * logs rather than in playtests: a stuck warn when an alive bot covers
 * no ground for a few seconds, and a rolling mobility audit that flags
 * bots staying flat-footed while they claim to be travelling.
 * Renamed off "botWatchdog" — the client's BotWatchdog is a DIFFERENT
 * tool (logic-vs-render stall detection), not a port of this.
 */
export class MobilityWatchdog {
  private stuck = new Map<string, StuckState>();
  /** Set when the watchdog fires - the serverBots call site owns moveSim,
   *  so it consumes this and applies the unstick impulse itself. */
  unstickPending = false;
  private sheep = new Map<string, SheepState>();

  constructor(private roomName: string) {}

  remove(id: string): void {
    this.stuck.delete(id);
    this.sheep.delete(id);
  }

  /** Live mobility read for the match-results ledger - the same HA/A/S
   *  buckets the scoreboard shows (ski+air / air / jet as % of active
   *  ticks) plus pace + distance covered. Humans aren't tracked here -
   *  their movement signature rides the client scoreboard instead. */
  statsOf(id: string, dt = 0.05): { skiAirPct: number; airPct: number; jetPct: number; avgSpeed: number; covered: number } | undefined {
    const s = this.sheep.get(id);
    if (!s || s.ticks === 0) {return undefined;}
    return {
      skiAirPct: Math.round((s.skiAir / s.ticks) * 100),
      airPct: Math.round((s.air / s.ticks) * 100),
      jetPct: Math.round((s.jet / s.ticks) * 100),
      avgSpeed: Number((s.dist / (s.ticks * dt)).toFixed(1)),
      covered: Number(s.dist.toFixed(1)),
    };
  }

  /** Warn when an alive bot hasn't covered ~2m in a few seconds. Re-arms
   *  each time the bot actually moves, so the log line marks the stall
   *  boundary rather than spamming every tick. Stand-and-shoot is a legal
   *  pick — the timer is parked while the brain holds a combat spot. */
  checkStuck(id: string, pos: Vec3, brain: BotBrain, carryingFlag: boolean, now: number): void {
    const w = this.stuck.get(id);
    if (!w) {
      this.stuck.set(id, { x: pos.x, z: pos.z, since: now, warned: false, boostAt: 0 });
      return;
    }
    const dx = pos.x - w.x, dz = pos.z - w.z;
    if (dx * dx + dz * dz >= STUCK_DIST * STUCK_DIST) {
      w.x = pos.x; w.z = pos.z; w.since = now; w.warned = false;
      return;
    }
    if (!carryingFlag && brain.holding) { w.since = now; return; }
    // A perched bot (tank refill on a face, lip-mount staging) is
    // standing still ON PURPOSE — not a pin. Same exemption shape as
    // `holding`: parked by choice, re-arm the leash instead of warning.
    if (brain.perched) { w.since = now; return; }
    // Standing on the destination is "arrived", not stuck — driveMove
    // cuts input inside 0.5m, so a parked-on-goal bot covers nothing by
    // design. 2.5m of slack covers yaw-circling around the point.
    const ddx = brain.lastDest.x - pos.x, ddz = brain.lastDest.z - pos.z;
    if (ddx * ddx + ddz * ddz < 6.25) { w.since = now; return; }
    const leash = carryingFlag ? STUCK_MS_FLAG : STUCK_MS;
    if (!w.warned && now - w.since > leash) {
      w.warned = true;
      w.boostAt = now;
      this.unstickPending = true; // caller applies the impulse (owns moveSim)
      logger.warn('Bot stuck', {
        room: this.roomName, bot: id,
        ms: now - w.since, carrying: carryingFlag,
        hunting: brain.currentHuntId !== null,
        pos: { x: Number(pos.x.toFixed(1)), y: Number(pos.y.toFixed(1)), z: Number(pos.z.toFixed(1)) },
        // The destination it can't reach is what separates "parked by
        // choice" from "grinding into a pocket" — log both ends.
        dest: { x: Number(brain.lastDest.x.toFixed(1)), y: Number(brain.lastDest.y.toFixed(1)), z: Number(brain.lastDest.z.toFixed(1)) },
        diag: brain.stuckDiag,
      });
    }
    // The one-shot impulse can lose to pocket geometry (wedged on a lip,
    // boxed in by friends): a bot that stays put 13h is a real prod
    // sighting. Re-boost every 30s while the leash holds; silent, the
    // initial warn already named the stall.
    if (w.warned && now - w.boostAt > 30_000) {
      w.boostAt = now;
      this.unstickPending = true;
    }
  }

  /** Rolling mobility audit. 'trying' = the brain has a destination this
   *  tick — defenders parked on a stand don't accrue. Warns once per 10s
   *  window when a mobile bot stays pedestrian: under the ski/air,
   *  jet-use, pace, or coverage floors. Healthy mobility is logged too,
   *  so a regression is visible not just failures. */
  checkSheep(id: string, pos: Vec3, m: MobilitySample, now: number): void {
    const s = this.sheep.get(id);
    if (!s) {
      this.sheep.set(id, { winStart: now, ticks: 0, skiAir: 0, air: 0, jet: 0, dist: 0, lx: pos.x, lz: pos.z });
      return;
    }
    const dx = pos.x - s.lx, dz = pos.z - s.lz;
    s.lx = pos.x; s.lz = pos.z;
    if (m.trying) {
s.ticks += 1; s.dist += Math.hypot(dx, dz);
      if (m.ski || m.airborne) {s.skiAir += 1;}
      // airPct is the honest "dynamic Tribes bot" number — skiHeld on the
      // ground counts as ski, but only real altitude counts as air.
      if (m.airborne) {s.air += 1;}
      if (m.jetting) {s.jet += 1;}
    }
    const winMs = now - s.winStart;
    if (winMs < SHEEP_WIN_MS) {return;}
    if (s.ticks >= SHEEP_MIN_TICKS) {
      const frac = s.skiAir / s.ticks;
      const avgSpeed = s.dist / (s.ticks * m.dt); // per-tick distance → m/s
      const stats = {
        room: this.roomName, bot: id,
        skiAirPct: Math.round(frac * 100),
        airPct: Math.round((s.air / s.ticks) * 100),
        jetPct: Math.round((s.jet / s.ticks) * 100),
        avgSpeed: Number(avgSpeed.toFixed(1)),
        covered: Number(s.dist.toFixed(1)),
      };
      logger.debug('Bot mobility', stats);
      // Coverage is the ground truth: a bot topping 100m/s over 700m
      // while holding no jet key is a fast skier, not a sheep — flagging
      // on jetPct/skiAir alone was the main false-positive source.
      // Those stay in stats as diagnostics; the alarm asks only "did it
      // move" plus "did it ever leave the ground" for the slow cases.
      const jetPct = s.jet / s.ticks;
      const sheeping = (avgSpeed < SHEEP_SPEED || s.dist < SHEEP_COVER_M)
        && (frac < SHEEP_SKIAIR || jetPct < SHEEP_JETPCT);
      // One slow window is a blip (downhill rest, orbital patrol) —
      // only a bot that stays immobile across consecutive windows is
      // worth a line. Healthy samples reset the streak.
      if (sheeping) {
        s.wasSheep = true;
        if ((s.sheepStreak = (s.sheepStreak ?? 0) + 1) >= 2) {logger.info('Bot sheeping', stats);}
      } else {
        s.sheepStreak = 0;
      }
    }
    s.winStart = now; s.ticks = 0; s.skiAir = 0; s.air = 0; s.jet = 0; s.dist = 0;
  }
}
