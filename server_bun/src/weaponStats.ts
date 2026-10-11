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
import { logger } from './logger.ts';

// This module rides p2p/host.ts into the browser bundle — node builtins
// are externalized stubs there, so fs resolves lazily inside flush()
// (never called client-side) instead of at import time.
const NODE = typeof window === 'undefined';
let statsPaths: { dir: string; file: string } | null = null;
async function statsFile(): Promise<{ dir: string; file: string } | null> {
  if (!NODE) {return null;}
  if (!statsPaths) {
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // import.meta.dir is Bun-only — the vitest suite imports this too.
    const here = (import.meta as { dir?: string }).dir ?? dirname(fileURLToPath(import.meta.url));
    const dir = join(here, '..', '..', 'logs');
    statsPaths = { dir, file: join(dir, 'weaponstats.jsonl') };
  }
  return statsPaths;
}

export interface WeaponRow {
  hits: number;
  damage: number;
  kills: number;
  /** Trigger pulls — shots×firePeriod = trigger-uptime seconds, the
   *  K/s denominator that stays honest across weapon switching. */
  shots: number;
  /** Shot counts by shooter→aim distance band — a weapon spammed out of
   *  its band shows as volume where it can't connect. */
  dist?: { [band: string]: number };
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
interface PickupRow { spawned: number; banked: number; decayed: number; refused: number }

const CELL = 10;
const SPEED_BIN = 5;

// One key per 5 m/s forever is an unbounded keyspace — legit speeds top
// out near ~150 (jet cap + dive conversion), so anything past that is a
// physics anomaly that belongs in one 'fast' bucket, not a fresh mint.
const speedBin = (v: { x: number; y: number; z: number } | null): string => {
  if (!v) {return 'unk';}
  const s = (v.x * v.x + v.y * v.y + v.z * v.z) ** 0.5;
  return s >= 150 ? '150+' : String(Math.floor(s / SPEED_BIN) * SPEED_BIN);
};

const FLUSH_MS = 60_000;

export class WeaponStats {
  private table: RoomTable = {};
  private deaths: { [mode: string]: { [cell: string]: number } } = {};
  private ttk: { [mode: string]: { [source: string]: TtkRow } } = {};
  private flags: { [mode: string]: FlagRow } = {};
  private speeds: { [mode: string]: SpeedRow } = {};
  private pickups: { [mode: string]: { [kind: string]: PickupRow } } = {};
  // deployables: placements per kind — cross-read with the 'Turret hit' /
  // 'Mine hit' damage rows for kills-per-placement (deployable value).
  private deploys: { [mode: string]: { [kind: string]: number } } = {};
  private dirty = false;

  // Mode names are client-chosen (any word() on join/switchRoom), so
  // every per-mode table shares one cap — a spammer minting unique mode
  // names would otherwise grow these maps (and the jsonl) forever.
  private static readonly MAX_MODES = 64;
  private modeOk(mode: string): boolean {
    if (this.table[mode]) {return true;}
    if (Object.keys(this.table).length >= WeaponStats.MAX_MODES) {return false;}
    this.table[mode] = {}; // admit — one slot covers every per-mode map
    return true;
  }

  private static readonly MAX_SOURCES = 64;
  private row(mode: string, source: string): WeaponRow {
    this.table[mode] ??= {};
    const m = this.table[mode];
    // Source keys are 'w<client-claimed weaponType>' — arbitrary numbers
    // mint arbitrary keys, so overflow folds into a shared 'other' row.
    const key = source in m || Object.keys(m).length < WeaponStats.MAX_SOURCES ? source : 'other';
    return (m[key] ??= { hits: 0, damage: 0, kills: 0, shots: 0, botDamage: 0, botKills: 0, dist: {} });
  }

  /** Feed one credited hit. `source` is `w<weaponType>` or a label for
   *  non-weapon damage ('Turret hit', 'Mine hit', 'environment'). */
  record(mode: string, source: string, damage: number, killed: boolean, botShooter: boolean): void {
    if (damage <= 0 || !this.modeOk(mode)) {return;}
    const r = this.row(mode, source);
r.hits += 1;
    r.damage += damage;
    if (killed) {r.kills += 1;}
    if (botShooter) {
      r.botDamage += damage;
      if (killed) {r.botKills += 1;}
    }
    this.dirty = true;
  }

  /** One trigger pull — every shooter funnels here so a weapon's
   *  kills can be priced against its own trigger-uptime, not just
   *  hits that actually landed. */
  recordShot(mode: string, source: string, dist?: number): void {
    if (!this.modeOk(mode)) {return;}
    const r = this.row(mode, source);
r.shots += 1;
    if (dist !== undefined && Number.isFinite(dist)) {
      const band = dist < 10 ? '<10' : dist < 25 ? '10-25' : dist < 60 ? '25-60' : dist < 120 ? '60-120' : '120+';
      r.dist ??= {};
      const d = r.dist;
      d[band] = (d[band] ?? 0) + 1;
    }
    this.dirty = true;
  }

