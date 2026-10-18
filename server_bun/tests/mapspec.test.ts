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
    expect(resolveMapSpec({ terrain: `${'a/'.padEnd(140, 'b')  }x.bin` }).terrain).toBeUndefined();
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

  it('terrainPreset accepts the extended palette ids (0..7)', () => {
    for (const p of [1, 2, 3, 4, 5, 6, 7]) {
      expect(resolveMapSpec({ terrainPreset: p }).terrainPreset).toBe(p);
    }
    expect(resolveMapSpec({ terrainPreset: 0 }).terrainPreset).toBeUndefined(); // 0 = default
    expect(resolveMapSpec({ terrainPreset: 9 }).terrainPreset).toBe(7);
  });

  it('weather keeps known kinds, clamps intensity, drops the rest', () => {
    expect(resolveMapSpec({ weather: { snow: 1.5, embers: 2 } }).weather)
      .toEqual({ snow: 1.5, embers: 2 });
    expect(resolveMapSpec({ weather: { dust: 5 } }).weather).toEqual({ dust: 2 });
    expect(resolveMapSpec({ weather: { lava: 1, ash: -1 } }).weather).toEqual({ ash: 0 });
    expect(resolveMapSpec({ weather: 'snow' }).weather).toBeUndefined();
    expect(resolveMapSpec({ weather: {} }).weather).toBeUndefined();
  });

  it('atmosphere clamps multipliers, drops unknown/non-numeric', () => {
    expect(resolveMapSpec({ atmosphere: { rayleigh: 0.8, mie: 3.5, sunIntensity: 0.9 } }).atmosphere)
      .toEqual({ rayleigh: 0.8, mie: 3.5, sunIntensity: 0.9 });
    expect(resolveMapSpec({ atmosphere: { mie: 999 } }).atmosphere).toEqual({ mie: 20 });
    expect(resolveMapSpec({ atmosphere: { starIntensity: -4 } }).atmosphere).toEqual({ starIntensity: 0 });
    expect(resolveMapSpec({ atmosphere: { nope: 1 } }).atmosphere).toBeUndefined();
    expect(resolveMapSpec({ atmosphere: [] }).atmosphere).toBeUndefined();
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

describe('resolveMapSpec — water', () => {
  it('accepts a level with optional tints', () => {
    const s = resolveMapSpec({ water: { level: 12, color: [0.1, 0.34, 0.4], deep: [0.02, 0.1, 0.2] } });
    expect(s.water?.level).toBe(12);
    expect(s.water?.color).toEqual([0.1, 0.34, 0.4]);
    expect(s.water?.deep).toEqual([0.02, 0.1, 0.2]);
  });

  it('drops the block when level is missing or non-finite', () => {
    expect(resolveMapSpec({ water: { color: [0, 0, 0] } }).water).toBeUndefined();
    expect(resolveMapSpec({ water: { level: Number.NaN } }).water).toBeUndefined();
    expect(resolveMapSpec({}).water).toBeUndefined();
  });

  it('clamps tints to 0..1 and level to a sane band', () => {
    const s = resolveMapSpec({ water: { level: 9999, color: [2, -1, 0.5] } });
    expect(s.water?.level).toBe(2000);
    expect(s.water?.color).toEqual([1, 0, 0.5]);
  });
});
