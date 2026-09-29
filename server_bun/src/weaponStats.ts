/**
 * weaponStats — balance telemetry. Every credited hit routes through
 * CombatHandler.applyHit, so one hook records the whole picture per
 * room mode: damage dealt, hits, and kills per weapon (non-weapon
 * sources like turrets/mines key on their log label). Human vs bot
 * shooters split so a weapon that's only good in bot hands reads
 * differently than one that works for people.
 *
 * Persistence: a rollup appends to logs/weaponstats.jsonl every FLUSH_MS
 * (and /weaponstats serves the live in-memory table) — accumulated data
 * survives restarts, the same convention as matches.jsonl.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.ts';

export interface WeaponRow {
  hits: number;
  damage: number;
  kills: number;
  /** Bot-authored share of damage — >0.9 means the weapon's numbers come
   *  from aim-bot fights, not representative of human play. */
  botDamage: number;
  botKills: number;
}

interface ModeTable { [source: string]: WeaponRow }
interface RoomTable { [mode: string]: ModeTable }

// Balance telemetry beyond raw damage:
// - deaths: kill locations binned to 10m cells — heatmaps expose spawn
//   traps, dead zones, and dominant sightlines per map/mode.
// - ttk: first-hit→kill ms per weapon source — raw damage overstates
//   spray weapons; engagement time is the real lethality signal.
// - flags: carrier hold ms on cap, dropped ms on return — answers
//   "do flags die on the stand or never reach midfield".
interface TtkRow { n: number; totalMs: number }
interface FlagRow { caps: number; holdMs: number; returns: number; dropMs: number }
// speeds: kill moments binned to 5 m/s buckets for shooter and victim —
// Tribes balance lives on movement; if kills only happen at low speed
// the game is a foot-shooter, not a ski game.
interface SpeedBins { [bucket: string]: number }
// air counts proxy air-vs-ground kill share without terrain plumbing:
// |vy| > 4 m/s at kill moment reads as airborne (a ski crest or jet
// climb always carries vertical speed; walking never does).
interface SpeedRow { shooter: SpeedBins; victim: SpeedBins; airShooter: number; airVictim: number }
// pickups: economy funnel per pickup kind — spawned vs banked vs decayed.
// A kind that mostly decays means drops outpace collectors (bots under-
// farm, or the loot isn't worth the detour).
interface PickupRow { spawned: number; banked: number; decayed: number }

const CELL = 10;
const SPEED_BIN = 5;

const FLUSH_MS = 60_000;
const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');
const STATS_FILE = join(LOGS_DIR, 'weaponstats.jsonl');

class WeaponStats {
  private table: RoomTable = {};
  private deaths: { [mode: string]: { [cell: string]: number } } = {};
  private ttk: { [mode: string]: { [source: string]: TtkRow } } = {};
  private flags: { [mode: string]: FlagRow } = {};
  private speeds: { [mode: string]: SpeedRow } = {};
  private pickups: { [mode: string]: { [kind: string]: PickupRow } } = {};
  private dirty = false;

  private row(mode: string, source: string): WeaponRow {
    const m = (this.table[mode] ??= {});
    return (m[source] ??= { hits: 0, damage: 0, kills: 0, botDamage: 0, botKills: 0 });
  }

  /** Feed one credited hit. `source` is `w<weaponType>` or a label for
   *  non-weapon damage ('Turret hit', 'Mine hit', 'environment'). */
  record(mode: string, source: string, damage: number, killed: boolean, botShooter: boolean): void {
    if (damage <= 0) return;
    const r = this.row(mode, source);
    r.hits++;
    r.damage += damage;
    if (killed) r.kills++;
    if (botShooter) {
      r.botDamage += damage;
      if (killed) r.botKills++;
    }
    this.dirty = true;
  }

  /** A kill location, binned to a CELL-meter grid cell. */
  recordDeath(mode: string, pos: { x: number; z: number }): void {
    const m = (this.deaths[mode] ??= {});
    const cell = `${Math.round(pos.x / CELL)},${Math.round(pos.z / CELL)}`;
    m[cell] = (m[cell] ?? 0) + 1;
    this.dirty = true;
  }

  /** Engagement time for a finished duel (ms, first-hit → kill). */
  recordTtk(mode: string, source: string, ms: number): void {
    const m = (this.ttk[mode] ??= {});
    const r = (m[source] ??= { n: 0, totalMs: 0 });
    r.n++; r.totalMs += ms;
    this.dirty = true;
  }

  /** Flag lifecycle: 'cap' adds holdMs (pickup→cap), 'return' dropMs. */
  recordFlag(mode: string, kind: 'cap' | 'return', ms: number): void {
    const r = (this.flags[mode] ??= { caps: 0, holdMs: 0, returns: 0, dropMs: 0 });
    if (kind === 'cap') { r.caps++; r.holdMs += ms; }
    else { r.returns++; r.dropMs += ms; }
    this.dirty = true;
  }

  /** Kill-moment speeds (m/s) for shooter and victim, 5 m/s buckets. */
  recordKillSpeed(mode: string, shooterVel: { x: number; y: number; z: number } | null, victimVel: { x: number; y: number; z: number } | null): void {
    const r = (this.speeds[mode] ??= { shooter: {}, victim: {}, airShooter: 0, airVictim: 0 });
    const bin = (v: { x: number; y: number; z: number } | null): string => {
      if (!v) return 'unk';
      const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      return String(Math.floor(s / SPEED_BIN) * SPEED_BIN);
    };
    const sb = bin(shooterVel), vb = bin(victimVel);
    r.shooter[sb] = (r.shooter[sb] ?? 0) + 1;
    r.victim[vb] = (r.victim[vb] ?? 0) + 1;
    if (shooterVel && Math.abs(shooterVel.y) > 4) r.airShooter++;
    if (victimVel && Math.abs(victimVel.y) > 4) r.airVictim++;
    this.dirty = true;
  }

  /** Pickup economy: 'spawned' at drop, 'banked' on collect, 'decayed' on TTL. */
  recordPickup(mode: string, kind: string, event: 'spawned' | 'banked' | 'decayed'): void {
    const m = (this.pickups[mode] ??= {});
    const r = (m[kind] ??= { spawned: 0, banked: 0, decayed: 0 });
    r[event]++;
    this.dirty = true;
  }

  snapshot(): { byMode: RoomTable; deaths: typeof this.deaths; ttk: typeof this.ttk; flags: typeof this.flags; speeds: typeof this.speeds; pickups: typeof this.pickups } {
    return JSON.parse(JSON.stringify({
      byMode: this.table, deaths: this.deaths, ttk: this.ttk, flags: this.flags,
      speeds: this.speeds, pickups: this.pickups,
    }));
  }

  /** Append the accumulated rollup to the JSONL ledger. */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      appendFileSync(STATS_FILE, JSON.stringify({
        ts: new Date().toISOString(), byMode: this.table,
        deaths: this.deaths, ttk: this.ttk, flags: this.flags,
        speeds: this.speeds, pickups: this.pickups,
      }) + '\n');
    } catch (e) {
      logger.warn('WeaponStats flush failed', e);
    }
  }

  start(): void {
    const t = setInterval(() => this.flush(), FLUSH_MS);
    t.unref?.();
  }
}

export const weaponStats = new WeaponStats();
weaponStats.start();
