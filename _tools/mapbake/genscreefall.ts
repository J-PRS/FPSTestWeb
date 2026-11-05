// genscreefall.ts - bake maps/screefall.bin from the maplab copy-params
// recipe (seed 9541, jordan ridged field, terrace + 5x scree verbs).
// Replicates maplab.ts refresh(): bake chain first, verbs replayed on
// top in log order, the same order the lab rendered it.
//   bun _tools/mapbake/genscreefall.ts
import { writeFileSync } from 'node:fs';
import {
  synthField, faultPass, smoothPass, streamPower, erode, glacierPass,
  talusPass, flatsPass, terracePass, DEFAULTS, type GenParams,
} from '../../client/src/maplab/gen.ts';

const p: GenParams = {
  ...DEFAULTS,
  size: 449,
  seed: 9541,
  freq: 1.05,
  detail: 1.5,
  noiseType: 3,
  warp: 0.45,
  curl: 0.65,
  ridge: 0.8500000000000001,
  elong: 1.25,
  tilt: 0,
  tiltAxis: 'x',
  fault: 0,
  faultAngle: 90,
  glacier: 0.6000000000000001,
  smoothIters: 30,
  flats: 2,
  padR: 25,
  bowlR: 110,
  bowlDepth: 0.7000000000000001,
  plateauR: 140,
  plateauLift: 0.9500000000000001,
  seaR: 240,
  seaDepth: 0.55,
  vscale: 0.9000000000000001,
  droplets: 30,
  inertia: 0.55,
  erodeRate: 0.35000000000000003,
  depositRate: 0.2,
  evap: 0.055,
  capacity: 0.25,
  stream: 0.2,
  streamIters: 2,
  talus: 16,
  talusAngle: 0.005,
};

// maplab verb table, only the ops this recipe's log uses.
const VERBS: Record<string, (h: Float32Array, N: number) => void> = {
  terrace: (h, N) => terracePass(h, N),
  scree:   (h, N) => talusPass(h, N, { ...p, talus: 6, talusAngle: 0.008 }),
};
const verbs = ['terrace', 'scree', 'scree', 'scree', 'scree', 'scree'];

const N = p.size;
const h = synthField(p);
faultPass(h, N, p);
if (p.smoothIters > 0) { smoothPass(h, N, p.smoothIters); }
streamPower(h, N, p);
if (p.droplets > 0) { erode(h, N, p); }
glacierPass(h, N, p);
if (p.talus > 0) { talusPass(h, N, p); }
flatsPass(h, N, p);
for (const v of verbs) { VERBS[v]?.(h, N); }

const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i]! * p.vscale)) * 255); }
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync('maps/screefall.bin', bytes);
console.log(`maps/screefall.bin: ${N}x${N} baked (${verbs.join(' -> ')})`);
