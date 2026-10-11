import fs from 'fs';
// node typeimports.mjs <warn-file> [--apply]
// Replaces inline `import('path').Type` annotations with bare `Type`,
// adding/merging `import type { Type } from 'path'` at top of file.
const apply = process.argv[3] === '--apply';
const files = [...new Set(
  fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)
    .map(l => l.match(/^(.+):\d+:\d+:?$/)?.[1]).filter(Boolean),
)];

const IMP_RE = /import\('([^']+)'\)\.([\w$]+)/g;
const stripExt = p => p.replace(/\.(ts|js)$/, '');

let nDo = 0, nSkip = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  const needed = new Map(); // type -> path
  const seen = new Map();
  for (const [i, s] of src.entries()) {
    for (const m of s.matchAll(IMP_RE)) {
      const [, path, type] = m;
      if (!needed.has(type)) needed.set(type, path);
      seen.set(i, true);
    }
  }
  if (!needed.size) continue;
  // bound names: existing import members + top-level decls (approx)
  const bound = new Set();
  for (const s of src) {
    const im = s.match(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from/);
    if (im) for (const n of im[1].split(',')) bound.add(n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop());
    const dm = s.match(/^import\s+(?:type\s+)?([\w$]+|\*\s+as\s+[\w$]+)\s+from/);
    if (dm) bound.add(dm[1].replace(/\*\s+as\s+/, ''));
    const td = s.match(/^(?:export\s+)?(?:class|interface|type|const|let|var|function|enum)\s+([\w$]+)/);
    if (td) bound.add(td[1]);
  }
  // find existing type-import lines per module (ext-insensitive)
  const typeImportIdx = new Map(); // strippedPath -> line idx
  let lastImportLine = -1;
  for (const [i, s] of src.entries()) {
    const m = s.match(/^import\s+(type\s+)?.*from\s+['"]([^'"]+)['"]/);
    if (m) { lastImportLine = i; typeImportIdx.set(stripExt(m[2]) + '|' + (m[1] ? 't' : 'v'), i); }
  }
  const edits = new Map(); // lineIdx -> 'Type' to append
  const newImports = []; // 'import type {X} from path'
  const unresolved = [];
  for (const [type, path] of needed) {
    if (bound.has(type)) { unresolved.push(type); continue; }
    const key = stripExt(path) + '|t';
    const vi = typeImportIdx.get(key);
    const vv = typeImportIdx.get(stripExt(path) + '|v');
    if (vi !== undefined) {
      edits.set(vi, (edits.get(vi) ?? []).concat(type));
    } else if (vv !== undefined) {
      // convert value import to include `type X` member
      edits.set(vv, (edits.get(vv) ?? []).concat(`type ${type}`));
    } else {
      newImports.push(`import type { ${type} } from '${path}';`);
    }
    nDo++;
  }
  for (const t of unresolved) { nSkip++; console.log('COLLIDE', f, t); }
  // apply member appends + annotation replacements
  const out = [];
  for (const [i, s] of src.entries()) {
    let ns = s;
    if (edits.has(i)) {
      ns = ns.replace(/\}\s+from/, `, ${edits.get(i).join(', ')} } from`);
    }
    ns = ns.replace(IMP_RE, '$2');
    out.push(ns);
  }
  if (newImports.length) out.splice(lastImportLine + 1, 0, ...newImports);
  console.log(`${f}: ${needed.size} types -> ${newImports.length} new imports, ${unresolved.length} collisions`);
  if (apply) fs.writeFileSync(f, out.join('\n'));
}
console.log('---', nDo, 'replaced,', nSkip, 'collisions');
