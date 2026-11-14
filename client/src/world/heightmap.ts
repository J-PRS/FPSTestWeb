import * as THREE from 'three';
import type { Heightfield } from '../../../shared/heightfield.js';

import {
  TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE, TERRAIN_HEIGHTMAP_DIVISOR, TERRAIN_STRUCTURE_LIPS
} from '../core/config.js';
import { urlParams } from '../core/params.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const DEFAULT_WORLD_SCALE = TERRAIN_WORLD_SCALE;

// Step size for CPU-side normal calculation (matches finest clipmap spacing)
const CPU_STEP = 5;

let hmData: Uint8ClampedArray | null = null;
let hmSize = 0;
// Per-map vertical gain (spec.heightScale) - multiplies HSCALE in every
// world-height read AND the shader uniforms, so physics, prediction and
// the mesh scale together. Server's field carries the same multiplier.
let hmScale = 1;
// Per-map tile span (spec.tileSize) - meters one heightmap wrap covers.
// T2 ports run 2048m tiles; default stays the engine's 1500.
let hmWorldScale = DEFAULT_WORLD_SCALE;

// Coarse per-cell max over the heightmap - lets a swept segment reject
// terrain in one lookup when it flies entirely above the local ground.
// 64×64 cells covers the world; a cell's max can never under-report, so
// skipping on `minY > cellMax` can't hide a real hit.
const MAXGRID = 64;
const maxGrid = new Uint8Array(MAXGRID * MAXGRID);

function cellMax(cx: number, cz: number, texel: number): number {
  let m = 0;
  const xEnd = Math.min(hmSize, (cx + 1) * texel);
  const zEnd = Math.min(hmSize, (cz + 1) * texel);
  for (let z = cz * texel; z < zEnd; z += 1) {
    const row = (z * hmSize + cx * texel) * 4;
    for (let x = cx * texel; x < xEnd; x += 1) {
      const v = hmData![row + (x - cx * texel) * 4];
      if (v > m) {m = v;}
    }
  }
  return m;
}

function buildMaxGrid(): void {
  maxGrid.fill(0);
  if (!hmData || !hmSize) {return;}
  const texel = Math.max(1, Math.floor(hmSize / MAXGRID));
  for (let cz = 0; cz < MAXGRID; cz += 1) {
    for (let cx = 0; cx < MAXGRID; cx += 1) {
      maxGrid[cz * MAXGRID + cx] = cellMax(cx, cz, texel);
    }
  }
}

/** Scaled world height of the tallest texel anywhere under the XZ rect
 *  (world coords, wrapped like sampleHeight). Returns 0 before data loads -
 *  callers must treat 0 as "unknown", not "flat". */
const toCell = (w: number): number => {
  const u = (((w / hmWorldScale) % 1) + 1) % 1;
  return Math.min(MAXGRID - 1, Math.floor(u * MAXGRID));
};
const span = (a: number, b: number): number => {
  const d = (b - a + MAXGRID) % MAXGRID;
  return Math.min(d, MAXGRID - 1) + 1;
};

export function maxHeightInRect(wx0: number, wz0: number, wx1: number, wz1: number): number {
  if (!hmData || !hmSize) {return 0;}
  // Walk cells from each end mod MAXGRID - a seam-crossing rect covers
  // its real cells; a rect spanning the world just scans the row (a
  // superset still can't under-report the max).
  const xa = toCell(wx0), xb = toCell(wx1);
  const za = toCell(wz0), zb = toCell(wz1);
  const nx = span(xa, xb), nz = span(za, zb);
  let m = 0;
  for (let iz = 0; iz < nz; iz += 1) {
    const z = (za + iz) % MAXGRID;
    const row = z * MAXGRID;
    for (let ix = 0; ix < nx; ix += 1) {
      const v = maxGrid[row + (xa + ix) % MAXGRID];
      if (v > m) {m = v;}
    }
  }
  return (m / TERRAIN_HEIGHTMAP_DIVISOR) * HSCALE * hmScale;
}

