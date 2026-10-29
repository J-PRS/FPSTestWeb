// bake_map — regenerate a shipped map .bin from the gen.ts pipeline.
// bun _tools/bake_map.ts wyrd [--seed 42]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthField, smoothPass, streamPower, glacierPass, erode, talusPass, playaPass, lakePass, cliffPass, foldPass, breachPass, stretchPass, flatsPass, floodPass, DEFAULTS, type GenParams } from '../client/src/maplab/gen.ts';
const MAPS = join(import.meta.dir, '..', 'maps');
const name = process.argv[2] ?? 'wyrd';
const seed = Number(process.argv[process.argv.indexOf('--seed') + 1] ?? 42);
const spec = JSON.parse(readFileSync(join(MAPS, `${name}.json`), 'utf8'));
const N = 513;

const recipes: Record<string, (h: Float32Array) => void> = {
  // wyrd: coherent valley network + glowing flat floors + jagged spines.
  // Target: flat%>=20, steep%<=40, connected routes.
  wyrd: (h) => {
    smoothPass(h, N, 14);                                   // broad valleys first
    streamPower(h, N, { ...DEFAULTS, stream: 1.2, streamIters: 4 });
    glacierPass(h, N, { ...DEFAULTS, glacier: 0.5 });
    playaPass(h, N, 0.06, 18);                            // wide flat floors
    playaPass(h, N, 0.04, 12);                            // second, smaller basins
    lakePass(h, N);                                       // real lake pools
    floodPass(h, N, 0.30);                                // lowland floor = flat
    breachPass(h, N);                                     // channels cross the flats
    talusPass(h, N, { ...DEFAULTS, talus: 10, talusAngle: 0.02 });
    stretchPass(h, N);
  },
};

const p: GenParams = { ...DEFAULTS,
  size: N, seed, freq: 0.8, detail: 0.5, warp: 0.5, curl: 0.4,
  ridge: 0.35, elong: 1.2, noiseType: 2, flats: 4, padR: 60,
};
const h = synthField(p);
flatsPass(h, N, p);
recipes[name]?.(h);

// stats
const hs = [...h].sort((a, b) => a - b);
const cell = 1500 / N;
let slopeSum = 0, steep = 0, flat = 0;
for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
  const i = z * N + x;
  const sl = Math.max(Math.abs(h[i] - h[i - 1]!), Math.abs(h[i] - h[i - N]!)) / cell;
  slopeSum += sl; const deg = Math.atan(sl * 125 * (spec.heightScale ?? 1)) * 180 / Math.PI;
  if (deg > 32) steep++; if (deg < 8) flat++;
}
const n = (N - 2) * (N - 2);
console.log(`${name} seed=${seed} rel=${((hs[N * N - 1] - hs[0]) * 125 * (spec.heightScale ?? 1)).toFixed(0)}m slope=${(Math.atan(slopeSum / n * 125 * (spec.heightScale ?? 1)) * 180 / Math.PI).toFixed(1)}° flat%=${(100 * flat / n).toFixed(0)} steep%=${(100 * steep / n).toFixed(0)}`);

const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i++) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i])) * 255); }
new DataView(bytes.buffer).setUint32(0, N, true); new DataView(bytes.buffer).setUint32(4, N, true);
writeFileSync(join(MAPS, `${name}.bin`), bytes);
console.log(`wrote maps/${name}.bin`);
