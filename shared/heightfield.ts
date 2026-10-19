/**
 * Heightfield — the pure-CPU half of terrain.ts, shared verbatim by client
 * and server so ball flight resolves identical heights on both ends.
 *
 * Data: R channel of the heightmap, dumped per map as maps/<name>.bin
 * (u32 size + raw bytes). ONE source of truth — the client fetches the
 * same .bin the server reads (maps/ mirrored under /assets/heightmaps),
 * so both ends sample identical bytes. stride=4 tolerates a legacy
 * RGBA ImageData field; everything live is stride=1.
 * Bilinear sampling matches the GPU texture path exactly (texel-center
 * offset, see terrain.ts for the derivation) — a server ball and a client
 * replay must land on the same vertex or bounces diverge.
 */

import { dhypot } from './dmath.ts';

export const HM_WORLD_SCALE = 1500; // meters per heightmap wrap — MUST match client config TERRAIN_WORLD_SCALE
export const HM_HEIGHT_SCALE = 125; // MUST match TERRAIN_HEIGHT_SCALE
export const HM_DIVISOR = 255;      // MUST match TERRAIN_HEIGHTMAP_DIVISOR
const CPU_STEP = 5;                 // normal finite-diff step (finest clipmap spacing)

export interface Heightfield {
  size: number;
  /** Heightmap bytes. stride=4 for RGBA ImageData (client), stride=1 for a
   *  raw R-channel dump (server heightmap.bin). */
  data: Uint8Array | Uint8ClampedArray;
  stride: number;
  /** Per-map vertical gain — multiplies HM_HEIGHT_SCALE (spec.heightScale).
   *  Lives on the field, not the spec, so every sim sampling it gets the
   *  identical world height without threading the spec through. */
  heightScale?: number;
  /** Per-map tile span in meters (spec.tileSize) — how much world one
   *  heightmap wrap covers. T2 ports run their native 2048m tiles; maps
   *  without it default to HM_WORLD_SCALE. */
  worldScale?: number;
}

/** The RAW bilinear field read — internal. Ground truth for physics is
 *  the chord below; callers that need the continuous field are rare and
 *  should say so explicitly. */
function hmField(f: Heightfield, wx: number, wz: number): number {
  const N = f.size;
  const ws = f.worldScale ?? HM_WORLD_SCALE;
  const u = (((wx / ws) % 1) + 1) % 1 * N - 0.5;
  const v = (((wz / ws) % 1) + 1) % 1 * N - 0.5;
  const x0 = ((Math.floor(u) % N) + N) % N;
  const z0 = ((Math.floor(v) % N) + N) % N;
  const x1 = (x0 + 1) % N;
  const z1 = (z0 + 1) % N;
  const fx = u - Math.floor(u);
  const fz = v - Math.floor(v);
  const d = f.data;
  const s = f.stride;
  const h =
    d[(z0 * N + x0) * s]! * (1 - fx) * (1 - fz) +
    d[(z0 * N + x1) * s]! * fx * (1 - fz) +
    d[(z1 * N + x0) * s]! * (1 - fx) * fz +
    d[(z1 * N + x1) * s]! * fx * fz;
  return (h / HM_DIVISOR) * HM_HEIGHT_SCALE * (f.heightScale ?? 1);
}

export function hmChord(f: Heightfield, wx: number, wz: number): number {
  const s = CPU_STEP;
  const x0 = Math.floor(wx / s) * s, z0 = Math.floor(wz / s) * s;
  const h00 = hmField(f, x0, z0), h10 = hmField(f, x0 + s, z0);
  const h01 = hmField(f, x0, z0 + s), h11 = hmField(f, x0 + s, z0 + s);
  const tx = (wx - x0) / s, tz = (wz - z0) / s;
  return tx + tz <= 1
    ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
    : h11 + (h10 - h11) * (1 - tz) + (h01 - h11) * (1 - tx);
}



/** Ground height = the RENDERED surface — the client's level-0 clipmap
 *  draws each 5m quad as two flat triangles split on the (x0+s,z0)↔
 *  (x0,z0+s) diagonal, and its lattice is world-anchored (the clipmap
 *  origin snaps to spacing multiples), so this chord is a fixed,
 *  deterministic surface that IS what every client renders inside the
 *  fine LOD ring. Physics samples this — not the smooth field — so feet,
 *  shots, and spawns land exactly on the drawn mesh. It also quantizes
 *  away sub-texel terracing in 8-bit heightmaps. The old bilinear field
 *  survives as hmField for chord corner taps. */
