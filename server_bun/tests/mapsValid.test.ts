import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMapSpec } from '../../shared/mapSpec.ts';

// Shipped-data tripwire: resolveMapSpec coerces malformed fields and
// reports each one in spec.warnings (§5 "coercion reports itself") — a
// map file producing ANY warning carries a field the author meant to
// take and the parser dropped or clamped. This fails on the first
// silently-defaulted edit instead of surfacing it as a weird spawn.
const MAPS = join(import.meta.dir, '..', '..', 'maps');
const files = readdirSync(MAPS).filter(f => f.endsWith('.json'));

describe('maps/*.json — shipped specs resolve clean', () => {
  it('has map files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every spec parses valid JSON', () => {
    for (const f of files) {
      expect(() => JSON.parse(readFileSync(join(MAPS, f), 'utf8')), f).not.toThrow();
    }
  });

  it('every spec resolves with zero coercion warnings', () => {
    const warned: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(JSON.parse(readFileSync(join(MAPS, f), 'utf8')));
      for (const w of spec.warnings ?? []) warned.push(`${f}: ${w}`);
    }
    expect(warned).toEqual([]);
  });

  it('every declared terrain file exists under maps/', () => {
    const missing: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(JSON.parse(readFileSync(join(MAPS, f), 'utf8')));
      if (spec.terrain && !existsSync(join(MAPS, spec.terrain))) {
        missing.push(`${f}: ${spec.terrain}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
