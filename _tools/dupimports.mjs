import fs from 'fs';
// node dupimports.mjs <warn-file> [--apply]
// Merges duplicate `import ... from 'x'` + `import type ... from 'x'`
// into `import {a, b, type c} from 'x'`. All-type merges stay `import type`.
// Skips namespace/default complexities (keeps those lines, reports).
const apply = process.argv[3] === '--apply';
const files = [...new Set(
  fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)
    .map(l => l.match(/^(.+):\d+:\d+:?$/)?.[1]).filter(Boolean),
)];

const IMPORT_RE = /^import\s+(type\s+)?(\{[^}]*\}|[^\s{]+)\s+from\s+(['"][^'"]+['"]);?\s*$/;

let nMerge = 0, nSkip = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  const groups = new Map(); // source -> [{line, isType, members, default}]
  src.forEach((s, i) => {
    const m = s.match(IMPORT_RE);
    if (!m) return;
    const [, typeKw, clause, path] = m;
    if (!clause.startsWith('{')) {
      // default or namespace import — leave alone but note
      (groups.get(path) ?? groups.set(path, []).get(path)).push({ line: i, raw: s, complex: true });
      return;
    }
    const members = clause.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    (groups.get(path) ?? groups.set(path, []).get(path)).push({ line: i, isType: !!typeKw, members, raw: s });
  });
  const delLines = new Set();
  const inserts = [];
  for (const [path, imps] of groups) {
    if (imps.length < 2) continue;
    if (imps.some(i => i.complex)) { nSkip++; console.log('SKIP-complex', f, path); continue; }
    const allType = imps.every(i => i.isType);
    const merged = imps.flatMap(i =>
      i.isType && !allType ? i.members.map(m => `type ${m}`) : i.members);
    // dedupe member names
    const seen = new Set();
    const uniq = merged.filter(m => { const k = m.replace(/^type /, ''); if (seen.has(k)) return false; seen.add(k); return true; });
    const stmt = `import ${allType ? 'type ' : ''}{${uniq.join(', ')}} from ${path};`;
    inserts.push({ line: imps[0].line, stmt });
    imps.forEach(i => delLines.add(i.line));
    console.log(`${f}: merge ${imps.length} imports from ${path}`);
    nMerge++;
  }
  if (apply && delLines.size) {
    // per-group insertion point: original line index minus deleted lines before it
    for (const ins of inserts) {
      ins.pos = ins.line - [...delLines].filter(d => d < ins.line).length;
    }
    inserts.sort((a, b) => a.pos - b.pos);
    const out = src.filter((_, i) => !delLines.has(i));
    for (const ins of inserts) out.splice(ins.pos, 0, ins.stmt);
    fs.writeFileSync(f, out.join('\n'));
  }
}
console.log('---', nMerge, 'merged,', nSkip, 'skipped');
