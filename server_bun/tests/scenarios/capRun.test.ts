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

describe('scenario: capper run on real terrain', () => {
  it('300m stands on peaks.bin — grab and carry timed', () => {
    const stat = measureCap(field, BASES, { verbose: true, tag: 'peaks' });
    expect(stat.caps).toBeGreaterThan(0);
    // A stand-to-stand transit that walks most of the 300m on foot
    // (~15m/s ski pace is the floor; a real cap route beats it).
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
