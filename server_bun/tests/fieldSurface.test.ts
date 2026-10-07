import { describe, it, expect } from 'bun:test';
import { FieldSurface } from '../../shared/fieldSurface.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { MoveState } from '../../shared/movement.ts';
import { TREE, type VgsNode } from '../../shared/vgsTree.ts';

// FieldSurface fuses the heightfield with map-structure solids into ONE
// move surface — the server shadow, client predictor, and netbot harness
// each build the same object, so a box only one side saw is a guaranteed
// divergence. Pin the fusion rules and the VGS chord-tree data.

const FLAT: Heightfield = { size: 64, data: new Uint8Array(64 * 64), stride: 1 };
// A slab: center (10,3,20), half-extents (2,3,4) → top face at y=6.
const slab = () => SolidWorld.fromSpecs([{ kind: 'box', pos: { x: 10, y: 0, z: 20 }, size: { x: 4, y: 6, z: 8 } }]);

describe('fieldSurface', () => {
  it('a structure top face wins over terrain as floor', () => {
    const fs = FieldSurface.fromField(FLAT);
    fs.solid = slab();
    expect(fs.getHeight(10, 20)).toBeCloseTo(6, 10);
    expect(fs.getHeight(0, 0)).toBe(0); // off the footprint: terrain
  });

  it('maxTop bounds which tops count — a deck overhead is not a floor', () => {
    const fs = FieldSurface.fromField(FLAT);
    fs.solid = slab();
    // Feet can only claim tops within reach; capping below the slab's
    // 6m top leaves the terrain height standing.
    expect(fs.getHeight(10, 20, 1)).toBe(0);
    expect(fs.getHeight(10, 20, 10)).toBeCloseTo(6, 10);
  });

  it('normal over a structure is flat-up — a walker stands level on the slab', () => {
    const fs = FieldSurface.fromField(FLAT);
    fs.solid = slab();
    const out = { x: 9, y: 9, z: 9 };
    fs.getNormal(10, 20, out);
    expect(out).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('no solid means pure terrain — getHeight/getNormal pass through', () => {
    const fs = FieldSurface.fromField(FLAT);
    expect(fs.getHeight(10, 20)).toBe(0);
    const out = { x: 0, y: 0, z: 0 };
    expect(fs.getNormal(10, 20, out)).toBe(out);
    expect(out.y).toBe(1);
  });

  it('resolveBody pushes a capsule out of a wall face horizontally', () => {
    const fs = FieldSurface.fromField(FLAT);
    fs.solid = slab();
    // Eye at y=3 with height 1.8 → feet 1.2, inside the slab's 0..6 span,
    // 0.5m past its x edge → the push-out lands it clear of the face.
    const s: MoveState = { pos: { x: 12.5, y: 3, z: 20 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: false };
    fs.resolveBody(s, 1.8);
    expect(s.pos.x).toBeGreaterThan(12.4); // shoved out along +x
  });
});

describe('vgsTree', () => {
  const leaves = (node: VgsNode, path: string, out: { path: string; node: VgsNode }[]) => {
    if ('line' in node) { out.push({ path, node }); return; }
    for (const [k, c] of Object.entries(node.children)) leaves(c, path + k, out);
  };
  const all: { path: string; node: VgsNode }[] = [];
  for (const [k, c] of Object.entries(TREE)) leaves(c, k, all);

  it('every chord resolves to a labelled leaf with a non-empty line', () => {
    expect(all.length).toBeGreaterThan(80); // canon tree is broad
    for (const { path, node } of all) {
      expect(node.label.length, path).toBeGreaterThan(0);
      expect((node as { line: string }).line.length, path).toBeGreaterThan(0);
    }
  });

  it('VG* lines are all-chat (team:false); everything else is team-scoped', () => {
    for (const { path, node } of all) {
      const team = (node as { team?: boolean }).team;
      if (path.startsWith('G')) expect(team, path).toBe(false);
      else expect(team, path).toBe(true);
    }
  });

  it('category nodes carry only children — no line-shaped cat', () => {
    const cats = (node: VgsNode, path: string) => {
      if ('line' in node) return;
      expect(node.children && Object.keys(node.children).length, path).toBeGreaterThan(0);
      for (const [k, c] of Object.entries(node.children)) cats(c, path + k);
    };
    for (const [k, c] of Object.entries(TREE)) cats(c, k);
  });
});
