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

const CELL = 10;

const FLUSH_MS = 60_000;
const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');
const STATS_FILE = join(LOGS_DIR, 'weaponstats.jsonl');

class WeaponStats {
  private table: RoomTable = {};
  private deaths: { [mode: string]: { [cell: string]: number } } = {};
  private ttk: { [mode: string]: { [source: string]: TtkRow } } = {};
  private flags: { [mode: string]: FlagRow } = {};
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

  snapshot(): { byMode: RoomTable; deaths: typeof this.deaths; ttk: typeof this.ttk; flags: typeof this.flags } {
    return JSON.parse(JSON.stringify({
      byMode: this.table, deaths: this.deaths, ttk: this.ttk, flags: this.flags,
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
