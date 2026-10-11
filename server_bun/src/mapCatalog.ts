import { readFileSync, readdirSync } from 'node:fs';
import { CONFIG } from './config.ts';
import { type MapSpec, resolveMapSpec, specModes, parseMapSpecJson } from '../../shared/mapSpec.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';
import { evictEldest } from './evictEldest.ts';

const MAPS_DIR = `${import.meta.dir}/../../maps`;

/** Everything that turns "a room wants a map" into "this MapSpec": the
 *  maps/*.json loader, the join-time fallback chain (room name → base
 *  room → map → mode), the shared rotation cursor, and the room→map
 *  source bookkeeping quick-join groups by. Kept off GameServer so it
 *  stays about sockets and seats. */
export class MapCatalog {
  /** Which maps/<X>.json spawned each room — lets quick-join group by
   *  map rather than room name. */
  private roomMapName = new Map<string, string>();
  /** Maps carrying the `_t2` provenance marker — the lobby badges them
   *  so players can tell a T2 port from a native arena. */
  private t2Flags = new Set<string>();

  mapNameOf(room: string): string | undefined { return this.roomMapName.get(room); }
  /** Room → map name, never cleared on room dispose — a switchRoom
   *  name-spammer grows it forever otherwise. Entries only feed the
   *  scoreboard's map title, so evicting the oldest is harmless. */
  noteSource(room: string, src: string): void {
    if (!src) {return;}
    if (this.roomMapName.size >= 256 && !this.roomMapName.has(room)) {
      evictEldest(this.roomMapName);
    }
    this.roomMapName.set(room, src);
  }

  /** maps/<name>.json — a missing or malformed file just means "default
   *  match rules", not an error. readFileSync keeps callers synchronous.
   *  Misses are negative-cached for 30s — a /join flood of bogus map
   *  names would otherwise pay a disk read per request (and a
   *  newly-added map still appears within half a minute). */
  private specMisses = new Map<string, number>();
  /** Resolved specs — hits were never cached, so every /join and every
   *  roomFor paid a full read+parse+resolve per request. Hits ride the
   *  same 30s staleness window as misses so a maps/*.json edit still
   *  reaches new rooms within half a minute; the admin hot-swap forces
   *  it sooner through reloadSpec below. */
  private specs = new Map<string, { at: number; spec: MapSpec }>();
  private static MISS_TTL_MS = 30_000;

  loadMapSpec(name: string): MapSpec | undefined {
    if (!name) {return undefined;}
    const missAt = this.specMisses.get(name);
    if (missAt !== undefined && wallNow() - missAt < MapCatalog.MISS_TTL_MS) {return undefined;}
    const hit = this.specs.get(name);
    if (hit && wallNow() - hit.at < MapCatalog.MISS_TTL_MS) {return hit.spec;}
    try {
      const spec = this.readSpec(name);
      this.specMisses.delete(name);
      this.specs.set(name, { at: wallNow(), spec });
      return spec;
    } catch {
      this.specMisses.set(name, wallNow());
      if (this.specMisses.size > 512) {evictEldest(this.specMisses);}
      return undefined;
    }
  }

  /** Force a fresh disk read — the admin reload path exists to pick up
   *  an edited maps/*.json, which a cache hit would silently veto. */
  reloadSpec(name: string): MapSpec | undefined {
    if (!name) {return undefined;}
    try {
      const spec = this.readSpec(name);
      this.specMisses.delete(name);
      this.specs.set(name, { at: wallNow(), spec });
      return spec;
    } catch {
      return undefined;
    }
  }

  private readSpec(name: string): MapSpec {
    const path = `${MAPS_DIR}/${name}.json`;
    const parsed = parseMapSpecJson(readFileSync(path, 'utf8'));
    const isT2 = (parsed as { _t2?: unknown })._t2 !== undefined;
    if (isT2 && CONFIG.publicBeta) {throw new Error('t2 spec excluded by FPS_PUBLIC_BETA');}
    if (isT2) {this.t2Flags.add(name);}
    const spec = resolveMapSpec(parsed);
    // Fail loud on coerced/dropped fields — a typo in the JSON shouldn't
    // silently play as a different map than the author wrote.
    if (spec.warnings?.length) {
      logger.warn('Map spec parse warnings', { room: name, warnings: spec.warnings });
    }
    logger.info('Map spec loaded', { room: name, path });
    return spec;
  }

  /** True when maps/<name>.json resolves — route-level validation for
   *  the map arg (a bogus name must not spin up a throwaway room). */
  has(name: string): boolean { return this.loadMapSpec(name) !== undefined; }

