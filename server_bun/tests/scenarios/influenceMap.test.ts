import { describe, it, expect } from 'bun:test';
import { InfluenceMap, IMAP_CELL } from '../../src/influenceMap.ts';

// The influence map is the room's spatial memory: events splat scent,
// scent decays on the sim clock, and bots query hotspots/quiet lanes.
// These guarantees are what hunt/flee consumers rely on — a broken
// splat ring or a missing decay silently lobotomizes both.

const WORLD = 1500;
const C = { x: 0, y: 0, z: 0 }; // grid-center position

describe('scenario: influence map', () => {
  it('splat deposits strongest at center, half-strength at the ring', () => {
    const im = new InfluenceMap(WORLD);
    im.splat(C, 'dangerA', 2);
    expect(im.value(C, 'dangerA')).toBeCloseTo(2);
    // One cell away reads half — the spread gives bots "where the
    // fighting was", not just the exact tile.
    expect(im.value({ x: IMAP_CELL, y: 0, z: 0 }, 'dangerA')).toBeCloseTo(1);
    // Other layers untouched — a death writes danger, not opportunity.
    expect(im.value(C, 'opportunity')).toBe(0);
  });

  it('decay halves scent on the sim clock — old fights fade', () => {
    const im = new InfluenceMap(WORLD);
    im.splat(C, 'traffic', 1);
    const v0 = im.value(C, 'traffic');
    for (let i = 0; i < 300; i++) im.tick(0.1); // ~30s sim → ~half-life
    const v1 = im.value(C, 'traffic');
    expect(v1).toBeGreaterThan(v0 * 0.3);
    expect(v1).toBeLessThan(v0 * 0.7);
  });

  it('hottestNear returns the scented cell and null on a cold map', () => {
    const im = new InfluenceMap(WORLD);
    expect(im.hottestNear(C, 'opportunity')).toBeNull();
    im.splat({ x: 64, y: 0, z: 0 }, 'opportunity', 1);
    const hot = im.hottestNear(C, 'opportunity', 6);
    expect(hot).not.toBeNull();
    expect(hot!.v).toBeGreaterThan(0);
  });

  it('quietestDir points away from the hot side of the ring', () => {
    const im = new InfluenceMap(WORLD);
    // Hot underfoot, cold on the far edge — the escape read picks the
    // first unscented cell it scans, which sits on the west/north edge.
    im.splat(C, 'dangerA', 4);
    const d = im.quietestDir(C, 'dangerA', 5);
    expect(d.x).toBeLessThan(0);
  });

  it('resize to a wider field rebuilds clean layers', () => {
    const im = new InfluenceMap(WORLD);
    im.splat(C, 'dangerB', 3);
    im.resize(2048);
    expect(im.value(C, 'dangerB')).toBe(0);
    expect(im.value(C, 'dangerB')).not.toBeNaN();
  });
});
