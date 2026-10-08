import { describe, it, expect } from 'bun:test';
import { MapCatalog } from '../src/mapCatalog.ts';

// The room mint resolves a room name + client-supplied mode/map claims
// through one fallback chain — a drift there means named rooms silently
// play different rules than their map file, or a bogus mode sprouts
// flags on a dm arena. specModes is pinned in mapspec.test.ts; this pins
// the resolution order and the legality gate around it.
const cat = new MapCatalog();

describe('MapCatalog.specFor', () => {
  it('the room name resolves its own spec first', () => {
    // Modes are map-agnostic — a legal mode claim still swaps in over
    // the resolved spec's default.
    const { spec, src } = cat.specFor('ctf', 'dm', '');
    expect(spec?.mode).toBe('dm');
    expect(src).toBe('ctf');
  });

  it('a numbered room inherits its base spec — ctf-2 plays ctf rules', () => {
    const { spec, src } = cat.specFor('ctf-2', 'ctf', '');
    expect(spec?.mode).toBe('ctf');
    expect(src).toBe('ctf');
  });

  it('the map arg resolves when the room name has no spec', () => {
    const { spec, src } = cat.specFor('arena-x', '', 'quicksand');
    expect(spec?.mode).toBe('tdm');
    expect(src).toBe('quicksand');
  });

  it('a legal mode swaps in over the spec default', () => {
    // deathball hosts ['dm','tdm','duel','nuggets','rabbit'] — duel is legal.
    const { spec } = cat.specFor('x', 'duel', 'deathball');
    expect(spec?.mode).toBe('duel');
  });

  it('an unrecognized mode leaves the spec default', () => {
    // Modes are map-agnostic — every real ruleset is legal everywhere,
    // so only a bogus mode name falls through to the spec default.
    const { spec } = cat.specFor('x', 'zzz', 'ctf');
    expect(spec?.mode).toBe('ctf');
    expect(spec?.bases).toBeDefined();
  });

  it('a bots claim overrides spec bot counts at creation', () => {
    const { spec } = cat.specFor('x', '', 'ctf', 7);
    expect(spec?.bots).toBe(7);
    expect(spec?.botFill).toBe(7);
  });

  it('no spec anywhere resolves to defaults, not a crash', () => {
    const { spec, src } = cat.specFor('zzz-nothing', 'zzz', 'zzz');
    expect(spec).toBeUndefined();
    expect(src).toBe('');
  });
});
