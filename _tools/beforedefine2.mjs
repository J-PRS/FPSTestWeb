// no-use-before-define pass 2: hoist top-level `const name = (arrow|fn)` decls
// above their earliest textual use. Arrow/fn bodies evaluate at call time, so
// the only TDZ risk is a use evaluated at module init — we skip moves whose
// earliest use sits inside another top-level const initializer evaluated at
// load (conservative: allow, tsc + oxlint re-check catches problems).
import fs from 'fs';
import ts from '../client/node_modules/typescript/lib/typescript.js';

const oxl = fs.readFileSync('_tools/oxl.txt', 'utf8');
const flagged = new Map(); // file -> Set<name>
for (const line of oxl.split(/\r?\n/)) {
  const m = line.match(/^([^\s:]+\.ts):\d+:\d+: warning eslint\(no-use-before-define\): '([A-Za-z_$][\w$]*)' was used/);
  if (!m) continue;
  if (!flagged.has(m[1])) flagged.set(m[1], new Set());
  flagged.get(m[1]).add(m[2]);
}

let moved = 0;
for (const [f, names] of flagged) {
  let src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
  const tops = sf.statements;

  // per name: find declaring top-level variable statement (single decl, arrow/fn init)
  // and the earliest textual use position.
  const nameUses = new Map();
  const nameDecl = new Map();
  for (const st of tops) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && names.has(d.name.text)
            && st.declarationList.declarations.length === 1
            && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          nameDecl.set(d.name.text, st);
        }
      }
    }
  }
  // earliest use: first identifier occurrence in file before decl (approx via indexOf on word-boundary)
  for (const n of names) {
    const decl = nameDecl.get(n);
    if (!decl) continue;
    const re = new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`);
    // find first occurrence of the name anywhere before decl start
    const head = src.slice(0, decl.getStart());
    const mm = head.match(re);
    if (!mm) continue;
    nameUses.set(n, mm.index);
  }

  // plan moves: for each decl, the enclosing top-level statement containing the earliest use
  const plans = [];
  for (const [n, usePos] of nameUses) {
    const decl = nameDecl.get(n);
    const target = tops.find(st => usePos >= st.getStart() && usePos < st.getEnd());
    if (!target || target === decl) continue;
    plans.push({ n, decl, target });
  }
  // apply back-to-front: collect (declStart,declEnd,text) and (targetStart)
  const cuts = plans.map(p => ({
    start: p.decl.getStart(), end: p.decl.getEnd(),
    text: src.slice(p.decl.getStart(), p.decl.getEnd()),
    ins: p.target.getStart(),
  })).sort((a, b) => b.start - a.start);
  // apply cuts descending, then inserts ascending offset-adjusted
  let out = src;
  const inserts = [];
  for (const c of cuts) {
    out = out.slice(0, c.start) + out.slice(c.end);
    inserts.push({ at: c.ins - (c.ins > c.start ? (c.end - c.start) : 0), text: c.text + '\n' });
  }
  inserts.sort((a, b) => a.at - b.at);
  let shift = 0;
  for (const i of inserts) { out = out.slice(0, i.at + shift) + i.text + out.slice(i.at + shift); shift += i.text.length; }
  if (cuts.length) { fs.writeFileSync(f, out); moved += cuts.length; }
}
console.log('moved:', moved);