/** Server-format heightmap: 8-byte LE header (w,h) + uint8 grid, stride 1.
 *  This is what maps/<name>.bin carries - same bytes the server's
 *  BallSim/RoomMoveSim parse, so client prediction and server truth sample
 *  the identical field. */
export function setHeightScale(mult: number): void {
  if (mult === hmScale) {return;}
  hmScale = mult;
  _hvc.clear(); // visual cache holds scaled world heights - stale otherwise
  invalidateField();
}

export function getHeightScale(): number {
  return hmScale;
}

export function setWorldScale(meters: number): void {
  if (meters === hmWorldScale) {return;}
  hmWorldScale = meters;
  _hvc.clear();
  invalidateField();
}

export function getWorldScale(): number {
  return hmWorldScale;
}

/** Push the resident field's gain/span into the render uniforms - call
 *  wherever the module state is set outside applyTerrain (boot prime,
 *  demo inject/restore) or the mesh draws at the old gain while the
 *  collider already samples the new one. */
export function applyHeightfieldScale(terrain: { setHeightScale(v: number): void; setWorldScale(v: number): void }): void {
  terrain.setHeightScale(HSCALE * hmScale);
  terrain.setWorldScale(hmWorldScale);
}

export async function loadHeightfieldBin(url: string): Promise<void> {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = view.getUint32(0, true);
  const h = view.getUint32(4, true);
  if (w !== h || w < 2 || buf.byteLength !== 8 + w * h) {
    throw new Error(`Bad heightfield bin: ${w}x${h}, ${buf.byteLength} bytes (${url})`);
  }
  const src = buf.subarray(8);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = src[i]!;
    rgba[i * 4 + 1] = src[i]!;
    rgba[i * 4 + 2] = src[i]!;
    rgba[i * 4 + 3] = 255;
  }
  hmData = rgba;
  hmSize = w;
  buildMaxGrid();
  rebuildVisual(); // lips reapply on the new field - sources persist across swaps
  invalidateField();
}

function hmSample(x: number, z: number): number {
  const idx = (z * hmSize + x) * 4;
  return hmData![idx] / TERRAIN_HEIGHTMAP_DIVISOR; // R channel 0..1
}

// Raw bilinear read - the FIELD, not the collider. Ground truth is the
// 5m L0 chord in sampleHeight (see shared/heightfield.ts hmHeight -
// physics on both ends now collides with the drawn clipmap surface).
function sampleHeightmap(wx: number, wz: number): number {
  // GPU texture2D + LinearFilter evaluates at texel CENTERS - texel i sits at
  // (i + 0.5)/N in UV space. Sample identically on CPU (u shifted by -0.5) or
  // physics height is offset half a texel from the rendered mesh, which puts
  // the player/projectiles inside hills on steep slopes.
  const u = (((wx / hmWorldScale) % 1) + 1) % 1 * hmSize - 0.5;
  const v = (((wz / hmWorldScale) % 1) + 1) % 1 * hmSize - 0.5;
  const x0 = ((Math.floor(u) % hmSize) + hmSize) % hmSize;
  const z0 = ((Math.floor(v) % hmSize) + hmSize) % hmSize;
  const x1 = (x0 + 1) % hmSize;
  const z1 = (z0 + 1) % hmSize;
  const fx = u - Math.floor(u);
  const fz = v - Math.floor(v);
  const h =
    hmSample(x0, z0) * (1 - fx) * (1 - fz) +
    hmSample(x1, z0) * fx * (1 - fz) +
    hmSample(x0, z1) * (1 - fx) * fz +
    hmSample(x1, z1) * fx * fz;
  return h * HSCALE * hmScale;
}

