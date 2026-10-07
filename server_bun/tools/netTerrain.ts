/**
 * netTerrain — heightfield loading for wire-level test bots.
 *
 * A named room plays on its map spec's terrain — simming the default
 * heightmap against e.g. swarm.bin ground leaves every report floating
 * tens of meters off the shadow and reads as a movement cheat. Spec-less
 * rooms replay the server's own heightmap.bin (it lives in server_bun/,
 * not maps/). Rooms can sit on DIFFERENT terrain files, so each bot
 * loads its room's field on every re-seat — a shared mutable field
 * swapped on hop corrupts every sim still in the old room.
 */
import type { Heightfield } from '../../shared/heightfield.ts';
import { FieldSurface } from '../../shared/fieldSurface.ts';

const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
if (!bunFile) throw new Error('netBot tools require Bun');

const here = (rel: string): string =>
  new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Binary heightmap: 8-byte w/h header + raw R channel. */
export function parseField(buf: Uint8Array): Heightfield | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  if (w !== h) return null;
  return { size: w, data: buf.subarray(8), stride: 1 };
}

export async function loadField(path: string): Promise<Heightfield> {
  const f = parseField(new Uint8Array(await bunFile!(path).arrayBuffer()));
  if (!f) throw new Error(`non-square heightmap: ${path}`);
  return f;
}

/** Resolve which terrain file a room actually runs on: its map spec's
 *  `terrain` entry, else the server default. `mapArg` wins if given. */
export async function resolveRoomTerrain(room: string, mapArg: string): Promise<{ path: string; field: Heightfield }> {
  let path = mapArg;
  if (!path) {
    try {
      const spec = JSON.parse(new TextDecoder().decode(await bunFile!(here(`../../maps/${room}.json`)).arrayBuffer())) as { terrain?: string };
      path = spec.terrain ? here(`../../maps/${spec.terrain}`) : here('../heightmap.bin');
    } catch {
      path = here('../heightmap.bin');
    }
  }
  return { path, field: await loadField(path) };
}

/** Per-name loader honoring the room-hop contract: unknown or malformed
 *  names fall back to `fallback` (matching the server's own fallback),
 *  and the server default is seeded as its own cache entry since the
 *  run's default may be a spec file. */
export function makeTerrainLoader(fallback: Heightfield): (name: string) => Promise<Heightfield> {
  const cache = new Map<string, Heightfield>();
  const ready = (async () => {
    try { cache.set('heightmap.bin', await loadField(here('../heightmap.bin'))); }
    catch { cache.set('heightmap.bin', fallback); }
  })();
  return async (name) => {
    await ready;
    const cached = cache.get(name);
    if (cached) return cached;
    let f = fallback;
    try {
      const parsed = parseField(new Uint8Array(await bunFile!(here(`../../maps/${name}`)).arrayBuffer()));
      if (parsed) { f = parsed; console.log(`[netBot] terrain loaded: ${name}`); }
    } catch { /* unknown file — default, matching the server's fallback */ }
    cache.set(name, f);
    return f;
  };
}

/** MoveSim surface over a heightfield — the shared FieldSurface, so the
 *  netbot's ground normals (hmNormal's 2.5m diff step, not a hand-rolled
 *  0.5m one) and structure overlay are byte-identical to the server's.
 *  A netbot sim that rolls its own surface is a divergence generator:
 *  it once read normals at e=0.5 and never saw structure walls at all. */
export function surfaceFor(field: Heightfield): FieldSurface {
  return FieldSurface.fromField(field);
}
