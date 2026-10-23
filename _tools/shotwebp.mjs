#!/usr/bin/env node
// _tools/shotwebp.mjs — shrink screenshot PNGs to webp in place.
//
//   node _tools/shotwebp.mjs            # convert eligible PNGs
//   node _tools/shotwebp.mjs --dry-run  # report only
//   node _tools/shotwebp.mjs --days 0   # include files of any age
//
// Skips:
//  - precision captures (name matches diff/alpha/heat/mask/height/normal/
//    baseline/spec) — pixel-exact comparisons need lossless PNG
//  - files younger than --days (default 7) — fresh shots may still be
//    re-captured or diffed by tools
//  - files whose basename appears in any tracked text file (docs, code,
//    baselines) — converting would break the reference
// Originals are deleted only after the webp verifies decodable.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const require = createRequire(join(REPO, 'client/package.json'));
const sharp = require('sharp');

const DRY = process.argv.includes('--dry-run');
const days = Number(process.argv[process.argv.indexOf('--days') + 1] ?? 7);
const DIRS = ['_tools/e2e/shots', '_tools/poseshot/shots', '_tools/tershot/shots',
              'screenshots', 'client/shots', '_tools/screenshots_web'];
const PRECISION = /diff|alpha|heat|mask|height|normal|baseline|spec|depth/i;

// Basenames mentioned anywhere in tracked text → referenced, don't touch.
const referenced = new Set();
for (const f of execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n')) {
  const p = join(REPO, f.trim());
  try {
    if (!f.trim() || statSync(p).size > 1e6) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/[\w.-]+\.png/g)) referenced.add(m[0]);
  } catch { /* binary/gone */ }
}

const walk = (dir) => {
  const out = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.png$/i.test(e.name)) out.push(p);
    }
  } catch { /* missing dir */ }
  return out;
};

let done = 0, before = 0, after = 0;
const skipped = { fresh: 0, precision: 0, referenced: 0, hasWebp: 0 };
const minAge = days * 86400e3;
for (const dir of DIRS) {
  for (const png of walk(join(REPO, dir))) {
    const base = png.split(/[\\/]/).pop();
    const webp = png.replace(/\.png$/i, '.webp');
    if (existsSync(webp)) { skipped.hasWebp++; continue; }
    if (PRECISION.test(base)) { skipped.precision++; continue; }
    if (referenced.has(base)) { skipped.referenced++; continue; }
    if (Date.now() - statSync(png).mtimeMs < minAge) { skipped.fresh++; continue; }
    const size = statSync(png).size;
    if (DRY) { console.log(`[dry] ${png}  ${(size / 1024).toFixed(0)}KB`); before += size; done++; continue; }
    try {
      await sharp(png).webp({ quality: 80 }).toFile(webp);
      await sharp(webp).stats();                    // verify it decodes
      unlinkSync(png);
      before += size; after += statSync(webp).size; done++;
    } catch (e) { console.log(`[fail] ${png}: ${e.message}`); }
  }
}
const mb = (n) => (n / 1e6).toFixed(1);
console.log(`[shotwebp] ${DRY ? 'would convert' : 'converted'} ${done} pngs  ${mb(before)}MB -> ${mb(after)}MB`
  + `  (skipped: ${skipped.fresh} fresh, ${skipped.precision} precision,`
  + ` ${skipped.referenced} referenced, ${skipped.hasWebp} already webp)`);
