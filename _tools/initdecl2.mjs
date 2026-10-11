import fs from 'fs';
// node initdecl2.mjs <warn-file> [--apply]
// leftover `let x: T;` -> `let x = undefined as unknown as T;` (runtime-identical:
// uninitialized lets read undefined; removes "used before assigned" CFA guard).
const apply = process.argv[3] === '--apply';
const byFile = new Map();
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (!m) continue;
  (byFile.get(m[1]) ?? byFile.set(m[1], []).get(m[1])).push(+m[2]);
}
let n = 0, skip = 0;
for (const [f, lines] of byFile) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  for (const ln of lines) {
    const s = src[ln - 1];
    const m = s.match(/^(\s*)let\s+([\w$]+)\s*:\s*([^;]+);\s*(.*)$/);
    if (!m) { skip++; console.log('SKIP', f, ln, s.trim().slice(0, 80)); continue; }
    const [, ind, name, type, tail] = m;
    if (type.replace(/<[^<>]*>/g, '').includes(',')) { skip++; console.log('MULTI', f, ln, s.trim().slice(0, 80)); continue; }
    src[ln - 1] = `${ind}let ${name} = undefined as unknown as ${type.trim()};${tail ? ` ${tail}` : ''}`;
    n++;
  }
  if (apply) fs.writeFileSync(f, src.join('\n'));
}
console.log(n, 'cast-initialized,', skip, 'skipped', apply ? '(applied)' : '(dry)');
