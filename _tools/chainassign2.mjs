// v2: handles paren-rhs, mid-block chains, bracket lvalues, join of wrapped lines.
import fs from 'fs';

const sites = fs.readFileSync('_tools/.ma.txt', 'utf8').trim().split(/\r?\n/).filter(Boolean);
const byF = new Map();
for (const l of sites) {
  const m = l.match(/^(.+):(\d+):(\d+)/);
  if (!m) continue;
  const arr = byF.get(m[1]) ?? [];
  arr.push(+m[2]);
  byF.set(m[1], arr);
}

const LV = '(?:this\\.)?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])*';
let n = 0;
const pending = [];

for (const [f, lns] of byF) {
  let src = fs.readFileSync(f, 'utf8').split('\n');

  // Pass 0: join a wrapped chain: line ends with '=' and next line is 'target = rhs;'
  for (const ln of lns) {
    const i = ln - 1;
    if (src[i] !== undefined && /=\s*$/.test(src[i]) && src[i + 1] !== undefined) {
      src[i] = src[i] + ' ' + src[i + 1].trim();
      src.splice(i + 1, 1);
    }
  }

  for (const ln of lns.sort((a, b) => b - a)) {
    const i = ln - 1;
    let s = src[i];
    if (s === undefined) continue;
    const ind = s.match(/^\s*/)[0];
    const TAIL = '(\\s*(?:\\/\\/.*)?\\s*)$';

    // A: decl with inner assign — rhs greedy to last ')' or ';'
    let m = s.match(new RegExp(
      '^(\\s*)(const|let|var)\\s+([\\w$]+)\\s*=\\s*\\(?\\s*(' + LV + ')\\s*(=|\\?\\?=|\\+=|-=|\\*=|/=)\\s*(.*\\S)\\s*\\)?\\s*;' + TAIL));
    if (m) {
      const [, ws, kw, name, tgt, op, rhs0, tail] = m;
      let rhs = rhs0;
      // if decl was '... (T op= E) ;' the captured rhs holds trailing ')' — strip one if unbalanced
      if (/\)\s*$/.test(rhs) && (rhs.match(/\(/g) || []).length < (rhs.match(/\)/g) || []).length) {
        rhs = rhs.replace(/\)\s*$/, '');
      }
      src[i] = `${ws}${tgt} ${op} ${rhs};\n${ws}${kw} ${name} = ${tgt};${tail}`;
      n++; continue;
    }

    // B: `lhs = (T op= E);` non-declaration
    m = s.match(new RegExp(
      '^(\\s*)(' + LV + ')\\s*=\\s*\\(\\s*(' + LV + ')\\s*(\\?\\?=|\\+=|-=|\\*=|/=)\\s*(.*\\S)\\s*\\)\\s*;' + TAIL));
    if (m) {
      const [, ws, lhs, tgt, op, rhs, tail] = m;
      src[i] = `${ws}${tgt} ${op} ${rhs};\n${ws}${lhs} = ${tgt};${tail}`;
      n++; continue;
    }

    // C: mid-line or bare chain `A = B = ... = E` (inside {} or alone)
    const chainRe = new RegExp('(' + LV + ')\\s*=\\s*(' + LV + ')\\s*=\\s*([^;{}]+?)(;|//|$)');
    const cm = s.match(chainRe);
    if (cm) {
      // split full chain left of rhs
      const seg = cm[0].replace(/;\s*$/, '').replace(/\/\/.*$/, '');
      const parts = seg.split(/\s*=\s*/);
      const rhs = parts.pop();
      const rebuilt = parts.slice(1).concat([]); // drop first, handle below
      const stmts = [];
      for (let k = parts.length - 1; k >= 0; k--) {
        stmts.push(`${parts[k]} = ${k === parts.length - 1 ? rhs : parts[k + 1]}`);
      }
      const inner = stmts.join('; ') + ';';
      s = s.replace(seg + (cm[4] === ';' ? ';' : ''), inner);
      src[i] = s;
      n++; continue;
    }
    pending.push(`${f}:${ln} ${s.trim().slice(0, 90)}`);
  }
  fs.writeFileSync(f, src.join('\n'));
}
console.log(n + ' rewritten');
for (const p of pending) console.log('PEND', p);