// No quantization memo here - a cell-keyed cache returns a neighbor's
// height (up to ~slope×cell error), and this feeds prediction ground
// clamps: a wrong clamp reads as sim divergence → corrections. The
// bilinear itself is ~20 ops; the callers' sweep budgets are the lever.
export function sampleHeight(wx: number, wz: number): number {
  if (!hmData) {return 0;}
  // The L0 clipmap chord (two flat triangles per 5m cell, world-anchored
  // lattice) - mirrors shared/heightfield.ts hmChord so prediction lands
  // on the same surface the server sims AND the GPU draws.
  const s = 5;
  const x0 = Math.floor(wx / s) * s, z0 = Math.floor(wz / s) * s;
  const h00 = sampleHeightmap(x0, z0), h10 = sampleHeightmap(x0 + s, z0);
  const h01 = sampleHeightmap(x0, z0 + s), h11 = sampleHeightmap(x0 + s, z0 + s);
  const tx = (wx - x0) / s, tz = (wz - z0) / s;
  return tx + tz <= 1
    ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
    : h11 + (h10 - h11) * (1 - tz) + (h01 - h11) * (1 - tx);
}

// Visual-only cached read: debris shards / ambient particles ask for the
// same few 1m cells every frame while skimming ground. ~slope×1m error is
// invisible for decoration; sim code must keep calling sampleHeight above.
const _hvc = new Map<number, number>();
export function sampleHeightVisual(wx: number, wz: number): number {
  const k = (Math.trunc(wx)) * 131_072 + (Math.trunc(wz));
  let v = _hvc.get(k);
  if (v === undefined) {
    if (_hvc.size > 2048) {_hvc.clear();}
    v = sampleHeight(wx, wz);
    _hvc.set(k, v);
  }
  return v;
}

/** Raw RGBA pixels for the GPU displacement texture - Terrain uploads this
 *  verbatim; null until the field arrives via injectHeightmapBytes. When
 *  structure sediment lips are set, this returns the BUMPED visual copy -
 *  the sim still reads raw hmData everywhere else (the lip is cosmetic:
 *  a couple of meters under a structure's own footprint, below anything
 *  gameplay would sample honestly). */
export function getHeightmapData(): { data: Uint8ClampedArray; size: number } | null {
  const d = hmVisual ?? hmData;
  if (d) {packLodMin(d);}
  return d ? { data: d, size: hmSize } : null;
}

// --- LOD min channels ------------------------------------------------------
// Coarse clipmap rings draw chords over up-to-40m cells; the chord interior
// can hang above the sim surface and swallow remotes/pickups (the "buried
// under terrain" class). G/B/A carry a min-pool of R at each coarse level's
// reach (10/40/80m - the real vertSpacing chords, not the nominal cell);
// a level's vertex samples its own channel, so the drawn triangle is never
// above the collider anywhere in its cell. Residual flips to "slightly
// above a coarsened dip" - shootable-honest. C6 in
// _docs/UPHEAVAL/CANDIDATES.md. Only R feeds the min (lips included).
const LOD_SPACINGS_M = [0, 10, 40, 80]; // channel = clipmap level; 0 = exact R
let hmPackedSrc: Uint8ClampedArray | null = null;

function packLodMin(src: Uint8ClampedArray): void {
  if (hmPackedSrc === src || !hmSize) {return;}
  const N = hmSize;
  const texel = hmWorldScale / N;
  const tmp = new Uint8Array(N * N);
  for (let lod = 1; lod < LOD_SPACINGS_M.length; lod += 1) {
    // Texel radius covering every texel that can influence a 5m-lattice
    // point inside a vertex's +-s window (vertex bilinear touches texels
    // +-T of it, each lattice point touches +-T of itself): s+2T.
    const r = Math.ceil((LOD_SPACINGS_M[lod]! + 2 * texel) / texel);
    poolMinAxis(src, 0, tmp, 0, r, true);
    poolMinAxis(tmp, 0, src, lod, r, false);
  }
  hmPackedSrc = src;
}

/** One separable min-pool pass: horiz pools R-field texels into a flat
 *  scratch row, vert pools scratch back into the `outChan` RGBA lane. */
function poolMinAxis(inp: Uint8ClampedArray | Uint8Array, inChan: number, out: Uint8ClampedArray | Uint8Array, outChan: number, r: number, horiz: boolean): void {
  const N = hmSize;
  for (let z = 0; z < N; z += 1) {
    const row = z * N;
    for (let x = 0; x < N; x += 1) {
      let m = 255;
      for (let d = -r; d <= r; d += 1) {
        const i = horiz ? row + ((x + d) % N + N) % N : (((z + d) % N + N) % N) * N + x;
        const v = inp[horiz ? i * 4 + inChan : i]!;
        if (v < m) {m = v;}
      }
      out[horiz ? row + x : (row + x) * 4 + outChan] = m;
    }
  }
}

