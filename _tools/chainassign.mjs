// Splits chained assignments into sequential statements.
//  `const x = T = E;`      -> `T = E;\n  const x = T;`
//  `a = b = E;`            -> `b = E;\n  a = b;`
//  `a = b = c = E;`        -> `c = E;\n  b = c;\n  a = b;`
//  `x = (T ??= E)` / `(T += E)` inside decl/expr -> hoist: `T ??= E;\n  x = T;`
import fs from 'fs';

const sites = fs.readFileSync(process.argv[2] ?? '_tools/.ma.txt', 'utf8')
  .trim().split(/\r?\n/).filter(Boolean);
const byF = new Map();
for (const l of sites) {
  const m = l.match(/^(.+):(\d+):(\d+)/);
  if (!m) continue;
  const arr = byF.get(m[1]) ?? [];
  arr.push([+m[2], +m[3]]);
  byF.set(m[1], arr);
}

const LV = '(?:this\\.)?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])*';

let n = 0, skip = 0;
for (const [f, list] of byF) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  const done = new Set();
  for (const [ln] of list.sort((a, b) => b[0] - a[0])) {
    const i = ln - 1;
    if (done.has(i)) continue;
    let s = src[i];
    const ind = s.match(/^\s*/)[0];

    // Shape A: declaration `const x = T = E;` or `const x = (T ??= E);` / `= (T += E)`
    let m = s.match(new RegExp(
      '^(\\s*(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*)\\(?(' + LV + ')\\s*(=|\\?\\?=|\\+=|-=|\\*=|/=)\\s*([^;)]+?)\\)?\\s*;(.*)$'));
    if (m) {
      const [, pre, tgt, op, rhs, tail] = m;
      const nl = s.match(/^(\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*)/)[1].split(/[\s=]/).pop();
      const stmt = `${ind}${tgt} ${op} ${rhs};`;
      const decl = `${pre.replace(/=\s*$/, '= ' + tgt + ';')}${tail.trim()}`;
      // if op is plain '=', target may not exist yet as a read — x = T is fine
      src[i] = stmt + '\n' + ind + decl.trimStart();
      n++; done.add(i); continue;
    }

    // Shape B: `s.prop = (G += 1)` — non-declaration with parenthesized assign RHS
    m = s.match(new RegExp(
      '^(\\s*[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])*\\s*=\\s*)\\((' + LV + ')\\s*(\\?\\?=|\\+=|-=|\\*=|/=)\\s*([^;)]+)\\)(\\s*;.*)$'));
    if (m) {
      const [, pre, tgt, op, rhs, tail] = m;
      const lhs = pre.trim().replace(/=\s*$/, '');
      src[i] = `${ind}${tgt} ${op} ${rhs};\n${ind}${lhs} = ${tgt}${tail}`;
      n++; done.add(i); continue;
    }

    // Shape C: bare chain `a = b = ... = E;` (any depth, incl. const-less)
    m = s.match(new RegExp(
      '^(\\s*)(' + LV + ')(\\s*=\\s*' + LV + ')+\\s*=\\s*([^;]+);(.*)$'));
    if (m) {
      const targets = s.match(new RegExp(LV + '(?=\\s*=[^=])', 'g'));
      const rhs = m[4];
      const tail = m[5];
      const stmts = [];
      for (let k = targets.length - 1; k >= 0; k--) {
        stmts.push(`${ind}${targets[k]} = ${k === targets.length - 1 ? rhs : targets[k + 1]};`);
      }
      src[i] = stmts.join('\n') + (tail.trim() ? ' ' + tail.trim() : '');
      n++; done.add(i); continue;
    }
    skip++;
    console.log('SKIP', f, ln, s.trim().slice(0, 80));
  }
  fs.writeFileSync(f, src.join('\n'));
}
console.log(`${n} lines split, ${skip} skipped`);
