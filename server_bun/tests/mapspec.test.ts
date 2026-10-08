import { describe, expect, it } from 'bun:test';

import { resolveMapSpec, specModes, DEFAULT_MAP_SPEC } from '../../shared/mapSpec.ts';

describe('resolveMapSpec — path-traversal boundary', () => {
  it('rejects directory traversal in path fields', () => {
    for (const evil of ['../secret.bin', 'a/../../x.bin', '/abs/path.bin',
      'dir/../../etc/passwd', 'a.b/c.bin', '..', 'a/b/c/d/x.bin']) {
      const s = resolveMapSpec({ terrain: evil });
      expect(s.terrain).toBeUndefined();
    }
  });

  it('accepts legit two-deep map-relative paths', () => {
    expect(resolveMapSpec({ terrain: 't2/danger_crossing/terrain.bin' }).terrain)
      .toBe('t2/danger_crossing/terrain.bin');
    expect(resolveMapSpec({ terrainTex: 't2/dx/ground.png' }).terrainTex)
      .toBe('t2/dx/ground.png');
    expect(resolveMapSpec({ sky: 'clear-day' }).sky).toBe('clear-day');
  });

  it('drops paths with wrong extensions or oversize input', () => {
    expect(resolveMapSpec({ terrain: 'a/x.png' }).terrain).toBeUndefined(); // needs .bin
    expect(resolveMapSpec({ terrainTex: 'a/x.bin' }).terrainTex).toBeUndefined(); // needs image
    expect(resolveMapSpec({ terrain: 'a/'.padEnd(140, 'b') + 'x.bin' }).terrain).toBeUndefined();
  });
});

describe('resolveMapSpec — clamps and defaults', () => {
  it('empty input yields the default spec', () => {
    const s = resolveMapSpec(undefined);
    expect(s.balls).toEqual(DEFAULT_MAP_SPEC.balls);
    expect(s.mode).toBeUndefined();
  });

  it('ball counts clamp and max never drops below base', () => {
    const s = resolveMapSpec({ balls: { base: 50, max: 10 } });
    expect(s.balls.max).toBe(50);
    expect(resolveMapSpec({ balls: { base: 9999 } }).balls.base).toBe(200);
    expect(resolveMapSpec({ balls: { base: -5 } }).balls.base).toBe(0);
  });

  it('mode strings are word-char only, modes array caps at 8', () => {
    expect(resolveMapSpec({ mode: 'ctf' }).mode).toBe('ctf');
    expect(resolveMapSpec({ mode: 'ct f;drop' }).mode).toBeUndefined();
    expect(resolveMapSpec({ modes: Array(20).fill('dm') }).modes).toHaveLength(8);
    expect(resolveMapSpec({ modes: ['ctf', 42, 'dm'] }).modes).toEqual(['ctf', 'dm']);
  });
});

describe('specModes', () => {
  it('declared modes win; bare mode degrades to itself; nothing = any', () => {
    expect(specModes(resolveMapSpec({ modes: ['ctf', 'nuggets'] }))).toEqual(['ctf', 'nuggets']);
    // Modes are map-agnostic — a bare dm arena can host every ruleset,
    // ctf included (stands auto-place on geometry without authored bases).
    expect(specModes(resolveMapSpec({ mode: 'dm' }))).toEqual(
      expect.arrayContaining(['dm', 'ctf', 'tdm', 'nuggets', 'rabbit', 'duel']));
    expect(specModes(resolveMapSpec({}))).toEqual([]);
    expect(specModes(undefined)).toEqual([]);
  });
});
