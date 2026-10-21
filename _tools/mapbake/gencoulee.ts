// gencoulee.ts — canyon-plateau field for maps/coulee.bin. Maplab's
// synth pipeline (stream-power valley network into a smoothed massif)
// is the eroded-canyon look: flat green table cut by earthen gullies.
//   bun _tools/mapbake/gencoulee.ts
import { writeFileSync } from 'node:fs';
import { bake, DEFAULTS } from '../../client/src/maplab/gen.ts';

const bytes = bake({
  ...DEFAULTS,
  size: 513, seed: 23,
  detail: 0.55,          // low carpet — the table stays smooth
  warp: 0.45, ridge: 0.1,
  smoothIters: 10,       // flatten the plain between channels
  stream: 1.5, streamIters: 5,  // the canyon network — macro carver
  droplets: 60_000,      // micro-gullies feathering the walls
  glacier: 0.45,         // widen the trunk floors (ski lines)
  talus: 40, talusAngle: 0.02, // repose aprons at the wall toes
  flats: 6, padR: 50,    // base pads on the table
  vscale: 1,
});
writeFileSync('maps/coulee.bin', bytes);
console.log('maps/coulee.bin: canyon-plateau baked');
