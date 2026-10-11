// LOD seam weld: each clipmap level's outer-edge verts morph onto the
// parent ring's drawn surface — the same two-triangle field chord the
// parent's flat grid interpolates. These tests port the vertex-shader
// math 1:1 (terrainShaders.ts) and assert the weld stays exact even
// when origin snapping lands the boundary off the parent lattice, and
// that the only residual anywhere is the sub-quad triangle-split fold.
import { describe, it, expect } from 'vitest';

// Mirrors CLIPMAP_LEVELS + the outer-ring half-division geometry in
// terrain.ts — real vertex spacing is what the mesh actually draws, not
// cfg.spacing (that mismatch was the original distant-hole bug).
const LEVELS = [
  { levelScale: 5 * 80,  vertSpacing: 5 },
  { levelScale: 10 * 80, vertSpacing: 10 },
  { levelScale: 20 * 80, vertSpacing: 40 },
  { levelScale: 40 * 80, vertSpacing: 80 },
] as const;

// A curved field — linear fields can't expose chord-vs-polyline error.
const field = (x: number, z: number): number =>
  Math.sin(x * 0.013) * 14 + Math.cos(z * 0.021) * 9 + Math.sin((x + z) * 0.004) * 22;

const snap = (p: number, s: number): number => Math.round(p / s) * s;

// --- GLSL ports (keep in sync with terrainVert) ---
function parentChord(p: [number, number], o: [number, number], s: number): number {
  const lx = p[0] - o[0], lz = p[1] - o[1];
  const cx = Math.floor(lx / s) * s, cz = Math.floor(lz / s) * s;
  const fx = (lx - cx) / s, fz = (lz - cz) / s;
  const x0 = o[0] + cx, z0 = o[1] + cz;
  const s00 = field(x0, z0), s10 = field(x0 + s, z0);
  const s01 = field(x0, z0 + s), s11 = field(x0 + s, z0 + s);
  return fx + fz <= 1
    ? s00 + (s10 - s00) * fx + (s01 - s00) * fz
    : s11 + (s10 - s11) * (1 - fz) + (s01 - s11) * (1 - fx);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function morphHeight(p: [number, number], own: [number, number], levelScale: number,
    parentSpacing: number, parentOrigin: [number, number]): number {
  const h = field(p[0], p[1]);
  if (parentSpacing <= 0) {return h;}
  const dist = Math.max(Math.abs(p[0] - own[0]), Math.abs(p[1] - own[1]));
  const halfOuter = levelScale * 0.5;
  const morphStart = halfOuter - parentSpacing * 2;
  if (dist <= morphStart) {return h;}
  return h + (parentChord(p, parentOrigin, parentSpacing) - h) *
    smoothstep(morphStart, halfOuter, dist);
}

// The parent ring's drawn surface IS the tri-chord — same function.
const parentSurface = parentChord;

describe('LOD seam weld', () => {
  // Boundary verts (dist >= halfSize) must land exactly on the parent's
  // drawn surface — that's what makes the discard-hole seam watertight.
  // Sweeps player positions that snap inner/outer origins to opposite
  // lattice parities, the case the old coarse→fine morph left cracked.
  it('outer-edge verts lie exactly on the parent surface at any parity', () => {
    for (const px of [0, 2.5, 7.5, 33.3]) {
      for (let i = 0; i < LEVELS.length - 1; i += 1) {
        const lvl = LEVELS[i];
        const parent = LEVELS[i + 1];
        const half = lvl.levelScale / 2;
        const own: [number, number] = [snap(px, lvl.vertSpacing), snap(px, lvl.vertSpacing)];
        const pSpacing = parent.vertSpacing;
        const pOrigin: [number, number] = [snap(px, pSpacing), snap(px, pSpacing)];
        for (const zFrac of [-1, -0.5, -0.27, 0, 0.63, 1]) {
          const p: [number, number] = [own[0] + half, own[1] + zFrac * half];
          expect(morphHeight(p, own, lvl.levelScale, pSpacing, pOrigin))
            .toBeCloseTo(parentSurface(p, pOrigin, pSpacing), 6);
        }
      }
    }
  });

  // Residual between the fine edge TRIANGLE and the parent surface is
  // bounded by the quad-split fold only — not the field-vs-chord meters
  // the old scheme leaked at every seam.
  it('edge-tri residual stays within the triangle-split fold', () => {
    const px = 7.5; // worst-case parity
    for (let i = 0; i < LEVELS.length - 1; i += 1) {
      const lvl = LEVELS[i];
      const parent = LEVELS[i + 1];
      const half = lvl.levelScale / 2;
      const own: [number, number] = [snap(px, lvl.vertSpacing), snap(px, lvl.vertSpacing)];
      const pSpacing = parent.vertSpacing;
      const pOrigin: [number, number] = [snap(px, pSpacing), snap(px, pSpacing)];
      // Edge-strip triangles: verts at (half, z) and (half+ownSpacing, z).
      let worst = 0;
      for (let z = -half; z < half; z += lvl.vertSpacing) {
        for (const f of [0.25, 0.5, 0.75]) {
          const wz = own[1] + z + f * lvl.vertSpacing;
          const hEdge = morphHeight([own[0] + half, own[1] + z], own, lvl.levelScale, pSpacing, pOrigin);
          const hEdge2 = morphHeight([own[0] + half, own[1] + z + lvl.vertSpacing], own, lvl.levelScale, pSpacing, pOrigin);
          const fine = hEdge + (hEdge2 - hEdge) * f;
          worst = Math.max(worst, Math.abs(fine - parentSurface([own[0] + half, wz], pOrigin, pSpacing)));
        }
      }
      // Quad-fold bound: curvature of `field` over a parent cell is ~1m;
      // anything larger means the weld regressed.
      expect(worst).toBeLessThan(2);
    }
  });

  it('unmorphed interior keeps raw field height', () => {
    const [lvl, parent] = LEVELS;
    const own: [number, number] = [100, 100];
    const pSpacing = parent.vertSpacing;
    const pOrigin: [number, number] = [100, 100];
    const p: [number, number] = [own[0] + 50, own[1] + 30]; // well inside
    expect(morphHeight(p, own, lvl.levelScale, pSpacing, pOrigin)).toBe(field(p[0], p[1]));
  });
});
