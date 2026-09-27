import * as THREE from 'three';
import type { Heightfield } from '../../../shared/heightfield.js';

import {
  TERRAIN_HEIGHT_SCALE, TERRAIN_WORLD_SCALE, TERRAIN_HEIGHTMAP_DIVISOR
} from '../core/config.js';

const HSCALE = TERRAIN_HEIGHT_SCALE;
const HM_WORLD_SCALE = TERRAIN_WORLD_SCALE;

// Step size for CPU-side normal calculation (matches finest clipmap spacing)
const CPU_STEP = 5.0;

let hmData: Uint8ClampedArray | null = null;
let hmSize = 0;

export async function loadHeightmap(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
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
      resolve();
    };
    img.onerror = reject;
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
  const u = (((wx / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize - 0.5;
  const v = (((wz / HM_WORLD_SCALE) % 1.0) + 1.0) % 1.0 * hmSize - 0.5;
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
  return h * HSCALE;
}

export function sampleHeight(wx: number, wz: number): number {
  if (hmData) return sampleHeightmap(wx, wz);
  return 0;
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
  return hmData ? { size: hmSize, data: hmData, stride: 4 } : null;
}

const _normalTmp = new THREE.Vector3();

export function sampleNormal(wx: number, wz: number): THREE.Vector3 {
  const e = CPU_STEP * 0.5;
  const hL = sampleHeight(wx - e, wz);
  const hR = sampleHeight(wx + e, wz);
  const hD = sampleHeight(wx, wz - e);
  const hU = sampleHeight(wx, wz + e);
  return _normalTmp.set(hL - hR, 2.0 * e, hD - hU).normalize();
}
