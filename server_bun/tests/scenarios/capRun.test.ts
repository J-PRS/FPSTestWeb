import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { measureCap } from './capMeasure.ts';

// Cap-run telemetry: a real-terrain CTF match where the capper's speed
// IS the scoreboard — grab time, transit speed, cap time. The measure
// lives in capMeasure.ts so _tools/sweeps scores genomes on the same loop.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/peaks.bin`)));
const katabatic = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/katabatic.bin`)));

/** Two stands ~300m apart on real ground — the flag pos rides the
 *  terrain height at its xz, so bases sit wherever the field says. */
const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const katAt = (x: number, z: number) => ({ x, y: hmHeight(katabatic, x, z), z });
const BASES = { alpha: baseAt(-150, 0), bravo: baseAt(150, 0) };
// Real T2 Katabatic stand positions (maps/katabatic.json `bases`) —
// ~775m stand-to-stand, the actual map's flag line.
const KAT_BASES = { alpha: katAt(236.85, -127.11), bravo: katAt(-423.57, 281.67) };

// Programmatic flag stands: probe the field for two flat-ish, well-
// separated cells instead of trusting authored bases. Flatness = max
// |Δheight| across a 6m cross; "flat" means a runner doesn't face a
// wall or a pit at the stand. Deterministic scan order — no RNG.
function pickStands(
  fld: ReturnType<typeof hmParseBin>,
  worldScale: number,
  minSep: number,
): { alpha: { x: number; y: number; z: number }; bravo: { x: number; y: number; z: number } } {
  const flat = (x: number, z: number): number => {
    const c = hmHeight(fld, x, z);
    return Math.max(
      Math.abs(hmHeight(fld, x + 6, z) - c), Math.abs(hmHeight(fld, x - 6, z) - c),
      Math.abs(hmHeight(fld, x, z + 6) - c), Math.abs(hmHeight(fld, x, z - 6) - c));
  };
  // Coarse raster over the middle 80% of the tile; keep cells under 2m
  // local relief, greedy-pick a pair at least minSep apart.
  const candidates: { x: number; y: number; z: number }[] = [];
  const lo = worldScale * 0.1, hi = worldScale * 0.9;
  for (let z = lo; z < hi; z += 40) {
    for (let x = lo; x < hi; x += 40) {
      if (flat(x, z) < 2) { candidates.push({ x, y: hmHeight(fld, x, z), z }); }
    }
  }
  const a = candidates[0];
  const b = candidates.find(c => Math.hypot(c.x - a!.x, c.z - a!.z) >= minSep)
    ?? candidates[candidates.length - 1];
  if (!a || !b) { throw new Error('no flat stand pair found on field'); }
  return { alpha: a, bravo: b };
}

describe('scenario: capper run on real terrain', () => {
  it('300m stands on peaks.bin — grab and carry timed', () => {
    const stat = measureCap(field, BASES, { verbose: true, tag: 'peaks' });
    expect(stat.caps).toBeGreaterThan(0);
    // A stand-to-stand transit that walks most of the 300m on foot
    // (~15m/s ski pace is the floor; a real cap route beats it).
    expect(stat.avgSpeed).toBeGreaterThan(10);
  }, 120000);

  it('dunes — programmatic stands on the dunes map terrain', () => {
    // maps/dunes.json rides slagheap.bin at heightScale 1.5 on the
    // default 1500m wrap — rolling sand relief, stands chosen by the
    // field scan rather than the spec's authored bases.
    const dunes = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/slagheap.bin`)), 1.5, 1500);
    const stands = pickStands(dunes, 1500, 500);
    const sep = Math.hypot(stands.alpha.x - stands.bravo.x, stands.alpha.z - stands.bravo.z);
    console.log(`  dunes stands: (${stands.alpha.x.toFixed(0)},${stands.alpha.z.toFixed(0)}) ↔ (${stands.bravo.x.toFixed(0)},${stands.bravo.z.toFixed(0)}) sep=${sep.toFixed(0)}m`);
    const stat = measureCap(dunes, stands, { verbose: true, tag: 'dunes', simBudgetS: 480 });
    expect(stat.caps).toBeGreaterThan(0);
    expect(stat.avgSpeed).toBeGreaterThan(10);
  }, 120000);

  it('real T2 Katabatic stands (~775m, no static meshes)', () => {
    // 775m stand-to-stand at honest cap pace runs ~300-350s door to
    // door. The orbit detector needs no tight window: a true orbit
    // never caps at ANY budget (0 caps, always). 480 only asks that
    // the cap completes at all on this map's real distance.
    const stat = measureCap(katabatic, KAT_BASES, { verbose: true, tag: 'katabatic', simBudgetS: 480 });
    expect(stat.caps).toBeGreaterThan(0);
    // The long route still has to beat a walk — no stand-distance
    // excuse for llama pace.
    expect(stat.avgSpeed).toBeGreaterThan(10);
  }, 120000);
});