export function hmHeight(f: Heightfield, wx: number, wz: number): number {
  return hmChord(f, wx, wz);
}

/** Cheap field identity for desync forensics — not a hash, just enough
 *  bits to tell "client is simming a different heightfield than the
 *  server" apart from integrator drift in one log line. */
export function hmFingerprint(f: Heightfield): string {
  const N = f.size;
  const s = f.stride;
  const d = f.data;
  let acc = 0;
  for (let i = 0; i < 64; i += 1) {
    const cell = Math.floor((i / 64) * N * N);
    // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point
    acc = (acc * 31 + d[cell * s]!) | 0;
  }
  return `${N}:${(acc >>> 0).toString(16)}:${f.heightScale ?? 1}:${f.worldScale ?? HM_WORLD_SCALE}`;
}

/** Decode a maps/<name>.bin dump — u32 width, u32 height (square),
 *  raw R-channel bytes. The one parser for server, netbots, and tools. */
export function hmParseBin(buf: Uint8Array, heightScale = 1, worldScale?: number): Heightfield {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = view.getUint32(0, true);
  const h = view.getUint32(4, true);
  if (w !== h || w < 2 || buf.byteLength !== 8 + w * h) {
    throw new Error(`Bad heightmap.bin: ${w}x${h}, ${buf.byteLength} bytes`);
  }
  return { size: w, data: buf.subarray(8), stride: 1, heightScale, worldScale };
}

/** Same bytes, different gain — a spec that scales the DEFAULT field must
 *  not mutate the shared object (other rooms read it unscaled). */
export function hmScaled(f: Heightfield, heightScale: number, worldScale?: number): Heightfield {
  const ws = worldScale ?? HM_WORLD_SCALE;
  const fws = f.worldScale ?? HM_WORLD_SCALE;
  return (heightScale === 1 && ws === fws) ? f : ((Object.assign({}, f, {heightScale,worldScale: ws})));
}

export function hmNormal(f: Heightfield, wx: number, wz: number, out: { x: number; y: number; z: number }): void {
  const e = CPU_STEP * 0.5;
  const hL = hmHeight(f, wx - e, wz);
  const hR = hmHeight(f, wx + e, wz);
  const hD = hmHeight(f, wx, wz - e);
  const hU = hmHeight(f, wx, wz + e);
  const nx = hL - hR;
  const ny = 2 * e;
  const nz = hD - hU;
  const il = 1 / (nx * nx + ny * ny + nz * nz) ** 0.5;
  out.x = nx * il;
  out.y = ny * il;
  out.z = nz * il;
}



/** Plain terrain-only move surface — the server wraps this shape with
 *  structure solids (FieldSurface); bots and tools use it bare. */
export function hmSurface(f: Heightfield): { getHeight(x: number, z: number): number; getNormal(x: number, z: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } } {
  return {
    getHeight: (x, z): number => hmHeight(f, x, z),
    getNormal: (x, z, out): { x: number; y: number; z: number; } => { hmNormal(f, x, z, out); return out; },
  };
}

/** A dropped object's rest spot must be reachable: a tumble that ends on
 *  a cliff lip or a steep face is unreachable for every walker, so the
 *  rest spot slides downhill until the gradient is walkable. Mutates pos. */
export function hmSettleWalkable(f: Heightfield, pos: { x: number; y: number; z: number }, lift = 0.5): void {
  for (let i = 0; i < 12; i += 1) {
    const h0 = hmHeight(f, pos.x, pos.z);
    const gxm = hmHeight(f, pos.x - 4, pos.z), gxp = hmHeight(f, pos.x + 4, pos.z);
    const gzm = hmHeight(f, pos.x, pos.z - 4), gzp = hmHeight(f, pos.x, pos.z + 4);
    const sx = (gxp - gxm) / 8, sz = (gzp - gzm) / 8;
    const slope = dhypot(sx, sz);
    if (slope < 0.8) {break;} // walkable grade
    const d = slope || 1;
    pos.x -= (sx / d) * 6; pos.z -= (sz / d) * 6;
    // Rest height is the drawn chord — the flat triangles dip under the
    // bilinear field on convex ground, so a field rest reads midair.
    pos.y = Math.max(hmHeight(f, pos.x, pos.z), hmChord(f, pos.x, pos.z)) + lift;
    if (Math.abs(h0 - pos.y) < 0.5 && i > 4) {break;} // settled on a shelf
  }
}
