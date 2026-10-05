import * as THREE from 'three';
import type { Heightfield } from '../../../shared/heightfield.js';

import {
  TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE, TERRAIN_HEIGHTMAP_DIVISOR
} from '../core/config.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const DEFAULT_WORLD_SCALE = TERRAIN_WORLD_SCALE;

// Step size for CPU-side normal calculation (matches finest clipmap spacing)
const CPU_STEP = 5;

let hmData: Uint8ClampedArray | null = null;
let hmSize = 0;
// Per-map vertical gain (spec.heightScale) — multiplies HSCALE in every
// world-height read AND the shader uniforms, so physics, prediction and
// the mesh scale together. Server's field carries the same multiplier.
let hmScale = 1;
// Per-map tile span (spec.tileSize) — meters one heightmap wrap covers.
// T2 ports run 2048m tiles; default stays the engine's 1500.
let hmWorldScale = DEFAULT_WORLD_SCALE;

// Coarse per-cell max over the heightmap — lets a swept segment reject
// terrain in one lookup when it flies entirely above the local ground.
// 64×64 cells covers the world; a cell's max can never under-report, so
// skipping on `minY > cellMax` can't hide a real hit.
const MAXGRID = 64;
const maxGrid = new Uint8Array(MAXGRID * MAXGRID);

function cellMax(cx: number, cz: number, texel: number): number {
  let m = 0;
  const xEnd = Math.min(hmSize, (cx + 1) * texel);
  const zEnd = Math.min(hmSize, (cz + 1) * texel);
  for (let z = cz * texel; z < zEnd; z++) {
    const row = (z * hmSize + cx * texel) * 4;
    for (let x = cx * texel; x < xEnd; x++) {
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
  for (let cz = 0; cz < MAXGRID; cz++) {
    for (let cx = 0; cx < MAXGRID; cx++) {
      maxGrid[cz * MAXGRID + cx] = cellMax(cx, cz, texel);
    }
  }
}

/** Scaled world height of the tallest texel anywhere under the XZ rect
 *  (world coords, wrapped like sampleHeight). Returns 0 before data loads —
 *  callers must treat 0 as "unknown", not "flat". */
export function maxHeightInRect(wx0: number, wz0: number, wx1: number, wz1: number): number {
  if (!hmData || !hmSize) {return 0;}
  const toCell = (w: number) => {
    const u = (((w / hmWorldScale) % 1) + 1) % 1;
    return Math.min(MAXGRID - 1, Math.floor(u * MAXGRID));
  };
  // Walk cells from each end mod MAXGRID — a seam-crossing rect covers
  // its real cells; a rect spanning the world just scans the row (a
  // superset still can't under-report the max).
  const xa = toCell(wx0), xb = toCell(wx1);
  const za = toCell(wz0), zb = toCell(wz1);
  const span = (a: number, b: number) => {
    const d = (b - a + MAXGRID) % MAXGRID;
    return Math.min(d, MAXGRID - 1) + 1;
  };
  const nx = span(xa, xb), nz = span(za, zb);
  let m = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = (za + iz) % MAXGRID;
    const row = z * MAXGRID;
    for (let ix = 0; ix < nx; ix++) {
      const v = maxGrid[row + (xa + ix) % MAXGRID];
      if (v > m) {m = v;}
    }
  }
  return (m / TERRAIN_HEIGHTMAP_DIVISOR) * HSCALE * hmScale;
}

/** Server-format heightmap: 8-byte LE header (w,h) + uint8 grid, stride 1.
 *  This is what maps/<name>.bin carries — same bytes the server's
 *  BallSim/RoomMoveSim parse, so client prediction and server truth sample
 *  the identical field. */
export function setHeightScale(mult: number): void {
  if (mult === hmScale) {return;}
  hmScale = mult;
  _hvc.clear(); // visual cache holds scaled world heights — stale otherwise
}

export function getHeightScale(): number {
  return hmScale;
}

export function setWorldScale(meters: number): void {
  if (meters === hmWorldScale) {return;}
  hmWorldScale = meters;
  _hvc.clear();
}

export function getWorldScale(): number {
  return hmWorldScale;
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
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = src[i]!;
    rgba[i * 4 + 1] = src[i]!;
    rgba[i * 4 + 2] = src[i]!;
    rgba[i * 4 + 3] = 255;
  }
  hmData = rgba;
  hmSize = w;
  buildMaxGrid();
}

export async function loadHeightmap(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      hmSize = img.width;
      if (img.width !== img.height) {
        reject(new Error(`Heightmap must be square, got ${img.width}x${img.height}`));
        return;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      hmData = ctx.getImageData(0, 0, img.width, img.height).data; // RGBA
      buildMaxGrid();
      resolve();
    });
    img.addEventListener('error', () => reject(new Error(`heightmap load failed: ${url}`)));
    img.src = url;
  });
}

function hmSample(x: number, z: number): number {
  const idx = (z * hmSize + x) * 4;
  return hmData![idx] / TERRAIN_HEIGHTMAP_DIVISOR; // R channel 0..1
}

function sampleHeightmap(wx: number, wz: number): number {
  // GPU texture2D + LinearFilter evaluates at texel CENTERS — texel i sits at
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

// No quantization memo here — a cell-keyed cache returns a neighbor's
// height (up to ~slope×cell error), and this feeds prediction ground
// clamps: a wrong clamp reads as sim divergence → corrections. The
// bilinear itself is ~20 ops; the callers' sweep budgets are the lever.
export function sampleHeight(wx: number, wz: number): number {
  if (hmData) {return sampleHeightmap(wx, wz);}
  return 0;
}

// Visual-only cached read: debris shards / ambient particles ask for the
// same few 1m cells every frame while skimming ground. ~slope×1m error is
// invisible for decoration; sim code must keep calling sampleHeight above.
const _hvc = new Map<number, number>();
export function sampleHeightVisual(wx: number, wz: number): number {
  const k = (wx | 0) * 131_072 + (wz | 0);
  let v = _hvc.get(k);
  if (v === undefined) {
    if (_hvc.size > 2048) {_hvc.clear();}
    v = sampleHeight(wx, wz);
    _hvc.set(k, v);
  }
  return v;
}

/** Raw RGBA pixels for the GPU displacement texture — Terrain uploads this
 *  verbatim; null until loadHeightmap resolves. */
export function getHeightmapData(): { data: Uint8ClampedArray; size: number } | null {
  return hmData ? { data: hmData, size: hmSize } : null;
}

/** The heightmap in the shared format — server-owned creatures (ballSim)
 *  replay flight against the identical field, so prediction lands on the
 *  same vertices as the server's sim. */
export function getHeightfield(): Heightfield | null {
  return hmData ? { size: hmSize, data: hmData, stride: 4, heightScale: hmScale, worldScale: hmWorldScale } : null;
}

const _normalTmp = new THREE.Vector3();

export function sampleNormal(wx: number, wz: number): THREE.Vector3 {
  const e = CPU_STEP * 0.5;
  const hL = sampleHeight(wx - e, wz);
  const hR = sampleHeight(wx + e, wz);
  const hD = sampleHeight(wx, wz - e);
  const hU = sampleHeight(wx, wz + e);
  return _normalTmp.set(hL - hR, 2 * e, hD - hU).normalize();
}
