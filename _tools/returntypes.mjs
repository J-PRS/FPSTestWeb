// Dry-run/apply: annotate missing explicit return types using the TS checker.
// Usage: node _tools/returntypes.mjs [apply]
import ts from '../client/node_modules/typescript/lib/typescript.js';
import fs from 'fs';
import path from 'path';

const ROOTS = ['client/src', 'shared', 'server_bun/src'];
const APPLY = process.argv.includes('apply');

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !p.endsWith('.d.ts')) files.push(p);
  }
}
for (const r of ROOTS) walk(r);

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  allowJs: false,
  noEmit: true,
  types: [],
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
});
const checker = program.getTypeChecker();

const edits = new Map(); // file -> [{pos, text}]
const stats = { done: 0, skipAny: 0, skipLong: 0, skipImport: 0, err: 0 };
const typeCounts = new Map();

function isFnLike(n) {
  return ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
    ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n);
}

const BUILTIN = new Set(['void','number','boolean','string','never','unknown','null','undefined','any','Promise','Array','ReadonlyArray','Map','Set','Record','Partial','Required','Pick','Omit','Exclude','Extract','NonNullable','ReturnType','Parameters','Readonly','Error','RegExp','Date','true','false','this','object','symbol','bigint','Iterable','Iterator','Generator','AsyncGenerator','Awaited','InstanceType','ThisType','undefined']);

for (const f of files) {
  const sf = program.getSourceFile(f.replaceAll('\\', '/')) || program.getSourceFile(path.resolve(f).replaceAll('\\', '/'));
  if (!sf) continue;
  const src = fs.readFileSync(f, 'utf8');
  const refsOk = (t) => {
    // every capitalized identifier or dotted namespace must already appear in the file
    for (const m of t.matchAll(/\b[A-Za-z_$][\w$]*/g)) {
      const id = m[0];
      if (BUILTIN.has(id) || id === id.toLowerCase()) continue;
      if (!src.includes(id)) return false;
    }
    return true;
  };
  const fileEdits = [];
  const visit = (n) => {
    if (isFnLike(n) && !ts.isConstructorDeclaration(n) && !n.type && !ts.isSetAccessorDeclaration(n)) {
      // must have a body or be a declaration with body
      if (n.body) {
        try {
          const sig = checker.getSignatureFromDeclaration(n);
          if (sig) {
            const rt = checker.getReturnTypeOfSignature(sig);
            let t = checker.typeToString(rt, n, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
            if (!t) t = 'void';
            if (t === 'any') { stats.skipAny++; }
            else if (t.length > 90 || t.includes('\n')) { stats.skipLong++; }
            else if (t.includes('import(') || t.includes('=>') && t.length > 90) { stats.skipImport++; }
            else {
              // parameters.end sits just before the ')' for parenthesized params;
              // bare-param arrows (`x => body`) have no parens and need wrapping.
              // Bare-param arrow iff no '(' appears between the arrow's own
              // start and its first param — a leading '(' before a bare param
              // belongs to the enclosing call, not the param list.
              const first = n.parameters[0];
              const head = src.slice(n.pos, first ? first.pos : n.parameters.end);
              if (ts.isArrowFunction(n) && !head.includes('(')) {
                fileEdits.push({ pos: n.parameters.pos, text: '(' });
                fileEdits.push({ pos: n.parameters.end, text: '): ' + t });
              } else {
                const closeParen = src.indexOf(')', n.parameters.end);
                if (closeParen < 0) { stats.err++; ts.forEachChild(n, visit); return; }
                fileEdits.push({ pos: closeParen + 1, text: ': ' + t });
              }
              stats.done++;
              typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
            }
          }
        } catch { stats.err++; }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (fileEdits.length) edits.set(f, fileEdits);
}

const top = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('stats', stats);
console.log('top types:', top.map(([t, c]) => `${c}x ${t}`).join('\n  '));
console.log('files touched:', edits.size);

if (APPLY) {
  for (const [f, es] of edits) {
    let s = fs.readFileSync(f, 'utf8');
    es.sort((a, b) => b.pos - a.pos);
    for (const e of es) s = s.slice(0, e.pos) + e.text + s.slice(e.pos);
    fs.writeFileSync(f, s);
  }
  console.log('applied to', edits.size, 'files');
}
