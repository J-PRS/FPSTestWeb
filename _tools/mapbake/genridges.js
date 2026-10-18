// genridges.js — bake recipe for the ridges field (maps/ridges.bin), the
// ORIGINAL peaks terrain kept as its own map after the 2026-10-18 plateau
// rebake took over peaks.bin.
//
// The committed bin predates recorded bake params, so this is a tuned
// approximation, not the true lineage: low fBm octaves for the big smooth
// masses, a modest ridged blend for the crest texture, elong 1.8 to pull
// the hills into drifting ridges, warp for organic edges. Flat pads under
// each base/spawn cluster keep the flags level (bake coords = game ±85
// diagonal on the default 1500m tile → ∓665 in feature space).
//
//   bun _tools/mapbake/genridges.js [maps/ridges.bin] [--seed=7]
//
// NOTE: the shipped maps/ridges.bin is the byte-exact original
// (extracted via `git show HEAD:maps/peaks.bin`); this script regenerates a
// lookalike, not a bitwise match. Use it when you want to retune the shape.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'maps/ridges.bin';

execFileSync(process.execPath, [
  resolve(here, 'genmap.js'), out,
  '--size=1024',
  '--ridge=0.4',
  '--elong=1.8',
  '--warp=0.6',
  '--flats=665,665,80;-665,-665,80',
  ...args.filter(a => a !== out),
], { stdio: 'inherit' });
