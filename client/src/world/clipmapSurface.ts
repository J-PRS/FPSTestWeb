export interface ClipmapSurfaceLevel {
  originX: number;
  originZ: number;
  halfSize: number;
  levelScale: number;
  spacing: number;
  parentSpacing: number;
  parentOriginX: number;
  parentOriginZ: number;
  /** Per-level field sampler (min-pooled for coarse rings so the drawn
   *  chord can't hang above the sim surface). Falls back to `sample`. */
  sample?: (x: number, z: number) => number;
  /** The parent ring's own sampler - its chord lives on ITS surface. */
  parentSample?: (x: number, z: number) => number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const cacheX = new Float64Array(32);
const cacheZ = new Float64Array(32);
const cacheH = new Float64Array(32);
const cacheF: (((x: number, z: number) => number) | null)[] = new Array(32).fill(null);
let cacheN = 0;

// Calls are synchronous on the render thread; a fixed scratch avoids per-query
// maps/closures while deduping shared parent-chord taps in transition bands.
// Keyed on the sampler too - level and parent taps can hit the same xz on
// different field surfaces (min-pooled vs exact).
function readCached(fn: (x: number, z: number) => number, x: number, z: number): number {
  for (let i = 0; i < cacheN; i += 1) {
    if (cacheF[i] === fn && cacheX[i] === x && cacheZ[i] === z) {return cacheH[i]!;}
  }
  const h = fn(x, z);
  if (cacheN < cacheX.length) {
    cacheF[cacheN] = fn;
    cacheX[cacheN] = x;
    cacheZ[cacheN] = z;
    cacheH[cacheN] = h;
    cacheN += 1;
  }
  return h;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function triangleHeight(x: number, z: number, spacing: number, originX: number, originZ: number,
                        sample: (x: number, z: number) => number): number {
  const x0 = originX + Math.floor((x - originX) / spacing) * spacing;
  const z0 = originZ + Math.floor((z - originZ) / spacing) * spacing;
  const tx = (x - x0) / spacing, tz = (z - z0) / spacing;
  const h00 = sample(x0, z0), h10 = sample(x0 + spacing, z0);
  const h01 = sample(x0, z0 + spacing), h11 = sample(x0 + spacing, z0 + spacing);
  return tx + tz <= 1
    ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
    : h11 + (h10 - h11) * (1 - tz) + (h01 - h11) * (1 - tx);
}

function morphedVertex(x: number, z: number, level: ClipmapSurfaceLevel,
                       sample: (x: number, z: number) => number): number {
  const smp = level.sample ?? sample;
  const h = readCached(smp, x, z);
  if (level.parentSpacing <= 0) {return h;}
  const edgeDistance = Math.max(Math.abs(x - level.originX), Math.abs(z - level.originZ));
  const half = level.levelScale * 0.5;
  const blend = smoothstep(half - level.parentSpacing * 2, half, edgeDistance);
  if (blend <= 0) {return h;}
  const parent = triangleHeight(x, z, level.parentSpacing, level.parentOriginX, level.parentOriginZ,
    (px, pz) => readCached(level.parentSample ?? sample, px, pz));
  return h + (parent - h) * blend;
}

/** CPU equivalent of the clipmap's selected grid triangle after vertex LOD morphing. */
export function clipmapSurfaceHeight(
  levels: readonly ClipmapSurfaceLevel[],
  x: number,
  z: number,
  sample: (x: number, z: number) => number,
): number {
  let level: ClipmapSurfaceLevel | undefined;
  for (const candidate of levels) {
    if (Math.abs(x - candidate.originX) < candidate.halfSize &&
        Math.abs(z - candidate.originZ) < candidate.halfSize) {
      level = candidate;
      break;
    }
  }
  if (!level) {level = levels[levels.length - 1];}
  if (!level) {return 0;}
  cacheN = 0;

  const half = level.levelScale * 0.5;
  const x0 = level.originX - half + Math.floor((x - (level.originX - half)) / level.spacing) * level.spacing;
  const z0 = level.originZ - half + Math.floor((z - (level.originZ - half)) / level.spacing) * level.spacing;
  const tx = (x - x0) / level.spacing, tz = (z - z0) / level.spacing;
  const h00 = morphedVertex(x0, z0, level, sample);
  const h10 = morphedVertex(x0 + level.spacing, z0, level, sample);
  const h01 = morphedVertex(x0, z0 + level.spacing, level, sample);
  const h11 = morphedVertex(x0 + level.spacing, z0 + level.spacing, level, sample);
  return tx + tz <= 1
    ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
    : h11 + (h10 - h11) * (1 - tz) + (h01 - h11) * (1 - tx);
}
