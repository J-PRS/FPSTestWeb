import { describe, expect, it } from 'vitest';
import { clipmapSurfaceHeight, type ClipmapSurfaceLevel } from '../world/clipmapSurface.js';

const field = (x: number, z: number): number =>
  Math.sin(x * 0.013) * 14 + Math.cos(z * 0.021) * 9 + Math.sin((x + z) * 0.004) * 22;

const levels: ClipmapSurfaceLevel[] = [
  { originX: 0, originZ: 0, halfSize: 200, levelScale: 400, spacing: 5, parentSpacing: 10, parentOriginX: 0, parentOriginZ: 0 },
  { originX: 0, originZ: 0, halfSize: 400, levelScale: 800, spacing: 10, parentSpacing: 40, parentOriginX: 0, parentOriginZ: 0 },
  { originX: 0, originZ: 0, halfSize: 800, levelScale: 1600, spacing: 40, parentSpacing: 80, parentOriginX: 0, parentOriginZ: 0 },
  { originX: 0, originZ: 0, halfSize: 1600, levelScale: 3200, spacing: 80, parentSpacing: 0, parentOriginX: 0, parentOriginZ: 0 },
];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function expectedSurface(level: ClipmapSurfaceLevel, x: number, z: number): number {
  const half = level.levelScale / 2;
  const x0 = level.originX - half + Math.floor((x - (level.originX - half)) / level.spacing) * level.spacing;
  const z0 = level.originZ - half + Math.floor((z - (level.originZ - half)) / level.spacing) * level.spacing;
  const vertex = (vx: number, vz: number): number => {
    const h = field(vx, vz);
    if (level.parentSpacing <= 0) {return h;}
    const px0 = level.parentOriginX + Math.floor((vx - level.parentOriginX) / level.parentSpacing) * level.parentSpacing;
    const pz0 = level.parentOriginZ + Math.floor((vz - level.parentOriginZ) / level.parentSpacing) * level.parentSpacing;
    const tx = (vx - px0) / level.parentSpacing, tz = (vz - pz0) / level.parentSpacing;
    const a = field(px0, pz0), b = field(px0 + level.parentSpacing, pz0);
    const c = field(px0, pz0 + level.parentSpacing), d = field(px0 + level.parentSpacing, pz0 + level.parentSpacing);
    const parent = tx + tz <= 1
      ? a + (b - a) * tx + (c - a) * tz
      : d + (b - d) * (1 - tz) + (c - d) * (1 - tx);
    const dist = Math.max(Math.abs(vx - level.originX), Math.abs(vz - level.originZ));
    const blend = smoothstep(half - level.parentSpacing * 2, half, dist);
    return h + (parent - h) * blend;
  };
  const tx = (x - x0) / level.spacing, tz = (z - z0) / level.spacing;
  const a = vertex(x0, z0), b = vertex(x0 + level.spacing, z0);
  const c = vertex(x0, z0 + level.spacing), d = vertex(x0 + level.spacing, z0 + level.spacing);
  return tx + tz <= 1
    ? a + (b - a) * tx + (c - a) * tz
    : d + (b - d) * (1 - tz) + (c - d) * (1 - tx);
}

describe('CPU clipmap surface', (): void => {
  it('matches the GPU triangle plane throughout each LOD transition band', (): void => {
    for (let i = 0; i < levels.length - 1; i += 1) {
      const l = levels[i]!;
      const start = l.levelScale / 2 - l.parentSpacing * 2;
      for (const d of [start, start + l.parentSpacing, l.levelScale / 2]) {
        const x = l.originX + d;
        const z = l.originZ + Math.floor((l.halfSize * 0.37) / l.spacing) * l.spacing + l.spacing * 0.31;
        expect(clipmapSurfaceHeight(levels, x, z, field)).toBeCloseTo(expectedSurface(l, x, z), 10);
      }
    }
  });

  it('returns the rendered triangle plane, not the unsplit bilinear patch', (): void => {
    const x = 12, z = 7;
    const h00 = field(10, 5), h10 = field(15, 5), h01 = field(10, 10);
    const expected = h00 + (h10 - h00) * (2 / 5) + (h01 - h00) * (2 / 5);
    expect(clipmapSurfaceHeight(levels, x, z, field)).toBeCloseTo(expected, 10);
  });

  it('changes level at the same nested ring boundary used by rendering', (): void => {
    const fineEdge = clipmapSurfaceHeight(levels, 199.99, 13, field);
    const coarseSide = clipmapSurfaceHeight(levels, 200.01, 13, field);
    expect(Number.isFinite(fineEdge)).toBe(true);
    expect(Number.isFinite(coarseSide)).toBe(true);
    expect(Math.abs(fineEdge - coarseSide)).toBeLessThan(2);
  });
});
