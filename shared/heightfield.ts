/**
 * Heightfield — the pure-CPU half of terrain.ts, shared verbatim by client
 * and server so ball flight resolves identical heights on both ends.
 *
 * Data: R channel of the heightmap PNG (u8, square). The client builds one
 * from canvas ImageData; the server loads the pre-dumped heightmap.bin.
 * Bilinear sampling matches the GPU texture path exactly (texel-center
 * offset, see terrain.ts for the derivation) — a server ball and a client
 * replay must land on the same vertex or bounces diverge.
 */

export const HM_WORLD_SCALE = 1500.0; // meters per heightmap wrap — MUST match client config TERRAIN_WORLD_SCALE
export const HM_HEIGHT_SCALE = 125.0; // MUST match TERRAIN_HEIGHT_SCALE
export const HM_DIVISOR = 255.0;      // MUST match TERRAIN_HEIGHTMAP_DIVISOR
const CPU_STEP = 5.0;                 // normal finite-diff step (finest clipmap spacing)

export interface Heightfield {
  size: number;
  /** Heightmap bytes. stride=4 for RGBA ImageData (client), stride=1 for a
   *  raw R-channel dump (server heightmap.bin). */
  data: Uint8Array | Uint8ClampedArray;
  stride: number;
}

export function hmHeight(f: Heightfield, wx: number, wz: number): number {
  const N = f.size;
  const u = (((wx / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * N - 0.5;
  const v = (((wz / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * N - 0.5;
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
  return (h / HM_DIVISOR) * HM_HEIGHT_SCALE;
}

export function hmNormal(f: Heightfield, wx: number, wz: number, out: { x: number; y: number; z: number }): void {
  const e = CPU_STEP * 0.5;
  const hL = hmHeight(f, wx - e, wz);
  const hR = hmHeight(f, wx + e, wz);
  const hD = hmHeight(f, wx, wz - e);
  const hU = hmHeight(f, wx, wz + e);
  const nx = hL - hR;
  const ny = 2.0 * e;
  const nz = hD - hU;
  const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
  out.x = nx * il;
  out.y = ny * il;
  out.z = nz * il;
}
