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

const FLUSH_MS = 60_000;
const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');
const STATS_FILE = join(LOGS_DIR, 'weaponstats.jsonl');

class WeaponStats {
  private table: RoomTable = {};
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

  snapshot(): RoomTable {
    return JSON.parse(JSON.stringify(this.table));
  }

  /** Append the accumulated rollup to the JSONL ledger. */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      appendFileSync(STATS_FILE, JSON.stringify({ ts: new Date().toISOString(), byMode: this.table }) + '\n');
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