/** Min-pooled field read for clipmap level `lod` (1..3). Same texel-center
 *  bilinear as sampleHeightmap so the CPU mirror equals the GPU vertex. */
export function sampleHeightLod(lod: number, wx: number, wz: number): number {
  const d = hmVisual ?? hmData;
  if (!d || !hmSize) {return 0;}
  packLodMin(d);
  return sampleChannel(d, lod, wx, wz);
}

function sampleChannel(d: Uint8ClampedArray, chan: number, wx: number, wz: number): number {
  const u = (((wx / hmWorldScale) % 1) + 1) % 1 * hmSize - 0.5;
  const v = (((wz / hmWorldScale) % 1) + 1) % 1 * hmSize - 0.5;
  const x0 = ((Math.floor(u) % hmSize) + hmSize) % hmSize;
  const z0 = ((Math.floor(v) % hmSize) + hmSize) % hmSize;
  const x1 = (x0 + 1) % hmSize;
  const z1 = (z0 + 1) % hmSize;
  const fx = u - Math.floor(u);
  const fz = v - Math.floor(v);
  const at = (x: number, z: number): number => d[(z * hmSize + x) * 4 + chan]! / TERRAIN_HEIGHTMAP_DIVISOR;
  const h =
    at(x0, z0) * (1 - fx) * (1 - fz) +
    at(x1, z0) * fx * (1 - fz) +
    at(x0, z1) * (1 - fx) * fz +
    at(x1, z1) * fx * fz;
  return h * HSCALE * hmScale;
}

// --- visual-only sediment lips -------------------------------------------
// Structure bases mound the DRAWN field - organic accumulation around the
// footprint edge so hulls sit IN the ground instead of on it. Bumps merge
// per source ('structs', 'interiors') so each replacer clears its own set
// on map swap; reloadHeightmap re-uploads the texture afterwards.
export interface TerrainBump { x: number; z: number; r: number; h: number }
let hmVisual: Uint8ClampedArray | null = null;
const bumpSources = new Map<string, TerrainBump[]>();

export function setTerrainBumps(source: string, list: TerrainBump[] | null): void {
  if (list?.length) {bumpSources.set(source, list);}
  else {bumpSources.delete(source);}
  rebuildVisual();
}

/** Wipe every bump source - full teardown (tests, demo-inject swaps whose
 *  placement set never re-fires). Structure lists re-push their own lips
 *  on the next apply path; this is the escape hatch when they won't. */
export function clearTerrainBumps(): void {
  bumpSources.clear();
  hmVisual = null;
}

function rebuildVisual(): void {
  if (!TERRAIN_STRUCTURE_LIPS || urlParams.noLips || !hmData || !hmSize || bumpSources.size === 0) {hmVisual = null; return;}
  const v = new Uint8ClampedArray(hmData);
  const metersToByte = TERRAIN_HEIGHTMAP_DIVISOR / (HSCALE * hmScale);
  let idx = 0;
  for (const list of bumpSources.values()) {
    for (const b of list) {
      const seed = idx++ * 2.17;
      const gx = (((b.x / hmWorldScale) % 1 + 1) % 1) * hmSize;
      const gz = (((b.z / hmWorldScale) % 1 + 1) % 1) * hmSize;
      const gr = (b.r / hmWorldScale) * hmSize;
      const reach = Math.ceil(gr * 2.1);
      for (let dz = -reach; dz <= reach; dz += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) {
          const d = Math.hypot(dx, dz);
          // Angular wobble - the ring radius breathes by direction so the
          // lip reads wind-drifted, not a stamped circle.
          const ang = Math.atan2(dz, dx);
          const tw = d / (gr * (1 + 0.2 * Math.sin(3 * ang + seed) + 0.1 * Math.sin(7 * ang + seed * 1.7)));
          // Apron profile: flat under the footprint (<0.35r), peak ~0.9r,
          // fade to zero at 2r - soil piled at the wall, not under it.
          let amp = 0;
          if (tw > 0.35 && tw <= 0.9) { const t = (tw - 0.35) / 0.55; amp = t * t * (3 - 2 * t); }
          else if (tw > 0.9 && tw < 2) { const t = 1 - (tw - 0.9) / 1.1; amp = t * t * (3 - 2 * t); }
          else {continue;}
          const lift = amp * b.h * metersToByte;
          if (lift < 1) {continue;}
          const x = ((Math.round(gx + dx) % hmSize) + hmSize) % hmSize;
          const z = ((Math.round(gz + dz) % hmSize) + hmSize) % hmSize;
          const p = (z * hmSize + x) * 4;
          const nv = Math.min(255, v[p]! + lift);
          v[p] = v[p + 1] = v[p + 2] = nv;
        }
      }
    }
  }
  hmVisual = v;
}

