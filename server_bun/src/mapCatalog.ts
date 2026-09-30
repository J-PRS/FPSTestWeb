import { readFileSync, readdirSync } from 'node:fs';
import { type MapSpec, resolveMapSpec, specModes } from '../../shared/mapSpec.ts';
import { logger } from './logger.ts';

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

  mapNameOf(room: string): string | undefined { return this.roomMapName.get(room); }
  noteSource(room: string, src: string): void { if (src) this.roomMapName.set(room, src); }

  /** maps/<name>.json — a missing or malformed file just means "default
   *  match rules", not an error. readFileSync keeps callers synchronous:
   *  map files are tiny and loaded once per room lifetime. */
  loadMapSpec(name: string): MapSpec | undefined {
    if (!name) return undefined;
    try {
      const path = `${MAPS_DIR}/${name}.json`;
      const raw = readFileSync(path, 'utf8');
      const spec = resolveMapSpec(JSON.parse(raw));
      logger.info('Map spec loaded', { room: name, path });
      return spec;
    } catch {
      return undefined;
    }
  }

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
      spec = { ...spec, mode };
    }
    if (bots !== undefined) spec = { ...spec, bots, botFill: bots } as MapSpec;
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
      if (env.length) this.rotationList = env;
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
  nextRotationSpec(room: { name: string; mode: string }): MapSpec | null {
    const list = this.rotation();
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const name = list[this.rotationIdx++ % list.length];
      if (name === undefined) continue;
      const spec = this.loadMapSpec(name);
      // A spec declares its legal modes; a mode-less one is a bare arena
      // that inherits whatever the room already runs.
      const legal = specModes(spec);
      if (!spec || (room.mode && legal.length && !legal.includes(room.mode))) continue;
      this.rotationIdx %= list.length;
      this.roomMapName.set(room.name, name);
      logger.info('Map rotated', { room: room.name, map: name });
      return spec;
    }
    return null;
  }

  /** Playable map list for the menu — name + legal modes + default
   *  bot count, straight from maps/*.json. `mode` stays the spec's own
   *  default so the picker can label "default ruleset" honestly. */
  list(): { name: string; mode: string; modes: string[]; bots: number }[] {
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
          };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
}