  /** A kill location, binned to a CELL-meter grid cell. */
  recordDeath(mode: string, pos: { x: number; z: number }): void {
    if (!this.modeOk(mode)) {return;}
    this.deaths[mode] ??= {};
    const m = this.deaths[mode];
    // Cell coords derive from client position claims — unbounded
    // magnitude mints unbounded cells, so overflow folds into 'far'.
    const raw = `${Math.round(pos.x / CELL)},${Math.round(pos.z / CELL)}`;
    const cell = raw in m || Object.keys(m).length < 512 ? raw : 'far';
    m[cell] = (m[cell] ?? 0) + 1;
    this.dirty = true;
  }

  /** Engagement time for a finished duel (ms, first-hit → kill). */
  recordTtk(mode: string, source: string, ms: number): void {
    if (!this.modeOk(mode)) {return;}
    this.ttk[mode] ??= {};
    const m = this.ttk[mode];
    const key = source in m || Object.keys(m).length < WeaponStats.MAX_SOURCES ? source : 'other';
    m[key] ??= { n: 0, totalMs: 0 };
    const r = m[key];
r.n += 1; r.totalMs += ms;
    this.dirty = true;
  }

  /** Flag lifecycle: 'cap' adds holdMs (pickup→cap), 'return' dropMs. */
  recordFlag(mode: string, kind: 'cap' | 'return', ms: number): void {
    if (!this.modeOk(mode)) {return;}
    this.flags[mode] ??= { caps: 0, holdMs: 0, returns: 0, dropMs: 0 };
    const r = this.flags[mode];
    if (kind === 'cap') {r.caps += 1; r.holdMs += ms; }
    else {r.returns += 1; r.dropMs += ms; }
    this.dirty = true;
  }

  /** Kill-moment speeds (m/s) for shooter and victim, 5 m/s buckets. */
  recordKillSpeed(mode: string, shooterVel: { x: number; y: number; z: number } | null, victimVel: { x: number; y: number; z: number } | null): void {
    if (!this.modeOk(mode)) {return;}
    this.speeds[mode] ??= { shooter: {}, victim: {}, airShooter: 0, airVictim: 0 };
    const r = this.speeds[mode];
    const sb = speedBin(shooterVel), vb = speedBin(victimVel);
    r.shooter[sb] = (r.shooter[sb] ?? 0) + 1;
    r.victim[vb] = (r.victim[vb] ?? 0) + 1;
    if (shooterVel && Math.abs(shooterVel.y) > 4) {r.airShooter += 1;}
    if (victimVel && Math.abs(victimVel.y) > 4) {r.airVictim += 1;}
    this.dirty = true;
  }

  /** Pickup economy: 'spawned' at drop, 'banked' on collect, 'decayed'
   *  on TTL, 'refused' when the pool cap swallowed the spawn. */
  recordPickup(mode: string, kind: string, event: 'spawned' | 'banked' | 'decayed' | 'refused'): void {
    if (!this.modeOk(mode)) {return;}
    this.pickups[mode] ??= {};
    const m = this.pickups[mode];
    m[kind] ??= { spawned: 0, banked: 0, decayed: 0, refused: 0 };
    const r = m[kind];
r[event] += 1;
    this.dirty = true;
  }

  /** A deployable was placed (turret/mine/station/drone). */
  recordDeploy(mode: string, kind: string): void {
    if (!this.modeOk(mode)) {return;}
    this.deploys[mode] ??= {};
    const m = this.deploys[mode];
    m[kind] = (m[kind] ?? 0) + 1;
    this.dirty = true;
  }

  snapshot(): {
    byMode: RoomTable;
    deaths: { [mode: string]: { [cell: string]: number } };
    ttk: { [mode: string]: { [source: string]: TtkRow } };
    flags: { [mode: string]: FlagRow };
    speeds: { [mode: string]: SpeedRow };
    pickups: { [mode: string]: { [kind: string]: PickupRow } };
    deploys: { [mode: string]: { [kind: string]: number } };
  } {
    return JSON.parse(JSON.stringify({
      byMode: this.table, deaths: this.deaths, ttk: this.ttk, flags: this.flags,
      speeds: this.speeds, pickups: this.pickups, deploys: this.deploys,
    }));
  }

  /** Append the accumulated rollup to the JSONL ledger. */
  private flush(): void {
    if (!this.dirty) {return;}
    this.dirty = false;
    statsFile().then(async (paths): Promise<void> => {
      if (!paths) {return;}
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const { rotateLogIfBig } = await import('./logRotate.ts');
        mkdirSync(paths.dir, { recursive: true });
        rotateLogIfBig(paths.file);
        appendFileSync(paths.file, `${JSON.stringify({
          ts: new Date().toISOString(), byMode: this.table,
          deaths: this.deaths, ttk: this.ttk, flags: this.flags,
          speeds: this.speeds, pickups: this.pickups, deploys: this.deploys,
        })  }\n`);
      } catch (error) {
        logger.warn('WeaponStats flush failed', error);
      }
    return; }).catch((): void => undefined);
  }

  start(): void {
    const t = setInterval((): void => this.flush(), FLUSH_MS);
    // Client tsc sees setInterval as the DOM overload (returns number) —
    // unref exists on the Node/Bun timer but not that signature.
    (t as unknown as { unref?: () => void }).unref?.();
  }
}

export const weaponStats = new WeaponStats();
weaponStats.start();
