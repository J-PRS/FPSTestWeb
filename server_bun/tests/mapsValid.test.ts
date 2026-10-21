import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { resolveMapSpec, parseMapSpecJson } from '../../shared/mapSpec.ts';
import { findStructureOverlaps } from '../../shared/ballCollide.ts';
import { KIT_HULLS, seatKits } from '../../shared/structKits.ts';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';

// Shipped-data tripwire: resolveMapSpec coerces malformed fields and
// reports each one in spec.warnings (§5 "coercion reports itself") — a
// map file producing ANY warning carries a field the author meant to
// take and the parser dropped or clamped. This fails on the first
// silently-defaulted edit instead of surfacing it as a weird spawn.
const MAPS = join(import.meta.dir, '..', '..', 'maps');
const files = readdirSync(MAPS).filter(f => f.endsWith('.json') || f.endsWith('.toml'));

/** maps/<name>.json|toml → the parsed spec blob resolveMapSpec eats. */
function readSpecFile(f: string): unknown {
  const text = readFileSync(join(MAPS, f), 'utf8');
  return f.endsWith('.toml')
    ? JSON.parse(JSON.stringify(parseToml(text)))
    : parseMapSpecJson(text);
}

describe('maps/*.{json,toml} — shipped specs resolve clean', () => {
  it('has map files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every spec parses', () => {
    for (const f of files) {
      expect(() => readSpecFile(f), f).not.toThrow();
    }
  });

  it('every spec resolves with zero coercion warnings', () => {
    const warned: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(readSpecFile(f));
      for (const w of spec.warnings ?? []) {warned.push(`${f}: ${w}`);}
    }
    expect(warned).toEqual([]);
  });

  it('every declared terrain file exists under maps/', () => {
    const missing: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(readSpecFile(f));
      if (spec.terrain && !existsSync(join(MAPS, spec.terrain))) {
        missing.push(`${f}: ${spec.terrain}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Building-swallowing-building is the bug class: kit×kit containment
  // means a dome eats a bunker, doubled colliders, z-fighting mesh.
  // Scatter embedding (pillar through a wall joint, ported hull packs)
  // is normal authored practice — only kit pairs gate.
  it('no map has kit pieces interpenetrating', () => {
    const bad: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(readSpecFile(f));
      for (const o of findStructureOverlaps(spec.structures)) {
        const a = spec.structures![o.a]!, b = spec.structures![o.b]!;
        if (a.kind !== 'kit' || b.kind !== 'kit') {continue;}
        // Deck panels and piers are the arena's floor/support grid — a
        // building on the deck and a column under a stand legitimately
        // share volume with them.
        if (a.piece === 'arenapanel' || b.piece === 'arenapanel' ||
            a.piece === 'arenapier' || b.piece === 'arenapier') {continue;}
        bad.push(`${f}: ${a.piece}@(${a.pos.x.toFixed(0)},${a.pos.z.toFixed(0)}) × ${b.piece}@(${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}) ${o.x.toFixed(1)}x${o.y.toFixed(1)}x${o.z.toFixed(1)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // The screenshot bug class: a kit seated on the footprint MAX (genhouse
  // keeps its deck above dirt) hangs its downhill wall in the air when
  // the site slopes. Hulls whose bottom sits at the base plane are the
  // ground contacts — measure air under each; >3m reads as floating.
  it('no kit piece floats above terrain', () => {
    const bad: string[] = [];
    for (const f of files) {
      const spec = resolveMapSpec(readSpecFile(f));
      if (!spec.terrain || !spec.structures) {continue;}
      const field = hmParseBin(new Uint8Array(readFileSync(join(MAPS, spec.terrain))), spec.heightScale ?? 1, spec.tileSize);
      const structs = spec.structures.map(s => ({ ...s, pos: { ...s.pos } }));
      seatKits(structs, (x, z) => hmHeight(field, x, z));
      for (const s of structs) {
        if (s.kind !== 'kit') {continue;}
        const hulls = KIT_HULLS[s.piece ?? ''];
        if (!hulls) {continue;}
        const k = s.scale ?? 1;
        const cos = Math.cos(s.rotY ?? 0), sin = Math.sin(s.rotY ?? 0);
        let worst = 0, wx = 0, wz = 0;
        for (const h of hulls) {
          const bottomLocal = h.pos.y - h.size.y / 2;
          if (bottomLocal > 0.6) {continue;} // roofs/decks are elevated by design
          const lx = h.pos.x * k, lz = h.pos.z * k;
          const hx = s.pos.x + lx * cos + lz * sin;
          const hz = s.pos.z - lx * sin + lz * cos;
          const gap = s.pos.y + bottomLocal * k - hmHeight(field, hx, hz);
          if (gap > worst) { worst = gap; wx = hx; wz = hz; }
        }
        if (worst > 3) {bad.push(`${f}: ${s.piece}@(${s.pos.x.toFixed(0)},${s.pos.z.toFixed(0)}) floats ${worst.toFixed(1)}m at (${wx.toFixed(0)},${wz.toFixed(0)})`);}
      }
    }
    expect(bad).toEqual([]);
  });
});
