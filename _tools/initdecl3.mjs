import fs from 'fs';
// node initdecl3.mjs <warn-file> [--apply]
// last tier: `let x!: T` / `let a: T, b: U` (multi) -> per-declarator init.
const apply = process.argv[3] === '--apply';
const byFile = new Map();
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (!m) continue;
  (byFile.get(m[1]) ?? byFile.set(m[1], []).get(m[1])).push(+m[2]);
}
function defFor(t) {
  t = t.trim();
  if (t === 'number') return '0';
  if (t === 'boolean') return 'false';
  if (t === 'string') return "''";
  if (/\bunknown\b/.test(t)) return 'undefined';
  if (/\|\s*undefined|\bundefined\s*\|/.test(t)) return 'undefined';
  if (/\|\s*null|\bnull\s*\|/.test(t)) return 'null';
  if (/\[\]$/.test(t)) return '[]';
  return `undefined as unknown as ${t}`;
}
function splitDecls(decls) {
  // split `a: T, b: U` on top-level commas (track <>/{} depth)
  const out = []; let depth = 0, cur = '';
  for (const c of decls) {
    if (c === '<' || c === '{') depth++;
    if (c === '>' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
let n = 0, skip = 0;
for (const [f, lines] of byFile) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  for (const ln of new Set(lines)) {
    const s = src[ln - 1];
    const m = s.match(/^(\s*)let\s+(.+?);(\s*(?:\/\/.*)?)$/);
    if (!m) { skip++; continue; }
    const [, ind, decls, tail] = m;
    const parts = splitDecls(decls);
    const out = [];
    for (const d of parts) {
      const dm = d.trim().match(/^([\w$]+)!?\s*:\s*(.+)$/s);
      if (!dm) { out.push(null); break; }
      out.push(`${dm[1]} = ${defFor(dm[2])}`);
    }
    if (out.includes(null)) { skip++; console.log('SKIP', f, ln, decls.slice(0, 90)); continue; }
    src[ln - 1] = `${ind}let ${out.join(', ')};${tail}`;
    n++;
  }
  if (apply) fs.writeFileSync(f, src.join('\n'));
}
console.log(n, 'done,', skip, 'skipped');
