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
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';

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

/** MoveSim surface over a heightfield — gradient normals via central
 *  difference, same math the server's ground queries use. */
export function surfaceFor(field: Heightfield) {
  const g = (x: number, z: number) => hmHeight(field, x, z);
  return {
    getHeight: g,
    getNormal(x: number, z: number, out: { x: number; y: number; z: number }) {
      const e = 0.5;
      out.x = (g(x - e, z) - g(x + e, z)) / (2 * e);
      out.y = 1;
      out.z = (g(x, z - e) - g(x, z + e)) / (2 * e);
      const l = Math.hypot(out.x, out.y, out.z);
      out.x /= l; out.y /= l; out.z /= l;
      return out;
    },
  };
}