/** The heightmap in the shared format - server-owned creatures (ballSim)
 *  replay flight against the identical field, so prediction lands on the
 *  same vertices as the server's sim. */
let _fieldObj: Heightfield | null = null;
export function getHeightfield(): Heightfield | null {
  // Cached wrapper - heightfield.chordTaps keys its chord-tap cache on the
  // field OBJECT; minting a fresh wrapper here invalidated the cache every
  // call and rebuilt the span² tap array inside every stepBall (~9ms×N).
  if (!hmData) { _fieldObj = null; return null; }
  if (!_fieldObj) {_fieldObj = { size: hmSize, data: hmData, stride: 4, heightScale: hmScale, worldScale: hmWorldScale };}
  return _fieldObj;
}
/** Any module-state mutation must rebuild the cached field wrapper or
 *  stale size/scale leaks into physics sampling. */
function invalidateField(): void { _fieldObj = null; }

// Full module state, restorable - demo playback swaps in the clip's
// embedded terrain, then hands the live map back on stop.
export interface HeightmapSnapshot {
  data: Uint8ClampedArray | null; size: number; scale: number; worldScale: number;
}

export function snapshotHeightmap(): HeightmapSnapshot {
  return { data: hmData, size: hmSize, scale: hmScale, worldScale: hmWorldScale };
}

export function restoreHeightmap(snap: HeightmapSnapshot): void {
  hmData = snap.data; hmSize = snap.size; hmScale = snap.scale; hmWorldScale = snap.worldScale;
  buildMaxGrid();
  rebuildVisual();
  _hvc.clear();
  invalidateField();
}



/** Replace the field with a stride-1 u8 grid (e.g. a demo's embedded
 *  HMAP). Returns a restore() that hands back the previous field -
 *  callers must also Terrain.reloadHeightmap() on both transitions. */
export function injectHeightmapBytes(
  data: Uint8Array | Uint8ClampedArray, size: number, heightScale: number, worldScale: number
): () => void {
  const prev = snapshotHeightmap();
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = data[i]!;
    rgba[i * 4 + 1] = data[i]!;
    rgba[i * 4 + 2] = data[i]!;
    rgba[i * 4 + 3] = 255;
  }
  hmData = rgba; hmSize = size; hmScale = heightScale; hmWorldScale = worldScale;
  buildMaxGrid();
  rebuildVisual();
  _hvc.clear();
  invalidateField();
  return (): void => restoreHeightmap(prev);
}

const _normalTmp = new THREE.Vector3();

export function sampleNormal(wx: number, wz: number): THREE.Vector3 {
  const e = CPU_STEP * 0.5;
  const hL = sampleHeight(wx - e, wz);
  const hR = sampleHeight(wx + e, wz);
  const hD = sampleHeight(wx, wz - e);
  const hU = sampleHeight(wx, wz + e);
  const n = _normalTmp.set(hL - hR, 2 * e, hD - hU).normalize();
  // NaN heights normalize to a NaN vector - feeding it to a quaternion
  // renders the mesh invisible; flat ground is the honest fallback.
  return Number.isFinite(n.x) && Number.isFinite(n.z) ? n : n.set(0, 1, 0);
}
