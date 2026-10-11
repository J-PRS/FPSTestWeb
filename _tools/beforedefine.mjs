// Move top-level `function` declarations above the top-level statement that
// first uses them, satisfying no-use-before-define. Function decls are hoisted
// so reordering can't change semantics; const/class/nested decls are skipped.
// Usage: node _tools/beforedefine.mjs [apply]
import ts from '../client/node_modules/typescript/lib/typescript.js';
import fs from 'fs';
import { execSync } from 'child_process';

const APPLY = process.argv.includes('apply');
const out = fs.readFileSync('_tools/oxl.txt', 'utf8');
const re = /^([a-z_0-9/.-]+\.ts):(\d+):(\d+): warning eslint\(no-use-before-define\): '([\w$]+)'/gim;
const sites = new Map();
let m;
while ((m = re.exec(out))) {
  const [, f, line, , name] = m;
  if (!sites.has(f)) sites.set(f, []);
  sites.get(f).push({ line: +line, name });
}
console.log('files:', sites.size);

const stats = { moved: 0, skipNotTopFn: 0, already: 0, files: 0 };

for (const [f, list] of sites) {
  let src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true);
  const lineStarts = sf.getLineStarts();
  const topFn = new Map();
  sf.forEachChild(n => { if (ts.isFunctionDeclaration(n) && n.name && !topFn.has(n.name.text)) topFn.set(n.name.text, n); });
  // earliest use per name — later warnings resolve once the decl is moved
  const earliest = new Map();
  for (const { line, name } of list) {
    const cur = earliest.get(name);
    if (cur === undefined || line < cur) earliest.set(name, line);
  }
  const edits = [];
  for (const [name, line] of earliest) {
    const d = topFn.get(name);
    if (!d) { stats.skipNotTopFn++; continue; }
    const useOff = lineStarts[line - 1];
    if (d.getStart(sf) < useOff) { stats.already++; continue; }
    // find top-level statement containing useOff
    let target = null;
    sf.forEachChild(n => { if (n.getStart(sf) <= useOff && useOff < n.getEnd()) target = n; });
    if (!target) { stats.skipNotTopFn++; continue; }
    if (target === d) { stats.already++; continue; }
    edits.push({ cutStart: d.getFullStart(), cutEnd: d.getEnd(), insertAt: target.getFullStart() });
    stats.moved++;
  }
  if (!edits.length) continue;
  const cuts = [...edits].sort((a, b) => b.cutStart - a.cutStart);
  const movedTexts = [];
  for (const e of cuts) {
    movedTexts.unshift({ text: src.slice(e.cutStart, e.cutEnd) + '\n\n', insertAt: e.insertAt });
    src = src.slice(0, e.cutStart) + src.slice(e.cutEnd);
  }
  // recompute insert positions in the post-cut text: insertAt was pre-cut
  for (const mt of movedTexts.sort((a, b) => b.insertAt - a.insertAt)) {
    let adj = mt.insertAt;
    for (const e of cuts) if (e.cutStart < mt.insertAt) adj -= (e.cutEnd - e.cutStart);
    if (adj < 0) adj = 0;
    src = src.slice(0, adj) + mt.text + src.slice(adj);
  }
  if (APPLY) fs.writeFileSync(f, src);
  stats.files++;
}
console.log(stats);
