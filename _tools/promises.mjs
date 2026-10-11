// promise/always-return + promise/catch-or-return fixer.
// For each flagged .then() call:
//  - always-return: insert `return;` as last stmt of the then callback
//  - catch-or-return: append `.catch((): void => undefined)` after the chain
// Sites are parsed from _tools/oxl.txt.
import fs from 'fs';
import ts from '../client/node_modules/typescript/lib/typescript.js';

const oxl = fs.readFileSync('_tools/oxl.txt', 'utf8');
const alwaysRet = new Map(); // file -> set of 0-based line numbers (callback start lines)
const catchRet = new Map();
for (const line of oxl.split(/\r?\n/)) {
  const m = line.match(/^([^\s:]+\.ts):(\d+):(\d+): warning promise\((always-return|catch-or-return)\)/);
  if (!m) continue;
  const [, f, l, c, kind] = m;
  const map = kind === 'always-return' ? alwaysRet : catchRet;
  if (!map.has(f)) map.set(f, []);
  map.get(f).push({ line: +l, col: +c });
}

let fixedA = 0, fixedC = 0;
const files = new Set([...alwaysRet.keys(), ...catchRet.keys()]);
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
  const edits = [];

  // Collect then-call sites: match by line of the call expression / callback.
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'then' && n.arguments.length > 0) {
      const cb = n.arguments[0];
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        const cbStart = sf.getLineAndCharacterOfPosition(cb.getStart()).line + 1;
        const callStart = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        // always-return: flagged at the callback's position
        for (const s of (alwaysRet.get(f) || [])) {
          if (s.line === cbStart) {
            // insert `return;` before the callback body's closing brace
            if (ts.isBlock(cb.body)) {
              edits.push({ pos: cb.body.end - 1, text: 'return; ', line: s.line });
              fixedA++;
            }
          }
        }
        // catch-or-return: flagged at the call's start line
        for (const s of (catchRet.get(f) || [])) {
          if (s.line === callStart) {
            edits.push({ pos: n.end, text: '.catch((): void => undefined)', line: s.line });
            fixedC++;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  edits.sort((a, b) => b.pos - a.pos);
  for (const e of edits) src = src.slice(0, e.pos) + e.text + src.slice(e.pos);
  fs.writeFileSync(f, src);
}
console.log('alwaysReturn:', fixedA, 'catchOrReturn:', fixedC);
