import { describe, expect, test } from 'vitest';
import { KIT_BUILDERS } from '../world/mapStructures.ts';
import { KIT_HULLS, KIT_PIECES } from '../../../shared/structKits.ts';
import type { HullBox } from '../structures/structKit.ts';

// The drift pin shared/structKits.ts asks for: the server collides kit
// pieces as KIT_HULLS while the client builds the real mesh — the two
// must never disagree or a shot/player behaves differently per side.
// Builders emit their own userData.hulls sidecar (authored next to the
// geometry), so the check is builder-hull vs table-hull, not a guess.
describe('kit hull parity', () => {
  test('every KIT_HULLS piece has a builder and vice versa', () => {
    for (const piece of KIT_PIECES) expect(KIT_BUILDERS[piece], `no builder for '${piece}'`).toBeTruthy();
    for (const key of Object.keys(KIT_BUILDERS)) expect(KIT_HULLS[key], `no hulls for builder '${key}'`).toBeTruthy();
  });

  test('builder sidecar hulls match the server table', () => {
    for (const [piece, build] of Object.entries(KIT_BUILDERS)) {
      const hulls = (build(0).userData.hulls as HullBox[] | undefined) ?? [];
      const table = KIT_HULLS[piece] ?? [];
      expect(hulls.length, `${piece}: hull count`).toBe(table.length);
      hulls.forEach((h, i) => {
        const t = table[i]!;
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(h.pos[axis], `${piece}[${i}].pos.${axis}`).toBeCloseTo(t.pos[axis], 5);
          expect(h.size[axis], `${piece}[${i}].size.${axis}`).toBeCloseTo(t.size[axis], 5);
        }
        expect(h.rotY ?? 0, `${piece}[${i}].rotY`).toBeCloseTo(t.rotY ?? 0, 5);
      });
    }
  });
});
