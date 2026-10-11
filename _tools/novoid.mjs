import fs from 'fs';
// node novoid.mjs <warn-file> [--apply] — remove `void ` operator on flagged lines;
// `void 0`/`void(0)` -> `undefined` first.
const apply = process.argv[3] === '--apply';
const byFile = new Map();
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (!m) continue;
  const f = m[1];
  (byFile.get(f) ?? byFile.set(f, []).get(f)).push(+m[2]);
}
let n = 0;
for (const [f, lines] of byFile) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  for (const ln of lines) {
    let s = src[ln - 1];
    const before = s;
    s = s.replace(/\bvoid\s*\(\s*0\s*\)/g, 'undefined')
         .replace(/\bvoid\s+0\b/g, 'undefined')
         .replace(/\bvoid\s+/g, '');
    if (s !== before) { src[ln - 1] = s; n++; }
  }
  if (apply) fs.writeFileSync(f, src.join('\n'));
}
console.log(n, 'lines edited', apply ? '(applied)' : '(dry)');