  /** Join-time spec resolution: room name, then the numbered-room base
   *  (`ctf-2` inherits ctf.json), then the map arg, then the mode. */
  specFor(name: string, mode: string, map: string, bots?: number): { spec: MapSpec | undefined; src: string } {
    let spec = this.loadMapSpec(name);
    let src = spec ? name : '';
    if (!spec) {
      // Numbered ad-hoc rooms inherit their base spec — a bare --room
      // join must play the same rules quickRoom would, or numbered rooms
      // silently run spec-less defaults.
      const base = name.replace(/-\d+$/, '');
      if (base !== name) { spec = this.loadMapSpec(base); src = spec ? base : ''; }
    }
    if (!spec && map) { spec = this.loadMapSpec(map); src = map; }
    if (!spec) { spec = this.loadMapSpec(mode); src = spec ? mode : ''; }
    // Mode and map are separate axes: a requested mode that the spec
    // can host swaps in over the spec's default; one it can't leaves the
    // map's own ruleset in charge (a dm map never sprouts flag stands).
    if (spec && mode && spec.mode !== mode && specModes(spec).includes(mode)) {
      spec = { ...spec, mode};
    }
    if (bots !== undefined) {spec = (({ ...spec, bots,botFill: bots})) as MapSpec;}
    return { spec, src };
  }

  // Map rotation pool: maps/rotation.json (["name","name",…]) or the
  // FPS_MAP_ROTATION env (comma list). Rooms advance a shared cursor —
  // every room on the rotation marches the same sequence.
  private rotationList: string[] | null | undefined;
  private rotationIdx = 0;

  private rotation(): string[] {
    if (this.rotationList === undefined) {
      const env = (process.env.FPS_MAP_ROTATION ?? '').split(',')
        .map(s => s.trim()).filter(Boolean);
      if (env.length > 0) {this.rotationList = env;}
      else {
        try {
          const raw = readFileSync(`${MAPS_DIR}/rotation.json`, 'utf8');
          const list = JSON.parse(raw);
          this.rotationList = Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
        } catch { this.rotationList = null; }
      }
    }
    return this.rotationList ?? [];
  }

  /** Next map in the rotation whose mode matches the room's — a mode
   *  swap would need Room reconstruction (mode wiring is ctor-time), so
   *  foreign-mode specs are skipped rather than half-applied. */
  nextRotationSpec(room: { name: string; mode: string; mapSrc?: string }): MapSpec | null {
    const list = this.rotation();
    if (list.length === 0) {return null;}
    for (let i = 0; i < list.length; i += 1) {
      const name = list[this.rotationIdx++ % list.length];
      if (name === undefined) {continue;}
      const spec = this.loadMapSpec(name);
      // A spec declares its legal modes; a mode-less one is a bare arena
      // that inherits whatever the room already runs.
      const legal = specModes(spec);
      if (!spec || (room.mode && legal.length > 0 && !legal.includes(room.mode))) {continue;}
      this.rotationIdx %= list.length;
      this.roomMapName.set(room.name, name);
      room.mapSrc = name; // keep the scoreboard's map title honest too
      logger.info('Map rotated', { room: room.name, map: name });
      return spec;
    }
    return null;
  }

  /** Playable map list for the menu — name + legal modes + default
   *  bot count, straight from maps/*.json. `mode` stays the spec's own
   *  default so the picker can label "default ruleset" honestly.
   *  Cached briefly: the lobby polls this per viewer, and the cost of a
   *  fresh answer is a directory scan — new maps surface within 30s. */
  private listCache: { at: number; rows: { name: string; mode: string; modes: string[]; bots: number; t2: boolean }[] } | undefined;
  list(): { name: string; mode: string; modes: string[]; bots: number; t2: boolean }[] {
    const c = this.listCache;
    if (c && wallNow() - c.at < MapCatalog.MISS_TTL_MS) {return c.rows;}
    const rows = this.buildList();
    this.listCache = { at: wallNow(), rows };
    return rows;
  }

  private buildList(): { name: string; mode: string; modes: string[]; bots: number; t2: boolean }[] {
    try {
      return readdirSync(MAPS_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'rotation.json') // rotation.json is a playlist, not a map
        .map((f) => {
          const spec = this.loadMapSpec(f.slice(0, -5));
          return {
            name: f.slice(0, -5),
            mode: spec?.mode ?? '',
            modes: specModes(spec),
            bots: spec?.bots ?? spec?.botFill ?? 0,
            t2: this.t2Flags.has(f.slice(0, -5)),
            hidden: spec?.hidden === true,
          };
        })
        .filter((r) => !r.hidden)
        .toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}
