// Bundle-size budget audit. Run after `vite build` in client/.
// Node from repo root or client/: node _tools/bundleSize.cjs
// Exit 1 if a hard budget is exceeded; prints the full top-N table either way.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'client', 'dist');
// Budgets vs 2026-10-05 baseline (game.js 2.30MB / 709KB gzip, total 15.24MB).
// Warn band first; hard fail only on large regressions.
const BUDGETS = [
  { name: 'game.js (entry JS)', match: (f) => /^game\.js$/.test(path.basename(f)), warn: 2.6e6, fail: 3.2e6 },
  { name: 'any single asset', match: () => false, warn: 0, fail: 0 }, // placeholder keeps table shape
];

if (!fs.existsSync(dist)) {
  console.error('client/dist missing — run `npm run build` first');
  process.exit(2);
}

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
  );
const files = walk(dist)
  .map((f) => ({ f: path.relative(dist, f), s: fs.statSync(f).size }))
  .sort((a, b) => b.s - a.s);

let total = 0;
for (const { f, s } of files) total += s;
console.log(`TOTAL ${(total / 1024 / 1024).toFixed(2)} MB across ${files.length} files`);
for (const { f, s } of files.slice(0, 15)) {
  console.log(`  ${(s / 1024).toFixed(1).padStart(9)} KB  ${f}`);
}

let fail = false;
for (const b of BUDGETS) {
  if (!b.warn) continue;
  for (const { f, s } of files.filter((x) => b.match(x.f))) {
    const tag = s > b.fail ? 'FAIL' : s > b.warn ? 'WARN' : 'ok';
    if (s > b.fail) fail = true;
    console.log(`${tag.padStart(5)}  ${b.name}: ${(s / 1024).toFixed(1)} KB (warn>${(b.warn / 1e6).toFixed(1)}MB fail>${(b.fail / 1e6).toFixed(1)}MB)`);
  }
}
process.exit(fail ? 1 : 0);
