import fs from 'fs';
// node initdecl.mjs <warn-file> [--apply]
// `let x: T;` -> `let x: T = <default>;` for defaultable T.
const apply = process.argv[3] === '--apply';
const byFile = new Map();
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (!m) continue;
  (byFile.get(m[1]) ?? byFile.set(m[1], []).get(m[1])).push(+m[2]);
}

function defaultFor(t) {
  t = t.trim();
  if (t === 'number') return '0';
  if (t === 'boolean') return 'false';
  if (t === 'string') return "''";
  if (t === 'unknown' || t === 'any') return 'undefined';
  if (/\[\]$/.test(t)) return '[]';
  if (/\bMap</.test(t)) return 'new Map()';
  if (/\bSet</.test(t)) return 'new Set()';
  if (/\|\s*undefined\b/.test(t) || /\bundefined\s*\|/.test(t)) return 'undefined';
  if (/\|\s*null\b/.test(t) || /\bnull\s*\|/.test(t)) return 'null';
  return null;
}

let n = 0, skip = 0;
for (const [f, lines] of byFile) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  for (const ln of lines) {
    const s = src[ln - 1];
    const m = s.match(/^(\s*)let\s+(.+?);\s*$/);
    if (!m) { skip++; console.log('NOLET', f, ln, s.trim().slice(0, 80)); continue; }
    const [, ind, decls] = m;
    const parts = decls.split(/,(?=\s*[\w$]+\s*:)/); // split on commas that start a new `name:` declarator
    const out = [];
    let ok = true;
    for (const d of parts) {
      const dm = d.match(/^([\w$]+)\s*:\s*(.+)$/);
      if (!dm) { ok = false; break; }
      const def = defaultFor(dm[2]);
      if (def === null) { ok = false; break; }
      out.push(`${dm[1]}: ${dm[2]} = ${def}`);
    }
    if (!ok) { skip++; console.log('SKIP', f, ln, decls.slice(0, 80)); continue; }
    src[ln - 1] = `${ind}let ${out.join(', ')};`;
    n++;
  }
  if (apply) fs.writeFileSync(f, src.join('\n'));
}
console.log(n, 'initialized,', skip, 'skipped', apply ? '(applied)' : '(dry)');
