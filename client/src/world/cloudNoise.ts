/**
 * cloudNoise — the shared noise/field helpers for the cloud family:
 * tileable value-noise (dome deck) and billboard-puff sampling live in
 * volumetricClouds.ts / cloudPuffs.ts respectively; this leaf keeps the
 * dep one-directional instead of the two modules importing each other.
 */

// World meters covered by one noise-tex repeat — ~500m puff features.
export const NOISE_WORLD_SCALE = 3200;

export const noiseHash = (x: number, y: number): number => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};
export const _smooth = (t: number) => t * t * (3 - 2 * t);

// Sample a normalized CPU field with repeat-wrapping, bilinear.
export function sampleBase(base: Float32Array, size: number, u: number, v: number): number {
  const x = ((u % 1) + 1) % 1 * size, y = ((v % 1) + 1) % 1 * size;
  const xi = Math.floor(x) % size, yi = Math.floor(y) % size;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const a = base[yi * size + xi]!, b = base[yi * size + (xi + 1) % size]!;
  const c = base[((yi + 1) % size) * size + xi]!, d = base[((yi + 1) % size) * size + (xi + 1) % size]!;
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
