// Terrain shape census — per-map relief/slope/flat metrics.
// bun _tools/terrstats.ts [name...]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hmParseBin, HM_HEIGHT_SCALE, HM_DIVISOR, HM_WORLD_SCALE } from '../shared/heightfield.ts';
const MAPS = join(import.meta.dir, '..', 'maps');
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(MAPS).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
for (const name of names) {
  try {
    const spec = JSON.parse(readFileSync(join(MAPS, `${name}.json`), 'utf8'));
    const bin = spec.terrain ?? `${name}.bin`;
    if (!existsSync(join(MAPS, bin))) { console.log(`${name.padEnd(22)} no bin`); continue; }
    const f = hmParseBin(new Uint8Array(readFileSync(join(MAPS, bin))), spec.heightScale ?? 1, spec.tileSize);
    const N = f.size, cell = (f.worldScale ?? HM_WORLD_SCALE) / N;
    const gain = HM_HEIGHT_SCALE * (f.heightScale ?? 1) / HM_DIVISOR;
    let mn = Infinity, mx = -Infinity, slopeSum = 0, steep = 0, flat = 0;
    const hs: number[] = [];
    for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
      const i = z * N + x, h = f.data[i]! * gain;
      hs.push(h); if (h < mn) mn = h; if (h > mx) mx = h;
      const sl = Math.max(Math.abs(f.data[i]! - f.data[i - 1]!), Math.abs(f.data[i]! - f.data[i - N]!)) * gain / cell;
      slopeSum += sl;
      const deg = Math.atan(sl) * 180 / Math.PI;
      if (deg > 32) steep++;
      if (deg < 8) flat++;
    }
    hs.sort((a, b) => a - b);
    const n = hs.length;
    console.log(`${name.padEnd(22)} ${f.worldScale ?? HM_WORLD_SCALE}m N${N} rel=${(mx - mn).toFixed(0).padStart(4)}m  slope=${(Math.atan(slopeSum / n) * 180 / Math.PI).toFixed(1)}°  flat%=${(100 * flat / n).toFixed(0).padStart(2)}  steep%=${(100 * steep / n).toFixed(0).padStart(2)}  p10-90=${(hs[Math.floor(n * 0.9)]! - hs[Math.floor(n * 0.1)]!).toFixed(0).padStart(3)}m  hs=${spec.heightScale ?? 1}`);
  } catch (e) { console.log(`${name.padEnd(22)} ERR ${(e as Error).message.slice(0, 70)}`); }
}
