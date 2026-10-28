// Build-output guard: records every file under client/dist (path + bytes) and
// compares it with client/dist-manifest.json. Any added, removed, or resized
// file fails the run until the baseline is regenerated on purpose:
//   node _tools/dist-manifest.mjs            compare (CI)
//   node _tools/dist-manifest.mjs --update   accept the current build
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
const dist = join(root, 'dist');
const baselinePath = join(root, 'dist-manifest.json');

if (!existsSync(dist)) {
  console.error('dist-manifest: client/dist missing — run the client build first');
  process.exit(2);
}

const files = {};
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {walk(p);}
    else {files[relative(dist, p).split('\\').join('/')] = statSync(p).size;}
  }
};
walk(dist);
const current = { count: Object.keys(files).length, bytes: Object.values(files).reduce((a, b) => a + b, 0), files };

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`dist-manifest: baseline written — ${current.count} files, ${current.bytes} bytes`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('dist-manifest: no client/dist-manifest.json — run with --update and commit it');
  process.exit(2);
}
const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
// Content-hashed vite names (foo-BaGOKOLn.js) churn on every code edit —
// compare adds/removes on the un-hashed stem so a rebuild counts as a
// resize, not a phantom add+remove.
const stem = (f) => f.replace(/-[A-Za-z0-9_-]{7,}(?=\.)/, '');
const curStems = Object.keys(files).map(stem);
const baseStems = Object.keys(base.files).map(stem);
const added = Object.keys(files).filter((f, i) => !baseStems.includes(curStems[i]));
const removed = Object.keys(base.files).filter((f, i) => !curStems.includes(baseStems[i]));
const resized = Object.keys(files).filter((f, i) => !added.includes(f) && baseStems.includes(curStems[i]) && files[f] !== base.files[f]);
if (added.length + removed.length + resized.length === 0) {
  console.log(`dist-manifest: unchanged — ${current.count} files, ${current.bytes} bytes`);
  process.exit(0);
}
// Size noise below SIZE_TOLERANCE of the bundle total is hashed-code churn
// (every source edit re-bundles game.js a few hundred bytes either way) —
// file adds/removes always trip the guard, size only trips it in bulk.
const SIZE_TOLERANCE = 0.02;
const delta = current.bytes - base.bytes;
const resizedWithinTolerance = Math.abs(delta) <= Math.ceil(base.bytes * SIZE_TOLERANCE);
if (added.length + removed.length > 0 || !resizedWithinTolerance) {
  console.error(`dist-manifest: build output changed vs client/dist-manifest.json`);
  console.error(`  files: ${base.count} -> ${current.count}, bytes: ${base.bytes} -> ${current.bytes} (${delta >= 0 ? '+' : ''}${delta}, ${(delta / base.bytes * 100).toFixed(2)}%)`);
  for (const f of added) {console.error(`  + ${f} (${files[f]} bytes)`);}
  for (const f of removed) {console.error(`  - ${f} (${base.files[f]} bytes)`);}
  for (const f of resized) {console.error(`  ~ ${f} (${base.files[f]} -> ${files[f]} bytes)`);}
  console.error('If this is intended, run: node _tools/dist-manifest.mjs --update and commit client/dist-manifest.json');
  process.exit(1);
}
console.log(`dist-manifest: size drift within ${SIZE_TOLERANCE * 100}% tolerance — ${delta >= 0 ? '+' : ''}${delta} bytes across ${resized.length} file(s)`);
